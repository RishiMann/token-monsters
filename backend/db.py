"""PostgreSQL access layer.

Connection comes from DATABASE_URL, so the same code runs against a local
server, Azure Database for PostgreSQL, or anything else that speaks Postgres:

    DATABASE_URL=postgresql://user:password@host:5432/frostedcorner

Locally the variable is optional: with none set, and outside App Service,
the connection falls back to a `frostedcorner` database on the machine's
own PostgreSQL server.

`init_schema()` is idempotent and `seed()` only fills empty tables, so both are
safe to run on every boot. The JSON files in this directory remain the seed
source for the catalog; everything mutable lives in the database from then on.
"""

import json
import os
import re
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

_pool = None


class DatabaseUnavailable(RuntimeError):
    """Raised when the database is not configured or not reachable."""


LOCAL_DEFAULT = "postgresql:///frostedcorner"

# DATABASE_URL is the setting. App Service exposes anything entered under
# "Connection strings" with a type prefix instead, so those spellings count too.
URL_NAMES = ("DATABASE_URL", "POSTGRESQLCONNSTR_DATABASE_URL", "CUSTOMCONNSTR_DATABASE_URL",
             "SQLAZURECONNSTR_DATABASE_URL", "SQLCONNSTR_DATABASE_URL")


def database_url():
    """DATABASE_URL, falling back to a local database during development.

    App Service always sets PORT, so the fallback only ever applies on a
    developer machine. That means `createdb frostedcorner` and running the
    server is enough locally, with no environment variable to remember.
    """
    for name in URL_NAMES:
        url = os.environ.get(name)
        if url:
            return url.strip()
    if "PORT" in os.environ:
        return None
    return LOCAL_DEFAULT


def database_url_source():
    """Which environment variable supplied the URL, for /api/health."""
    return next((n for n in URL_NAMES if os.environ.get(n)), None)


def _sqlite_path():
    """Where the fallback database file lives."""
    override = os.environ.get("SQLITE_PATH")
    if override:
        return Path(override)
    url = database_url() or ""
    if url.startswith("sqlite:"):
        path = url.split("sqlite:", 1)[1].lstrip("/")
        if path:
            return Path("/" + path) if url.startswith("sqlite:///") else Path(path)
    # App Service persists /home across restarts; everything else is ephemeral.
    home = Path("/home")
    if "PORT" in os.environ and home.is_dir() and os.access(home, os.W_OK):
        return home / "frostedcorner.db"
    return DATA_DIR / "frostedcorner.db"


def _open_postgres(url):
    try:
        from psycopg_pool import ConnectionPool
    except ImportError:
        import psycopg

        class _Direct:
            driver = "postgres"

            def connection(self_inner):
                return psycopg.connect(url)

        direct = _Direct()
        with direct.connection():          # fail fast if it is not reachable
            pass
        return direct

    pool = ConnectionPool(url, min_size=1, max_size=4, open=True)
    pool.wait(timeout=5)                   # surface a bad URL now, not mid-request
    pool.driver = "postgres"
    return pool


def _open_sqlite():
    """A file-backed fallback so the app still works with no PostgreSQL.

    This keeps a deployment without a database fully demoable: accounts, the
    profile and the operations console all work against the same seed data.
    PostgreSQL remains the real target and is always preferred.
    """
    import sqlite3
    from datetime import date, datetime

    sqlite3.register_adapter(date, lambda value: value.isoformat())
    sqlite3.register_adapter(datetime, lambda value: value.isoformat())

    path = _sqlite_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    import threading

    class _SqlitePool:
        driver = "sqlite"

        def __init__(self_inner):
            self_inner._conn = sqlite3.connect(
                str(path), timeout=30, check_same_thread=False
            )
            self_inner._conn.execute("PRAGMA foreign_keys = ON")
            self_inner._conn.execute("PRAGMA journal_mode = WAL")
            self_inner._lock = threading.Lock()

        @contextmanager
        def connection(self_inner):
            # sqlite3 connections are not thread-safe, and this server is
            # threaded, so serialize access to the one connection.
            with self_inner._lock:
                conn = self_inner._conn
                try:
                    yield _SqliteConn(conn)
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise

    return _SqlitePool()


class _SqliteConn:
    """Gives sqlite3 the cursor-as-context-manager shape psycopg has."""

    def __init__(self, conn):
        self._conn = conn

    @contextmanager
    def cursor(self):
        cur = self._conn.cursor()
        try:
            yield _SqliteCursor(cur)
        finally:
            cur.close()


class _SqliteCursor:
    def __init__(self, cur):
        self._cur = cur

    def execute(self, sql, params=()):
        # psycopg uses %s placeholders; sqlite uses ?.
        return self._cur.execute(sql.replace("%s", "?"), tuple(params))

    def executescript(self, sql):
        return self._cur.executescript(sql)

    @property
    def description(self):
        return self._cur.description

    @property
    def rowcount(self):
        return self._cur.rowcount

    def fetchall(self):
        return self._cur.fetchall()


def _pool_or_raise():
    """One lazily-created connection source for the process.

    PostgreSQL is preferred whenever it is configured and reachable. If it is
    not, the app falls back to SQLite rather than losing accounts entirely.
    """
    global _pool
    if _pool is not None:
        return _pool

    url = database_url()

    # Explicit opt-in to the file-backed store, e.g. DATABASE_URL=sqlite:///tmp/fc.db
    if url and url.startswith("sqlite:"):
        _pool = _open_sqlite()
        print(f"Using SQLite at {_sqlite_path()}.")
        return _pool

    if not url:
        raise DatabaseUnavailable("DATABASE_URL is not set")

    _pool = _open_postgres(url)
    return _pool


def driver():
    return getattr(_pool_or_raise(), "driver", "unknown")


@contextmanager
def connect():
    """Yields a connection, committing on success and rolling back on error."""
    pool = _pool_or_raise()
    try:
        with pool.connection() as conn:
            yield conn
    except DatabaseUnavailable:
        raise
    except Exception as exc:
        raise DatabaseUnavailable(str(exc)) from exc


def query(sql, params=(), one=False):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description is None:
                return None
            cols = [getattr(c, "name", None) or c[0] for c in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    return (rows[0] if rows else None) if one else rows


def execute(sql, params=()):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount


# ── Schema ───────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    password_salt   TEXT NOT NULL,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'customer',
    home_corner     TEXT,
    plan            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- Free-form so agents can read preferences without a migration per key.
CREATE TABLE IF NOT EXISTS preferences (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);

-- user_id is NULL for a guest checkout; a guest follows the order with its
-- tracking token instead. status walks placed -> preparing -> ready |
-- out_for_delivery -> completed, or cancelled; seeded history is 'fulfilled'.
CREATE TABLE IF NOT EXISTS orders (
    id             BIGSERIAL PRIMARY KEY,
    user_id        BIGINT REFERENCES users(id) ON DELETE CASCADE,
    placed_at      DATE NOT NULL,
    channel        TEXT NOT NULL DEFAULT 'app',
    status         TEXT NOT NULL DEFAULT 'fulfilled',
    fulfillment    TEXT,
    location_id    TEXT,
    offer_id       TEXT,
    total          NUMERIC(10,2),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ,
    promised_at    TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ,
    window_label   TEXT,
    address        TEXT,
    contact_name   TEXT,
    note           TEXT,
    tracking_token TEXT
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
    order_id    BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id     TEXT NOT NULL,
    quantity    INT NOT NULL DEFAULT 1,
    unit_price  NUMERIC(10,2),
    PRIMARY KEY (order_id, item_id)
);

-- Every status change, so the customer sees a timeline rather than a word.
CREATE TABLE IF NOT EXISTS order_events (
    id        BIGSERIAL PRIMARY KEY,
    order_id  BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status    TEXT NOT NULL,
    at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    note      TEXT
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events(order_id);

CREATE TABLE IF NOT EXISTS locations (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    region        TEXT NOT NULL,
    orders_week   INT NOT NULL DEFAULT 0,
    revenue_week  NUMERIC(10,2) NOT NULL DEFAULT 0,
    change_pct    NUMERIC(5,2) NOT NULL DEFAULT 0
);

-- Stock is per location, so "Scottsdale is low" is a query rather than a claim.
CREATE TABLE IF NOT EXISTS inventory (
    location_id    TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    sku            TEXT NOT NULL,
    name           TEXT NOT NULL,
    unit           TEXT NOT NULL,
    on_hand        NUMERIC(10,2) NOT NULL,
    reorder_point  NUMERIC(10,2) NOT NULL,
    on_order       NUMERIC(10,2) NOT NULL DEFAULT 0,
    lead_time_days INT NOT NULL DEFAULT 3,
    PRIMARY KEY (location_id, sku)
);

CREATE TABLE IF NOT EXISTS supply_orders (
    id           TEXT PRIMARY KEY,
    location_id  TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    placed       DATE NOT NULL,
    eta          DATE NOT NULL,
    status       TEXT NOT NULL,
    total        NUMERIC(10,2) NOT NULL,
    lines        INT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_daily (
    day          DATE NOT NULL,
    location_id  TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    orders       INT NOT NULL,
    revenue      NUMERIC(10,2) NOT NULL,
    PRIMARY KEY (day, location_id)
);

CREATE TABLE IF NOT EXISTS item_sales (
    day      DATE NOT NULL,
    item_id  TEXT NOT NULL,
    units    INT NOT NULL,
    PRIMARY KEY (day, item_id)
);
"""


def _sqlite_schema():
    """The same schema in SQLite's dialect.

    Only the type names and the identity column differ; the tables, keys and
    constraints are identical, so every query in the app runs unchanged.
    """
    sql = SCHEMA
    sql = re.sub(r"\bBIGSERIAL PRIMARY KEY\b", "INTEGER PRIMARY KEY AUTOINCREMENT", sql)
    sql = re.sub(r"\bTIMESTAMPTZ\b", "TEXT", sql)
    sql = re.sub(r"\bNUMERIC\(\d+,\s*\d+\)", "REAL", sql)
    sql = re.sub(r"\bBIGINT\b", "INTEGER", sql)
    sql = re.sub(r"\bnow\(\)", "CURRENT_TIMESTAMP", sql)
    return sql


# Columns added after the first schema shipped. Each statement is best effort:
# it fails harmlessly where the column already exists (SQLite has no IF NOT
# EXISTS for columns) and where the table was just created with it.
MIGRATIONS = [
    "ALTER TABLE orders ADD COLUMN fulfillment TEXT",
    "ALTER TABLE orders ADD COLUMN location_id TEXT",
    "ALTER TABLE orders ADD COLUMN offer_id TEXT",
    "ALTER TABLE orders ADD COLUMN total NUMERIC(10,2)",
    "ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL",   # PostgreSQL only
    # Order tracking. SQLite cannot default a new column to now(), so the
    # timestamp columns are added bare and filled from placed_at below.
    "ALTER TABLE orders ADD COLUMN created_at TIMESTAMPTZ",
    "ALTER TABLE orders ADD COLUMN updated_at TIMESTAMPTZ",
    "ALTER TABLE orders ADD COLUMN promised_at TIMESTAMPTZ",
    "ALTER TABLE orders ADD COLUMN completed_at TIMESTAMPTZ",
    "ALTER TABLE orders ADD COLUMN window_label TEXT",
    "ALTER TABLE orders ADD COLUMN address TEXT",
    "ALTER TABLE orders ADD COLUMN contact_name TEXT",
    "ALTER TABLE orders ADD COLUMN note TEXT",
    "ALTER TABLE orders ADD COLUMN tracking_token TEXT",
    "ALTER TABLE order_items ADD COLUMN unit_price NUMERIC(10,2)",
    "UPDATE orders SET created_at = placed_at WHERE created_at IS NULL",
    # Orders placed before tracking existed were fulfilled on the spot.
    "UPDATE orders SET status = 'completed' WHERE status = 'placed' AND updated_at IS NULL",
    "CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status)",
]


def init_schema():
    with connect() as conn:
        with conn.cursor() as cur:
            if driver() == "sqlite":
                cur.executescript(_sqlite_schema())
            else:
                cur.execute(SCHEMA)
    for statement in MIGRATIONS:
        try:
            with connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(statement)
        except Exception:
            pass


def _json(name):
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def catalog():
    """The product catalog still lives in storefront.json — it is not mutable."""
    return _json("storefront.json")


def menu_items(today=None):
    """Everything on the counter today: year-round items plus released seasonal ones."""
    import seasons
    data = catalog()
    return [*data.get("weeklyMenu", []), *data.get("plantBased", []),
            *seasons.released_items(data.get("eventMenus", []), today)]
