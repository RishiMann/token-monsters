/** Customer profile, rendered from /api/me. */

import { requireRole, signOut, isDemo } from "./auth.js";
import { demoProfile } from "./demo-data.js";

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

function toast(message) {
  const el = $("[data-toast]");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("is-visible"), 2400);
}

async function boot() {
  const user = await requireRole("customer");
  if (!user) return;

  $("[data-signout]").addEventListener("click", async () => {
    await signOut();
    location.assign("login.html");
  });

  $("[data-initials]").textContent = user.initials;
  $("[data-name]").textContent = user.name;
  $("[data-session-chip]").textContent = user.email;
  $("[data-sub]").textContent = [
    user.plan, user.homeCorner && `home corner ${user.homeCorner}`,
    user.memberSince && `member since ${user.memberSince}`
  ].filter(Boolean).join(" · ") || "New member";

  const [fetched, storefront] = await Promise.all([
    isDemo()
      ? null
      : fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null),
    fetch("/api/storefront").then((r) => r.json()).catch(() => ({}))
  ]);

  // Without a database the server cannot answer, so the demo profile stands in.
  const me = (!fetched || fetched.error) ? demoProfile(user) : fetched;

  if (!me || me.error) {
    $("[data-favorites]").innerHTML = `<p class="empty">Your account data is unavailable right now.</p>`;
    return;
  }

  const menu = [...(storefront.weeklyMenu || []), ...(storefront.plantBased || [])];
  const byId = (id) => menu.find((i) => i.id === id);

  renderFavorites(me.history?.favorites || [], byId);
  renderOrders(me.orders || [], byId);
  renderPreferences(me.preferences || {});
}

function renderFavorites(favorites, byId) {
  const wrap = $("[data-favorites]");
  if (!favorites.length) {
    wrap.innerHTML = `<p class="empty">Order a few boxes and your favorites will appear here.</p>`;
    return;
  }
  const top = favorites[0].units || 1;
  wrap.innerHTML = favorites.map((fav, index) => {
    const item = byId(fav.id) || {};
    return `
      <article class="favorite tint-${esc(item.tint || "pink")}">
        <span class="favorite-rank">${index + 1}</span>
        <span class="favorite-emoji" aria-hidden="true">${esc(item.emoji || "")}</span>
        <div class="favorite-body">
          <strong>${esc(fav.name)}</strong>
          <small>${esc(item.blurb || `last ordered ${fav.last_ordered}`)}</small>
          <div class="favorite-meter"><i style="width:${Math.round((fav.units / top) * 100)}%"></i></div>
        </div>
        <div class="favorite-meta">
          <span class="favorite-count">${esc(fav.units)}×</span>
          <span class="favorite-price">${item.price ? money(item.price) : ""}</span>
        </div>
      </article>`;
  }).join("");
}

function renderOrders(orders, byId) {
  const wrap = $("[data-orders]");
  if (!orders.length) {
    wrap.innerHTML = `<p class="empty">No boxes yet.</p>`;
    return;
  }
  wrap.innerHTML = orders.map((order) => {
    const names = (order.items || []).map((line) => {
      const item = byId(line.id);
      return item ? `${item.name}${line.quantity > 1 ? ` ×${line.quantity}` : ""}` : null;
    }).filter(Boolean);
    return `
      <article class="order-row">
        <div class="order-date">${esc(order.date)}</div>
        <div class="order-items">${esc(names.join(" · ")) || "—"}</div>
        <span class="chip">${esc(order.channel)}</span>
      </article>`;
  }).join("");
}

function renderPreferences(prefs) {
  const wrap = $("[data-event]");
  const saved = prefs.saved_event ? prefs.saved_event.split("|") : null;
  const rows = Object.entries(prefs)
    .filter(([key]) => !["saved_event"].includes(key))
    .map(([key, value]) => `
      <div class="pref-row"><span>${esc(key.replace(/_/g, " "))}</span><strong>${esc(value || "—")}</strong></div>`)
    .join("");

  wrap.innerHTML = `
    ${saved ? `
      <div class="event-saved">
        <div><strong>${esc(saved[0])}</strong><small>${esc(saved[1])} guests · ${esc(saved[2])}</small></div>
        <a class="button button-ghost" href="index.html#party">Plan it <span aria-hidden="true">→</span></a>
      </div>` : ""}
    <div class="pref-list">${rows || '<p class="empty">No preferences saved yet.</p>'}</div>`;
}

boot();
