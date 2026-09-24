/** Customer profile, rendered from /api/me. */

import { requireRole, signOut, isDemo } from "./auth.js";
import { demoProfile } from "./demo-data.js";
import { initTracker } from "./orders.js";

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

  const menu = [
    ...(storefront.weeklyMenu || []), ...(storefront.plantBased || []),
    ...(storefront.eventMenus || []).flatMap((m) => m.items || [])
  ];
  const byId = (id) => menu.find((i) => i.id === id);

  renderFavorites(me.history?.favorites || [], byId);
  renderOrders(me.orders || [], byId);
  renderPreferences(me.preferences || {});

  // Orders still moving through the corner, as live cards; the list below
  // re-reads itself whenever one of them changes status.
  if (!isDemo()) {
    initTracker($("[data-order-cards]"), {
      section: $("[data-tracker-panel]"),
      compact: true,
      onToast: async (message) => {
        toast(message);
        const fresh = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null);
        if (fresh && !fresh.error) renderOrders(fresh.orders || [], byId);
      }
    });
  }
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

const SHOW_ORDERS = 3;
let ordersExpanded = false;

function renderOrders(orders, byId) {
  const wrap = $("[data-orders]");
  if (!orders.length) {
    wrap.innerHTML = `<p class="empty">No boxes yet.</p>`;
    return;
  }
  const row = (order) => {
    const names = (order.items || []).map((line) => {
      const name = line.name || byId(line.id)?.name;
      return name ? `${name}${line.quantity > 1 ? ` ×${line.quantity}` : ""}` : null;
    }).filter(Boolean);
    const status = (order.status || "fulfilled").replace(/_/g, "-");
    const label = order.statusLabel || order.channel || "";
    const where = [order.fulfillment, order.location?.name].filter(Boolean).join(" · ");
    return `
      <article class="order-row${order.active ? " is-active" : ""}">
        <div class="order-row-top">
          <span class="order-date">${esc(order.date)} <small>#${esc(order.id)}</small></span>
          ${order.total != null ? `<span class="order-total">${money(order.total)}</span>` : ""}
          <span class="order-pill status-${esc(status)}">${esc(label)}</span>
        </div>
        <p class="order-items">${esc(names.join(" · ")) || "—"}</p>
        ${where ? `<small class="order-where">${esc(where)}</small>` : ""}
      </article>`;
  };
  // Three at a glance; the rest behind "View more" so the page stays short.
  const shown = ordersExpanded ? orders : orders.slice(0, SHOW_ORDERS);
  const hidden = orders.length - SHOW_ORDERS;
  wrap.innerHTML = shown.map(row).join("") + (hidden > 0 ? `
    <button class="chip order-more" type="button" data-orders-more aria-expanded="${ordersExpanded}">
      ${ordersExpanded ? "Show fewer" : `View ${hidden} more`}
    </button>` : "");
  wrap.querySelector("[data-orders-more]")?.addEventListener("click", () => {
    ordersExpanded = !ordersExpanded;
    renderOrders(orders, byId);
  });
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
