/**
 * Client side of authentication.
 *
 * There are no credentials here. The browser posts to /api/auth/*, the server
 * verifies against PostgreSQL and sets an HttpOnly session cookie, which page
 * scripts cannot read or forge. This module only caches the public profile the
 * server returns so pages can render without refetching on every navigation.
 */

const CACHE_KEY = "fc.user";

const cache = {
  read() {
    try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null"); } catch { return null; }
  },
  write(user) {
    try {
      if (user) sessionStorage.setItem(CACHE_KEY, JSON.stringify(user));
      else sessionStorage.removeItem(CACHE_KEY);
    } catch { /* private browsing can refuse storage */ }
  }
};

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body || {})
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* empty body */ }
  return { ok: response.ok, status: response.status, ...payload };
}

export async function signUp(email, password, name) {
  const result = await post("/api/auth/signup", { email, password, name });
  if (!result.ok) return { ok: false, error: result.error || "Could not create that account." };
  cache.write(result.user);
  return { ok: true, user: result.user };
}

export async function signIn(email, password) {
  const result = await post("/api/auth/login", { email, password });
  if (!result.ok) return { ok: false, error: result.error || "Could not sign you in." };
  cache.write(result.user);
  return { ok: true, user: result.user };
}

export async function signOut() {
  cache.write(null);
  try { await post("/api/auth/logout"); } catch { /* already gone */ }
}

/** The cached profile — synchronous, for first paint. May be stale. */
export function cachedUser() {
  return cache.read();
}

/** Asks the server who this session belongs to; the source of truth. */
export async function currentUser() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!response.ok) { cache.write(null); return null; }
    const { user } = await response.json();
    cache.write(user);
    return user;
  } catch {
    return cache.read();
  }
}

/**
 * Sends the visitor to sign in unless the server agrees they hold the role.
 * Convenience for page flow — the real check is server-side on each endpoint.
 */
export async function requireRole(role) {
  const user = await currentUser();
  if (!user || (role && user.role !== role)) {
    const next = encodeURIComponent(location.pathname.replace(/^\//, ""));
    location.replace(`login.html?next=${next}`);
    return null;
  }
  return user;
}

export function homeFor(user) {
  return user?.role === "admin" ? "admin.html" : "account.html";
}
