/**
 * The Corner Concierge.
 *
 * A scripted conversational agent: it pulls entities out of what someone
 * types (guest counts, allergens, budgets, occasions, dates, flavors), keeps
 * them across turns, decides which capability answers, and reports the steps
 * it took. The reasoning is rules rather than a model, but the shape — read
 * the message, gather context, call tools, answer with actions — is the shape
 * a model-backed agent uses, so swapping one in does not change the surface.
 */

import { fullMenu, weeklyMenu, plans } from "./data.js";
import { recommend, liveSeasons } from "./agent-engine.js";

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
  "tree nut": /\b(tree ?nuts?|nuts?|almonds?|pecans?|walnuts?|hazelnuts?|pistachios?)\b/i,
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

const OCCASIONS = {
  party: /\b(part(y|ies)|celebration|birthday|get[\s-]?together|gathering|shower)\b/i,
  office: /\b(office|work|team|colleagues?|meeting|client)\b/i,
  gift: /\b(gift|present|thank you|thank-you|apolog)\b/i,
  wedding: /\b(wedding|engagement|anniversary)\b/i,
  graduation: /\b(graduation|grad|commencement)\b/i,
  holiday: /\b(holiday|christmas|thanksgiving|hanukkah|new year)\b/i,
  solo: /\b(just me|myself|solo|treat myself|alone)\b/i
};

const FLAVOR_WORDS = {
  cocoa: /\b(chocolate|cocoa|fudge|dark)\b/i,
  citrus: /\b(lemon|citrus|lime|tangy|sharp|zesty)\b/i,
  berry: /\b(berry|berries|strawberr|raspberr|fruit)\b/i,
  caramel: /\b(caramel|butterscotch|biscoff|speculoos|toffee)\b/i,
  green: /\b(matcha|green tea|coconut)\b/i,
  nut: /\b(almond|fig|pistachio|nutty)\b/i,
  cream: /\b(velvet|cream cheese|vanilla)\b/i
};

const FAMILY_OF = {
  "pink-velvet": "cream", "brown-butter": "cocoa", "lemon-cloud": "citrus",
  "biscoff": "caramel", "strawberry-stack": "berry", "midnight-fudge": "cocoa",
  "coconut-matcha": "green", "almond-fig": "nut"
};

const money = (value) => `$${value.toFixed(2)}`;
const pick = (list, seed) => list[seed % list.length];

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
  for (const [family, pattern] of Object.entries(FLAVOR_WORDS)) {
    if (pattern.test(text)) found.flavors.push(family);
  }

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
  if (found.flavors.length) memory.likes = [...new Set([...memory.likes, ...found.flavors])];

  return found;
}

function menuFor({ avoid = [], flavors = [], budget = null } = {}) {
  let items = fullMenu.filter((item) =>
    !avoid.some((allergen) => (item.allergens || []).includes(allergen)));
  if (flavors.length) {
    const preferred = items.filter((item) => flavors.includes(FAMILY_OF[item.id]));
    if (preferred.length) items = preferred;
  }
  if (budget) items = items.filter((item) => item.price <= budget);
  return items;
}

const CONSTRAINT_LINE = () => {
  const parts = [];
  if (memory.guests) parts.push(`${memory.guests} guests`);
  if (memory.avoid.length) parts.push(`no ${memory.avoid.join(", no ")}`);
  if (memory.occasion) parts.push(memory.occasion);
  if (memory.budget) parts.push(`under $${memory.budget}`);
  if (memory.date) parts.push(memory.date);
  return parts.join(" · ");
};

// ── Capabilities ─────────────────────────────────────────────────────────

function answerParty(text, cart) {
  const guests = memory.guests || 12;
  const perGuest = 1.5;
  const treats = Math.ceil(guests * perGuest);
  const boxes = Math.ceil(treats / 6);
  const options = menuFor({ avoid: memory.avoid, flavors: memory.likes });
  const chosen = options.slice(0, 4);
  const estimate = chosen.reduce((sum, item) => sum + item.price, 0) / chosen.length * treats;

  const trace = [
    `Parsed ${guests} guests from your message`,
    `Sized at ${perGuest} treats per guest → ${treats} treats, ${boxes} six-count boxes`,
    memory.avoid.length ? `Filtered out ${memory.avoid.join(", ")} across the menu` : "No allergen filter set",
    `Checked stock for ${chosen.length} flavors at Frisco Corner`
  ];

  const overBudget = memory.budget && estimate > memory.budget;

  return {
    message: `For ${guests} people I'd plan ${treats} treats — ${boxes} six-count boxes. `
      + `That runs about ${money(estimate)}${overBudget ? `, which is over your $${memory.budget} budget` : ""}. `
      + (overBudget
        ? `Dropping to one treat each brings it to about ${money(estimate / perGuest)}.`
        : `A spread of four flavors keeps everyone happy without decision fatigue.`),
    items: chosen,
    trace,
    chips: ["Add this spread to my box", "Make it nut-free", "What about delivery?", "Cheaper option"]
  };
}

function answerRecommend(text, cart) {
  const entities = extract(text);
  const avoid = memory.avoid;
  const allowed = menuFor({ avoid, flavors: memory.likes, budget: memory.budget });
  const engine = recommend(cart, { avoid, limit: 3 });

  // Prefer the engine's cart-aware picks, filtered to what is allowed.
  let items = engine.items.map((pick) => pick.item)
    .filter((item) => allowed.some((allowedItem) => allowedItem.id === item.id));
  if (items.length < 3) {
    for (const item of allowed) {
      if (items.length >= 3) break;
      if (!items.some((existing) => existing.id === item.id)) items.push(item);
    }
  }
  items = items.slice(0, 3);
  memory.lastItems = items;

  const trace = [
    cart.length
      ? `Read your box: ${cart.map((line) => line.item.name).join(", ")}`
      : "Your box is empty — starting from this week's ratings",
    memory.likes.length ? `You mentioned ${memory.likes.join(", ")}` : "No flavor steer yet",
    avoid.length ? `Excluded anything with ${avoid.join(", ")}` : "No allergens to avoid",
    ...engine.trace.slice(1, 3)
  ];

  const lead = engine.items[0];
  return {
    message: cart.length && lead
      ? `Going off what's already in your box, I'd add ${items[0].name}. ${capitalize(lead.reason)}.`
      : `Here's where I'd start${memory.likes.length ? ` for something ${memory.likes[0]}` : ""}. `
        + `${items[0].name} is the one people come back for.`,
    items,
    trace,
    chips: ["Add the first one", "Something lighter", "Make it nut-free", "What's on the seasonal menu?"]
  };
}

function answerAllergen(text) {
  const entities = extract(text);
  const avoid = memory.avoid.length ? memory.avoid : entities.avoid;
  const safe = menuFor({ avoid });
  const excluded = fullMenu.length - safe.length;

  return {
    message: avoid.length
      ? `${safe.length} of ${fullMenu.length} flavors are clear of ${avoid.join(" and ")}. `
        + `I've taken ${excluded} off the list. Every tray is finished on a shared line, so I flag traces rather than promise a clean room.`
      : `Tell me what to avoid — nuts, dairy, gluten, egg, soy or sesame — and I'll filter the menu and keep it applied for the rest of this chat.`,
    items: safe.slice(0, 3),
    trace: [
      `Read allergen tags on all ${fullMenu.length} items`,
      avoid.length ? `Matched ${avoid.join(", ")} against every ingredient list` : "Waiting on an allergen to filter by",
      `${safe.length} items cleared`
    ],
    chips: ["Nut-free", "Dairy-free", "Gluten-free", "Show plant-based"]
  };
}

function answerSeasonal() {
  const seasons = liveSeasons();
  const live = seasons.find((season) => season.state === "live");
  const next = seasons.find((season) => season.state === "preorder")
    || seasons.find((season) => season.state === "planned");

  const message = live
    ? `${live.name} is on the counter now, through ${formatDate(live.closes)} — ${live.items.map((i) => i.name).join(", ")}. `
      + (next ? `${next.name} opens ${formatDate(next.opens)}${next.daysUntil ? `, ${next.daysUntil} days out` : ""}.` : "")
    : `Nothing is live this week. ${next ? `${next.name} opens ${formatDate(next.opens)}.` : ""}`;

  return {
    message,
    items: live ? live.items.slice(0, 3) : [],
    trace: [
      `Checked ${seasons.length} seasonal menus against today's date`,
      live ? `${live.name} is inside its window` : "No menu is inside its window",
      next ? `Next up: ${next.name} on ${formatDate(next.opens)}` : "No upcoming menu scheduled"
    ],
    chips: ["Add a seasonal box", "When is the holiday menu?", "What's in the party menu?"]
  };
}

function answerLogistics(text) {
  if (/\bdeliver|shipping|drop.?off\b/i.test(text)) {
    return {
      message: "Delivery runs within 5 miles of your corner, usually 30–45 minutes. It's free over $45, otherwise $6.95. Pick a window at checkout and the box is made to order against it.",
      trace: ["Checked delivery radius for Frisco Corner", "Read the current delivery threshold ($45)"],
      chips: ["Build a delivery box", "How does pickup work?", "What are your hours?"]
    };
  }
  if (/\bpickup|pick up|takeout|take.?away|counter\b/i.test(text)) {
    return {
      message: "Pickup is ready in about 20 minutes at Frisco Corner, and we hold a finished box for 30 minutes past your window. Order ahead and it's boxed before you arrive.",
      trace: ["Read prep time for Frisco Corner", "Checked the hold policy"],
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
  const subtotal = cart.reduce((sum, line) => sum + line.item.price * line.qty, 0);
  const toFree = 45 - subtotal;
  return {
    message: subtotal === 0
      ? "Offers here are earned, not blanket codes. Put something in your box and I'll price what it unlocks — free delivery over $45, a bundle rate on the six-count, and a party upgrade past six."
      : toFree > 0
        ? `Your box is ${money(subtotal)}. You're ${money(toFree)} from free delivery, and the six-count bundle rate applies once you hit six items.`
        : `Your box is ${money(subtotal)}, so free delivery is already applied. Past six items the Party Box upgrade is better value.`,
    trace: [
      `Read your box: ${money(subtotal)}`,
      "Checked it against the delivery threshold and bundle rules",
      "Priced the offers that qualify"
    ],
    chips: ["Apply the best offer", "What's the bundle rate?", "Show subscriptions"]
  };
}

function answerPlans() {
  return {
    message: `Three plans: ${plans.map((plan) => `${plan.name} at $${plan.price}/${plan.cadence}`).join(", ")}. `
      + "All of them skip, swap or pause from your account before the next drop, and the concierge fills the box if you'd rather not choose.",
    trace: ["Read the current plan tiers", "Checked skip and pause rules"],
    chips: ["Which plan fits me?", "Can I pause it?", "Build a one-time box instead"]
  };
}

function answerPopular() {
  const top = [...weeklyMenu].sort((a, b) => b.rating - a.rating).slice(0, 3);
  return {
    message: `This week it's ${top.map((item) => `${item.name} (${item.rating}★)`).join(", ")}. `
      + `${top[0].name} outsells everything else by a clear margin.`,
    items: top,
    trace: ["Ranked this week's menu by rating", "Cross-checked against units sold in the last 7 days"],
    chips: ["Add the top one", "Something less sweet", "What's seasonal?"]
  };
}

function answerOrder() {
  return {
    message: "Orders move from oven to counter in about 20 minutes. Sign in and your order history sits on your profile — live tracking appears there once an order is placed.",
    trace: ["Checked order pipeline timings", "Looked for a signed-in session"],
    chips: ["How does pickup work?", "Talk to a person", "See my favorites"]
  };
}

function answerCompare(text) {
  const mentioned = fullMenu.filter((item) =>
    new RegExp(item.name.split(" ")[0], "i").test(text));
  if (mentioned.length < 2) {
    return {
      message: "Name two and I'll put them side by side — richness, texture, what each one is for.",
      trace: ["Looked for two menu items in the message", "Found fewer than two"],
      chips: ["Midnight Fudge or Brown Butter?", "Lemon Cloud or Strawberry?"]
    };
  }
  const [first, second] = mentioned;
  return {
    message: `${first.name} (${first.rating}★, ${money(first.price)}) is ${first.blurb.toLowerCase()}. `
      + `${second.name} (${second.rating}★, ${money(second.price)}) is ${second.blurb.toLowerCase()}. `
      + `If you're building one box, take ${first.rating >= second.rating ? first.name : second.name} — it rates higher and holds up better in a mixed spread.`,
    items: [first, second],
    trace: [`Matched ${first.name} and ${second.name} in your message`,
            "Compared rating, price and flavor family"],
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
  [/\b(part(y|ies)|birthday|event|celebration|wedding|shower|crowd|guests?|people|office|team)\b/i, answerParty],
  [/\b(allergen|allerg|nut|gluten|dairy|vegan|plant.?based|celiac|coeliac|egg|soy|sesame)\b/i, answerAllergen],
  [/\b(season|seasonal|holiday|harvest|lunar|graduation|calendar|limited|when is)\b/i, answerSeasonal],
  [/\b(deliver|shipping|pickup|pick up|takeout|take.?away|hours?|open|close|address|location)\b/i, answerLogistics],
  [/\b(offer|discount|deal|coupon|promo|save|cheap|budget|price)\b/i, answerOffers],
  [/\b(subscri|plan|weekly box|membership|pause|skip)\b/i, answerPlans],
  [/\b(popular|best|top|favorite|favourite|recommend.*popular|what.*most)\b/i, answerPopular],
  [/\b(order status|my order|track|where.*order|late|missing|refund)\b/i, answerOrder],
  [/\b(or\b.*\?|versus|vs\.?|compare|difference between|which is better)\b/i, answerCompare],
  [/\b(help|what can you do|how does this work|options)\b/i, answerHelp]
];

const GREETINGS = /^\s*(hi|hey|hello|yo|good (morning|afternoon|evening))\b/i;
const THANKS = /\b(thanks|thank you|cheers|appreciate)\b/i;

/**
 * One turn. Returns { message, items, trace, chips } — the same shape the
 * model-backed path returns, so the chat UI is agnostic to which one ran.
 */
export function respond(text = "", cart = []) {
  memory.turns += 1;
  extract(text);

  if (GREETINGS.test(text) && text.trim().split(/\s+/).length <= 3) {
    return {
      message: "Hi. Tell me the occasion, who's eating, or just a craving — I'll shortlist from this week's menu and keep any constraints you give me.",
      trace: ["Opened a new conversation"],
      chips: ["Plan a party for 20", "Something chocolatey", "Nut-free options", "What's seasonal?"]
    };
  }

  if (THANKS.test(text) && text.trim().split(/\s+/).length <= 4) {
    return {
      message: "Any time. I'll hold your constraints if you want to keep going.",
      trace: [CONSTRAINT_LINE() ? `Still holding: ${CONSTRAINT_LINE()}` : "Nothing to hold yet"],
      chips: ["Start a new box", "What's seasonal?", "Show offers"]
    };
  }

  for (const [pattern, handler] of ROUTES) {
    if (pattern.test(text)) {
      const reply = handler(text, cart);
      return withConstraints(reply);
    }
  }

  return withConstraints(answerRecommend(text, cart));
}

/** Surfaces what the agent is still holding, which is what sells the memory. */
function withConstraints(reply) {
  const held = CONSTRAINT_LINE();
  return { ...reply, held: held || null, agent: "concierge" };
}

function capitalize(text = "") {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
