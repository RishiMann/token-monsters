/**
 * DEMO AUTHENTICATION — PROTOTYPE ONLY.
 *
 * This is not a security boundary. Credentials are compared in the browser
 * against the list below, and the session is a sessionStorage flag, so anyone
 * can grant themselves the admin role from devtools. It exists so the MVP can
 * demonstrate the two role-based experiences the brief calls for.
 *
 * Before this goes anywhere real, replace it with Microsoft Entra ID (the app
 * already runs on Azure App Service, which has built-in auth) and move every
 * admin data source behind a server-side role check. `/api/operations` is
 * currently readable by anyone who knows the URL.
 */

const SESSION_KEY = "fc.session";

/** Demo accounts, shown on the sign-in page on purpose. */
export const DEMO_ACCOUNTS = [
  {
    email: "alex@frostedcorner.com",
    password: "treat",
    role: "customer",
    name: "Alex Rivera",
    initials: "AR",
    homeCorner: "Frisco Corner",
    memberSince: "2024",
    plan: "The Table"
  },
  {
    email: "hq@frostedcorner.com",
    password: "admin",
    role: "admin",
    name: "Morgan Sato",
    initials: "MS",
    title: "Franchise Operations, HQ",
    scope: "All 40+ corners"
  }
];

export function signIn(email, password) {
  const account = DEMO_ACCOUNTS.find(
    (candidate) =>
      candidate.email.toLowerCase() === String(email).trim().toLowerCase() &&
      candidate.password === password
  );
  if (!account) return { ok: false, error: "We don't recognize that email and password." };

  const { password: _omit, ...session } = account;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private browsing can refuse storage; the caller still gets the session.
  }
  return { ok: true, session };
}

export function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

export function signOut() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * Redirects to the sign-in page when the visitor lacks the role.
 * A convenience for the prototype's page flow — not access control.
 */
export function requireRole(role) {
  const session = getSession();
  if (!session || (role && session.role !== role)) {
    const next = encodeURIComponent(location.pathname.replace(/^\//, ""));
    location.replace(`login.html?next=${next}`);
    return null;
  }
  return session;
}

export function homeFor(session) {
  return session?.role === "admin" ? "admin.html" : "account.html";
}
