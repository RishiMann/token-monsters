/** Sign-in and sign-up. Credentials go to the server; nothing is checked here. */

import { signIn, signUp, currentUser, homeFor } from "./auth.js";

const $ = (sel) => document.querySelector(sel);
const form = $("[data-login-form]");
const errorEl = $("[data-error]");
const emailInput = $("#email");
const passwordInput = $("#password");
const nameInput = $("#name");
const nameField = $("[data-name-field]");
const submit = $("[data-submit]");
const hint = $("[data-hint]");

const safeNext = (user) => homeFor(user);

let mode = "signin";
let selectedRole = "customer";

const fail = (message) => {
  errorEl.textContent = message;
  errorEl.hidden = false;
};

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  document.querySelectorAll("[data-mode]").forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  nameField.hidden = !signup;
  nameInput.required = signup;
  hint.hidden = !signup;
  submit.textContent = signup ? "Create account" : "Sign in";
  $("[data-heading]").textContent = signup ? "Make an account" : "Welcome back";
  $("[data-lede]").textContent = signup
    ? "Your box history and preferences are saved to your account."
    : "Sign in to see your offers, favorites and box history.";
  // Role choice only applies to sign-in; new accounts are always customers.
  document.querySelector(".role-toggle").hidden = signup;
  errorEl.hidden = true;
}

document.querySelectorAll("[data-mode]").forEach((tab) =>
  tab.addEventListener("click", () => setMode(tab.dataset.mode))
);

document.querySelectorAll("[data-role]").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-role]").forEach((b) => b.classList.remove("is-active"));
    button.classList.add("is-active");
    selectedRole = button.dataset.role;
  })
);

document.querySelectorAll("[data-fill]").forEach((row) =>
  row.querySelector("button").addEventListener("click", () => {
    const admin = row.dataset.fill === "admin";
    setMode("signin");
    emailInput.value = admin ? "hq@frostedcorner.com" : "alex@frostedcorner.com";
    passwordInput.value = admin ? "admin" : "treat";
    document.querySelector(`[data-role="${row.dataset.fill}"]`)?.click();
    passwordInput.focus();
  })
);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.hidden = true;

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) return fail("Enter your email and password.");

  submit.disabled = true;
  const original = submit.textContent;
  submit.textContent = mode === "signup" ? "Creating…" : "Signing in…";

  const result = mode === "signup"
    ? await signUp(email, password, nameInput.value.trim())
    : await signIn(email, password);

  submit.disabled = false;
  submit.textContent = original;

  if (!result.ok) return fail(result.error);

  // The toggle is a hint; the account's own role decides where they land.
  if (mode === "signin" && result.user.role !== selectedRole) {
    return fail(
      result.user.role === "admin"
        ? "That's a Franchise & HQ account — switch the toggle above."
        : "That's a customer account — switch the toggle above."
    );
  }

  location.assign(safeNext(result.user));
});

// Already signed in? Skip the form.
currentUser().then((user) => { if (user) location.replace(safeNext(user)); });
