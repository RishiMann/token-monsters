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
const POLL_MS = 10000;
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");

async function loadOperations() {
  return fetch("/api/operations", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

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

  const fetched = await loadOperations();

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
    document.querySelectorAll("[data-live], [data-board-live]").forEach((el) => { el.hidden = false; });
    setInterval(async () => {
      if (document.hidden) return;
      const next = await loadOperations();
      if (next && !next.error) render(next);
    }, POLL_MS);
  }

  // Supply orders: approve a draft, ship and deliver, or drop a draft.
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-supply]");
    if (!button) return;
    const id = button.dataset.supplyId;
    const verb = button.dataset.supply;
    button.disabled = true;
    const response = await fetch(`/api/supply/${id}/${verb}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: "{}"
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) { button.disabled = false; return toast(payload.error || "That change did not go through"); }
    toast({ approve: `${id} sent to HQ`, ship: `${id} is on its way`, deliver: `${id} delivered — stock is on the shelf`, dismiss: `${id} set aside` }[verb]);
    const next = await loadOperations();
    if (next && !next.error) render(next);
  });

  // Moving an order along, or cancelling it, then re-reading everything so
  // the stock rows show what came back.
  $("[data-board]").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-advance], [data-cancel]");
    if (!button) return;
    const id = button.dataset.advance || button.dataset.cancel;
    const verb = button.dataset.advance ? "advance" : "cancel";
    button.disabled = true;
    const response = await fetch(`/api/orders/${id}/${verb}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: "{}"
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) {
      button.disabled = false;
      return toast(payload.error || "That change did not go through");
    }
    toast(`Order #${id} → ${payload.order.statusLabel.toLowerCase()}`);
    const next = await loadOperations();
    if (next && !next.error) render(next);
  });
}

function render(ops) {
  renderBoard(ops.orders);
  renderReplenishment(ops.replenishment);
  renderInventory(ops.inventory || []);
  renderLocations(ops.locations || []);
  renderSupply(ops.replenishment?.orders || ops.supplyOrders || []);
  renderSales({ ...(ops.insights || {}), channels: ops.orders?.channels }, ops.weekly || []);
  const stamp = `Live · updated ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  document.querySelectorAll("[data-live], [data-board-live]").forEach((el) => { el.textContent = stamp; });
}

const FULFILLMENT = { pickup: "Pickup", delivery: "Delivery" };

/* ── Replenishment: the inventory agent's forecast and drafts ── */
const FORECAST_LABEL = { order_now: "Order now", soon: "Order this cycle", inbound: "Order inbound", ok: "Covered" };
const FORECAST_PILL = { order_now: "critical", soon: "low", inbound: "inbound", ok: "ok" };
const qty = (n, unit) => `${Number(n) % 1 === 0 ? Number(n) : Number(n).toFixed(2)} ${unit}`;

function renderReplenishment(rep) {
  const panel = $("[data-replenishment-panel]");
  if (!panel) return;
  if (!rep) {
    panel.hidden = true;                       // demo figures have no sales to forecast from
    return;
  }
  panel.hidden = false;
  const drafts = rep.drafts || [];
  const empty = $("[data-drafts-empty]");
  empty.hidden = drafts.length > 0;
  $("[data-drafts]").innerHTML = drafts.map((d) => `
    <article class="draft-card">
      <div class="draft-head">
        <div>
          <p class="eyebrow">Suggested order · ${esc(d.id)}</p>
          <strong>${esc(d.location.name)}</strong>
          <small>${d.lines.length} line${d.lines.length === 1 ? "" : "s"} · lands by ${esc(d.eta)} if sent today</small>
        </div>
        <strong class="draft-total">${money2(d.total)}</strong>
      </div>
      <ul class="draft-lines">
        ${d.lines.map((l) => `
          <li><span class="draft-qty">${esc(qty(l.quantity, l.unit))}</span> <strong>${esc(l.name)}</strong>
              <small>${esc(l.reason)} · ${money2(l.quantity * l.unitCost)}</small></li>`).join("")}
      </ul>
      <div class="board-actions">
        <button class="chip chip-solid" type="button" data-supply="approve" data-supply-id="${esc(d.id)}">Approve &amp; send to HQ</button>
        <button class="chip" type="button" data-supply="dismiss" data-supply-id="${esc(d.id)}">Not now</button>
      </div>
    </article>`).join("");

  const rows = rep.forecast || [];
  $("[data-forecast]").innerHTML = rows.map((r) => `
    <tr class="${r.status === "ok" ? "is-final" : ""}">
      <td>${esc(r.location.name)}</td>
      <td>${esc(r.name)}<small class="row-sub"><code>${esc(r.sku)}</code></small></td>
      <td class="num">${esc(r.on_hand)} ${esc(r.unit)}${r.on_order ? `<small class="row-sub">+${esc(r.on_order)} on order</small>` : ""}</td>
      <td class="num">${esc(r.burn_per_day)}</td>
      <td class="num">${r.days_of_cover == null ? "—" : esc(r.days_of_cover)}</td>
      <td>${r.stockout_date ? esc(r.stockout_date) : "—"}</td>
      <td class="num">${esc(r.lead_time_days)}d</td>
      <td class="num">${r.suggested_qty ? esc(qty(r.suggested_qty, r.unit)) : "—"}</td>
      <td><span class="pill pill-${FORECAST_PILL[r.status]}">${FORECAST_LABEL[r.status]}</span></td>
    </tr>`).join("");
  const s = rep.summary || {};
  $("[data-forecast-details]").querySelector("summary").textContent =
    `Forecast by corner and ingredient · ${s.order_now || 0} to order now · ${s.soon || 0} this cycle · ${money2(s.inbound_value || 0)} inbound`;
}

function renderBoard(board) {
  const stats = $("[data-board-stats]");
  const body = $("[data-board]");
  const empty = $("[data-board-empty]");
  const count = $("[data-board-count]");
  if (!board) {
    // Demo figures have no orders table.
    stats.innerHTML = "";
    body.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Live orders need the database — this console is showing demo figures.";
    return;
  }
  const orders = board.orders || [];
  const active = orders.filter((o) => o.active);
  const by = board.today?.byStatus || {};
  stats.innerHTML = [
    { value: active.length, label: "in progress now", tone: active.length ? "live" : "" },
    { value: (by.placed || 0), label: "waiting to start", tone: by.placed ? "alert" : "" },
    { value: board.today?.orders || 0, label: "orders today" },
    { value: money2(board.today?.revenue || 0), label: "revenue today" }
  ].map((s) => `
    <div class="stat ${s.tone ? `is-${s.tone}` : ""}"><strong>${esc(s.value)}</strong><small>${esc(s.label)}</small></div>`).join("");
  count.hidden = active.length === 0;
  count.textContent = active.length;
  empty.hidden = orders.length > 0;
  empty.textContent = "Nothing in progress. Place an order on the storefront and it appears here within a few seconds.";

  body.innerHTML = orders.map((order) => `
    <tr class="${order.active ? "" : "is-final"}">
      <td><code>#${esc(order.id)}</code></td>
      <td class="board-when">${esc(clock(order.placedAt))}<small>${order.active && order.promisedAt ? `due ${esc(clock(order.promisedAt))}` : esc(order.date)}</small></td>
      <td class="board-customer">${esc(order.customer)}<small>${order.signedIn ? esc(order.email || "account") : "guest"}${order.note ? ` · “${esc(order.note)}”` : ""}</small></td>
      <td><div class="board-items">${(order.items || []).map((i) => `<span>${i.quantity} × ${esc(i.name)}</span>`).join("")}</div></td>
      <td>${esc(FULFILLMENT[order.fulfillment] || order.fulfillment)}<small class="row-sub">${esc(order.location?.name || "")}${order.window && order.window !== "As soon as possible" ? ` · ${esc(order.window)}` : ""}${order.address ? ` · ${esc(order.address)}` : ""}</small></td>
      <td class="num">${money2(order.total)}</td>
      <td><span class="pill pill-${esc(order.status)}">${esc(order.statusLabel)}</span></td>
      <td><div class="board-actions">
        ${order.nextAction ? `<button class="chip chip-solid" type="button" data-advance="${esc(order.id)}">${esc(order.nextAction)}</button>` : ""}
        ${order.consoleCanCancel ? `<button class="chip" type="button" data-cancel="${esc(order.id)}">Cancel</button>` : ""}
      </div></td>
    </tr>`).join("");
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
        ? `<button class="chip" type="button" data-order="${esc(row.location)}" title="Have the agent draft the order for this corner">Draft order</button>`
        : ""}</td>
    </tr>`).join("");

  $("[data-inventory]").querySelectorAll("[data-order]").forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      const response = await fetch("/api/supply/draft", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", body: JSON.stringify({ location: button.dataset.order })
      }).catch(() => null);
      const payload = response ? await response.json().catch(() => ({})) : {};
      if (!response?.ok) { button.disabled = false; return toast(payload.error || "Could not draft that order"); }
      toast(payload.drafts?.length ? `Draft for ${button.dataset.order} is ready above — approve it to send` : `${button.dataset.order} is covered; nothing to draft`);
      const next = await loadOperations();
      if (next && !next.error) render(next);
      $("[data-replenishment-panel]")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  // Prefer the replenishment service's shape (with lines and actions); the
  // demo figures still arrive in the older flat shape.
  // The rows live in [data-supply-rows]; [data-supply] is the action buttons.
  $("[data-supply-rows]").innerHTML = orders.map((order) => {
    const location = order.location?.name || order.location;
    const lines = Array.isArray(order.lines)
      ? order.lines.map((l) => `${qty(l.quantity, l.unit)} ${l.name}`).join(" · ")
      : `${order.lines} line${order.lines === 1 ? "" : "s"}`;
    const status = order.status;
    return `
    <tr class="${status === "delivered" ? "is-final" : ""}">
      <td><code>${esc(order.id)}</code>${order.source === "agent" ? `<small class="row-sub">by the agent</small>` : ""}</td>
      <td>${esc(location)}</td>
      <td>${esc(order.placed)}</td>
      <td>${esc(order.eta)}</td>
      <td><small>${esc(lines)}</small></td>
      <td class="num">${money2(order.total)}</td>
      <td><span class="pill pill-${status === "delivered" ? "ok" : status === "in-transit" ? "inbound" : "low"}">${esc(order.statusLabel || status.replace("-", " "))}</span></td>
      <td>${order.nextAction
        ? `<button class="chip" type="button" data-supply="${esc(order.nextAction)}" data-supply-id="${esc(order.id)}">${esc(order.nextLabel)}</button>` : ""}</td>
    </tr>`;
  }).join("");
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

  const channels = (sales.channels || []);
  const topChannel = Math.max(...channels.map((c) => c.orders), 1);
  $("[data-channels]").innerHTML = channels.length
    ? channels.map((c) => `
      <div class="rank-row">
        <div class="rank-head"><span>${esc(c.channel)}</span><span>${esc(c.orders)} orders</span></div>
        <div class="rank-bar"><i style="width:${Math.round((c.orders / topChannel) * 100)}%"></i></div>
      </div>`).join("")
    : `<p class="empty">No orders in the last 7 days.</p>`;

  renderWatchouts();
}

boot();
