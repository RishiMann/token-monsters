/**
 * The Corner Concierge.
 *
 * The rule-based half of the one chat surface. It pulls entities out of what
 * someone types (guest counts, allergens, budgets, occasions, dates, cravings),
 * keeps them across turns, decides which capability answers, and reports the
 * steps it actually took. When a model is configured on the server, agents.js
 * sends the turn there first and only falls back to this.
 *
 * Every pick comes from the recommendation engine and every offer from the
 * offer rules, so the chat never contradicts the storefront around it.
 */

import { fullMenu, plans, seasonalMenus, eventMenus, occasionLabels } from "./data.js";
import { recommend, offersFor, familiesIn, itemsForCraving } from "./agent-engine.js";
import { upcomingReleases } from "./seasons.js";

/** What the concierge remembers within a conversation. */
const memory = {
  guests: null,
  avoid: [],
  occasion: null,
  budget: null,
  date: null,
  likes: [],
  lastItems: [],
  turns: 0
};

export function conversationMemory() {
  return { ...memory, avoid: [...memory.avoid], likes: [...memory.likes] };
}

export function resetMemory() {
  Object.assign(memory, { guests: null, avoid: [], occasion: null, budget: null,
                          date: null, likes: [], lastItems: [], turns: 0 });
}

/** The word for each allergen, and the ingredients that imply it. */
const ALLERGEN_WORDS = {
  "tree nut": /\b(tree ?nuts?|nuts?|almonds?|pecans?|walnuts?|hazelnuts?|pistachios?|coconut)\b/i,
  peanut: /\b(peanuts?|peanut butter)\b/i,
  dairy: /\b(dairy|milk|lactose|cream cheese|butter)\b/i,
  wheat: /\b(gluten|wheat|celiac|coeliac)\b/i,
  egg: /\b(eggs?)\b/i,
  soy: /\b(soy|soya)\b/i,
  sesame: /\b(sesame|tahini)\b/i
};

/** "nut-free", "no nuts", "nothing with nuts", "allergic to dairy", "avoid gluten". */
const NEGATION = /\b(no|without|avoid|avoiding|free|nothing with|none with|can'?t have|cannot have|can not have|allergic to|allergy to|allergies to|intolerant to|skip|exclude|minus)\b/i;

function allergensIn(text) {
  const found = [];
  for (const [name, pattern] of Object.entries(ALLERGEN_WORDS)) {
    const match = pattern.exec(text);
    if (!match) continue;
    // Look at the words either side: "nut-free" and "no nuts" both count,
    // "with nuts" on its own does not.
    const before = text.slice(Math.max(0, match.index - 28), match.index);
    const after = text.slice(match.index + match[0].length,
                             match.index + match[0].length + 12);
    if (NEGATION.test(before) || /^\s*[-\s]?free\b/i.test(after)) found.push(name);
  }
  return found;
}

/** What people say -> the occasion ids the catalog profiles use. */
const OCCASIONS = {
  kids: /\b(kids?|children|child|toddlers?|school)\b/i,
  birthday: /\b(birthday|candles|turning \d+)\b/i,
  "dinner-party": /\b(dinner|supper|guests? over|hosting|wedding|engagement|anniversary|holiday table|thanksgiving|christmas)\b/i,
  "thank-you": /\b(gift|present|thank you|thank-you|apolog|for my (mom|dad|boss|neighbou?r|teacher))\b/i,
  office: /\b(office|work|team|colleagues?|meeting|client|coworkers?)\b/i,
  "just-because": /\b(just me|myself|solo|treat myself|alone|just because)\b/i
};

const money = (value) => `$${value.toFixed(2)}`;
const label = (occasion) => occasionLabels[occasion] || occasion.replace(/-/g, " ");

/** Pulls every entity it can out of one message, and remembers them. */
function extract(text) {
  const found = { guests: null, avoid: [], occasion: null, budget: null, date: null, flavors: [] };
  const lower = (text || "").toLowerCase();

  const guests = lower.match(/\b(\d{1,3})\s*(people|guests?|persons?|kids?|friends?|folks?|of us|pax)\b/)
    || lower.match(/\bfor\s+(\d{1,3})\b/)
    || lower.match(/\bparty of\s+(\d{1,3})\b/);
  if (guests) found.guests = Math.min(parseInt(guests[1], 10), 300);

  found.avoid = allergensIn(text);
  for (const [name, pattern] of Object.entries(OCCASIONS)) {
    if (pattern.test(text)) { found.occasion = name; break; }
  }
  if (!found.occasion && /\b(part(y|ies)|celebration|gathering|shower)\b/i.test(text)) {
    found.occasion = found.guests && found.guests <= 8 ? "dinner-party" : "birthday";
  }
  found.flavors = familiesIn(text);

  const budget = lower.match(/\$\s?(\d{1,4})|\bunder\s+(\d{1,4})\b|\bbudget of\s+(\d{1,4})\b/);
  if (budget) found.budget = parseInt(budget[1] || budget[2] || budget[3], 10);

  const day = lower.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this weekend|next week)\b/);
  if (day) found.date = day[1];

  // Carry it forward: constraints stated once should not need repeating.
  if (found.guests) memory.guests = found.guests;
  if (found.avoid.length) memory.avoid = [...new Set([...memory.avoid, ...found.avoid])];
  if (found.occasion) memory.occasion = found.occasion;
  if (found.budget) memory.budget = found.budget;
  if (found.date) memory.date = found.date;
  if (found.flavors.length) memory.likes = found.flavors; // the latest craving wins

  return found;
}

const CONSTRAINT_LINE = () => {
  const parts = [];
  if (memory.guests) parts.push(`${memory.guests} guests`);
  if (memory.avoid.length) parts.push(`no ${memory.avoid.join(", no ")}`);
  if (memory.occasion) parts.push(label(memory.occasion));
  if (memory.budget) parts.push(`under $${memory.budget}`);
  if (memory.date) parts.push(memory.date);
  return parts.join(" · ");
};

/** Everything the engine and the offer rules need from the page. */
let extras = { context: null, signedIn: false };

// ── Capabilities ─────────────────────────────────────────────────────────

function answerParty(text, cart) {
  const guests = memory.guests || 12;
  const perGuest = 1.5;
  const treats = Math.ceil(guests * perGuest);
  const boxes = Math.ceil(treats / 6);
  const variety = Math.min(6, Math.max(3, Math.round(guests / 4)));

  // Spread picks come from the engine so the same reasoning applies here.
  const engine = recommend([], { avoid: memory.avoid, occasion: memory.occasion, limit: variety, context: extras.context });
  let chosen = engine.items.map((pick) => pick.item);
  if (memory.likes.length) {
    const craved = itemsForCraving(memory.likes.join(" ")).filter((item) =>
      !memory.avoid.some((allergen) => (item.allergens || []).includes(allergen)));
    chosen = [...craved, ...chosen].filter((item, index, all) => all.findIndex((c) => c.id === item.id) === index).slice(0, variety);
  }
  if (memory.budget) {
    const within = chosen.filter((item) => item.price <= memory.budget);
    if (within.length) chosen = within;
  }
  const average = chosen.reduce((sum, item) => sum + item.price, 0) / (chosen.length || 1);
  const estimate = average * treats;
  const overBudget = memory.budget && estimate > memory.budget;

  const trace = [
    `Parsed ${guests} guests from the conversation`,
    `Sized at ${perGuest} treats per guest → ${treats} treats, ${boxes} six-count boxes`,
    memory.avoid.length ? `Excluded anything containing ${memory.avoid.join(", ")}` : "No allergen filter set",
    `Picked ${chosen.length} flavors to spread across`
  ];

  return {
    message: `For ${guests} people I'd plan ${treats} treats — ${boxes} six-count box${boxes === 1 ? "" : "es"}. `
      + `That runs about ${money(estimate)}${overBudget ? `, which is over your $${memory.budget} budget` : ""}. `
      + (overBudget
        ? `Dropping to one treat each brings it to about ${money(estimate / perGuest)}.`
        : `A spread of ${chosen.length} flavors keeps everyone happy without decision fatigue.`),
    items: chosen,
    trace,
    chips: ["Add this spread to my box", "Make it nut-free", "What about delivery?", "Cheaper option"]
  };
}

function answerRecommend(text, cart) {
  const avoid = memory.avoid;
  const engine = recommend(cart, { avoid, limit: 3, occasion: memory.occasion, context: extras.context });
  let items = engine.items.map((pick) => pick.item);

  // A stated craving narrows the picks to that flavor family when it can.
  if (memory.likes.length) {
    const craved = itemsForCraving(memory.likes.join(" "))
      .filter((item) => !cart.some((line) => line.item.id === item.id))
      .filter((item) => !avoid.some((allergen) => (item.allergens || []).includes(allergen)))
      .filter((item) => !memory.budget || item.price <= memory.budget)
      .sort((a, b) => b.rating - a.rating);
    if (craved.length) items = [...craved.slice(0, 2), ...items].filter((item, index, all) =>
      all.findIndex((c) => c.id === item.id) === index).slice(0, 3);
  }
  if (memory.budget) items = items.filter((item) => item.price <= memory.budget).length
    ? items.filter((item) => item.price <= memory.budget) : items;
  memory.lastItems = items;

  const trace = [
    cart.length
      ? `Read your box: ${cart.map((line) => line.item.name).join(", ")}`
      : "Your box is empty — starting from this week's ratings",
    memory.likes.length ? `You asked for ${memory.likes.join(", ")}` : "No flavor steer yet",
    avoid.length ? `Excluded anything with ${avoid.join(", ")}` : "No allergens to avoid",
    ...engine.trace.slice(1, 3)
  ];

  const lead = engine.items.find((pick) => pick.item.id === items[0]?.id);
  if (!items.length) {
    return {
      message: "Nothing on the counter fits all of that at once. Loosen one constraint and I'll try again.",
      items: [], trace,
      chips: ["Show everything", "Nut-free options", "What's seasonal?"]
    };
  }
  return {
    message: cart.length && lead
      ? `Going off what's already in your box, I'd add ${items[0].name}. ${lead.reason}.`
      : `Here's where I'd start${memory.likes.length ? ` for something ${memory.likes[0] === "cocoa" ? "chocolatey" : memory.likes[0]}` : ""}. `
        + `${items[0].name} is the one people come back for.`,
    items,
    trace,
    chips: ["Add the first one", "Something lighter", "Make it nut-free", "What's on the seasonal menu?"]
  };
}

function answerAllergen(text) {
  const entities = extract(text);
  const avoid = memory.avoid.length ? memory.avoid : entities.avoid;
  const safe = fullMenu.filter((item) => !avoid.some((allergen) => (item.allergens || []).includes(allergen)));
  const excluded = fullMenu.length - safe.length;

  return {
    message: avoid.length
      ? `${safe.length} of ${fullMenu.length} flavors are clear of ${avoid.join(" and ")}. `
        + `I've taken ${excluded} off the list. Every tray is finished on a shared line, so I flag traces rather than promise a clean room.`
      : `Tell me what to avoid — nuts, peanuts, dairy, gluten, egg, soy or sesame — and I'll filter the menu and keep it applied for the rest of this chat.`,
    items: safe.slice(0, 3),
    trace: [
      `Read allergen tags on all ${fullMenu.length} items on sale`,
      avoid.length ? `Matched ${avoid.join(", ")} against every ingredient list` : "Waiting on an allergen to filter by",
      `${safe.length} items cleared`
    ],
    chips: ["Nut-free", "Dairy-free", "Gluten-free", "Show plant-based"]
  };
}

function answerSeasonal() {
  const live = seasonalMenus.filter((menu) => menu.state === "live");
  const next = upcomingReleases(eventMenus, new Date(), { limit: 2 });
  const onCounter = live.flatMap((menu) => menu.released);

  const parts = [];
  if (live.length) {
    parts.push(`${live.map((menu) => menu.name).join(" and ")} ${live.length === 1 ? "is" : "are"} on the counter now — `
      + `${onCounter.map((item) => item.name).join(", ")}.`);
  } else {
    parts.push("No seasonal menu is live this week.");
  }
  if (next.length) {
    parts.push(`Next up: ${next.map(({ item, date, daysUntil }) =>
      `${item.name} on ${formatDate(date)}${daysUntil > 0 ? ` (${daysUntil} day${daysUntil === 1 ? "" : "s"} out)` : ""}`).join(", then ")}.`);
  }

  return {
    message: parts.join(" "),
    items: onCounter.slice(0, 3),
    trace: [
      `Checked ${seasonalMenus.length} seasonal menus against today's date`,
      live.length ? `${live.map((m) => m.name).join(", ")} inside ${live.length === 1 ? "its" : "their"} window` : "No menu is inside its window",
      next.length ? `Next release: ${next[0].item.name} on ${formatDate(next[0].date)}` : "No upcoming releases scheduled"
    ],
    chips: ["Add a seasonal treat", "When is the holiday menu?", "Show the calendar"]
  };
}

function answerLogistics(text) {
  if (/\bdeliver|shipping|drop.?off\b/i.test(text)) {
    return {
      message: "Delivery runs within 5 miles of your corner, usually 30–45 minutes. It's free over $45, otherwise $6.95. Pick a window at checkout and the box is made to order against it.",
      trace: ["Read the delivery policy for your corner"],
      chips: ["Build a delivery box", "How does pickup work?", "What are your hours?"]
    };
  }
  if (/\bpickup|pick up|takeout|take.?away|counter\b/i.test(text)) {
    return {
      message: "Pickup is ready in about 20 minutes at Frisco Corner, and we hold a finished box for 30 minutes past your window. Order ahead and it's boxed before you arrive.",
      trace: ["Read the pickup policy for Frisco Corner"],
      chips: ["Build a pickup box", "Can you deliver?", "What are your hours?"]
    };
  }
  return {
    message: "Frisco Corner is open Monday–Saturday 8:00am–8:00pm, and Sunday 9:00am–4:00pm. Pickup windows run the whole time we're open.",
    trace: ["Read opening hours for Frisco Corner"],
    chips: ["Plan a pickup", "Plan a delivery", "See this week's menu"]
  };
}

function answerOffers(cart) {
  const count = cart.reduce((sum, line) => sum + line.qty, 0);
  const subtotal = cart.reduce((sum, line) => sum + line.item.price * line.qty, 0);
  const evaluated = offersFor({ lines: cart, count, subtotal }, extras);
  const eligible = evaluated.filter((offer) => offer.eligible && !offer.auto);
  const delivery = evaluated.find((offer) => offer.auto);
  const nearest = evaluated.filter((offer) => !offer.eligible && !offer.auto)
    .sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))[0];

  let message;
  if (count === 0) {
    message = "Offers here are earned, not blanket codes. Put something in your box and I'll price what it unlocks — "
      + "a bundle rate on the six-count, $1.50 off seasonal treats, a free flight past a dozen, and free delivery over $45.";
  } else if (eligible.length) {
    message = `Your box is ${money(subtotal)}. You've earned ${eligible.map((offer) =>
      `${offer.title.toLowerCase()} (${offer.discount > 0 ? `saves ${money(offer.discount)}` : offer.value.toLowerCase()})`).join(" and ")}. `
      + `Apply it from the offers rail and it comes off at checkout.`
      + (delivery?.eligible ? " Free delivery is on too." : "");
  } else {
    message = `Your box is ${money(subtotal)} and nothing has unlocked yet. `
      + (nearest ? `Closest: ${nearest.title.toLowerCase()} — ${nearest.why}` : "")
      + (delivery && !delivery.eligible ? ` ${delivery.why}` : "");
  }

  return {
    message,
    trace: [
      `Read your box: ${count} item${count === 1 ? "" : "s"}, ${money(subtotal)}`,
      `Checked ${evaluated.length} offer rules against it`,
      `${eligible.length} eligible right now`
    ],
    chips: eligible.length ? ["Take me to checkout", "What else could I unlock?", "Show subscriptions"]
      : ["Fill the six-count", "Add a seasonal treat", "Show subscriptions"]
  };
}

function answerPlans() {
  return {
    message: `Three plans: ${plans.map((plan) => `${plan.name} at $${plan.price}/${plan.cadence}`).join(", ")}. `
      + "All of them skip, swap or pause from your account before the next drop, and the concierge fills the box if you'd rather not choose.",
    trace: ["Read the current plan tiers"],
    chips: ["Which plan fits me?", "Can I pause it?", "Build a one-time box instead"]
  };
}

function answerPopular() {
  const popular = (extras.context?.market?.popular || []).map((entry) => entry.item).filter(Boolean);
  const top = popular.length ? popular.slice(0, 3) : [...fullMenu].sort((a, b) => b.rating - a.rating).slice(0, 3);
  return {
    message: `This week it's ${top.map((item) => `${item.name} (${item.rating}★)`).join(", ")}. `
      + `${top[0].name} is the one the counter sells the most of.`,
    items: top,
    trace: [popular.length ? "Read this week's order counts" : "Ranked the menu by rating"],
    chips: ["Add the top one", "Something less sweet", "What's seasonal?"]
  };
}

function answerOrder() {
  return {
    message: "Orders move from oven to counter in about 20 minutes. Sign in and your order history sits on your profile — live tracking appears there once an order is placed.",
    trace: ["Read the order pipeline timings"],
    chips: ["How does pickup work?", "Talk to a person", "See my favorites"]
  };
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function answerCompare(text) {
  const mentioned = fullMenu.filter((item) =>
    new RegExp(`\\b${escapeRegex(item.name.split(" ")[0])}\\b`, "i").test(text));
  if (mentioned.length < 2) {
    return {
      message: "Name two and I'll put them side by side — richness, texture, what each one is for.",
      trace: ["Looked for two menu items in the message", "Found fewer than two"],
      chips: ["Midnight Fudge or Brown Butter?", "Lemon Cloud or Strawberry?"]
    };
  }
  const [first, second] = mentioned;
  const richer = (first.profile?.rich ?? 2) >= (second.profile?.rich ?? 2) ? first : second;
  const lighter = richer === first ? second : first;
  return {
    message: `${first.name} (${first.rating}★, ${money(first.price)}) is ${first.blurb.toLowerCase()}. `
      + `${second.name} (${second.rating}★, ${money(second.price)}) is ${second.blurb.toLowerCase()}. `
      + `${richer.name} is the richer of the two; ${lighter.name} is the lighter finish. In a mixed box, take ${first.rating >= second.rating ? first.name : second.name} — it rates higher.`,
    items: [first, second],
    trace: [`Matched ${first.name} and ${second.name} in your message`,
            "Compared rating, price, richness and flavor family"],
    chips: [`Add ${first.name}`, `Add ${second.name}`, "Add both"]
  };
}

function answerHelp() {
  return {
    message: "I can shortlist flavors for a craving or an occasion, size a party order, filter the whole menu for allergens, explain pickup and delivery, price what your box unlocks, and walk the seasonal calendar. Just say it plainly.",
    trace: ["Listed available capabilities"],
    chips: ["Plan a party for 20", "Something nut-free", "What's seasonal?", "What's popular?"]
  };
}

// ── Router ───────────────────────────────────────────────────────────────

const ROUTES = [
  [/\b(part(y|ies)|event|celebration|wedding|shower|crowd|guests?|people|headcount|feed)\b/i, answerParty],
  [/\b(allergen|allerg|nut|peanut|gluten|dairy|vegan|plant.?based|celiac|coeliac|egg|soy|sesame)\b/i, answerAllergen],
  [/\b(season|seasonal|holiday|harvest|lunar|graduation|calendar|limited|when is|when does|release)\b/i, answerSeasonal],
  [/\b(deliver|shipping|pickup|pick up|takeout|take.?away|hours?|open|close|address|location)\b/i, answerLogistics],
  [/\b(offers?|discounts?|deals?|coupons?|promos?|save|savings|cheap|cheaper|budget|price|cost|total)\b/i, answerOffers],
  [/\b(subscri\w*|plans?|weekly box|membership|pause|skip)\b/i, answerPlans],
  [/\b(popular|best.?sell|top|favorite|favourite|what.*most)\b/i, answerPopular],
  [/\b(order status|my order|track|where.*order|late|missing|refund)\b/i, answerOrder],
  [/\b(or\b.*\?|versus|vs\.?|compare|difference between|which is better)\b/i, answerCompare],
  [/\b(help|what can you do|how does this work|options)\b/i, answerHelp]
];

const GREETINGS = /^\s*(hi|hey|hello|yo|good (morning|afternoon|evening))\b/i;
const THANKS = /\b(thanks|thank you|cheers|appreciate)\b/i;

/**
 * One turn. Returns { message, items, trace, chips, held } — the same shape
 * the model-backed path returns, so the chat UI is agnostic to which one ran.
 *
 * `cart` is the box's lines; `page` carries { context, signedIn } from the
 * storefront so offers and history are judged the same way as on the page.
 */
export function respond(text = "", cart = [], page = {}) {
  extras = { context: page.context || null, signedIn: Boolean(page.signedIn) };
  memory.turns += 1;
  extract(text);

  if (GREETINGS.test(text) && text.trim().split(/\s+/).length <= 3) {
    return withConstraints({
      message: "Hi. Tell me the occasion, who's eating, or just a craving — I'll shortlist from today's menu and keep any constraints you give me.",
      trace: ["Opened a new conversation"],
      chips: ["Plan a party for 20", "Something chocolatey", "Nut-free options", "What's seasonal?"]
    });
  }

  if (THANKS.test(text) && text.trim().split(/\s+/).length <= 4) {
    return withConstraints({
      message: "Any time. I'll hold your constraints if you want to keep going.",
      trace: [CONSTRAINT_LINE() ? `Still holding: ${CONSTRAINT_LINE()}` : "Nothing to hold yet"],
      chips: ["Start a new box", "What's seasonal?", "Show offers"]
    });
  }

  for (const [pattern, handler] of ROUTES) {
    if (pattern.test(text)) return withConstraints(handler(text, cart));
  }

  return withConstraints(answerRecommend(text, cart));
}

/** Surfaces what the agent is still holding, which is what sells the memory. */
function withConstraints(reply) {
  const held = CONSTRAINT_LINE();
  return { ...reply, held: held || null, agent: "concierge" };
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`)
    .toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

/** The staged "work" shown while the answer is composed. */
export function toolTrace(reply) {
  return (reply.trace || []).slice(0, 4);
}
