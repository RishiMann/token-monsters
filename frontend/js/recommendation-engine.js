/**
 * The recommendation engine.
 *
 * Pure functions over a catalog: given the items on sale and the lines in a
 * box, decide what to suggest next and why. It reads each item's `profile`
 * (flavor family, richness, brightness, texture, occasions, pairings) from
 * the catalog, so a new item is recommendable the moment it has a profile.
 * Nothing here is hard-wired to an item id.
 *
 * The catalog is passed in rather than imported so the same code runs in the
 * browser and under node for tests.
 */

/** Flavor families that lift each other. Symmetry is not assumed. */
export const COMPLEMENTS = {
  cocoa:    ["citrus", "berry", "mint", "coffee", "caramel", "cream"],
  caramel:  ["green", "citrus", "orchard", "coffee", "nut", "cocoa"],
  citrus:   ["cocoa", "berry", "cream", "caramel", "nut", "spice"],
  berry:    ["cream", "cocoa", "citrus", "nut"],
  cream:    ["berry", "citrus", "spice", "cocoa", "coffee"],
  green:    ["nut", "citrus", "caramel", "sesame", "tropical"],
  nut:      ["green", "orchard", "caramel", "cocoa", "citrus", "berry"],
  spice:    ["cream", "orchard", "caramel", "coffee", "citrus"],
  coffee:   ["cocoa", "caramel", "nut", "cream"],
  tropical: ["green", "citrus", "cocoa"],
  orchard:  ["caramel", "spice", "nut", "cream"],
  mint:     ["cocoa", "cream"],
  sesame:   ["green", "bean", "citrus"],
  bean:     ["sesame", "green", "citrus"],
};

/** How a family reads in a sentence. */
const FAMILY_WORD = {
  cocoa: "chocolate", caramel: "caramel", citrus: "citrus", berry: "berry",
  cream: "cream", green: "matcha", nut: "nut", spice: "warm spice",
  coffee: "coffee", tropical: "tropical fruit", orchard: "orchard fruit",
  mint: "mint", sesame: "sesame", bean: "sweet bean",
};

const BOX_TARGET = 6;

const profileOf = (item) => item.profile || {
  family: null, rich: 2, bright: 2, texture: null, occasions: [], pairsWith: [],
};

const money = (value) => `$${value.toFixed(2)}`;
const capitalize = (text = "") => text.charAt(0).toUpperCase() + text.slice(1);

/** What the box adds up to: richness, brightness, textures, occasions. */
export function summarize(lines) {
  const totals = {
    count: 0, subtotal: 0, rich: 0, bright: 0,
    families: new Map(), textures: new Map(), occasions: new Map(),
    allVegan: lines.length > 0, ids: new Set(),
  };
  for (const { item, qty = 1 } of lines) {
    const profile = profileOf(item);
    totals.count += qty;
    totals.subtotal += item.price * qty;
    totals.ids.add(item.id);
    totals.rich += profile.rich * qty;
    totals.bright += profile.bright * qty;
    if (profile.family) totals.families.set(profile.family, (totals.families.get(profile.family) || 0) + qty);
    if (profile.texture) totals.textures.set(profile.texture, (totals.textures.get(profile.texture) || 0) + qty);
    for (const occasion of profile.occasions || []) {
      totals.occasions.set(occasion, (totals.occasions.get(occasion) || 0) + qty);
    }
    if (!(item.tags || []).includes("vegan")) totals.allVegan = false;
  }
  return totals;
}

/** The occasion the box most looks like, if one clearly leads. */
function leadingOccasion(totals) {
  let best = null;
  for (const [occasion, weight] of totals.occasions) {
    if (!best || weight > best.weight) best = { occasion, weight };
  }
  // Every item carries two or three occasions, so demand a real majority.
  return best && best.weight >= Math.max(2, totals.count * 0.6) ? best.occasion : null;
}

/** Score to a percentage the UI can show. Saturates rather than lying. */
const confidence = (score) => Math.round(Math.min(97, 50 + 46 * (1 - Math.exp(-Math.max(0, score) / 8))));

/**
 * What to suggest next, and why.
 *
 * @param catalog  every item on sale today
 * @param lines    [{ item, qty }] currently in the box
 * @param options  avoid: allergens to exclude outright
 *                 limit: how many picks to return
 *                 occasion: an occasion id the customer stated
 *                 favorites: [{ id, units }] from order history, best first
 *                 popular: item ids trending this week, best first
 *                 seasons: live menus [{ id, name, closes }]
 *                 occasionLabels: { id: label } for readable reasons
 * @returns { headline, trace, items: [{ item, reason, confidence, score, signals }] }
 */
export function recommend(catalog, lines = [], options = {}) {
  const {
    avoid = [], limit = 3, occasion = null, favorites = [], popular = [],
    seasons = [], occasionLabels = {},
  } = options;

  const totals = summarize(lines);
  const trace = [];
  const scored = new Map();
  const banned = new Set(avoid.map((a) => a.toLowerCase()));
  const label = (id) => occasionLabels[id] || id.replace(/-/g, " ");
  const seasonById = new Map(seasons.map((season) => [season.id, season]));
  const favoriteUnits = new Map(favorites.map((f) => [f.id, f.units || 1]));
  const popularRank = new Map(popular.map((id, index) => [id, index]));

  const consider = (item, points, key, reason) => {
    if (!item || totals.ids.has(item.id)) return;
    if ((item.allergens || []).some((a) => banned.has(a.toLowerCase()))) return;
    const entry = scored.get(item.id) || { item, score: 0, signals: [] };
    entry.score += points;
    entry.signals.push({ key, points, reason });
    scored.set(item.id, entry);
  };

  // ── Empty box: start from what people like, steered by any stated occasion.
  if (lines.length === 0) {
    trace.push(occasion
      ? `Box is empty — starting from what suits ${label(occasion)}`
      : "Box is empty — starting from this week's strongest ratings");
    for (const item of catalog) {
      consider(item, (item.rating - 4) * 10, "rating", `rated ${item.rating} by customers this week`);
      if (occasion && profileOf(item).occasions.includes(occasion)) {
        consider(item, 5, "occasion", `made for ${label(occasion)}`);
      }
      if (favoriteUnits.has(item.id)) {
        consider(item, 4, "favorite", `you've ordered this ${favoriteUnits.get(item.id)} time${favoriteUnits.get(item.id) === 1 ? "" : "s"}`);
      }
      if (popularRank.has(item.id)) consider(item, 2 - popularRank.get(item.id) * 0.5, "popular", "trending at the counter this week");
      const season = seasonById.get(item.season);
      if (season) consider(item, 2, "season", `${season.name} is on now`);
    }
    if (favorites.length) trace.push("Weighted your favorites from past boxes");
    trace.push(`Ranked ${scored.size} candidates`);
    return {
      headline: occasion ? `Picked for ${label(occasion)}` : "Where most people start",
      trace,
      items: rank(scored, limit),
    };
  }

  trace.push(`Read the box: ${totals.count} item${totals.count === 1 ? "" : "s"}, ${money(totals.subtotal)}`);

  // ── 1. Explicit pairings off what is already in the box.
  for (const { item } of lines) {
    for (const pair of profileOf(item).pairsWith || []) {
      const candidate = catalog.find((entry) => entry.id === pair.id);
      consider(candidate, 6, "pairing", `${pair.why}, next to your ${item.name}`);
    }
  }
  trace.push(`Matched pairings for ${lines.map((l) => l.item.name).join(", ")}`);

  // ── 2. Flavor families: complements score, repeats cost.
  for (const item of catalog) {
    const family = profileOf(item).family;
    if (!family) continue;
    for (const [boxFamily] of totals.families) {
      if ((COMPLEMENTS[boxFamily] || []).includes(family)) {
        consider(item, 3, "complement", `${FAMILY_WORD[family] || family} against the ${FAMILY_WORD[boxFamily] || boxFamily} already in the box`);
      }
    }
    if (totals.families.has(family)) {
      consider(item, -2, "repeat", `another ${FAMILY_WORD[family] || family} pick`);
    }
  }

  // ── 3. Balance: a box that is all one thing gets a counterweight.
  if (totals.rich >= totals.bright + 4) {
    trace.push("Box skews rich — weighting bright flavors up");
    for (const item of catalog) {
      if (profileOf(item).bright >= 2) consider(item, 4, "balance", "balances a rich box with something bright");
    }
  } else if (totals.bright >= totals.rich + 4) {
    trace.push("Box skews light — weighting richer flavors up");
    for (const item of catalog) {
      if (profileOf(item).rich >= 3) consider(item, 4, "balance", "adds depth to a light box");
    }
  }

  // ── 4. Texture: contrast when everything is the same.
  if (totals.textures.size === 1) {
    const [only] = totals.textures.keys();
    trace.push(`Every item is ${only} — looking for contrast`);
    for (const item of catalog) {
      const texture = profileOf(item).texture;
      if (texture && texture !== only) consider(item, 2, "texture", `${texture} against a ${only} box`);
    }
  } else if (totals.count >= 3) {
    for (const item of catalog) {
      const texture = profileOf(item).texture;
      if (texture && !totals.textures.has(texture)) consider(item, 1, "texture", "a texture the box doesn't have yet");
    }
  }

  // ── 5. Occasion: what the box already looks like, or what the customer said.
  const lead = occasion || leadingOccasion(totals);
  if (lead) {
    trace.push(occasion
      ? `You said ${label(occasion)} — favoring picks made for it`
      : `Box reads as ${label(lead)} — favoring picks that fit`);
    for (const item of catalog) {
      if (profileOf(item).occasions.includes(lead)) {
        consider(item, occasion ? 4 : 2, "occasion", `fits a ${label(lead)} box`);
      }
    }
  }

  // ── 6. Dietary consistency: an all-plant-based box stays that way.
  if (totals.allVegan) {
    trace.push("Everything so far is plant-based — keeping it that way");
    for (const item of catalog) {
      const vegan = (item.tags || []).includes("vegan");
      consider(item, vegan ? 4 : -8, "dietary", vegan ? "keeps the box plant-based" : "not plant-based");
    }
  }

  // ── 7. Signed-in history and this week's popularity.
  for (const item of catalog) {
    if (favoriteUnits.has(item.id)) {
      consider(item, 3, "favorite", `you've ordered this ${favoriteUnits.get(item.id)} time${favoriteUnits.get(item.id) === 1 ? "" : "s"} before`);
    }
    if (popularRank.has(item.id)) consider(item, 1, "popular", "trending at the counter this week");
  }
  if (favorites.length) trace.push("Checked your past boxes for favorites not in this one");

  // ── 8. Seasonal: a live menu gets a nudge, and a date in the reason.
  for (const item of catalog) {
    const season = seasonById.get(item.season);
    if (season) consider(item, 2, "season", `${season.name} runs until ${longDate(season.closes)}`);
  }
  if (seasons.length) trace.push(`${seasons.map((s) => s.name).join(" and ")} ${seasons.length === 1 ? "is" : "are"} live — seasonal picks in the mix`);

  const remaining = BOX_TARGET - totals.count;
  trace.push(`Ranked ${scored.size} candidates`);

  return {
    headline: remaining > 0 && remaining <= 2
      ? `${remaining} more to complete the box`
      : "Picked to go with your box",
    trace,
    items: rank(scored, limit),
  };
}

function rank(scored, limit) {
  return [...scored.values()]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.rating - a.item.rating || a.item.id.localeCompare(b.item.id))
    .slice(0, limit)
    .map((entry) => {
      const best = [...entry.signals].sort((a, b) => b.points - a.points)[0];
      return {
        item: entry.item,
        reason: capitalize(best.reason),
        confidence: confidence(entry.score),
        score: entry.score,
        signals: entry.signals,
      };
    });
}

function longDate(iso) {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Items that answer a free-text craving, using profiles rather than a
 * keyword-to-id table. Returns matching families so the caller can explain.
 */
export const FLAVOR_WORDS = {
  cocoa: /\b(chocolate|chocolatey|cocoa|fudge|fudgy|brownie|dark)\b/i,
  citrus: /\b(lemon|lime|citrus|orange|mandarin|tangy|sharp|zesty|zingy)\b/i,
  berry: /\b(berry|berries|strawberr\w*|raspberr\w*|cranberr\w*|blueberr\w*|fruit|fruity)\b/i,
  caramel: /\b(caramel|butterscotch|biscoff|speculoos|toffee|honey)\b/i,
  green: /\b(matcha|green tea)\b/i,
  nut: /\b(almond|pistachio|pecan|walnut|peanut|fig|nutty)\b/i,
  cream: /\b(velvet|cream cheese|vanilla|custard|pudding|creamy|banana)\b/i,
  spice: /\b(cinnamon|spice|spiced|spicy|gingerbread|ginger|pumpkin|carrot)\b/i,
  coffee: /\b(coffee|espresso|tiramisu|mocha)\b/i,
  tropical: /\b(mango|coconut|tropical|passion)\b/i,
  orchard: /\b(apple|pear|cider|orchard)\b/i,
  mint: /\b(mint|peppermint)\b/i,
  sesame: /\b(sesame|tahini)\b/i,
  bean: /\b(red bean|lotus|mooncake)\b/i,
};

export function familiesIn(text = "") {
  return Object.entries(FLAVOR_WORDS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([family]) => family);
}

export function itemsInFamilies(catalog, families) {
  if (!families.length) return [];
  return catalog.filter((item) => families.includes(profileOf(item).family));
}
