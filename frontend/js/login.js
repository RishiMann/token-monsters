/** Sign-in page wiring. See auth.js — this is prototype auth, not a security boundary. */

import { DEMO_ACCOUNTS, signIn, getSession, homeFor } from "./auth.js";

const $ = (sel) => document.querySelector(sel);
const form = $("[data-login-form]");
const errorEl = $("[data-error]");
const emailInput = $("#email");
const passwordInput = $("#password");

/** Honour ?next= so a redirected visitor lands where they were headed. */
const params = new URLSearchParams(location.search);
const requestedNext = params.get("next");

const safeNext = (session) => {
  // Only same-page relative targets — never an absolute or protocol-relative URL.
  if (requestedNext && /^[\w.-]+\.html$/.test(requestedNext)) return requestedNext;
  return homeFor(session);
};

// Already signed in? Skip the form.
const existing = getSession();
if (existing) location.replace(safeNext(existing));

let selectedRole = "customer";

document.querySelectorAll("[data-role]").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-role]").forEach((b) => b.classList.remove("is-active"));
    button.classList.add("is-active");
    selectedRole = button.dataset.role;
  })
);

document.querySelectorAll("[data-fill]").forEach((row) =>
  row.querySelector("button").addEventListener("click", () => {
    const account = DEMO_ACCOUNTS.find((a) => a.role === row.dataset.fill);
    if (!account) return;
    emailInput.value = account.email;
    passwordInput.value = account.password;
    document.querySelector(`[data-role="${account.role}"]`)?.click();
    errorEl.hidden = true;
    passwordInput.focus();
  })
);

const fail = (message) => {
  errorEl.textContent = message;
  errorEl.hidden = false;
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorEl.hidden = true;

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) return fail("Enter your email and password.");

  const result = signIn(email, password);
  if (!result.ok) return fail(result.error);

  // The toggle is a hint, not a gate — the account's own role decides.
  if (result.session.role !== selectedRole) {
    fail(
      result.session.role === "admin"
        ? "That's a Franchise & HQ account — switch the toggle above."
        : "That's a customer account — switch the toggle above."
    );
    return;
  }

  location.assign(safeNext(result.session));
});
