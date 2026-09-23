/**
 * Agent routing layer.
 *
 * The UI only ever awaits `ask(agentId, input)`. Every call goes to the
 * model-backed runtime on the server first; if that is not configured (or
 * fails) the local handlers below answer from the same catalog and the same
 * engine the storefront uses, so nothing the customer sees changes shape.
 *
 * Response shape: { agent, message, items?, chips?, note?, trace?, stats? }
 */

import { fullMenu, agents as roster } from "./data.js";
import { recommend } from "./agent-engine.js";
import { respond as concierge } from "./concierge.js";

/** Simulated round-trip so the UI exercises its real loading states. */
const think = (ms = 420) => new Promise((resolve) => setTimeout(resolve, ms));

/** Flavor families each party vibe leans on. */
const VIBE_FAMILIES = {
  classic: ["cream", "berry", "cocoa", "caramel"],
  bold: ["cocoa", "caramel", "coffee", "spice"],
  garden: ["citrus", "berry", "green", "tropical", "orchard"],
  cozy: ["spice", "caramel", "cream", "orchard"]
};

/**
 * Party sizing. Real catering math: roughly 1.5 servings a head, rounded up
 * to whole boxes, with variety scaling to group size rather than staying fixed.
 */
const planner = async ({ guests = 12, vibe = "classic", dietary = [], context } = {}) => {
  await think(520);

  const servings = Math.ceil(guests * 1.5);
  const boxes = Math.ceil(servings / 6);
  const varietyCount = Math.min(6, Math.max(3, Math.round(guests / 4)));
  const avoid = dietary.includes("nut-free") ? ["tree nut", "peanut"] : [];

  let pool = fullMenu.filter((item) => !avoid.some((allergen) => (item.allergens || []).includes(allergen)));
  if (dietary.includes("vegan")) pool = pool.filter((item) => item.tags.includes("vegan"));

  const families = VIBE_FAMILIES[vibe] || VIBE_FAMILIES.classic;
  const leaning = pool
    .filter((item) => families.includes(item.profile?.family))
    .sort((a, b) => families.indexOf(a.profile.family) - families.indexOf(b.profile.family) || b.rating - a.rating);
  const rest = pool.filter((item) => !leaning.includes(item)).sort((a, b) => b.rating - a.rating);

  // One item per flavor family first, so the spread reads as a spread.
  const items = [];
  const seenFamilies = new Set();
  for (const item of [...leaning, ...rest]) {
    if (items.length >= varietyCount) break;
    const family = item.profile?.family;
    if (family && seenFamilies.has(family) && items.length < leaning.length) continue;
    seenFamilies.add(family);
    items.push(item);
  }
  for (const item of [...leaning, ...rest]) {
    if (items.length >= varietyCount) break;
    if (!items.includes(item)) items.push(item);
  }

  const subtotal = items.reduce((sum, item) => sum + item.price, 0) / (items.length || 1) * servings;

  return {
    agent: "planner",
    message: `For ${guests} guests I'd plan ${servings} servings — that's ${boxes} box${boxes === 1 ? "" : "es"} across ${items.length} flavors.`,
    items,
    note: `Estimated subtotal $${subtotal.toFixed(2)} · leaves a little margin so nobody takes the last one.`,
    stats: { guests, servings, boxes, variety: items.length }
  };
};

/** Cart-aware picks, for surfaces that ask the recommendation agent directly. */
const recommendation = async ({ occasion, text, context } = {}) => {
  await think();
  const lines = (context?.cart?.lines || []).map((line) => ({
    item: fullMenu.find((item) => item.id === line.id), qty: line.quantity || 1
  })).filter((line) => line.item);
  const result = recommend(lines, { occasion: occasion || null, context, limit: 3 });
  const lead = result.items[0];
  return {
    agent: "recommendation",
    message: lead ? `${lead.reason}.` : "Tell me the occasion and I'll get more specific.",
    items: result.items.map((pick) => pick.item),
    trace: result.trace
  };
};

/** The chat surface: the concierge answers everything conversational. */
const conciergeHandler = async ({ text = "", occasion, context, signedIn, cart = [] } = {}) => {
  await think(300);
  return concierge(text || occasion || "", cart, { context, signedIn });
};

const HANDLERS = {
  recommendation,
  planner,
  concierge: conciergeHandler,
  orders: conciergeHandler,
  support: conciergeHandler,
  offers: conciergeHandler,
  seasonal: conciergeHandler,
  service: conciergeHandler
};

/**
 * Model-backed agents, with the rule-based handlers above as the fallback.
 *
 * The browser never holds a key: it posts to /api/agent and the backend runs
 * the model. Any failure there (no key, rate limit, refusal) falls through to
 * the local rules so the storefront keeps working.
 */
let backendAvailable = true;

async function askBackend(agentId, input) {
  const cart = input.context?.cart ? { ...input.context.cart, appliedOffer: input.appliedOffer || null } : null;
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: agentId,
      text: input.text || input.occasion || "",
      cart,
      history: Array.isArray(input.history) ? input.history : []
    })
  });

  if (response.status === 503) {
    // Runtime is not configured — stop trying for the rest of the session.
    backendAvailable = false;
    throw new Error("agent backend unavailable");
  }
  // Anything else (a model hiccup, a 502) is reported for this turn only.
  if (!response.ok) {
    const error = new Error(`agent backend returned ${response.status}`);
    error.status = response.status;
    error.reason = (await response.json().catch(() => ({}))).reason || null;
    throw error;
  }
  return response.json();
}

/** The provider's content filter refused the message itself; ask for other words. */
const FILTERED_REPLY = {
  message: "The safety filter on our model service blocked that message, so I didn't get to read it. Could you put it another way?",
  trace: ["The message was rejected by the model service's content filter before the model saw it"],
  chips: ["What's in my box?", "What's seasonal?"],
  transient: true
};

/** What the chat says when the model drops a turn mid-conversation. */
const RETRY_REPLY = {
  message: "I lost the thread for a second — could you say that again?",
  trace: [],
  chips: ["Say it again"],
  transient: true
};

/** Whether the model-backed runtime answered at all this session. */
export const modelAvailable = () => backendAvailable;

/** Single entry point the UI calls. Unknown ids fall back to the concierge. */
export async function ask(agentId, input = {}) {
  const handler = HANDLERS[agentId] || conciergeHandler;

  if (backendAvailable) {
    try {
      const reply = await askBackend(agentId, input);
      if (reply?.message) return { ...reply, agent: agentId, source: "model" };
    } catch (error) {
      // Mid-conversation, a one-off model failure should not hand the chat to a
      // different brain that has none of the context; ask to repeat instead.
      if (error.reason === "content_filter") {
        console.warn("Message blocked by the content filter");
        return { ...FILTERED_REPLY, agent: agentId, source: "model" };
      }
      if (backendAvailable && agentId === "concierge" && (input.history || []).length) {
        console.warn("Model dropped a turn:", error.message);
        return { ...RETRY_REPLY, agent: agentId, source: "model" };
      }
      console.warn("Falling back to local agent logic:", error.message);
    }
  }

  return { ...(await handler(input)), source: "rules" };
}

export const agentMeta = (id) => roster.find((agent) => agent.id === id);
