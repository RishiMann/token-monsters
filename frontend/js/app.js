/**
 * Frosted Corner storefront wiring.
 *
 * Rendering is plain template strings against the data modules. The live
 * surfaces (picks, offers, the calendar, the concierge) all read from the
 * same engine and the same offer rules, so what the page shows, what the
 * chat says and what checkout charges never disagree.
 */

import {
  fullMenu, eventMenus, plans, reviews, reviewSummary, occasions, announcements,
  dataLoadError, findItem, isOnSale
} from "./data.js";
import { ask } from "./agents.js";
import * as bag from "./bag.js";
import { currentUser, homeFor } from "./auth.js";
import { generateContext } from "./context.js";
import { recommend, offersFor, receipt } from "./agent-engine.js";
import { resetMemory } from "./concierge.js";
import { initItemDetail, open as openItem } from "./item-detail.js";
import { initCalendar } from "./calendar.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape anything that originates from user input before it hits innerHTML. */
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );

const money = (value) => `$${Number(value).toFixed(2)}`;

/**
 * Pages share this script, so a block whose section is not on this page must
 * no-op rather than throw. Everything page-specific runs through here.
 */
function withEl(selector, run) {
  const el = document.querySelector(selector);
  if (el) run(el);
  return el;
}

/* ── Who is here, and what the agents know ──────────────────── */
let signedIn = false;
const userReady = currentUser().then((user) => {
  signedIn = Boolean(user);
  return user;
}).catch(() => null);

let storefrontContext = null;
let contextReady = generateContext().then((context) => {
  storefrontContext = context;
  return context;
});

const customer = () => ({ context: storefrontContext, signedIn });

const withContext = async (input = {}) => ({
  ...input,
  context: await contextReady,
  signedIn,
  appliedOffer: bag.appliedOffer()
});

/* ── Toast ─────────────────────────────────────────────────── */
const toastEl = $("[data-toast]");
let toastTimer;
function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2600);
}

/* ── Announcement rotator ──────────────────────────────────── */
(function rotateAnnouncements() {
  const slot = $("[data-announce]");
  if (!slot || !announcements.length) return;
  let i = 0;
  setInterval(() => {
    i = (i + 1) % announcements.length;
    slot.style.animation = "none";
    void slot.offsetWidth; // restart the entrance animation
    slot.style.animation = "";
    slot.textContent = announcements[i];
  }, 4200);
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
      <button class="product-rating" type="button"
              data-open-item="${item.id}" data-open-reviews
              aria-label="Read the ${(item.reviews || []).length} reviews for ${esc(item.name)}">
        ★ ${item.rating}
      </button>
      <img class="product-photo" data-art="${item.id}" data-open-item="${item.id}"
           src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy" width="400" height="300" tabindex="0" role="button" />
    </div>
    <div class="product-info">
      <h3><button class="product-name" type="button" data-open-item="${item.id}">${esc(item.name)}</button></h3>
      <p>${esc(item.blurb)}</p>
      ${item.nutrition ? `<p class="product-kcal">${item.nutrition.calories} cal · ${item.nutrition.servingGrams}g</p>` : ""}
      <div class="product-foot">
        <span class="product-price">${money(item.price)}</span>
        <button class="add-button" type="button" data-add="${item.id}"
                aria-label="Add ${esc(item.name)} to your box">+</button>
      </div>
    </div>
  </article>`;
}

function renderMenu(filter = "all") {
  if (!grid) return;
  const items = filter === "all"
    ? fullMenu
    : filter === "seasonal"
      ? fullMenu.filter((item) => item.season)
      : fullMenu.filter((item) => item.tags.includes(filter));
  grid.innerHTML = items.length
    ? items.map(productCard).join("")
    : (dataLoadError ? '<p class="menu-error">Failed to load menu. Please try again later.</p>' : "");
  if (gridEmpty) gridEmpty.hidden = items.length > 0 || Boolean(dataLoadError);
}

$$("[data-filter]").forEach((chip) =>
  chip.addEventListener("click", () => {
    $$("[data-filter]").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
    renderMenu(chip.dataset.filter);
  })
);

function addToBox(itemId, sourceEl) {
  const item = findItem(itemId);
  if (!item) return;
  if (!isOnSale(itemId)) {
    const when = item.releaseDate || item.seasonOpens;
    toast(`${item.name} releases ${new Date(`${when}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
    return;
  }
  bag.add(item);
  bag.flyToBag(sourceEl || $(`[data-art="${item.id}"]`) || bagButton, bagButton, item.emoji);
  toast(`${item.name} added to your box`);
}

/** One delegated handler covers every add button, including re-rendered ones. */
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-add]");
  if (!button) return;
  addToBox(button.dataset.add, $(`[data-art="${button.dataset.add}"]`) || button);
});

/* ── Offers — re-priced against the box on every change ─────── */
const offerRail = $("[data-offer-rail]");

function offerCard(offer, appliedId) {
  const applied = offer.id === appliedId;
  const state = offer.auto
    ? (offer.eligible ? "auto-on" : "auto")
    : applied ? "applied" : offer.eligible ? "eligible" : "locked";
  const status = {
    "auto-on": "On at checkout", auto: "Automatic", applied: "Applied",
    eligible: "Earned", locked: "Not yet"
  }[state];
  const showProgress = offer.progress != null && offer.progress < 100 && !offer.eligible;
  const action = offer.auto
    ? `<span class="offer-auto">Applies on its own with delivery</span>`
    : offer.eligible
      ? `<button class="chip${applied ? " is-active" : ""}" type="button" data-claim="${offer.id}"
                 aria-pressed="${applied}">${applied ? "Applied ✓ · remove" : "Apply"}</button>`
      : `<button class="chip" type="button" disabled aria-disabled="true" title="${esc(offer.why)}">Apply</button>`;
  return `
    <article class="offer-card tint-${offer.tint} state-${state}${offer.eligible ? " is-live" : ""}">
      <span class="offer-status status-${state}">${status}${offer.eligible && !offer.auto ? '<span class="offer-live-dot"></span>' : ""}</span>
      <span class="offer-emoji" aria-hidden="true">${offer.emoji}</span>
      <span class="offer-label">${esc(offer.label)}</span>
      <h3>${esc(offer.title)}</h3>
      <p class="offer-detail">${esc(offer.detail)}</p>
      ${showProgress ? `<div class="offer-progress" aria-hidden="true"><i style="width:${Math.min(offer.progress, 100)}%"></i></div>` : ""}
      <p class="offer-reason"><strong>${offer.eligible ? "Why this box earned it:" : "To unlock it:"}</strong> ${esc(offer.why)}</p>
      <div class="offer-foot">
        <span class="offer-value">${offer.eligible && offer.discount > 0 ? `Saves ${money(offer.discount)}` : esc(offer.value)}</span>
        ${action}
      </div>
    </article>`;
}

function renderOffers(snapshot) {
  if (!offerRail) return;
  const evaluated = offersFor(snapshot, customer());
  const applied = snapshot.appliedOffer;

  // An applied offer the box no longer qualifies for comes off, and says so.
  if (applied) {
    const still = evaluated.find((offer) => offer.id === applied);
    if (!still || !still.eligible) {
      bag.removeOffer();
      toast(`${still?.title || "That offer"} no longer applies — the box changed`);
      return;
    }
  }
  offerRail.innerHTML = evaluated.map((offer) => offerCard(offer, applied)).join("");
}

document.addEventListener("click", (event) => {
  const claim = event.target.closest("[data-claim]");
  if (!claim || claim.disabled) return;
  const id = claim.dataset.claim;
  if (bag.appliedOffer() === id) {
    bag.removeOffer();
    toast("Offer removed");
    return;
  }
  const offer = offersFor(bag.snapshot(), customer()).find((entry) => entry.id === id);
  if (!offer?.eligible) {
    toast(offer?.why || "That offer doesn't apply to this box yet");
    return;
  }
  const swapped = bag.appliedOffer();
  bag.applyOffer(id);
  toast(swapped
    ? `Switched to ${offer.title.toLowerCase()} — one discount at a time`
    : `${offer.title} applied · comes off at checkout`);
});

/* ── Picked for you — the Recommendation Agent, live ────────── */
const picksPanel = $("[data-picks]");
const picksRow = $("[data-picks-row]");
const picksTrace = $("[data-picks-trace]");

function renderPicks(snapshot) {
  if (!picksPanel || !picksRow) return;
  const { items, trace, headline } = recommend(snapshot.lines, { limit: 3, context: storefrontContext });
  if (!items.length) { picksPanel.hidden = true; return; }

  picksPanel.hidden = false;
  $("[data-picks-headline]").textContent = headline;
  picksTrace.innerHTML = trace.map((step) => `<li>${esc(step)}</li>`).join("");

  picksRow.innerHTML = items.map((pick, index) => `
    <article class="pick-card tint-${pick.item.tint}" style="animation-delay:${index * 70}ms">
      <img class="pick-photo" data-art="${pick.item.id}" src="${esc(pick.item.image)}"
           alt="${esc(pick.item.name)}" loading="lazy" width="400" height="300" data-open-item="${pick.item.id}" role="button" tabindex="0" />
      <div class="pick-body">
        <div class="pick-top">
          <strong>${esc(pick.item.name)}</strong>
          <span class="pick-confidence" title="How strongly the agent recommends this">${pick.confidence}%</span>
        </div>
        <p class="pick-reason">${esc(pick.reason)}</p>
        <div class="pick-foot">
          <span class="pick-price">${money(pick.item.price)}</span>
          <button class="chip chip-solid" type="button" data-add="${pick.item.id}">Add</button>
        </div>
      </div>
    </article>`).join("");
}

/** A beat of "thinking" before the new answer, so the work reads as work. */
let agentTimer = null;
function refreshAgents(snapshot) {
  if (!picksPanel && !offerRail) return;
  clearTimeout(agentTimer);
  picksPanel?.classList.add("is-thinking");
  offerRail?.classList.add("is-thinking");
  agentTimer = setTimeout(() => {
    if (picksPanel) renderPicks(snapshot);
    renderOffers(snapshot);
    picksPanel?.classList.remove("is-thinking");
    offerRail?.classList.remove("is-thinking");
  }, 380);
}

$("[data-picks-trace-toggle]")?.addEventListener("click", (event) => {
  const open = picksTrace.hidden;
  picksTrace.hidden = !open;
  event.currentTarget.setAttribute("aria-expanded", String(open));
  event.currentTarget.textContent = open ? "Hide reasoning" : "How it decided";
});

/* ── Seasonal calendar ─────────────────────────────────────── */
withEl("[data-calendar]", (el) => {
  initCalendar(el, { menus: eventMenus, onOpenItem: (id) => openItem(id) });
});

/* ── Plans ─────────────────────────────────────────────────── */
withEl("[data-plan-grid]", (el) => { el.innerHTML = plans.map((plan) => `
  <article class="plan-card${plan.featured ? " is-featured" : ""}">
    ${plan.featured ? '<span class="plan-flag">Most popular</span>' : ""}
    <h3>${esc(plan.name)}</h3>
    <div class="plan-price"><strong>$${plan.price}</strong><span>/ ${plan.cadence}</span></div>
    <p class="plan-pitch">${esc(plan.pitch)}</p>
    <ul class="plan-perks">${plan.perks.map((perk) => `<li>${esc(perk)}</li>`).join("")}</ul>
    <button class="button ${plan.featured ? "button-light" : "button-ghost"}" type="button"
            data-subscribe="${esc(plan.name)}">Choose ${esc(plan.name)}</button>
  </article>`).join(""); });

document.addEventListener("click", (event) => {
  const sub = event.target.closest("[data-subscribe]");
  if (sub) {
    $$('[data-subscribe]').forEach((button) => button.classList.remove("is-active"));
    sub.classList.add("is-active");
    toast(`${sub.dataset.subscribe} selected — sign in to manage your weekly box`);
  }
});

/* ── Reviews ───────────────────────────────────────────────── */
withEl("[data-review-summary]", (el) => { el.innerHTML = `
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
  <p class="summary-watchout">${esc(reviewSummary.watchout)}</p>`; });

withEl("[data-review-grid]", (el) => { el.innerHTML = reviews.map((review) => `
  <article class="review-card${review.featured ? " is-featured" : ""} tint-${review.tint}">
    <span class="review-stars" aria-label="${review.stars} out of 5">${"★".repeat(review.stars)}${"☆".repeat(5 - review.stars)}</span>
    <p>${esc(review.body)}</p>
    <footer class="review-foot">
      <span class="review-avatar">${esc(review.initials)}</span>
      <span class="review-who"><strong>${esc(review.name)}</strong><small>${esc(review.verified)}</small></span>
    </footer>
  </article>`).join(""); });

/* ── Shared chat pieces (used by the concierge panel) ──────── */

function recStrip(items) {
  return `<div class="rec-strip">${items.map((item) => `
    <div class="rec-item tint-${item.tint}">
      ${item.image
        ? `<img class="rec-photo" src="${esc(item.image)}" alt="" loading="lazy" width="400" height="300" data-open-item="${item.id}" role="button" tabindex="0" />`
        : `<span class="rec-emoji" aria-hidden="true">${item.emoji}</span>`}
      <span class="rec-body"><strong>${esc(item.name)}</strong><small>${esc(item.blurb)}</small></span>
      ${isOnSale(item.id)
        ? `<button class="rec-add" type="button" data-add="${item.id}">Add</button>`
        : `<button class="rec-add rec-add-soon" type="button" data-open-item="${item.id}">Preview</button>`}
    </div>`).join("")}</div>`;
}

function replyChips(chips, attribute) {
  if (!chips?.length) return "";
  return `<div class="reply-chips">${chips.map((chip) =>
    `<button class="reply-chip" type="button" ${attribute}="${esc(chip)}">${esc(chip)}</button>`
  ).join("")}</div>`;
}

/** The concierge needs the live box; keep the latest snapshot to hand. */
let lastBag = { lines: [] };
bag.onChange((snapshot) => { lastBag = snapshot; });

/** What each occasion button says on the customer's behalf. */
const OCCASION_TEXT = {
  "just-because": "Just because — something for me",
  birthday: "It's a birthday",
  "dinner-party": "I'm hosting a dinner party",
  "thank-you": "It's a thank-you gift",
  office: "Something for the office",
  kids: "For a kids' party"
};

withEl("[data-occasion-grid]", (el) => { el.innerHTML = occasions.map((occ) => `
  <button class="occasion" type="button" data-occasion="${occ.id}">
    <span aria-hidden="true">${occ.emoji}</span>${esc(occ.label)}
  </button>`).join(""); });

initItemDetail({ onAdd: (itemId) => addToBox(itemId) });

/* ── Party planner (catering page only) ─────────────────────── */
// Scoped: the planner lives on catering.html, so skip it elsewhere.
if (document.querySelector("[data-guests]")) {
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

  document.querySelector("[data-plan]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Planning…";

    const reply = await ask("planner", await withContext({
      guests: Number(guestInput.value), vibe, dietary
    }));
    const stats = reply.stats || {
      guests: Number(guestInput.value),
      servings: Math.ceil(Number(guestInput.value) * 1.5),
      boxes: Math.ceil(Math.ceil(Number(guestInput.value) * 1.5) / 6),
      variety: (reply.items || []).length
    };

    plannerResult.innerHTML = `
      <p class="eyebrow"><span class="agent-dot tint-plum"></span>Planner result</p>
      <h3 style="margin-top:10px">${esc(reply.message)}</h3>
      <div class="planner-stats">
        <div><strong>${stats.guests}</strong><small>guests</small></div>
        <div><strong>${stats.servings}</strong><small>servings</small></div>
        <div><strong>${stats.boxes}</strong><small>boxes</small></div>
        <div><strong>${stats.variety}</strong><small>flavors</small></div>
      </div>
      ${recStrip(reply.items || [])}
      ${reply.note ? `<p class="planner-note">${esc(reply.note)}</p>` : ""}`;

    button.disabled = false;
    button.innerHTML = 'Plan my spread <span aria-hidden="true">→</span>';
  });
}

/* ── Corner Concierge — the one chatbot ─────────────────────── */
const supportPanel = $("[data-support-panel]");
const supportLog = $("[data-support-log]");
const supportFab = $("[data-support-open]");
let lastReplyItems = [];
let replying = false;

function supportBubble(html, from = "agent") {
  const el = document.createElement("div");
  el.className = `bubble from-${from}`;
  el.innerHTML = html;
  supportLog.appendChild(el);
  supportLog.scrollTop = supportLog.scrollHeight;
  return el;
}

function typingBubble() {
  const el = document.createElement("div");
  el.className = "bubble from-agent working";
  el.innerHTML = `<div class="typing" aria-label="Thinking"><span></span><span></span><span></span></div>`;
  supportLog.appendChild(el);
  supportLog.scrollTop = supportLog.scrollHeight;
  return el;
}

const greeting = () =>
  "Hi — I'm the Corner Concierge. Tell me the occasion, who's eating, or just a craving. "
  + "I'll remember anything you tell me: guests, allergies, budget."
  + replyChips(["Plan a party for 20", "Something chocolatey", "Nut-free options", "What's seasonal?"], "data-support-chip");

async function supportReply(text) {
  if (replying) return;
  replying = true;
  const typing = typingBubble();
  const input = $("[data-support-input]");
  if (input) input.disabled = true;

  let reply;
  try {
    reply = await ask("concierge", await withContext({ text, cart: lastBag.lines }));
  } catch (error) {
    console.error(error);
    reply = { message: "Something went wrong on my side. Try that again in a moment.", trace: [] };
  } finally {
    typing.remove();
    replying = false;
    if (input) { input.disabled = false; input.focus(); }
  }

  const items = (reply.items || []).map((item) => findItem(item.id) || item).filter(Boolean);
  lastReplyItems = items;

  supportBubble([
    `<div>${esc(reply.message)}</div>`,
    items.length ? recStrip(items) : "",
    reply.held ? `<small class="reply-held">Holding: ${esc(reply.held)}</small>` : "",
    reply.trace?.length
      ? `<details class="reply-trace"><summary>How it got there</summary><ol>${
          reply.trace.map((step) => `<li>${esc(step)}</li>`).join("")}</ol></details>`
      : "",
    reply.chips ? replyChips(reply.chips, "data-support-chip") : "",
    `<small class="bubble-source">${reply.source === "model" ? "Answered by the model" : "Answered by the menu rules"}</small>`
  ].join(""));
}

function openSupport(open) {
  if (!supportPanel || !supportFab) return;
  supportPanel.hidden = !open;
  supportFab.setAttribute("aria-expanded", String(open));
  if (open && !supportLog.childElementCount) supportBubble(greeting());
  if (open) $("[data-support-input]")?.focus();
}

supportFab?.addEventListener("click", () => openSupport(supportPanel.hidden));

/* Anything can open the concierge — a chip, a card, a link. */
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-concierge]")) openSupport(true);
});
document.querySelector("[data-support-close]")?.addEventListener("click", () => openSupport(false));
document.querySelector("[data-support-reset]")?.addEventListener("click", () => {
  resetMemory();
  lastReplyItems = [];
  supportLog.innerHTML = "";
  supportBubble(greeting());
  toast("Started a fresh conversation");
});

document.querySelector("[data-support-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("[data-support-input]");
  const text = input.value.trim();
  if (!text) return;
  supportBubble(esc(text), "user");
  input.value = "";
  supportReply(text);
});

/* Occasion buttons live in the panel and feed the same engine. */
withEl("[data-occasion-grid]", (el) => {
  el.addEventListener("click", (event) => {
    const button = event.target.closest("[data-occasion]");
    if (!button) return;
    el.querySelectorAll("[data-occasion]").forEach((b) => b.classList.remove("is-active"));
    button.classList.add("is-active");
    const text = OCCASION_TEXT[button.dataset.occasion] || button.textContent.trim();
    supportBubble(esc(text), "user");
    supportReply(text);
  });
});

/** Chips that act on the last answer do so directly instead of chatting. */
function handleChip(label) {
  const lower = label.toLowerCase();
  if (lower === "talk to a person") {
    supportBubble("Connecting you to your local corner — someone will pick this up shortly.");
    return true;
  }
  if (lower === "take me to checkout") { openSupport(false); openBag(true); return true; }
  if (lower === "show the calendar") {
    openSupport(false);
    $("[data-calendar]")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  }
  if (/^add (the first one|this spread to my box|both|the top one|a seasonal (box|treat))$/.test(lower)) {
    const picks = lower.startsWith("add the first one") || lower.startsWith("add the top one")
      ? lastReplyItems.slice(0, 1) : lastReplyItems;
    const added = picks.filter((item) => isOnSale(item.id));
    added.forEach((item) => bag.add(item));
    supportBubble(added.length
      ? `Added ${added.map((item) => item.name).join(", ")} to your box.`
      : "Nothing from that answer is on the counter yet.");
    if (added.length) bag.flyToBag(supportFab, bagButton, added[0].emoji);
    return true;
  }
  const named = lower.match(/^add (.+)$/);
  if (named) {
    const item = lastReplyItems.find((entry) => entry.name.toLowerCase() === named[1])
      || fullMenu.find((entry) => entry.name.toLowerCase() === named[1]);
    if (item && isOnSale(item.id)) {
      bag.add(item);
      supportBubble(`Added ${item.name} to your box.`);
      bag.flyToBag(supportFab, bagButton, item.emoji);
      return true;
    }
  }
  return false;
}

document.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-support-chip]");
  if (!chip) return;
  const label = chip.dataset.supportChip;
  supportBubble(esc(label), "user");
  if (!handleChip(label)) supportReply(label);
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
const checkoutReceipt = $(`[data-checkout-receipt]`);
const addressField = $(`[data-address-field]`);
let latestBox = { count: 0, subtotal: 0, lines: [], appliedOffer: null };

function fulfillment() {
  return $("input[name=fulfillment]:checked", checkoutDialog)?.value || "pickup";
}

function receiptRows(bill) {
  const rows = [`<div class="receipt-row"><span>Subtotal</span><span>${money(bill.subtotal)}</span></div>`];
  if (bill.applied) {
    rows.push(`<div class="receipt-row receipt-off"><span>${esc(bill.applied.title)}</span><span>−${money(bill.discount)}</span></div>`);
  }
  if (bill.addon) {
    rows.push(`<div class="receipt-row receipt-off"><span>${esc(bill.addon.name)} (worth ${money(bill.addon.value)})</span><span>Free</span></div>`);
  }
  if (bill.fulfillment === "delivery") {
    rows.push(`<div class="receipt-row${bill.deliveryFree ? " receipt-off" : ""}"><span>Delivery</span><span>${bill.deliveryFree ? "Free" : money(bill.deliveryFee)}</span></div>`);
  }
  rows.push(`<div class="receipt-row receipt-total"><span>Total</span><strong>${money(bill.total)}</strong></div>`);
  return rows.join("");
}

function renderCheckout() {
  if (!checkoutDialog) return;
  const bill = receipt(latestBox, { appliedId: latestBox.appliedOffer, fulfillment: fulfillment(), customer: customer() });
  if (checkoutSummary) {
    checkoutSummary.textContent = `${latestBox.count} treat${latestBox.count === 1 ? "" : "s"} · ${money(bill.subtotal)}`;
  }
  if (checkoutReceipt) checkoutReceipt.innerHTML = receiptRows(bill);
  return bill;
}

function syncFulfillmentOptions() {
  const selected = fulfillment();
  $$('input[name="fulfillment"]', checkoutDialog).forEach((input) =>
    input.closest(".fulfillment-option").classList.toggle("is-selected", input.checked)
  );
  if (addressField) {
    addressField.hidden = selected !== "delivery";
    addressField.querySelector("input").required = selected === "delivery";
  }
  renderCheckout();
}

checkoutDialog?.querySelectorAll('input[name="fulfillment"]').forEach((input) =>
  input.addEventListener("change", syncFulfillmentOptions)
);

function renderBox(snapshot) {
  latestBox = snapshot;
  $$("[data-bag-count]").forEach((el) => { el.textContent = snapshot.count; });
  if (!drawer) return;
  const { lines, count, subtotal, capacity } = snapshot;

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

  // The drawer shows the discount as soon as an offer is applied.
  const bill = receipt(snapshot, { appliedId: snapshot.appliedOffer, fulfillment: "pickup", customer: customer() });
  const offerLine = $("[data-drawer-offer]");
  if (offerLine) {
    offerLine.hidden = !bill.applied;
    offerLine.innerHTML = bill.applied
      ? `<span>${esc(bill.applied.title)}</span><strong>−${money(bill.discount)}</strong>
         <button class="text-button" type="button" data-claim="${bill.applied.id}">Remove</button>`
      : "";
  }
  const totalEl = $("[data-drawer-total]");
  if (totalEl) totalEl.textContent = money(bill.total);
  if (checkoutDialog?.open) renderCheckout();
}

bag.onChange((snapshot) => {
  contextReady = generateContext({ cart: snapshot }).then((context) => {
    storefrontContext = context;
    return context;
  });
  renderBox(snapshot);
});

function openBag(open) {
  if (!drawer) {
    if (open) location.assign("index.html#menu");
    return;
  }
  drawer.hidden = !open;
  scrim.hidden = !open;
  bagButton?.setAttribute("aria-expanded", String(open));
  document.body.style.overflow = open ? "hidden" : "";
  if (open) $("[data-close-bag]").focus();
}

bagButton?.addEventListener("click", () => openBag(drawer ? drawer.hidden : true));
document.querySelector("[data-close-bag]")?.addEventListener("click", () => openBag(false));
scrim?.addEventListener("click", () => openBag(false));

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (drawer && !drawer.hidden) openBag(false);
  else if (supportPanel && !supportPanel.hidden) openSupport(false);
});

document.addEventListener("click", (event) => {
  const dec = event.target.closest("[data-dec]");
  if (dec) bag.remove(dec.dataset.dec);
});

document.querySelector("[data-clear-bag]")?.addEventListener("click", () => {
  bag.clear();
  toast("Box emptied");
});

document.querySelector("[data-checkout]")?.addEventListener("click", () => {
  if (bag.getCount() === 0) return toast("Add something sweet first");
  syncFulfillmentOptions();
  checkoutDialog.showModal();
});

document.querySelector("[data-checkout-close]")?.addEventListener("click", () => checkoutDialog.close());

document.querySelector("[data-checkout-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const method = fulfillment();
  const windowLabel = $("select[name=window]", checkoutDialog).value;
  const bill = renderCheckout();
  checkoutDialog.close();
  bag.clear();
  openBag(false);
  toast(`Demo order placed for ${method}, ${windowLabel.toLowerCase()} · ${money(bill.total)}`
    + (bill.applied ? ` after ${bill.applied.title.toLowerCase()}` : ""));
});

/* ── Boot ──────────────────────────────────────────────────── */
renderMenu();
// Restore the box from the last visit, dropping anything no longer on sale.
bag.hydrate((id) => (isOnSale(id) ? findItem(id) : null));
bag.onChange(refreshAgents);
// Offers depend on who is signed in; re-price once that is known.
userReady.then(() => refreshAgents(bag.snapshot()));

/* ── Header account state ──────────────────────────────────── */
(async function showAccount() {
  const link = $("[data-account-link]");
  if (!link) return;
  // The session lives in an HttpOnly cookie, so only the server can read it.
  const user = await userReady;
  if (!user) return;

  link.href = homeFor(user);
  $("[data-account-label]").textContent = user.name.split(" ")[0];
  const avatar = $("[data-account-avatar]");
  avatar.textContent = user.initials;
  avatar.classList.add("is-signed-in");
  link.setAttribute("aria-label", `Your account, signed in as ${user.name}`);
})();

// Marks that the whole script ran; pages share it, so this is how a page
// says "nothing threw on the way down".
document.documentElement.dataset.appReady = "1";
