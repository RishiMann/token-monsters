"""Accounts and sessions.

Passwords are stored as PBKDF2-HMAC-SHA256 with a per-user random salt, so the
database never holds a recoverable password. Sessions are opaque random tokens
kept server-side and handed to the browser in an HttpOnly cookie, so page
scripts cannot read or forge one.

This replaces the earlier browser-side demo auth. It is a real mechanism, but
it is still a prototype: there is no email verification, rate limiting, lockout
or password reset, and it should sit behind HTTPS (App Service provides that).
"""

import hashlib
import hmac
import os
import re
import secrets
from datetime import datetime, timedelta, timezone

import db

ITERATIONS = 210_000
SESSION_DAYS = 7
SESSION_COOKIE = "fc_session"

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD = 8


class AuthError(Exception):
    """Raised for anything the caller should see as a 400/401."""


def hash_password(password, salt=None):
    """Returns (hex_digest, hex_salt)."""
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), ITERATIONS
    )
    return digest.hex(), salt


def verify_password(password, digest_hex, salt_hex):
    candidate, _ = hash_password(password, salt_hex)
    # Constant-time compare so a wrong password cannot be timed out character by character.
    return hmac.compare_digest(candidate, digest_hex)


def _year(value):
    """created_at is a datetime on PostgreSQL and an ISO string on SQLite."""
    if not value:
        return None
    if hasattr(value, "strftime"):
        return value.strftime("%Y")
    return str(value)[:4]


def _public(user):
    """The shape the frontend gets. Never includes hash or salt."""
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "role": user["role"],
        "initials": "".join(p[0] for p in user["name"].split()[:2]).upper(),
        "homeCorner": user.get("home_corner"),
        "plan": user.get("plan"),
        "memberSince": _year(user.get("created_at")),
    }


def sign_up(email, password, name):
    email = (email or "").strip().lower()
    name = (name or "").strip()
    password = password or ""

    if not EMAIL_RE.match(email):
        raise AuthError("Enter a valid email address.")
    if len(password) < MIN_PASSWORD:
        raise AuthError(f"Password must be at least {MIN_PASSWORD} characters.")
    if not name:
        raise AuthError("Enter your name.")
    if db.query("SELECT 1 FROM users WHERE email = %s", (email,), one=True):
        raise AuthError("An account with that email already exists.")

    digest, salt = hash_password(password)
    user = db.query(
        """INSERT INTO users (email, password_hash, password_salt, name, role)
           VALUES (%s, %s, %s, %s, 'customer')
           RETURNING id, email, name, role, home_corner, plan, created_at""",
        (email, digest, salt, name),
        one=True,
    )
    return _public(user), create_session(user["id"])


def sign_in(email, password):
    email = (email or "").strip().lower()
    user = db.query(
        """SELECT id, email, name, role, home_corner, plan, created_at,
                  password_hash, password_salt
           FROM users WHERE email = %s""",
        (email,),
        one=True,
    )
    # Same message either way so the form cannot be used to enumerate accounts.
    if not user or not verify_password(password or "", user["password_hash"], user["password_salt"]):
        raise AuthError("We don't recognize that email and password.")
    return _public(user), create_session(user["id"])


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    db.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (%s, %s, %s)",
        (token, user_id, expires),
    )
    return token


def session_user(token):
    """Returns the public user for a live token, or None."""
    if not token:
        return None
    row = db.query(
        """SELECT u.id, u.email, u.name, u.role, u.home_corner, u.plan, u.created_at
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token = %s AND s.expires_at > %s""",
        (token, datetime.now(timezone.utc)),
        one=True,
    )
    return _public(row) if row else None


def sign_out(token):
    if token:
        db.execute("DELETE FROM sessions WHERE token = %s", (token,))


def purge_expired():
    return db.execute("DELETE FROM sessions WHERE expires_at <= %s",
                      (datetime.now(timezone.utc),))


def preferences(user_id):
    rows = db.query("SELECT key, value FROM preferences WHERE user_id = %s", (user_id,))
    return {r["key"]: r["value"] for r in rows}


def set_preference(user_id, key, value):
    db.execute(
        "INSERT INTO preferences (user_id, key, value) VALUES (%s, %s, %s) "
        "ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value",
        (user_id, key, str(value)),
    )


def cookie_header(token, secure=True):
    """Session cookie: HttpOnly so scripts cannot read it, Lax to blunt CSRF."""
    parts = [
        f"{SESSION_COOKIE}={token}",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        f"Max-Age={SESSION_DAYS * 24 * 3600}",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header():
    return f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


def token_from_cookies(cookie_header_value):
    for chunk in (cookie_header_value or "").split(";"):
        name, _, value = chunk.strip().partition("=")
        if name == SESSION_COOKIE:
            return value
    return None
