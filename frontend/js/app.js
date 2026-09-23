/**
 * Frosted Corner storefront wiring.
 *
 * Rendering is plain template strings against the data modules; all agent
 * calls go through `ask()` so the UI already behaves like it's talking to a
 * service (loading states included) before any real one exists.
 */

import {
  fullMenu, weeklyMenu, eventMenus, smartOffers,
  plans, reviews, reviewSummary, agents, occasions, announcements, dataLoadError
} from "./data.js";
import { ask } from "./agents.js";
import * as bag from "./bag.js";
import { currentUser, homeFor } from "./auth.js";
import { generateContext } from "./context.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape anything that originates from user input before it hits innerHTML. */
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );

const money = (value) => `$${value.toFixed(2)}`;
let storefrontContext = null;
let contextReady = generateContext().then((context) => {
  storefrontContext = context;
  return context;
});

const withContext = async (input = {}) => ({
  ...input,
  context: await contextReady
});

/* ── Toast ─────────────────────────────────────────────────── */
const toastEl = $("[data-toast]");
let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2600);
}

/* ── Announcement rotator ──────────────────────────────────── */
(function rotateAnnouncements() {
  const slot = $("[data-announce]");
  if (!announcements.length) return;
  let i = 0;
  setInterval(() => {
    i = (i + 1) % announcements.length;
    slot.style.animation = "none";
    void slot.offsetWidth; // restart the entrance animation
    slot.style.animation = "";
    slot.textContent = announcements[i];
  }, 4200);
})();

/* ── Countdown to the weekly flavor drop (Thursday 09:00) ──── */
(function countdown() {
  const nodes = {
    days: $('[data-cd="days"]'), hours: $('[data-cd="hours"]'),
    mins: $('[data-cd="mins"]'), secs: $('[data-cd="secs"]')
  };

  const nextDrop = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    // 4 = Thursday. Roll forward to the next one that hasn't happened yet.
    const delta = (4 - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + delta);
    if (next <= now) next.setDate(next.getDate() + 7);
    return next;
  };

  const pad = (n) => String(n).padStart(2, "0");

  const tick = () => {
    const diff = Math.max(0, nextDrop() - Date.now());
    const secs = Math.floor(diff / 1000);
    nodes.days.textContent = Math.floor(secs / 86400);
    nodes.hours.textContent = pad(Math.floor(secs / 3600) % 24);
    nodes.mins.textContent = pad(Math.floor(secs / 60) % 60);
    nodes.secs.textContent = pad(secs % 60);
  };

  tick();
  setInterval(tick, 1000);
})();

/* ── Product grid ──────────────────────────────────────────── */
const grid = $("[data-product-grid]");
const gridEmpty = $("[data-grid-empty]");

if (dataLoadError) toast("Storefront data is temporarily unavailable");

function productCard(item, index) {
  return `
    <article class="product-card tint-${item.tint}" style="animation-delay:${index * 45}ms">
      <div class="product-art">
        <span class="product-badge">${esc(item.badge)}</span>
        <span class="product-rating">★ ${item.rating}</span>
        <span class="product-emoji" data-art="${item.id}" aria-hidden="true">${item.emoji}</span>
      </div>
      <div class="product-info">
        <h3>${esc(item.name)}</h3>
        <p>${esc(item.blurb)}</p>
        <div class="product-foot">
          <span class="product-price">${money(item.price)}</span>
          <button class="add-button" type="button" data-add="${item.id}"
                  aria-label="Add ${esc(item.name)} to your box">+</button>
        </div>
      </div>
    </article>`;
}

function renderMenu(filter = "all") {
  const source = filter === "all" ? weeklyMenu : fullMenu;
  const items = filter === "all" ? source : source.filter((item) => item.tags.includes(filter));
  if (items.length === 0) {
    grid.innerHTML = '<p class="menu-error">Failed to load menu. Please try again later.</p>';
  } else {
    grid.innerHTML = items.map(productCard).join("");
  }
  gridEmpty.hidden = items.length > 0;
}

$$("[data-filter]").forEach((chip) =>
  chip.addEventListener("click", () => {
    $$("[data-filter]").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
    renderMenu(chip.dataset.filter);
  })
);

/** One delegated handler covers every add button, including re-rendered ones. */
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-add]");
  if (!button) return;
  const item = fullMenu.find((entry) => entry.id === button.dataset.add);
  if (!item) return;

  bag.add(item);
  const art = $(`[data-art="${item.id}"]`) || button;
  bag.flyToBag(art, bagButton, item.emoji);
  toast(`${item.name} added to your box`);
});

/* ── Offers ────────────────────────────────────────────────── */
$("[data-offer-rail]").innerHTML = smartOffers.map((offer) => `
  <article class="offer-card tint-${offer.tint}">
    <span class="offer-emoji" aria-hidden="true">${offer.emoji}</span>
    <span class="offer-label">${esc(offer.label)}</span>
    <h3>${esc(offer.title)}</h3>
    <p class="offer-detail">${esc(offer.detail)}</p>
    <p class="offer-reason"><strong>Why this offer:</strong> ${esc(offer.reason)}</p>
    <div class="offer-foot">
      <span class="offer-value">${esc(offer.value)}</span>
      <button class="chip" type="button" data-claim="${offer.id}">Apply</button>
    </div>
  </article>`).join("");

document.addEventListener("click", (event) => {
  const claim = event.target.closest("[data-claim]");
  if (!claim) return;
  claim.textContent = "Applied ✓";
  claim.classList.add("is-active");
  toast("Offer applied to your next box");
});

/* ── Event menus ───────────────────────────────────────────── */
$("[data-event-grid]").innerHTML = eventMenus.map((menu) => `
  <article class="event-card tint-${menu.tint}">
    <span class="event-status status-${menu.status}">${menu.status === "preorder" ? "Pre-order" : menu.status}</span>
    <span class="event-emoji" aria-hidden="true">${menu.emoji}</span>
    <h3>${esc(menu.name)}</h3>
    <span class="event-window">${esc(menu.window)}</span>
    <p>${esc(menu.blurb)}</p>
    <ul class="event-highlights">${menu.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
  </article>`).join("");

/* ── Plans ─────────────────────────────────────────────────── */
$("[data-plan-grid]").innerHTML = plans.map((plan) => `
  <article class="plan-card${plan.featured ? " is-featured" : ""}">
    ${plan.featured ? '<span class="plan-flag">Most popular</span>' : ""}
    <h3>${esc(plan.name)}</h3>
    <div class="plan-price"><strong>$${plan.price}</strong><span>/ ${plan.cadence}</span></div>
    <p class="plan-pitch">${esc(plan.pitch)}</p>
    <ul class="plan-perks">${plan.perks.map((perk) => `<li>${esc(perk)}</li>`).join("")}</ul>
    <button class="button ${plan.featured ? "button-light" : "button-ghost"}" type="button"
            data-subscribe="${esc(plan.name)}">Choose ${esc(plan.name)}</button>
  </article>`).join("");

document.addEventListener("click", (event) => {
  const sub = event.target.closest("[data-subscribe]");
  if (sub) {
    $$('[data-subscribe]').forEach((button) => button.classList.remove("is-active"));
    sub.classList.add("is-active");
    toast(`${sub.dataset.subscribe} selected — sign in to manage your weekly box`);
  }
});

/* ── Reviews ───────────────────────────────────────────────── */
$("[data-review-summary]").innerHTML = `
  <span class="summary-tag"><span class="agent-dot tint-mint"></span>Synthesized by the review agent</span>
  <div class="summary-score">
    <strong>${reviewSummary.rating}</strong>
    <small>${reviewSummary.count.toLocaleString()} reviews</small>
  </div>
  <h3 style="color:#fff">${esc(reviewSummary.headline)}</h3>
  ${reviewSummary.points.map((point) => `
    <div class="summary-point">
      <div class="summary-point-head"><span>${esc(point.label)}</span><span>${point.score}%</span></div>
      <div class="meter"><i style="width:${point.score}%"></i></div>
      <small>${esc(point.detail)}</small>
    </div>`).join("")}
  <p class="summary-watchout">${esc(reviewSummary.watchout)}</p>`;

$("[data-review-grid]").innerHTML = reviews.map((review) => `
  <article class="review-card${review.featured ? " is-featured" : ""} tint-${review.tint}">
    <span class="review-stars" aria-label="${review.stars} out of 5">${"★".repeat(review.stars)}${"☆".repeat(5 - review.stars)}</span>
    <p>${esc(review.body)}</p>
    <footer class="review-foot">
      <span class="review-avatar">${esc(review.initials)}</span>
      <span class="review-who"><strong>${esc(review.name)}</strong><small>${esc(review.verified)}</small></span>
    </footer>
  </article>`).join("");

/* ── AI crew ───────────────────────────────────────────────── */
const crewGrid = $("[data-crew-grid]");
function renderCrew(audience = "all") {
  const list = agents.filter((agent) =>
    audience === "all" ? true :
      audience === "franchise" ? agent.audience === "franchise" : !agent.audience
  );
  crewGrid.innerHTML = list.map((agent, i) => `
    <article class="crew-card tint-${agent.tint}" style="position:relative;animation-delay:${i * 45}ms">
      ${agent.audience ? '<span class="crew-audience">Franchise</span>' : ""}
      <div class="crew-top">
        <span class="crew-glyph" aria-hidden="true">${agent.emoji}</span>
        <span><h3>${esc(agent.name)}</h3><span class="crew-role">${esc(agent.role)}</span></span>
      </div>
      <p>${esc(agent.blurb)}</p>
      <div class="crew-meta">
        <div class="crew-meta-row">
          <span>Appears in</span>
          <div class="crew-pills">${agent.surfaces.map((s) => `<i>${esc(s)}</i>`).join("")}</div>
        </div>
        <div class="crew-meta-row">
          <span>Reads</span>
          <div class="crew-pills">${agent.signals.map((s) => `<i>${esc(s)}</i>`).join("")}</div>
        </div>
      </div>
    </article>`).join("");
}
renderCrew();

$$("[data-crew]").forEach((chip) =>
  chip.addEventListener("click", () => {
    $$("[data-crew]").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
    renderCrew(chip.dataset.crew);
  })
);

/* ── Concierge ─────────────────────────────────────────────── */
const chatLog = $("[data-chat-log]");

function bubble(html, from = "agent") {
  const el = document.createElement("div");
  el.className = `bubble from-${from}`;
  el.innerHTML = html;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function typingBubble() {
  const el = document.createElement("div");
  el.className = "bubble from-agent typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function recStrip(items) {
  return `<div class="rec-strip">${items.map((item) => `
    <div class="rec-item tint-${item.tint}">
      <span class="rec-emoji" aria-hidden="true">${item.emoji}</span>
      <span class="rec-body"><strong>${esc(item.name)}</strong><small>${esc(item.blurb)}</small></span>
      <button class="rec-add" type="button" data-add="${item.id}">Add</button>
    </div>`).join("")}</div>`;
}

function replyChips(chips, attribute) {
  if (!chips?.length) return "";
  return `<div class="reply-chips">${chips.map((chip) =>
    `<button class="reply-chip" type="button" ${attribute}="${esc(chip)}">${esc(chip)}</button>`
  ).join("")}</div>`;
}

async function conciergeReply(input) {
  const typing = typingBubble();
  const reply = await ask("concierge", await withContext(input));
  typing.remove();
  const body = `<div>${esc(reply.message)}</div>${reply.items?.length ? recStrip(reply.items) : ""}${reply.note ? `<small class="reply-note">${esc(reply.note)}</small>` : ""}${reply.chips ? replyChips(reply.chips, "data-concierge-chip") : ""}`;
  bubble(body);
}

$("[data-occasion-grid]").innerHTML = occasions.map((occ) => `
  <button class="occasion" type="button" data-occasion="${occ.id}">
    <span aria-hidden="true">${occ.emoji}</span>${esc(occ.label)}
  </button>`).join("");

$$("[data-occasion]").forEach((button) =>
  button.addEventListener("click", () => {
    $$("[data-occasion]").forEach((b) => b.classList.remove("is-active"));
    button.classList.add("is-active");
    bubble(esc(button.textContent.trim()), "user");
    conciergeReply({ occasion: button.dataset.occasion });
  })
);

$("[data-chat-form]").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("[data-chat-input]");
  const text = input.value.trim();
  if (!text) return;
  bubble(esc(text), "user");
  input.value = "";
  conciergeReply({ text });
});

bubble("Hi! Tell me the occasion or just a craving, and I'll shortlist from this week's menu.");

/* ── Party planner ─────────────────────────────────────────── */
const guestInput = $("[data-guests]");
const guestOut = $("[data-guest-out]");
const plannerResult = $("[data-planner-result]");
let vibe = "classic";
let dietary = [];

function syncRangeFill() {
  const pct = ((guestInput.value - guestInput.min) / (guestInput.max - guestInput.min)) * 100;
  guestInput.style.setProperty("--fill", `${pct}%`);
  guestOut.textContent = guestInput.value;
}
guestInput.addEventListener("input", syncRangeFill);
syncRangeFill();

$$("[data-vibe]").forEach((chip) =>
  chip.addEventListener("click", () => {
    $$("[data-vibe]").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
    vibe = chip.dataset.vibe;
  })
);

$$("[data-diet]").forEach((chip) =>
  chip.addEventListener("click", () => {
    const on = chip.getAttribute("aria-pressed") === "true";
    chip.setAttribute("aria-pressed", String(!on));
    chip.classList.toggle("is-active", !on);
    dietary = $$('[data-diet][aria-pressed="true"]').map((c) => c.dataset.diet);
  })
);

$("[data-plan]").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Planning…";

  const reply = await ask("planner", await withContext({
    guests: Number(guestInput.value), vibe, dietary
  }));

  plannerResult.innerHTML = `
    <p class="eyebrow"><span class="agent-dot tint-plum"></span>Planner result</p>
    <h3 style="margin-top:10px">${esc(reply.message)}</h3>
    <div class="planner-stats">
      <div><strong>${reply.stats.guests}</strong><small>guests</small></div>
      <div><strong>${reply.stats.servings}</strong><small>servings</small></div>
      <div><strong>${reply.stats.boxes}</strong><small>boxes</small></div>
      <div><strong>${reply.stats.variety}</strong><small>flavors</small></div>
    </div>
    ${recStrip(reply.items)}
    <p class="planner-note">${esc(reply.note)}</p>`;

  button.disabled = false;
  button.innerHTML = 'Plan my spread <span aria-hidden="true">→</span>';
});

/* ── Support agent ─────────────────────────────────────────── */
const supportPanel = $("[data-support-panel]");
const supportLog = $("[data-support-log]");
const supportFab = $("[data-support-open]");

function supportBubble(html, from = "agent") {
  const el = document.createElement("div");
  el.className = `bubble from-${from}`;
  el.innerHTML = html;
  supportLog.appendChild(el);
  supportLog.scrollTop = supportLog.scrollHeight;
}

async function supportReply(text) {
  const typing = document.createElement("div");
  typing.className = "bubble from-agent typing";
  typing.innerHTML = "<span></span><span></span><span></span>";
  supportLog.appendChild(typing);
  supportLog.scrollTop = supportLog.scrollHeight;

  const reply = await ask("support", await withContext({ text }));
  typing.remove();
  const chips = reply.chips?.length
    ? `<div class="reply-chips">${reply.chips.map((c) => `<button class="reply-chip" type="button" data-support-chip="${esc(c)}">${esc(c)}</button>`).join("")}</div>`
    : "";
  supportBubble(`${esc(reply.message)}${chips}`);
}

function openSupport(open) {
  supportPanel.hidden = !open;
  supportFab.setAttribute("aria-expanded", String(open));
  if (open && !supportLog.childElementCount) {
    supportReply("");
  }
  if (open) $("[data-support-input]").focus();
}

supportFab.addEventListener("click", () => openSupport(supportPanel.hidden));
$("[data-support-close]").addEventListener("click", () => openSupport(false));

$("[data-support-form]").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("[data-support-input]");
  const text = input.value.trim();
  if (!text) return;
  supportBubble(esc(text), "user");
  input.value = "";
  supportReply(text);
});

document.addEventListener("click", (event) => {
  const conciergeChip = event.target.closest("[data-concierge-chip]");
  if (conciergeChip) {
    const label = conciergeChip.dataset.conciergeChip;
    bubble(esc(label), "user");
    conciergeReply({ text: label });
    return;
  }
  const chip = event.target.closest("[data-support-chip]");
  if (!chip) return;
  const label = chip.dataset.supportChip;
  supportBubble(esc(label), "user");
  if (label === "Talk to a person") {
    supportBubble("Connecting you to your local corner — someone will pick this up shortly.");
    return;
  }
  supportReply(label);
});

/* ── Voice ordering demo ───────────────────────────────────── */
$('[data-action="voice"]').addEventListener("click", async () => {
  toast("Voice demo ready — tell the Orders Agent what you want");
  const reply = await ask("orders", await withContext({ text: "" }));
  openSupport(true);
  supportBubble(`${esc(reply.message)}${reply.items?.length ? recStrip(reply.items) : ""}`);
});

/* ── The box ───────────────────────────────────────────────── */
const bagButton = $('[data-action="bag"]');
const drawer = $("[data-drawer]");
const scrim = $("[data-scrim]");
const boxEl = $("[data-box]");
const slotWrap = $("[data-box-slots]");
const linesWrap = $("[data-drawer-lines]");
const checkoutDialog = $(`[data-checkout-dialog]`);
const checkoutSummary = $(`[data-checkout-summary]`);
const addressField = $(`[data-address-field]`);
let latestBox = { count: 0, subtotal: 0 };

function syncFulfillmentOptions() {
  const selected = $("input[name=fulfillment]:checked", checkoutDialog)?.value;
  $$('input[name="fulfillment"]', checkoutDialog).forEach((input) =>
    input.closest(".fulfillment-option").classList.toggle("is-selected", input.checked)
  );
  addressField.hidden = selected !== "delivery";
  addressField.querySelector("input").required = selected === "delivery";
}

checkoutDialog.querySelectorAll('input[name="fulfillment"]').forEach((input) =>
  input.addEventListener("change", syncFulfillmentOptions)
);

function renderBox(snapshot) {
  latestBox = snapshot;
  const { lines, count, subtotal, capacity } = snapshot;

  $("[data-bag-count]").textContent = count;
  $("[data-subtotal]").textContent = money(subtotal);
  $("[data-drawer-title]").textContent =
    count === 0 ? "Empty box" : `${count} treat${count === 1 ? "" : "s"}`;

  // Slots: one tile per unit, with the last slot absorbing any overflow.
  const units = bag.slots();
  const tiles = [];
  for (let i = 0; i < capacity; i += 1) {
    const overflowing = units.length > capacity && i === capacity - 1;
    if (overflowing) {
      tiles.push(`<div class="slot is-filled is-overflow">+${units.length - capacity + 1}</div>`);
    } else if (units[i]) {
      tiles.push(`
        <div class="slot is-filled tint-${units[i].tint}" style="animation-delay:${i * 50}ms">
          <span class="slot-emoji" aria-hidden="true">${units[i].emoji}</span>
          <span class="slot-name">${esc(units[i].name)}</span>
        </div>`);
    } else {
      tiles.push('<div class="slot">empty</div>');
    }
  }
  slotWrap.innerHTML = tiles.join("");
  boxEl.classList.toggle("is-full", units.length >= capacity);

  $("[data-box-hint]").textContent =
    count === 0 ? "A Frosted Corner box holds six."
      : count < capacity ? `${capacity - count} slot${capacity - count === 1 ? "" : "s"} left in this box.`
        : count === capacity ? "Box is full — nicely done."
          : `${Math.ceil(count / capacity)} boxes for this order.`;

  linesWrap.innerHTML = lines.length
    ? lines.map((line) => `
        <div class="line-item tint-${line.item.tint}">
          <span class="line-emoji" aria-hidden="true">${line.item.emoji}</span>
          <span class="line-body">
            <strong>${esc(line.item.name)}</strong>
            <small>${money(line.item.price)} each</small>
          </span>
          <span class="line-controls">
            <button class="qty-button" type="button" data-dec="${line.item.id}" aria-label="Remove one ${esc(line.item.name)}">−</button>
            <span class="qty-value">${line.qty}</span>
            <button class="qty-button" type="button" data-add="${line.item.id}" aria-label="Add another ${esc(line.item.name)}">+</button>
          </span>
        </div>`).join("")
    : `<div class="drawer-empty"><span aria-hidden="true">🧁</span><p>Your box is waiting for something sweet.</p></div>`;
}

bag.onChange((snapshot) => {
  contextReady = generateContext({ cart: snapshot }).then((context) => {
    storefrontContext = context;
    return context;
  });
  renderBox(snapshot);
});

function openBag(open) {
  drawer.hidden = !open;
  scrim.hidden = !open;
  bagButton.setAttribute("aria-expanded", String(open));
  document.body.style.overflow = open ? "hidden" : "";
  if (open) $("[data-close-bag]").focus();
}

bagButton.addEventListener("click", () => openBag(drawer.hidden));
$("[data-close-bag]").addEventListener("click", () => openBag(false));
scrim.addEventListener("click", () => openBag(false));

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!drawer.hidden) openBag(false);
  else if (!supportPanel.hidden) openSupport(false);
});

document.addEventListener("click", (event) => {
  const dec = event.target.closest("[data-dec]");
  if (dec) bag.remove(dec.dataset.dec);
});

$("[data-clear-bag]").addEventListener("click", () => {
  bag.clear();
  toast("Box emptied");
});

$("[data-checkout]").addEventListener("click", () => {
  if (bag.getCount() === 0) return toast("Add something sweet first");
  checkoutSummary.textContent = `${latestBox.count} treat${latestBox.count === 1 ? "" : "s"} · ${money(latestBox.subtotal)}`;
  syncFulfillmentOptions();
  checkoutDialog.showModal();
});

$("[data-checkout-close]").addEventListener("click", () => checkoutDialog.close());

$("[data-checkout-form]").addEventListener("submit", (event) => {
  event.preventDefault();
  const method = $("input[name=fulfillment]:checked", checkoutDialog).value;
  const windowLabel = $("select[name=window]", checkoutDialog).value;
  checkoutDialog.close();
  bag.clear();
  openBag(false);
  toast(`Demo order placed for ${method}, ${windowLabel.toLowerCase()}`);
});

/* ── Boot ──────────────────────────────────────────────────── */
renderMenu();

/* ── Header account state ──────────────────────────────────── */
(async function showAccount() {
  const link = $("[data-account-link]");
  if (!link) return;
  // The session lives in an HttpOnly cookie, so only the server can read it.
  const user = await currentUser();
  if (!user) return;

  link.href = homeFor(user);
  $("[data-account-label]").textContent = user.name.split(" ")[0];
  const avatar = $("[data-account-avatar]");
  avatar.textContent = user.initials;
  avatar.classList.add("is-signed-in");
  link.setAttribute("aria-label", `Your account, signed in as ${user.name}`);
})();
