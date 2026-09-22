/** Franchise & HQ console: inventory and supplies, plus order and sales insights. */

import { requireRole, signOut } from "./auth.js";

const session = requireRole("admin");

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
  $("[data-signout]").addEventListener("click", () => {
    signOut();
    location.assign("login.html");
  });

  $("[data-initials]").textContent = session.initials;
  $("[data-name]").textContent = session.name;
  $("[data-sub]").textContent = `${session.title} · ${session.scope}`;
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

  const ops = await fetch("/api/operations").then((r) => r.json()).catch(() => null);
  if (!ops) {
    document.querySelector(".account-shell").insertAdjacentHTML(
      "beforeend",
      `<p class="empty">Operations data is unavailable right now.</p>`
    );
    return;
  }

  renderInventory(ops.inventory || []);
  renderLocations(ops.locations || []);
  renderSupply(ops.supplyOrders || []);
  renderSales(ops.salesInsights || {});
}

function renderInventory(inventory) {
  const rows = inventory.map((row) => ({ ...row, status: stockStatus(row) }));
  const needsOrder = rows.filter((r) => r.status === "critical").length;
  const inbound = rows.filter((r) => r.status === "inbound").length;
  const slowest = rows.reduce((max, r) => Math.max(max, r.leadTimeDays), 0);

  $("[data-inv-stats]").innerHTML = [
    { value: rows.length, label: "tracked SKUs" },
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
      <td>${esc(row.name)}</td>
      <td class="num">${esc(row.onHand)} ${esc(row.unit)}</td>
      <td class="num">${esc(row.reorderPoint)}</td>
      <td class="num">${row.onOrder ? esc(row.onOrder) : "—"}</td>
      <td class="num">${esc(row.leadTimeDays)}d</td>
      <td><span class="pill pill-${row.status}">${STATUS_LABEL[row.status]}</span></td>
      <td>${
        row.status === "critical"
          ? `<button class="chip" type="button" data-order="${esc(row.name)}">Order</button>`
          : ""
      }</td>
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
    <article class="location-card status-${esc(loc.status)}">
      <div class="location-top">
        <strong>${esc(loc.name)}</strong>
        <span class="pill pill-${esc(loc.status === "healthy" ? "ok" : loc.status === "watch" ? "low" : "critical")}">${esc(loc.status)}</span>
      </div>
      <small>${esc(loc.region)}</small>
      <div class="location-stats">
        <div><strong>${esc(loc.ordersWeek)}</strong><small>orders</small></div>
        <div><strong>${money0(loc.revenueWeek)}</strong><small>revenue ${delta(loc.change)}</small></div>
      </div>
      <div class="health">
        <div class="health-bar"><i style="width:${Number(loc.stockHealth)}%"></i></div>
        <small>${esc(loc.stockHealth)}% stock health</small>
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

function renderSales(sales) {
  $("[data-sales-stats]").innerHTML = [
    { value: money0(sales.revenueWeek), label: `revenue this week ${delta(sales.revenueChange)}` },
    { value: Number(sales.ordersWeek || 0).toLocaleString(), label: `orders ${delta(sales.ordersChange)}` },
    { value: money2(sales.avgBasket || 0), label: `average basket ${delta(sales.avgBasketChange)}` },
    { value: Number(sales.subscriberCount || 0).toLocaleString(), label: `subscribers ${delta(sales.subscriberChange)}` }
  ].map((s) => `<div class="stat"><strong>${s.value}</strong><small>${s.label}</small></div>`).join("");

  const weeks = sales.weekly || [];
  const peak = Math.max(...weeks.map((w) => w.revenue), 1);
  $("[data-revenue-chart]").innerHTML = weeks.map((week) => `
    <div class="bar-col">
      <div class="bar" style="height:${Math.round((week.revenue / peak) * 100)}%">
        <span class="bar-value">${money0(week.revenue)}</span>
      </div>
      <small>${esc(week.label)}</small>
    </div>`).join("");

  const topUnits = Math.max(...(sales.topFlavors || []).map((f) => f.units), 1);
  $("[data-top-flavors]").innerHTML = (sales.topFlavors || []).map((flavor) => `
    <div class="rank-row">
      <div class="rank-head"><span>${esc(flavor.name)}</span><span>${esc(flavor.units)} units</span></div>
      <div class="rank-bar"><i style="width:${Math.round((flavor.units / topUnits) * 100)}%"></i></div>
    </div>`).join("");

  const topRegion = Math.max(...(sales.regions || []).map((r) => r.revenue), 1);
  $("[data-regions]").innerHTML = (sales.regions || []).map((region) => `
    <div class="rank-row">
      <div class="rank-head"><span>${esc(region.name)}</span><span>${money0(region.revenue)} ${delta(region.change)}</span></div>
      <div class="rank-bar"><i style="width:${Math.round((region.revenue / topRegion) * 100)}%"></i></div>
    </div>`).join("");

  $("[data-channels]").innerHTML = (sales.channelMix || []).map((channel) => `
    <div class="rank-row">
      <div class="rank-head"><span>${esc(channel.channel)}</span><span>${esc(channel.share)}%</span></div>
      <div class="rank-bar"><i style="width:${Number(channel.share)}%"></i></div>
    </div>`).join("");

  $("[data-watchouts]").innerHTML = (sales.watchouts || [])
    .map((note) => `<li>${esc(note)}</li>`).join("");
}

// Start only once every const below has initialized.
if (session) boot();
