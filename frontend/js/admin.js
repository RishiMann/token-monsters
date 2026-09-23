/** Franchise & HQ console: inventory and supplies, plus order and sales insights. */

import { requireRole, signOut } from "./auth.js";
import { demoOperations } from "./demo-data.js";


const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money0 = (n) => `$${Math.round(Number(n)).toLocaleString()}`;
const money2 = (n) => `$${Number(n).toFixed(2)}`;
const delta = (n) =>
  `<span class="delta ${n < 0 ? "is-down" : "is-up"}">${n < 0 ? "▼" : "▲"} ${Math.abs(n)}%</span>`;

function toast(message) {
  const el = $("[data-toast]");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("is-visible"), 2600);
}

/** Below the reorder point is critical unless replenishment is already inbound. */
function stockStatus(row) {
  if (row.onHand <= row.reorderPoint) return row.onOrder > 0 ? "inbound" : "critical";
  if (row.onHand <= row.reorderPoint * 1.25) return "low";
  return "ok";
}

const STATUS_LABEL = { ok: "Healthy", low: "Getting low", inbound: "Order inbound", critical: "Below reorder point" };

async function boot() {
  const session = await requireRole("admin");
  if (!session) return;

  $("[data-signout]").addEventListener("click", async () => {
    await signOut();
    location.assign("login.html");
  });

  $("[data-initials]").textContent = session.initials;
  $("[data-name]").textContent = session.name;
  $("[data-sub]").textContent = "Franchise Operations, HQ · all corners";
  $("[data-session-chip]").textContent = session.email;

  document.querySelectorAll("[data-tab]").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      document.querySelectorAll("[data-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      });
    })
  );

  const fetched = await fetch("/api/operations", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // Without a database the server cannot answer, so demo figures stand in.
  const ops = (!fetched || fetched.error) ? demoOperations() : fetched;

  if (!ops || ops.error) {
    document.querySelector(".account-shell").insertAdjacentHTML(
      "beforeend",
      `<p class="empty">Operations data is unavailable right now.</p>`
    );
    return;
  }

  render(ops);

  // Stock moves with every order placed on the storefront, so keep the console
  // current while it is open. Demo figures are static, so only poll the real thing.
  if (fetched && !fetched.error) {
    const live = $("[data-live]");
    if (live) live.hidden = false;
    setInterval(async () => {
      const next = await fetch("/api/operations", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (next && !next.error) render(next);
    }, 15000);
  }
}

function render(ops) {
  renderInventory(ops.inventory || []);
  renderLocations(ops.locations || []);
  renderSupply(ops.supplyOrders || []);
  renderSales(ops.insights || {}, ops.weekly || []);
  const live = $("[data-live]");
  if (live) live.textContent = `Live · updated ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

let LOW_STOCK = [];

function renderInventory(rows) {
  LOW_STOCK = rows.filter((r) => r.status === "critical" || r.status === "inbound");
  const needsOrder = rows.filter((r) => r.status === "critical").length;
  const inbound = rows.filter((r) => r.status === "inbound").length;
  const slowest = rows.reduce((max, r) => Math.max(max, r.lead_time_days || 0), 0);

  $("[data-inv-stats]").innerHTML = [
    { value: rows.length, label: "tracked stock rows" },
    { value: needsOrder, label: "need ordering now", tone: needsOrder ? "alert" : "" },
    { value: inbound, label: "replenishment inbound" },
    { value: `${slowest}d`, label: "longest lead time" }
  ].map((s) => `
    <div class="stat ${s.tone ? "is-alert" : ""}">
      <strong>${esc(s.value)}</strong><small>${esc(s.label)}</small>
    </div>`).join("");

  $("[data-inventory]").innerHTML = rows.map((row) => `
    <tr>
      <td><code>${esc(row.sku)}</code></td>
      <td>${esc(row.name)}<small class="row-sub">${esc(row.location)}</small></td>
      <td class="num">${esc(row.on_hand)} ${esc(row.unit)}</td>
      <td class="num">${esc(row.reorder_point)}</td>
      <td class="num">${row.on_order ? esc(row.on_order) : "—"}</td>
      <td class="num">${esc(row.lead_time_days)}d</td>
      <td><span class="pill pill-${row.status}">${STATUS_LABEL[row.status]}</span></td>
      <td>${row.status === "critical"
        ? `<button class="chip" type="button" data-order="${esc(row.name)} at ${esc(row.location)}">Order</button>`
        : ""}</td>
    </tr>`).join("");

  $("[data-inventory]").querySelectorAll("[data-order]").forEach((button) =>
    button.addEventListener("click", () => {
      button.textContent = "Requested ✓";
      button.classList.add("is-active");
      button.disabled = true;
      toast(`Supply request for ${button.dataset.order} sent to HQ`);
    })
  );
}

function renderLocations(locations) {
  $("[data-locations]").innerHTML = locations.map((loc) => `
    <article class="location-card status-${Number(loc.stock_health) < 50 ? "critical" : Number(loc.stock_health) < 85 ? "watch" : "healthy"}">
      <div class="location-top">
        <strong>${esc(loc.name)}</strong>
        <span class="pill pill-${Number(loc.stock_health) < 50 ? "critical" : Number(loc.stock_health) < 85 ? "low" : "ok"}">${Number(loc.stock_health) < 50 ? "critical" : Number(loc.stock_health) < 85 ? "watch" : "healthy"}</span>
      </div>
      <small>${esc(loc.region)}</small>
      <div class="location-stats">
        <div><strong>${esc(loc.orders_week)}</strong><small>orders</small></div>
        <div><strong>${money0(loc.revenue_week)}</strong><small>revenue ${delta(loc.change_pct)}</small></div>
      </div>
      <div class="health">
        <div class="health-bar"><i style="width:${Number(loc.stock_health)}%"></i></div>
        <small>${esc(loc.stock_health)}% stock health</small>
      </div>
    </article>`).join("");
}

function renderSupply(orders) {
  $("[data-supply]").innerHTML = orders.map((order) => `
    <tr>
      <td><code>${esc(order.id)}</code></td>
      <td>${esc(order.location)}</td>
      <td>${esc(order.placed)}</td>
      <td>${esc(order.eta)}</td>
      <td class="num">${esc(order.lines)}</td>
      <td class="num">${money2(order.total)}</td>
      <td><span class="pill pill-${order.status === "delivered" ? "ok" : order.status === "in-transit" ? "inbound" : "low"}">${esc(order.status.replace("-", " "))}</span></td>
    </tr>`).join("");
}

/** Watch-outs are computed from the stock rows already on the page. */
function renderWatchouts() {
  const notes = LOW_STOCK.slice(0, 4).map((row) =>
    `${row.location}: ${row.name} at ${row.on_hand} ${row.unit}, reorder point ${row.reorder_point}` +
    (row.on_order ? ` (${row.on_order} inbound)` : `, nothing on order, ${row.lead_time_days}-day lead time`)
  );
  $("[data-watchouts]").innerHTML = notes.length
    ? notes.map((note) => `<li>${esc(note)}</li>`).join("")
    : `<li>Nothing below reorder point across the network.</li>`;
}

function renderSales(sales, weekly) {
  $("[data-sales-stats]").innerHTML = [
    { value: money0(sales.revenue), label: `revenue, last ${sales.window_days || 7} days ${sales.revenue_change_pct != null ? delta(sales.revenue_change_pct) : ""}` },
    { value: Number(sales.orders || 0).toLocaleString(), label: "orders in window" },
    { value: money0((sales.revenue || 0) / Math.max(sales.orders || 1, 1)), label: "average basket" },
    { value: (sales.by_region || []).length, label: "regions reporting" }
  ].map((s) => `<div class="stat"><strong>${s.value}</strong><small>${s.label}</small></div>`).join("");

  const peak = Math.max(...weekly.map((w) => Number(w.revenue)), 1);
  $("[data-revenue-chart]").innerHTML = weekly.map((week) => `
    <div class="bar-col">
      <div class="bar" style="height:${Math.round((Number(week.revenue) / peak) * 100)}%">
        <span class="bar-value">${money0(week.revenue)}</span>
      </div>
      <small>${esc(week.label)}</small>
    </div>`).join("");

  const topUnits = Math.max(...(sales.top_items || []).map((f) => f.units), 1);
  $("[data-top-flavors]").innerHTML = (sales.top_items || []).map((flavor) => `
    <div class="rank-row">
      <div class="rank-head"><span>${esc(flavor.name)}</span><span>${esc(flavor.units)} units</span></div>
      <div class="rank-bar"><i style="width:${Math.round((flavor.units / topUnits) * 100)}%"></i></div>
    </div>`).join("");

  const topRegion = Math.max(...(sales.by_region || []).map((r) => Number(r.revenue)), 1);
  $("[data-regions]").innerHTML = (sales.by_region || []).map((region) => `
    <div class="rank-row">
      <div class="rank-head"><span>${esc(region.region)}</span><span>${money0(region.revenue)}</span></div>
      <div class="rank-bar"><i style="width:${Math.round((Number(region.revenue) / topRegion) * 100)}%"></i></div>
    </div>`).join("");

  $("[data-channels]").innerHTML = `<p class="empty">Channel mix moves to the orders table next.</p>`;

  renderWatchouts();
}

boot();
