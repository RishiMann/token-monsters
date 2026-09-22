/**
 * Agent routing layer.
 *
 * Every agent is an async function returning a structured response. The UI
 * only ever awaits `ask(agentId, input)`, so swapping these local heuristics
 * for real model calls is a change inside this file and nowhere else.
 *
 * Response shape: { agent, message, items?, chips?, note? }
 */

import { fullMenu, weeklyMenu, eventMenus, agents as roster } from "./data.js";

/** Simulated round-trip so the UI exercises its real loading states. */
const think = (ms = 420) => new Promise((resolve) => setTimeout(resolve, ms));

const byId = (id) => fullMenu.find((item) => item.id === id);

/** Occasion -> curated picks, with a sentence explaining the choice. */
const OCCASION_PICKS = {
  "just-because": {
    ids: ["brown-butter", "lemon-cloud"],
    line: "Something buttery and something bright — the pairing people finish without meaning to."
  },
  birthday: {
    ids: ["pink-velvet", "strawberry-stack"],
    line: "Candles go in the Pink Velvet. The Shortcake is there so the table keeps talking about it."
  },
  "dinner-party": {
    ids: ["midnight-fudge", "lemon-cloud"],
    line: "A rich close and a clean one, so guests can pick by how the meal went."
  },
  "thank-you": {
    ids: ["biscoff", "brown-butter"],
    line: "Warm, familiar flavors. This reads as thoughtful without reading as expensive."
  },
  office: {
    ids: ["brown-butter", "coconut-matcha", "lemon-cloud"],
    line: "Crowd-safe, one plant-based, nothing that needs a fork. Desk-friendly on purpose."
  },
  kids: {
    ids: ["pink-velvet", "strawberry-stack", "midnight-fudge"],
    line: "Bright colors, no citrus tang, and every one of them survives being carried around."
  }
};

/** Keyword hints for free-text concierge input. */
const KEYWORD_HINTS = [
  { match: /vegan|plant|dairy.?free/i, ids: ["coconut-matcha", "almond-fig"], line: "Both of these are fully plant-based and stay good for a day." },
  { match: /chocolate|fudge|cocoa/i, ids: ["midnight-fudge", "brown-butter"], line: "Deep cocoa first, then a salted chip to keep it from getting heavy." },
  { match: /fruit|berry|citrus|lemon|strawberr/i, ids: ["lemon-cloud", "strawberry-stack"], line: "Fruit-forward and lighter — good after a big meal." },
  { match: /nut/i, ids: ["pink-velvet", "lemon-cloud"], line: "These two are made on a nut-free line. I've left the almond tart out." },
  { match: /wedding|anniversar|engagement/i, ids: ["pink-velvet", "strawberry-stack"], line: "Soft palette, photographs well, and both scale to a large tray." },
  { match: /coffee|espresso|brunch/i, ids: ["biscoff", "brown-butter"], line: "Built to sit next to coffee without competing with it." }
];

const pick = (ids) => ids.map(byId).filter(Boolean);

const recommendation = async ({ occasion, text } = {}) => {
  await think();

  if (occasion && OCCASION_PICKS[occasion]) {
    const { ids, line } = OCCASION_PICKS[occasion];
    return { agent: "recommendation", message: line, items: pick(ids) };
  }

  if (text) {
    const hit = KEYWORD_HINTS.find((hint) => hint.match.test(text));
    if (hit) return { agent: "recommendation", message: hit.line, items: pick(hit.ids) };
  }

  const top = [...weeklyMenu].sort((a, b) => b.rating - a.rating).slice(0, 2);
  return {
    agent: "recommendation",
    message: "Here's what the corner is loving this week. Tell me the occasion and I'll get more specific.",
    items: top
  };
};

/**
 * Party sizing. Real catering math: roughly 1.5 servings a head, rounded up to
 * whole boxes, with variety scaling to group size rather than staying fixed.
 */
const planner = async ({ guests = 12, vibe = "classic", dietary = [] } = {}) => {
  await think(520);

  const servings = Math.ceil(guests * 1.5);
  const boxes = Math.ceil(servings / 6);
  const varietyCount = Math.min(6, Math.max(3, Math.round(guests / 4)));

  let pool = [...weeklyMenu];
  if (dietary.includes("vegan")) pool = fullMenu.filter((item) => item.tags.includes("vegan")).concat(pool);
  if (dietary.includes("nut-free")) pool = pool.filter((item) => !item.allergens.includes("tree nut"));

  const vibePriority = {
    classic: ["brown-butter", "pink-velvet", "strawberry-stack"],
    bold: ["midnight-fudge", "biscoff", "brown-butter"],
    garden: ["lemon-cloud", "strawberry-stack", "coconut-matcha"],
    cozy: ["biscoff", "midnight-fudge", "pink-velvet"]
  }[vibe] || [];

  const ordered = [
    ...vibePriority.map(byId).filter((item) => item && pool.includes(item)),
    ...pool
  ];
  const seen = new Set();
  const items = ordered.filter((item) => item && !seen.has(item.id) && seen.add(item.id)).slice(0, varietyCount);

  const subtotal = items.reduce((sum, item) => sum + item.price, 0) / items.length * servings;

  return {
    agent: "planner",
    message: `For ${guests} guests I'd plan ${servings} servings — that's ${boxes} box${boxes === 1 ? "" : "es"} across ${items.length} flavors.`,
    items,
    note: `Estimated subtotal $${subtotal.toFixed(2)} · leaves a little margin so nobody takes the last one.`,
    stats: { guests, servings, boxes, variety: items.length }
  };
};

const offers = async ({ basketSize = 0 } = {}) => {
  await think(300);
  return {
    agent: "offers",
    message: basketSize >= 6
      ? "Your box is full — the party upgrade is the better value from here."
      : "Three offers are live for you right now, each tied to something you've actually done.",
    note: "Offers are reasoned per customer. No blanket codes."
  };
};

const support = async ({ text = "" } = {}) => {
  await think(380);

  if (/allergen|nut|gluten|dairy|vegan/i.test(text)) {
    return {
      agent: "support",
      message: "Every item lists its allergens on the card. Our nut-free line covers Pink Velvet, Lemon Glaze Cloud and Brown Butter Chip. Want me to filter the menu to just those?",
      chips: ["Show nut-free", "Show plant-based", "Talk to a person"]
    };
  }
  if (/where|order|status|track|pickup|late/i.test(text)) {
    return {
      agent: "support",
      message: "I can pull up live order status once you're signed in. Orders usually move from oven to counter in about 20 minutes.",
      chips: ["Track my order", "Change pickup time", "Talk to a person"]
    };
  }
  if (/refund|wrong|missing|cold|broken/i.test(text)) {
    return {
      agent: "support",
      message: "Sorry — that shouldn't happen. I can remake the item on your next pickup or refund it outright. Which would you prefer?",
      chips: ["Remake it", "Refund it", "Talk to a person"]
    };
  }
  if (/franchise|supply|inventory|wholesale/i.test(text)) {
    return {
      agent: "support",
      message: "Franchise supply ordering lives in the partner portal — the Inventory Agent handles reorder points per location.",
      chips: ["Open franchise portal", "Talk to a person"]
    };
  }

  return {
    agent: "support",
    message: "Happy to help. I can answer allergens, order status, subscriptions and party sizing — or hand you to someone at your local corner.",
    chips: ["Allergens", "Track my order", "Subscriptions", "Talk to a person"]
  };
};

const seasonal = async () => {
  await think(300);
  const live = eventMenus.find((menu) => menu.status === "live") || eventMenus[0];
  return {
    agent: "seasonal",
    message: `${live.name} is live through ${live.window.split("–")[1].trim()}. ${live.blurb}`,
    note: live.highlights.join(" · ")
  };
};

const orders = async ({ text = "" } = {}) => {
  await think(460);
  const mentioned = fullMenu.filter((item) =>
    text.toLowerCase().includes(item.name.toLowerCase().split(" ")[0].toLowerCase())
  );
  if (mentioned.length) {
    return {
      agent: "orders",
      message: `Got it — ${mentioned.map((item) => item.name).join(" and ")} added. Pickup or delivery?`,
      items: mentioned,
      chips: ["Pickup", "Delivery"]
    };
  }
  return {
    agent: "orders",
    message: "Tell me what you'd like and I'll build the box. You can say things like \"two chocolate, one lemon, pickup at six\".",
    chips: ["This week's six", "Repeat last order"]
  };
};

const HANDLERS = { recommendation, planner, offers, support, seasonal, orders };

/** Single entry point the UI calls. Unknown ids fall back to support. */
export async function ask(agentId, input = {}) {
  const handler = HANDLERS[agentId] || support;
  return handler(input);
}

export const agentMeta = (id) => roster.find((agent) => agent.id === id);
