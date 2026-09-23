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
    $("[data-offers]").innerHTML = `<p class="empty">Your account data is unavailable right now.</p>`;
    return;
  }

  const menu = [...(storefront.weeklyMenu || []), ...(storefront.plantBased || [])];
  const byId = (id) => menu.find((i) => i.id === id);

  renderStats(me, menu);
  renderOffers(me.offers || []);
  renderFavorites(me.history?.favorites || [], byId);
  renderOrders(me.orders || [], byId);
  renderPreferences(me.preferences || {});
}

function renderStats(me, menu) {
  const orders = me.orders || [];
  const treats = orders.reduce((sum, o) => sum + (o.items || []).reduce((n, i) => n + (i.quantity || 1), 0), 0);
  const spend = orders.reduce((sum, o) => sum + (o.items || []).reduce((n, i) => {
    const item = menu.find((m) => m.id === i.id);
    return n + (item ? item.price * (i.quantity || 1) : 0);
  }, 0), 0);

  $("[data-stats]").innerHTML = [
    { value: me.history?.order_count ?? orders.length, label: "boxes ordered" },
    { value: treats, label: "treats total" },
    { value: money(spend), label: "spend on record" },
    { value: me.preferences?.repeat_pattern || "—", label: "your rhythm" }
  ].map((s) => `<div class="stat"><strong>${esc(s.value)}</strong><small>${esc(s.label)}</small></div>`).join("");
}

function renderOffers(offers) {
  const wrap = $("[data-offers]");
  if (!offers.length) {
    wrap.innerHTML = `<p class="empty">No offers yet — order a box and they'll start showing up.</p>`;
    return;
  }
  wrap.innerHTML = offers.map((offer) => `
    <article class="offer-row tint-${esc(offer.tint || "gold")}">
      <span class="offer-row-emoji" aria-hidden="true">${esc(offer.emoji || "◎")}</span>
      <div class="offer-row-body">
        <span class="offer-label">${esc(offer.label)}</span>
        <strong>${esc(offer.title)}</strong>
        <p>${esc(offer.detail)}</p>
        <p class="offer-why"><strong>Why you:</strong> ${esc(offer.eligibility || offer.reason)}</p>
      </div>
      <div class="offer-row-act">
        <span class="offer-value">${esc(offer.value)}</span>
        <button class="chip" type="button" data-claim="${esc(offer.title)}">Apply</button>
      </div>
    </article>`).join("");

  wrap.querySelectorAll("[data-claim]").forEach((b) =>
    b.addEventListener("click", () => {
      b.textContent = "Applied ✓"; b.classList.add("is-active");
      toast(`${b.dataset.claim} applied to your next box`);
    })
  );
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
