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
import { runRecommendationTools } from "./recommendation-tools.js";

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
  { match: /coffee|espresso|brunch/i, ids: ["biscoff", "brown-butter"], line: "Built to sit next to coffee without competing with it." },
  { match: /caramel|cookie|biscoff|spiced/i, ids: ["biscoff", "brown-butter"], line: "Toasty, familiar flavors with enough salt to keep the sweetness in check." },
  { match: /light|fresh|not too sweet/i, ids: ["lemon-cloud", "strawberry-stack"], line: "These are the lighter picks: bright fruit and a clean finish." },
  { match: /rich|decadent|indulgent/i, ids: ["midnight-fudge", "biscoff"], line: "For a proper treat, I'd start with these two richer flavors." }
];

const pick = (ids) => ids.map(byId).filter(Boolean);
const uniqueItems = (items) => items.filter((item, index, all) =>
  item && all.findIndex((candidate) => candidate.id === item.id) === index
);

const normalized = (text = "") => text.trim().toLowerCase();

const keywordItems = (text) => {
  const hits = KEYWORD_HINTS.filter((hint) => hint.match.test(text));
  return uniqueItems(hits.flatMap((hint) => pick(hint.ids))).slice(0, 3);
};

const serviceInfo = async ({ text = "" } = {}) => {
  await think(260);
  const query = normalized(text);

  if (/delivery|deliver|shipping|drop.?off/i.test(query)) {
    return {
      agent: "service",
      message: "Delivery runs within 5 miles of your corner, usually in 30–45 minutes. It is free over $45; otherwise the delivery fee is $6.95. Choose delivery at checkout and we will show the available window.",
      chips: ["Build a delivery box", "What is pickup like?", "Ask about allergens"]
    };
  }
  if (/pickup|pick up|takeout|take.?away|counter/i.test(query)) {
    return {
      agent: "service",
      message: "Pickup and takeout are ready at Frisco Corner in about 20 minutes. We will hold a prepared box for 30 minutes after your selected window, and you can collect it at the counter.",
      chips: ["Build a pickup box", "Can you deliver?", "What are your hours?"]
    };
  }
  if (/hour|open|close|when are you/i.test(query)) {
    return {
      agent: "service",
      message: "Frisco Corner is open Monday–Saturday, 8:00 AM–8:00 PM, and Sunday, 9:00 AM–4:00 PM. Pickup windows are offered throughout open hours.",
      chips: ["Plan pickup", "Plan delivery", "See this week's menu"]
    };
  }
  return {
    agent: "service",
    message: "I can help with pickup, takeout, delivery windows, store hours, and getting a box ready for checkout.",
    chips: ["How does delivery work?", "How does pickup work?", "What are your hours?"]
  };
};

const recommendation = async ({ occasion, text, context } = {}) => {
  await think();

  const analysis = runRecommendationTools(context);
  const { cart, history, deals } = analysis;
  const popularNext = context?.signals?.popularNext || [];

  const dealNote = deals.regular[0] || deals.seasonal[1] || deals.seasonal[0];
  const dealMessage = dealNote ? ` ${dealNote.title}: ${dealNote.reason || dealNote.detail}` : "";

  if (occasion && OCCASION_PICKS[occasion]) {
    const { ids, line } = OCCASION_PICKS[occasion];
    return { agent: "recommendation", message: `${line}${dealMessage}`, items: pick(ids), analysis, deals };
  }

  if (text) {
    const hit = KEYWORD_HINTS.find((hint) => hint.match.test(text));
    const items = keywordItems(text);
    if (hit && items.length) return { agent: "recommendation", message: `${hit.line}${dealMessage}`, items, analysis, deals };
  }

  if (history.availableFavorites.length) {
    const favorite = history.availableFavorites[0];
    const favoriteItem = byId(favorite.id);
    return {
      agent: "recommendation",
      message: `You usually come back for ${favorite.name}. I paired it with a popular pick from this week's counter.${dealMessage}`,
      items: uniqueItems([favoriteItem, popularNext[0]]),
      analysis,
      deals
    };
  }

  const top = popularNext.length && cart.remaining > 0
    ? popularNext.slice(0, 2)
    : [...weeklyMenu].sort((a, b) => b.rating - a.rating).slice(0, 2);
  return {
    agent: "recommendation",
    message: `Here's what the corner is loving this week. Tell me the occasion and I'll get more specific.${dealMessage}`,
    items: top,
    analysis,
    deals
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

const offers = async ({ basketSize = 0, context } = {}) => {
  await think(300);
  const boxGap = context?.signals?.boxGap ?? Math.max(0, 6 - basketSize);
  return {
    agent: "offers",
    message: boxGap === 0
      ? "Your box is full — the party upgrade is the better value from here."
      : "Three offers are live for you right now, each tied to something you've actually done.",
    note: boxGap > 0 ? `${boxGap} slot${boxGap === 1 ? "" : "s"} remain in the current box.` : "Offers are reasoned per customer. No blanket codes."
  };
};

const support = async ({ text = "" } = {}) => {
  await think(380);

  if (/delivery|deliver|shipping|pickup|pick up|takeout|take.?away|hour|open|close/i.test(text)) {
    return serviceInfo({ text });
  }

  if (/allergen|nut|gluten|dairy|vegan/i.test(text)) {
    return {
      agent: "support",
      message: "Every item lists its allergens on the card. Our nut-free line covers Pink Velvet, Lemon Glaze Cloud and Brown Butter Chip. Want me to filter the menu to just those?",
      chips: ["Show nut-free", "Show plant-based", "Talk to a person"]
    };
  }
  if (/where|order|status|track|late|missing/i.test(text)) {
    return {
      agent: "support",
      message: "Orders move from oven to counter in about 20 minutes. For this demo, sign in to see your order history; a live order tracker would appear there once an order is placed.",
      chips: ["How does pickup work?", "How does delivery work?", "Talk to a person"]
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

  if (/subscribe|subscription|weekly|pause|skip|swap/i.test(text)) {
    return {
      agent: "support",
      message: "Subscriptions are flexible weekly boxes: choose a plan, then skip, swap, or pause from your account before the next flavor drop. The concierge can fill the box from the live menu when you want it to.",
      chips: ["Show subscription plans", "Pick up my box", "Build a one-time box"]
    };
  }

  if (/hello|hi|hey|help|what can you do/i.test(text)) {
    return {
      agent: "support",
      message: "I can recommend flavors, build a party spread, explain allergens, answer pickup and delivery questions, help with subscriptions, or find an order. Tell me what you are planning.",
      chips: ["Recommend something", "Plan for 12 people", "How does delivery work?"]
    };
  }

  return {
    agent: "support",
    message: "Happy to help. I can answer allergens, order status, subscriptions and party sizing — or hand you to someone at your local corner.",
    chips: ["Allergens", "Track my order", "Subscriptions", "Talk to a person"]
  };
};

const concierge = async (input = {}) => {
  const text = input.text || "";
  const query = normalized(text);
  const guestsMatch = query.match(/\b(\d{1,3})\s*(?:people|guests|person|friends|servings)\b/);

  if (!query && input.occasion) return recommendation(input);
  if (/delivery|deliver|shipping|pickup|pick up|takeout|take.?away|hour|open|close/i.test(query)) {
    return serviceInfo(input);
  }
  if (guestsMatch || /party|event|catering|spread|office|birthday|wedding/i.test(query)) {
    const guests = guestsMatch ? Math.max(4, Math.min(60, Number(guestsMatch[1]))) : 12;
    return planner({ ...input, guests, dietary: /vegan|plant.?based/i.test(query) ? ["vegan"] : [] });
  }
  if (/order|buy|checkout|box|add|two|three|four|five|six/i.test(query)) {
    return orders(input);
  }
  if (/offer|deal|discount|save/i.test(query)) return offers({ ...input, basketSize: input.context?.cart?.count || 0 });
  if (/season|seasonal|event|holiday/i.test(query)) return seasonal(input);
  if (/allergen|nut|gluten|dairy|refund|wrong|missing|subscription|subscribe|help|hello|hi|hey|hours/i.test(query)) {
    return support(input);
  }
  return recommendation(input);
};

const seasonal = async ({ context } = {}) => {
  await think(300);
  const live = eventMenus.find((menu) => menu.status === "live") || eventMenus[0];
  const seasonalName = context?.market?.liveSeasonal?.name || live.name;
  return {
    agent: "seasonal",
    message: `${seasonalName} is live through ${live.window.split("–")[1].trim()}. ${live.blurb}`,
    note: live.highlights.join(" · ")
  };
};

const orders = async ({ text = "" } = {}) => {
  await think(460);
  const mentioned = fullMenu.filter((item) =>
    text.toLowerCase().includes(item.name.toLowerCase().split(" ")[0].toLowerCase())
  );
  const matches = mentioned.length ? mentioned : keywordItems(text);
  if (matches.length) {
    return {
      agent: "orders",
      message: `I found ${matches.map((item) => item.name).join(" and ")}. Add them to your box below, then choose pickup or delivery at checkout.`,
      items: matches,
      chips: ["Pickup", "Delivery"]
    };
  }
  return {
    agent: "orders",
    message: "Tell me what you'd like and I'll build the box. You can say things like \"two chocolate, one lemon, pickup at six\".",
    chips: ["This week's six", "Repeat last order"]
  };
};

const HANDLERS = { recommendation, concierge, planner, offers, support, seasonal, orders, service: serviceInfo };

/**
 * Model-backed agents, with the rule-based handlers above as the fallback.
 *
 * The browser never holds a key: it posts to /api/agent and the backend runs
 * the model. Any failure there (no key, rate limit, refusal) falls through to
 * the local rules so the storefront keeps working.
 */
let backendAvailable = true;

async function askBackend(agentId, input) {
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: agentId,
      text: input.text || input.occasion || "",
      cart: input.context?.cart || null
    })
  });

  if (response.status === 503) {
    // Runtime is not configured — stop trying for the rest of the session.
    backendAvailable = false;
    throw new Error("agent backend unavailable");
  }
  if (!response.ok) throw new Error(`agent backend returned ${response.status}`);
  return response.json();
}

/** Single entry point the UI calls. Unknown ids fall back to support. */
export async function ask(agentId, input = {}) {
  const handler = HANDLERS[agentId] || support;

  if (backendAvailable) {
    try {
      const reply = await askBackend(agentId, input);
      if (reply?.message) return { ...reply, agent: agentId };
    } catch (error) {
      console.warn("Falling back to local agent logic:", error.message);
    }
  }

  return handler(input);
}

export const agentMeta = (id) => roster.find((agent) => agent.id === id);
