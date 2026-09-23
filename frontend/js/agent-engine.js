/**
 * The reasoning behind the live agent surfaces.
 *
 * Everything here is deterministic and runs in the browser: given a box, it
 * decides what to recommend and which offers have earned their place, and it
 * reports the steps it took so the UI can show its working. When a model is
 * wired up this module is what its tool calls replace — the shapes are the
 * same, which is why the surfaces do not need to change.
 */

import { fullMenu, eventMenus } from "./data.js";

const FREE_DELIVERY = 45;
const BOX_TARGET = 6;

/** Flavor families, used to judge whether a box is balanced. */
const PROFILE = {
  "pink-velvet": { rich: 2, bright: 1, texture: "soft", family: "cream" },
  "brown-butter": { rich: 3, bright: 0, texture: "chewy", family: "cocoa" },
  "lemon-cloud": { rich: 0, bright: 3, texture: "light", family: "citrus" },
  "biscoff": { rich: 3, bright: 0, texture: "dense", family: "caramel" },
  "strawberry-stack": { rich: 1, bright: 3, texture: "light", family: "berry" },
  "midnight-fudge": { rich: 4, bright: 0, texture: "dense", family: "cocoa" },
  "coconut-matcha": { rich: 1, bright: 2, texture: "light", family: "green" },
  "almond-fig": { rich: 2, bright: 2, texture: "soft", family: "nut" }
};

/** Pairs that genuinely work, and the reason a person would accept. */
const PAIRS = {
  "midnight-fudge": [["lemon-cloud", "cuts the fudge with something sharp"],
                     ["strawberry-stack", "berry lifts a heavy cocoa box"]],
  "brown-butter": [["midnight-fudge", "the classic cocoa pairing"],
                   ["lemon-cloud", "keeps a butter-forward box from flattening"]],
  "biscoff": [["coconut-matcha", "green tea cuts the caramel"],
              ["brown-butter", "caramel and browned butter run together"]],
  "lemon-cloud": [["strawberry-stack", "two bright flavors, different textures"],
                  ["pink-velvet", "adds body under the citrus"]],
  "strawberry-stack": [["pink-velvet", "the crowd-pleasing pink pair"],
                       ["midnight-fudge", "berry and dark cocoa"]],
  "pink-velvet": [["brown-butter", "cream cheese against browned butter"],
                  ["lemon-cloud", "keeps a sweet box from cloying"]],
  "coconut-matcha": [["almond-fig", "both plant-based, different textures"],
                     ["lemon-cloud", "clean and bright together"]],
  "almond-fig": [["coconut-matcha", "rounds out the plant-based half"],
                 ["biscoff", "fig and caramel"]]
};

const byId = (id) => fullMenu.find((item) => item.id === id);
const money = (value) => `$${value.toFixed(2)}`;

/** Seasonal menus that are open today, with their line-ups. */
export function liveSeasons(today = new Date()) {
  return eventMenus.map((menu) => {
    const opens = menu.opens ? new Date(`${menu.opens}T00:00:00`) : null;
    const closes = menu.closes ? new Date(`${menu.closes}T23:59:59`) : null;
    let state = "planned";
    if (opens && closes) {
      if (today >= opens && today <= closes) state = "live";
      else if (today < opens) {
        const weeks = Math.round((opens - today) / 604800000);
        state = weeks <= 8 ? "preorder" : "planned";
      } else state = "closed";
    }
    const days = opens ? Math.ceil((opens - today) / 86400000) : null;
    return { ...menu, state, daysUntil: days };
  });
}

function summarize(lines) {
  const totals = { rich: 0, bright: 0, count: 0, subtotal: 0, families: new Set(), textures: new Set() };
  for (const line of lines) {
    const profile = PROFILE[line.item.id];
    totals.count += line.qty;
    totals.subtotal += line.item.price * line.qty;
    if (!profile) continue;
    totals.rich += profile.rich * line.qty;
    totals.bright += profile.bright * line.qty;
    totals.families.add(profile.family);
    totals.textures.add(profile.texture);
  }
  return totals;
}

/**
 * What to suggest next, and why.
 * Returns { items, trace, headline } — trace is the agent's working.
 */
export function recommend(lines, options = {}) {
  const { avoid = [], limit = 3 } = options;
  const inBox = new Set(lines.map((line) => line.item.id));
  const totals = summarize(lines);
  const trace = [];
  const scored = new Map();

  const consider = (id, points, reason) => {
    if (!id || inBox.has(id)) return;
    const item = byId(id);
    if (!item) return;
    if (avoid.some((allergen) => (item.allergens || []).includes(allergen))) return;
    const current = scored.get(id) || { item, score: 0, reasons: [] };
    current.score += points;
    current.reasons.push(reason);
    scored.set(id, current);
  };

  if (lines.length === 0) {
    trace.push("Box is empty — falling back to this week's strongest ratings");
    [...fullMenu]
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit)
      .forEach((item, index) =>
        consider(item.id, 10 - index, `rated ${item.rating} by customers this week`));
    return {
      headline: "Where most people start",
      trace,
      items: rank(scored, limit)
    };
  }

  trace.push(`Read the box: ${totals.count} item${totals.count === 1 ? "" : "s"}, ${money(totals.subtotal)}`);

  // 1. Direct pairings off what is already in the box.
  for (const line of lines) {
    for (const [id, why] of PAIRS[line.item.id] || []) {
      consider(id, 6, `${why}, next to your ${line.item.name}`);
    }
  }
  trace.push(`Matched pairings for ${lines.map((l) => l.item.name).join(", ")}`);

  // 2. Balance: a box that is all one thing gets a counterweight.
  if (totals.rich >= totals.bright + 4) {
    trace.push("Box skews rich — weighting bright flavors up");
    for (const item of fullMenu) {
      const profile = PROFILE[item.id];
      if (profile && profile.bright >= 2) consider(item.id, 5, "balances a rich box with something bright");
    }
  } else if (totals.bright >= totals.rich + 4) {
    trace.push("Box skews light — weighting richer flavors up");
    for (const item of fullMenu) {
      const profile = PROFILE[item.id];
      if (profile && profile.rich >= 3) consider(item.id, 5, "adds depth to a light box");
    }
  }

  // 3. Texture variety.
  if (totals.textures.size === 1) {
    const only = [...totals.textures][0];
    trace.push(`Every item is ${only} — looking for contrast`);
    for (const item of fullMenu) {
      const profile = PROFILE[item.id];
      if (profile && profile.texture !== only) consider(item.id, 3, `different texture from the rest of the box`);
    }
  }

  // 4. Finish the box.
  const remaining = BOX_TARGET - totals.count;
  if (remaining > 0 && remaining <= 2) {
    trace.push(`${remaining} slot${remaining === 1 ? "" : "s"} left to fill the six-count`);
    for (const item of fullMenu) consider(item.id, 2, "fills the last of the six-count");
  }

  // 5. Seasonal hero, when a season is actually open.
  const live = liveSeasons().find((menu) => menu.state === "live");
  if (live && live.items?.length) {
    trace.push(`${live.name} is live until ${live.window.split("–").pop().trim()}`);
  }

  return {
    headline: remaining > 0 && remaining <= 2
      ? `${remaining} more to complete the box`
      : "Picked to go with your box",
    trace,
    items: rank(scored, limit)
  };
}

function rank(scored, limit) {
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || b.item.rating - a.item.rating)
    .slice(0, limit)
    .map((entry) => ({
      item: entry.item,
      reason: entry.reasons[0],
      confidence: Math.min(99, 62 + entry.score * 4)
    }));
}

/**
 * Offers that have earned their place against this box.
 * Each carries the reason it exists, which is the whole point of the surface.
 */
export function offersFor(lines, base = []) {
  const totals = summarize(lines);
  const offers = [];

  if (totals.count === 0) {
    return base.slice(0, 3).map((offer) => ({ ...offer, live: false }));
  }

  const toFree = FREE_DELIVERY - totals.subtotal;
  if (toFree > 0) {
    offers.push({
      id: "offer-delivery",
      label: "Because you're close",
      title: `${money(toFree)} from free delivery`,
      detail: `Your box is ${money(totals.subtotal)}. Delivery is free over ${money(FREE_DELIVERY)}.`,
      reason: toFree <= 12
        ? `One more item usually covers it — most singles are ${money(5.5)}.`
        : `About ${Math.ceil(toFree / 5.5)} more singles, or switch to a six-count bundle.`,
      value: "Save $6.95",
      tint: "gold",
      emoji: "🚚",
      live: true,
      progress: Math.round((totals.subtotal / FREE_DELIVERY) * 100)
    });
  } else if (totals.subtotal >= FREE_DELIVERY) {
    offers.push({
      id: "offer-delivery-earned",
      label: "Earned on this box",
      title: "Free delivery unlocked",
      detail: `Your box is ${money(totals.subtotal)}, over the ${money(FREE_DELIVERY)} threshold.`,
      reason: "Applied automatically at checkout — nothing to enter.",
      value: "Saved $6.95",
      tint: "mint",
      emoji: "✓",
      live: true,
      progress: 100
    });
  }

  const remaining = BOX_TARGET - totals.count;
  if (remaining > 0 && remaining <= 4) {
    offers.push({
      id: "offer-complete",
      label: remaining <= 2 ? "Because you're nearly there" : "Because the box isn't full",
      title: `Complete the six-count, ${remaining <= 2 ? "15" : "10"}% off`,
      detail: `Add ${remaining} more and the whole box drops to the bundle price.`,
      reason: `Singles are ${money(5.5)} each; the six-count works out cheaper per treat.`,
      value: `Save ${money(remaining <= 2 ? 4.95 : 3.3)}`,
      tint: "pink",
      emoji: "🎁",
      live: true
    });
  }

  if (totals.count >= BOX_TARGET) {
    offers.push({
      id: "offer-party",
      label: "Because this is a big box",
      title: "Upgrade to the Party Box",
      detail: "Swap to a 12-count spread and add a flavor flight free.",
      reason: `You already have ${totals.count} — the 12-count is better value past six.`,
      value: "Free flight ($9)",
      tint: "berry",
      emoji: "🎉",
      live: true
    });
  }

  if (totals.families.size >= 2) {
    offers.push({
      id: "offer-sampler",
      label: "Because you mixed it up",
      title: "Tasting notes card, free",
      detail: `You've got ${totals.families.size} different flavor families in one box.`,
      reason: "Boxes this varied are usually being shared — the card helps people choose.",
      value: "Free add-on",
      tint: "caramel",
      emoji: "📝",
      live: true
    });
  }

  // Keep the rail full with standing offers when the box hasn't earned three.
  for (const offer of base) {
    if (offers.length >= 3) break;
    if (!offers.some((existing) => existing.id === offer.id)) {
      offers.push({ ...offer, live: false });
    }
  }

  return offers.slice(0, 3);
}
