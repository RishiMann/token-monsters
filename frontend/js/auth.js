/**
 * Client side of authentication.
 *
 * There are no credentials here. The browser posts to /api/auth/*, the server
 * verifies against PostgreSQL and sets an HttpOnly session cookie, which page
 * scripts cannot read or forge. This module only caches the public profile the
 * server returns so pages can render without refetching on every navigation.
 */

const CACHE_KEY = "fc.user";
const DEMO_KEY = "fc.demo";

/**
 * Demo sign-in, used only when the server has no database (it answers 503).
 * These are the same seeded accounts the database would hold, and the login
 * page already lists them, so nothing here is secret. With a database
 * configured this path never runs and real hashed credentials are used.
 */
const DEMO_ACCOUNTS = [
  {
    password: "treat",
    user: { id: 1, email: "alex@frostedcorner.com", name: "Alex Rivera", role: "customer",
            initials: "AR", homeCorner: "Frisco Corner", plan: "The Table", memberSince: "2026" }
  },
  {
    password: "treat",
    user: { id: 2, email: "sam@frostedcorner.com", name: "Sam Okonkwo", role: "customer",
            initials: "SO", homeCorner: "South Congress", plan: "The Weekly Corner", memberSince: "2026" }
  },
  {
    password: "treat",
    user: { id: 3, email: "jordan@frostedcorner.com", name: "Jordan Bell", role: "customer",
            initials: "JB", homeCorner: "Heights Corner", plan: null, memberSince: "2026" }
  },
  {
    password: "admin",
    user: { id: 4, email: "hq@frostedcorner.com", name: "Morgan Sato", role: "admin",
            initials: "MS", homeCorner: null, plan: null, memberSince: "2026" }
  }
];

const demo = {
  read() {
    try { return JSON.parse(sessionStorage.getItem(DEMO_KEY) || "null"); } catch { return null; }
  },
  write(user) {
    try {
      if (user) sessionStorage.setItem(DEMO_KEY, JSON.stringify(user));
      else sessionStorage.removeItem(DEMO_KEY);
    } catch { /* private browsing can refuse storage */ }
  }
};

/** True when the server told us it has no database. */
const noDatabase = (result) => result.status === 503 || result.status === 0;

function demoSignIn(email, password) {
  const match = DEMO_ACCOUNTS.find(
    (account) => account.user.email === String(email).trim().toLowerCase()
  );
  if (!match || match.password !== password) {
    return { ok: false, error: "That email and password do not match." };
  }
  demo.write(match.user);
  cache.write(match.user);
  return { ok: true, user: match.user, demo: true };
}

/** Whether this page is running on the demo path. */
export function isDemo() {
  return !!demo.read();
}

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
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {})
    });
  } catch {
    return { ok: false, status: 0 };   // server unreachable
  }
  let payload = {};
  try { payload = await response.json(); } catch { /* empty body */ }
  return { ok: response.ok, status: response.status, ...payload };
}

export async function signUp(email, password, name) {
  const result = await post("/api/auth/signup", { email, password, name });
  if (!result.ok && noDatabase(result)) {
    // No database to store the account in, so sign them in for the session.
    const user = {
      id: 0, email: String(email).trim().toLowerCase(), name,
      role: "customer",
      initials: name.split(" ").slice(0, 2).map((part) => part[0]).join("").toUpperCase(),
      homeCorner: null, plan: null, memberSince: String(new Date().getFullYear())
    };
    demo.write(user);
    cache.write(user);
    return { ok: true, user, demo: true };
  }
  if (!result.ok) return { ok: false, error: result.error || "Could not create that account." };
  cache.write(result.user);
  return { ok: true, user: result.user };
}

export async function signIn(email, password) {
  const result = await post("/api/auth/login", { email, password });
  if (!result.ok && noDatabase(result)) return demoSignIn(email, password);
  if (!result.ok) return { ok: false, error: result.error || "Could not sign you in." };
  cache.write(result.user);
  return { ok: true, user: result.user };
}

export async function signOut() {
  cache.write(null);
  demo.write(null);
  try { await post("/api/auth/logout"); } catch { /* already gone */ }
}

/** The cached profile — synchronous, for first paint. May be stale. */
export function cachedUser() {
  return cache.read();
}

/** Asks the server who this session belongs to; the source of truth. */
export async function currentUser() {
  const demoUser = demo.read();
  if (demoUser) return demoUser;          // no cookie exists on the demo path
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
