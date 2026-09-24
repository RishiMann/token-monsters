/**
 * The full checkout page.
 *
 * Same box, same offer rules and same order call as the drawer on the menu
 * page; this just gives them room. Every offer is evaluated against the box
 * as it stands, so the page can say exactly which ones this order has earned
 * and what would unlock the rest.
 */

import * as bag from "./bag.js";
import { findItem, isOnSale, dataLoadError } from "./data.js";
import { offersFor, receipt } from "./agent-engine.js";
import { currentUser } from "./auth.js";
import { generateContext } from "./context.js";
import { rememberOrder, initTracker } from "./orders.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

const form = $("[data-checkout-page-form]");
const placedPanel = $("[data-placed]");
const toastEl = $("[data-toast]");
let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2600);
}
if (dataLoadError) toast("Storefront data is temporarily unavailable");

/* ── Who is here ─────────────────────────────────────────────── */
let signedIn = false;
let storefrontContext = null;
const userReady = currentUser().then((user) => { signedIn = Boolean(user); return user; }).catch(() => null);
const customer = () => ({ context: storefrontContext, signedIn });

/* ── Fulfillment ─────────────────────────────────────────────── */
const fulfillment = () => $("input[name=fulfillment]:checked", form)?.value || "pickup";
function syncFulfillment() {
  const selected = fulfillment();
  $$('input[name="fulfillment"]', form).forEach((input) =>
    input.closest(".fulfillment-option").classList.toggle("is-selected", input.checked));
  const address = $("[data-address-field]", form);
  address.hidden = selected !== "delivery";
  address.querySelector("input").required = selected === "delivery";
  render(bag.snapshot());
}
$$('input[name="fulfillment"]', form).forEach((input) => input.addEventListener("change", syncFulfillment));

/* ── Rendering ───────────────────────────────────────────────── */
function receiptRows(bill) {
  const rows = [`<div class="receipt-row"><span>Subtotal</span><span>${money(bill.subtotal)}</span></div>`];
  if (bill.applied) rows.push(`<div class="receipt-row receipt-off"><span>${esc(bill.applied.title)}</span><span>−${money(bill.discount)}</span></div>`);
  if (bill.addon) rows.push(`<div class="receipt-row receipt-off"><span>${esc(bill.addon.name)} (worth ${money(bill.addon.value)})</span><span>Free</span></div>`);
  if (bill.fulfillment === "delivery") {
    rows.push(`<div class="receipt-row${bill.deliveryFree ? " receipt-off" : ""}"><span>Delivery</span><span>${bill.deliveryFree ? "Free" : money(bill.deliveryFee)}</span></div>`);
  }
  rows.push(`<div class="receipt-row receipt-total"><span>Total</span><strong>${money(bill.total)}</strong></div>`);
  return rows.join("");
}

function offerCard(offer, appliedId) {
  const applied = offer.id === appliedId;
  const state = offer.auto ? (offer.eligible ? "auto-on" : "auto") : applied ? "applied" : offer.eligible ? "eligible" : "locked";
  const status = { "auto-on": "On for delivery", auto: "Automatic", applied: "Applied", eligible: "Earned by this order", locked: "Not for this order" }[state];
  const showProgress = offer.progress != null && offer.progress < 100 && !offer.eligible;
  const action = offer.auto
    ? `<span class="offer-auto">${offer.eligible ? "Applies when you choose delivery" : "Applies on its own with delivery"}</span>`
    : offer.eligible
      ? `<button class="chip${applied ? " is-active" : ""}" type="button" data-claim="${offer.id}" aria-pressed="${applied}">${applied ? "Applied ✓ · remove" : "Apply to this order"}</button>`
      : `<button class="chip" type="button" disabled aria-disabled="true" title="${esc(offer.why)}">Apply</button>`;
  return `
    <article class="offer-card tint-${offer.tint} state-${state}${offer.eligible ? " is-live" : ""}">
      <span class="offer-status status-${state}">${status}${offer.eligible && !offer.auto ? '<span class="offer-live-dot"></span>' : ""}</span>
      <span class="offer-emoji" aria-hidden="true">${offer.emoji}</span>
      <span class="offer-label">${esc(offer.label)}</span>
      <h3>${esc(offer.title)}</h3>
      <p class="offer-detail">${esc(offer.detail)}</p>
      ${showProgress ? `<div class="offer-progress" aria-hidden="true"><i style="width:${Math.min(offer.progress, 100)}%"></i></div>` : ""}
      <p class="offer-reason"><strong>${offer.eligible ? "Why this order earned it:" : "To unlock it:"}</strong> ${esc(offer.why)}</p>
      <div class="offer-foot">
        <span class="offer-value">${offer.eligible && offer.discount > 0 ? `Saves ${money(offer.discount)}` : esc(offer.value)}</span>
        ${action}
      </div>
    </article>`;
}

function render(snapshot) {
  const { lines, count, capacity } = snapshot;
  $$("[data-bag-count]").forEach((el) => { el.textContent = count; });
  $("[data-count-label]").textContent = count ? `· ${count} treat${count === 1 ? "" : "s"}` : "";
  $("[data-box-hint]").textContent =
    count === 0 ? "Your box is empty — head back to the menu."
    : count < capacity ? `${capacity - count} slot${capacity - count === 1 ? "" : "s"} left in this box.`
    : count === capacity ? "One full box of six."
    : `${Math.ceil(count / capacity)} boxes for this order.`;

  $("[data-lines]").innerHTML = lines.length
    ? lines.map((line) => `
      <div class="line-item tint-${line.item.tint}">
        ${line.item.image ? `<img class="line-photo" src="${esc(line.item.image)}" alt="" width="56" height="42" loading="lazy" />` : `<span class="line-emoji" aria-hidden="true">${line.item.emoji}</span>`}
        <span class="line-body">
          <strong>${esc(line.item.name)}</strong>
          <small>${money(line.item.price)} each · ${money(line.item.price * line.qty)}</small>
        </span>
        <span class="line-controls">
          <button class="qty-button" type="button" data-dec="${line.item.id}" aria-label="Remove one ${esc(line.item.name)}">−</button>
          <span class="qty-value">${line.qty}</span>
          <button class="qty-button" type="button" data-inc="${line.item.id}" aria-label="Add another ${esc(line.item.name)}">+</button>
        </span>
      </div>`).join("")
    : `<div class="drawer-empty"><span aria-hidden="true">🧁</span><p>Nothing here yet. <a href="index.html#menu">Pick something sweet.</a></p></div>`;

  // Offers, exactly as this order stands.
  const evaluated = offersFor(snapshot, customer());
  let applied = snapshot.appliedOffer;
  if (applied && !evaluated.find((o) => o.id === applied && o.eligible)) {
    bag.removeOffer();          // triggers another render with it cleared
    return;
  }
  const earned = evaluated.filter((o) => o.eligible && !o.auto);
  const deliveryFree = evaluated.find((o) => o.auto && o.eligible);
  $("[data-eligible-summary]").textContent = count === 0 ? ""
    : earned.length === 0
      ? (deliveryFree ? "No discount yet · free delivery is on" : "Nothing earned yet")
      : `${earned.length} earned${deliveryFree ? " · free delivery is on" : ""}`;
  $("[data-offer-rail]").innerHTML = evaluated.map((offer) => offerCard(offer, applied)).join("");

  const bill = receipt(snapshot, { appliedId: applied, fulfillment: fulfillment(), customer: customer() });
  $("[data-checkout-receipt]").innerHTML = receiptRows(bill);
  const note = $("[data-applied-note]");
  note.textContent = bill.applied
    ? `${bill.applied.title} is applied${earned.length > 1 ? " — one discount at a time" : ""}.`
    : earned.length
      ? `This order has earned ${earned.length === 1 ? earned[0].title.toLowerCase() : `${earned.length} deals`} — apply one above.`
      : "";
  $("[data-place]").disabled = count === 0;
  return bill;
}

/* ── Actions ─────────────────────────────────────────────────── */
form.addEventListener("click", (event) => {
  const dec = event.target.closest("[data-dec]");
  if (dec) return bag.remove(dec.dataset.dec);
  const inc = event.target.closest("[data-inc]");
  if (inc) { const item = findItem(inc.dataset.inc); if (item) bag.add(item); return; }
  const claim = event.target.closest("[data-claim]");
  if (!claim || claim.disabled) return;
  const id = claim.dataset.claim;
  if (bag.appliedOffer() === id) { bag.removeOffer(); toast("Offer removed"); return; }
  const offer = offersFor(bag.snapshot(), customer()).find((o) => o.id === id);
  if (!offer?.eligible) return toast(offer?.why || "That offer doesn't apply to this order yet");
  const swapped = bag.appliedOffer();
  bag.applyOffer(id);
  toast(swapped ? `Switched to ${offer.title.toLowerCase()} — one discount at a time` : `${offer.title} applied`);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const snapshot = bag.snapshot();
  if (snapshot.count === 0) return toast("Add something sweet first");
  const method = fulfillment();
  const name = $("input[name=name]", form).value.trim();
  const address = $("input[name=address]", form).value.trim();
  if (!name) return toast("Add a name for the order");
  if (method === "delivery" && !address) return toast("Add a delivery address");
  try { localStorage.setItem("fc-name", name); } catch { /* storage refused */ }

  const button = $("[data-place]");
  button.disabled = true;
  let placed = null;
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        lines: snapshot.lines.map((line) => ({ id: line.item.id, quantity: line.qty })),
        fulfillment: method,
        window: $("select[name=window]", form).value,
        name, address,
        note: $("textarea[name=note]", form).value.trim(),
        appliedOffer: snapshot.appliedOffer
      })
    });
    if (response.ok) placed = await response.json();
    else if (response.status === 400) {
      const { error } = await response.json().catch(() => ({}));
      button.disabled = false;
      return toast(error || "That order could not be placed");
    }
  } catch { placed = null; }
  button.disabled = false;

  if (!placed) {
    const bill = render(snapshot);
    bag.clear();
    return toast(`Demo order placed for ${method} · ${money(bill?.total)} — the server has no database to keep it`);
  }
  bag.clear();
  rememberOrder(placed);
  const low = (placed.stock || []).filter((row) => row.status !== "ok");
  toast(`Order #${placed.id} placed · ${money(placed.total)} · stock updated at ${placed.location?.name || "the corner"}`
    + (low.length ? ` — ${low[0].name} now ${low[0].status}` : ""));
  $("[data-checkout-heading]").innerHTML = `Order <em>#${placed.id}</em> is in`;
  $("[data-checkout-lede]").textContent = placed.headline;
  form.hidden = true;
  placedPanel.hidden = false;
  tracker.refresh();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

/* ── Boot ────────────────────────────────────────────────────── */
const tracker = initTracker($("[data-order-cards]"), { section: placedPanel, onToast: toast });
try { $("input[name=name]", form).value = localStorage.getItem("fc-name") || ""; } catch { /* storage refused */ }
bag.hydrate((id) => (isOnSale(id) ? findItem(id) : null));
bag.onChange((snapshot) => {
  generateContext({ cart: snapshot }).then((context) => { storefrontContext = context; render(bag.snapshot()); });
  render(snapshot);
});
syncFulfillment();
userReady.then((user) => {
  const nameInput = $("input[name=name]", form);
  if (user && nameInput && !nameInput.value) nameInput.value = user.name;
  render(bag.snapshot());
});
document.documentElement.dataset.appReady = "1";
