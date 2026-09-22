/** Customer profile: offers, favorites, recent boxes and the saved event. */

import { requireRole, signOut } from "./auth.js";

const session = requireRole("customer");

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => `$${Number(n).toFixed(2)}`;

function toast(message) {
  const el = $("[data-toast]");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("is-visible"), 2400);
}

async function boot() {
  $("[data-signout]").addEventListener("click", () => {
    signOut();
    location.assign("login.html");
  });

  $("[data-initials]").textContent = session.initials;
  $("[data-name]").textContent = session.name;
  $("[data-sub]").textContent =
    `${session.plan} · home corner ${session.homeCorner} · member since ${session.memberSince}`;
  $("[data-session-chip]").textContent = session.email;

  const [storefront, context] = await Promise.all([
    fetch("/api/storefront").then((r) => r.json()).catch(() => ({})),
    fetch("/api/context").then((r) => r.json()).catch(() => ({}))
  ]);

  const menu = [...(storefront.weeklyMenu || []), ...(storefront.plantBased || [])];
  const byId = (id) => menu.find((item) => item.id === id);
  const orders = context.orderHistory || [];

  renderStats(orders, menu, context);
  renderOffers(storefront.smartOffers || []);
  renderFavorites(orders, byId);
  renderOrders(orders, byId);
  renderEvent(context.customer?.savedEvent);
}

function renderStats(orders, menu, context) {
  const treats = orders.reduce(
    (sum, order) => sum + (order.items || []).reduce((n, i) => n + (i.quantity || 1), 0), 0
  );
  const spend = orders.reduce((sum, order) => {
    return sum + (order.items || []).reduce((n, i) => {
      const item = menu.find((m) => m.id === i.id);
      return n + (item ? item.price * (i.quantity || 1) : 0);
    }, 0);
  }, 0);

  const stats = [
    { value: orders.length, label: "boxes ordered" },
    { value: treats, label: "treats total" },
    { value: money(spend), label: "lifetime spend" },
    { value: context.customer?.repeatPattern || "—", label: "your rhythm" }
  ];

  $("[data-stats]").innerHTML = stats.map((s) => `
    <div class="stat">
      <strong>${esc(s.value)}</strong>
      <small>${esc(s.label)}</small>
    </div>`).join("");
}

function renderOffers(offers) {
  const wrap = $("[data-offers]");
  if (!offers.length) {
    wrap.innerHTML = `<p class="empty">No offers right now — order a box and they'll start showing up.</p>`;
    return;
  }
  wrap.innerHTML = offers.map((offer) => `
    <article class="offer-row tint-${esc(offer.tint || "gold")}">
      <span class="offer-row-emoji" aria-hidden="true">${esc(offer.emoji || "◎")}</span>
      <div class="offer-row-body">
        <span class="offer-label">${esc(offer.label)}</span>
        <strong>${esc(offer.title)}</strong>
        <p>${esc(offer.detail)}</p>
        <p class="offer-why"><strong>Why:</strong> ${esc(offer.reason)}</p>
      </div>
      <div class="offer-row-act">
        <span class="offer-value">${esc(offer.value)}</span>
        <button class="chip" type="button" data-claim="${esc(offer.title)}">Apply</button>
      </div>
    </article>`).join("");

  wrap.querySelectorAll("[data-claim]").forEach((button) =>
    button.addEventListener("click", () => {
      button.textContent = "Applied ✓";
      button.classList.add("is-active");
      toast(`${button.dataset.claim} applied to your next box`);
    })
  );
}

function renderFavorites(orders, byId) {
  const counts = new Map();
  orders.forEach((order) =>
    (order.items || []).forEach((line) =>
      counts.set(line.id, (counts.get(line.id) || 0) + (line.quantity || 1))
    )
  );

  const favorites = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([id, qty]) => ({ item: byId(id), qty }))
    .filter(({ item }) => item);

  const wrap = $("[data-favorites]");
  if (!favorites.length) {
    wrap.innerHTML = `<p class="empty">Order a few boxes and your favorites will appear here.</p>`;
    return;
  }

  const top = favorites[0].qty;
  wrap.innerHTML = favorites.map(({ item, qty }, index) => `
    <article class="favorite tint-${esc(item.tint || "pink")}">
      <span class="favorite-rank">${index + 1}</span>
      <span class="favorite-emoji" aria-hidden="true">${esc(item.emoji || "")}</span>
      <div class="favorite-body">
        <strong>${esc(item.name)}</strong>
        <small>${esc(item.blurb || "")}</small>
        <div class="favorite-meter"><i style="width:${Math.round((qty / top) * 100)}%"></i></div>
      </div>
      <div class="favorite-meta">
        <span class="favorite-count">${qty}×</span>
        <span class="favorite-price">${money(item.price)}</span>
      </div>
    </article>`).join("");
}

function renderOrders(orders, byId) {
  const wrap = $("[data-orders]");
  if (!orders.length) {
    wrap.innerHTML = `<p class="empty">No boxes yet.</p>`;
    return;
  }
  wrap.innerHTML = orders.map((order) => {
    const names = (order.items || [])
      .map((line) => {
        const item = byId(line.id);
        return item ? `${item.name}${line.quantity > 1 ? ` ×${line.quantity}` : ""}` : null;
      })
      .filter(Boolean);
    return `
      <article class="order-row">
        <div class="order-date">${esc(order.date || "—")}</div>
        <div class="order-items">${esc(names.join(" · ")) || "—"}</div>
        <button class="chip" type="button" data-reorder="${esc(names[0] || "")}">Reorder</button>
      </article>`;
  }).join("");

  wrap.querySelectorAll("[data-reorder]").forEach((button) =>
    button.addEventListener("click", () => toast("Added to your box — head to the menu to check out"))
  );
}

function renderEvent(event) {
  const wrap = $("[data-event]");
  if (!event) {
    wrap.innerHTML = `<p class="empty">No saved event. The planner can size one for you.</p>`;
    return;
  }
  wrap.innerHTML = `
    <div class="event-saved">
      <div>
        <strong>${esc(event.name)}</strong>
        <small>${esc(event.guests)} guests · ${esc(event.date)}</small>
      </div>
      <a class="button button-ghost" href="index.html#party">Plan it <span aria-hidden="true">→</span></a>
    </div>`;
}

// Start only once every const below has initialized.
if (session) boot();
