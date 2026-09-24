/**
 * Following an order after checkout.
 *
 * The server owns the order and its status; this module remembers which
 * orders this browser placed (id + tracking token, in localStorage), asks the
 * server where they are, and renders them as live cards. A signed-in customer
 * also gets their account's orders back from the same call.
 *
 * Polling is deliberately simple: every 10 seconds while anything is still in
 * progress, paused while the tab is hidden, and it stops once every order has
 * finished. A finished order stays on the page until it is dismissed.
 */

const KEY = "fc-orders";
const POLL_MS = 10000;

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const money = (value) => `$${Number(value || 0).toFixed(2)}`;

/* ── What this browser remembers ─────────────────────────────── */

function readRefs() {
  try {
    const refs = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(refs) ? refs.filter((r) => r && r.id) : [];
  } catch {
    return [];
  }
}

function writeRefs(refs) {
  try { localStorage.setItem(KEY, JSON.stringify(refs.slice(-20))); } catch { /* storage refused */ }
}

/** Keep an order the browser just placed. */
export function rememberOrder(order) {
  if (!order?.id) return;
  const refs = readRefs().filter((r) => r.id !== order.id);
  refs.push({ id: order.id, token: order.token || null, placedAt: order.placedAt || new Date().toISOString() });
  writeRefs(refs);
}

export function forgetOrder(id) {
  writeRefs(readRefs().filter((r) => r.id !== id));
}

/** {id, token} pairs, for the tracking call and for the concierge. */
export function trackedRefs() {
  return readRefs().map(({ id, token }) => ({ id, token }));
}

/* ── Talking to the server ───────────────────────────────────── */

/**
 * Where every order this browser knows about is right now, newest and most
 * active first. Returns null when the server has no database.
 */
export async function fetchTracked() {
  try {
    const response = await fetch("/api/orders/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ refs: trackedRefs() })
    });
    if (!response.ok) return null;
    const { orders } = await response.json();
    return Array.isArray(orders) ? orders : [];
  } catch {
    return null;
  }
}

const DISMISSED_KEY = "fc-orders-dismissed";

function readDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]")); } catch { return new Set(); }
}

/** Put a finished order away for good: recorded on the order itself, and remembered here too. */
export async function dismissOrder(id) {
  try {
    const set = readDismissed(); set.add(id);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set].slice(-50)));
  } catch { /* storage refused */ }
  forgetOrder(id);
  const ref = readRefs().find((r) => r.id === id);
  try {
    await fetch(`/api/orders/${id}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token: ref?.token || null })
    });
  } catch { /* offline: the local memory still hides it */ }
}

export async function cancelOrder(id) {
  const ref = readRefs().find((r) => r.id === id);
  const response = await fetch(`/api/orders/${id}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ token: ref?.token || null })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Could not cancel that order.");
  return payload.order;
}

/* ── Words for the card ──────────────────────────────────────── */

const clock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";

const sameDay = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

/** "Ready around 4:12 PM", "Arriving in about 12 minutes", "Picked up at 4:20 PM". */
export function timing(order, now = new Date()) {
  const pickup = order.fulfillment === "pickup";
  if (order.status === "cancelled") return `Cancelled ${clock(order.completedAt || order.updatedAt)}`;
  if (!order.active) {
    const when = order.completedAt || order.updatedAt;
    return `${pickup ? "Picked up" : "Delivered"}${sameDay(when) ? ` at ${clock(when)}` : ` on ${order.date}`}`;
  }
  if (!order.promisedAt) return pickup ? "Ready soon" : "On its way soon";
  const minutes = Math.round((new Date(order.promisedAt) - now) / 60000);
  const verb = order.status === "ready" ? "Ready now"
    : order.status === "out_for_delivery" ? "Arriving"
    : pickup ? "Ready" : "Arriving";
  if (order.status === "ready") return `${verb} · held until ${clock(new Date(new Date(order.promisedAt).getTime() + 30 * 60000))}`;
  if (minutes <= 1) return `${verb} any minute`;
  if (minutes < 60) return `${verb} in about ${minutes} minutes`;
  return `${verb} around ${clock(order.promisedAt)}`;
}

/* ── Rendering ───────────────────────────────────────────────── */

function stepList(order) {
  return `
    <ol class="order-steps" aria-label="Progress">
      ${order.steps.map((step) => `
        <li class="order-step${step.done ? " is-done" : ""}${step.current ? " is-current" : ""}">
          <i aria-hidden="true"></i>
          <span>${esc(step.label)}</span>
          <small>${step.at ? esc(clock(step.at)) : ""}</small>
        </li>`).join("")}
    </ol>`;
}

export function orderCard(order, { compact = false } = {}) {
  const status = order.status.replace(/_/g, "-");
  const lines = (order.items || []).map((line) => `
    <span class="order-line">
      ${line.image ? `<img src="${esc(line.image)}" alt="" width="36" height="27" loading="lazy" />` : ""}
      ${line.quantity} × ${esc(line.name)}
    </span>`).join("");
  return `
    <article class="order-card status-${esc(status)}${order.active ? " is-active" : " is-final"}" data-order-card="${order.id}">
      <header class="order-card-head">
        <div>
          <p class="eyebrow">Order #${order.id} · ${order.fulfillment === "pickup" ? "Pickup" : "Delivery"} · ${esc(order.location?.name || "")}</p>
          <strong class="order-headline">${esc(order.headline)}</strong>
          <small class="order-when">${esc(timing(order))}${order.window && order.window !== "As soon as possible" ? ` · ${esc(order.window)}` : ""}${order.address ? ` · ${esc(order.address)}` : ""}</small>
        </div>
        <span class="order-pill status-${esc(status)}">${esc(order.statusLabel)}</span>
      </header>
      ${order.status === "cancelled" ? "" : stepList(order)}
      ${compact ? "" : `<div class="order-lines">${lines}</div>`}
      <footer class="order-card-foot">
        <span><strong>${money(order.total)}</strong>${order.offer ? " after your offer" : ""}</span>
        <span class="order-updated">Updated ${esc(clock(order.updatedAt || order.placedAt))}</span>
        ${order.canCancel && order.active
          ? `<button class="text-button" type="button" data-cancel-order="${order.id}">Cancel order</button>` : ""}
        ${!order.active
          ? `<button class="text-button" type="button" data-dismiss-order="${order.id}">Dismiss</button>` : ""}
      </footer>
    </article>`;
}

/**
 * Mounts live order cards into `root`. Hides `root` (and its `section`
 * ancestor, when given) while there is nothing to show.
 * options: { section, onToast, compact }
 */
export function initTracker(root, { section = null, onToast = () => {}, compact = false } = {}) {
  if (!root) return { refresh: async () => [], destroy() {} };
  let timer = null;
  let orders = [];
  let dismissed = readDismissed();

  const wrap = section || root;

  const STALE_MS = 6 * 3600 * 1000;

  function paint() {
    // A finished order stays until dismissed, but not forever: after six
    // hours it is forgotten on its own so the page opens on the menu again.
    for (const o of orders) {
      const ended = o.completedAt || o.updatedAt;
      if (!o.active && ended && Date.now() - new Date(ended) > STALE_MS) { dismissed.add(o.id); forgetOrder(o.id); }
    }
    const visible = orders.filter((o) => !dismissed.has(o.id) && !o.dismissed);
    wrap.hidden = visible.length === 0;
    root.innerHTML = visible.map((o) => orderCard(o, { compact })).join("");
    root.dataset.active = String(visible.filter((o) => o.active).length);
  }

  function schedule() {
    clearTimeout(timer);
    if (!orders.some((o) => o.active)) return;
    timer = setTimeout(() => (document.hidden ? schedule() : refresh()), POLL_MS);
  }

  async function refresh() {
    const next = await fetchTracked();
    if (next === null) { wrap.hidden = orders.length === 0; schedule(); return orders; }
    // Announce a change of status for orders the page already showed.
    for (const order of next) {
      const before = orders.find((o) => o.id === order.id);
      if (before && before.status !== order.status) onToast(`Order #${order.id}: ${order.statusLabel.toLowerCase()}`);
    }
    orders = next;
    paint();
    schedule();
    return orders;
  }

  root.addEventListener("click", async (event) => {
    const cancel = event.target.closest("[data-cancel-order]");
    if (cancel) {
      cancel.disabled = true;
      try {
        await cancelOrder(Number(cancel.dataset.cancelOrder));
        onToast(`Order #${cancel.dataset.cancelOrder} cancelled — the corner put the ingredients back`);
        await refresh();
      } catch (error) {
        onToast(error.message);
        cancel.disabled = false;
      }
      return;
    }
    const dismiss = event.target.closest("[data-dismiss-order]");
    if (dismiss) {
      const id = Number(dismiss.dataset.dismissOrder);
      dismissed.add(id);
      paint();
      dismissOrder(id);
    }
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden && orders.some((o) => o.active)) refresh(); });

  refresh();
  return { refresh, destroy() { clearTimeout(timer); } };
}
