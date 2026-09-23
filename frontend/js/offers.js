/**
 * Offers: which ones a box has earned, and what each is worth at checkout.
 *
 * Every offer in the catalog carries a `rule`; this module is the only place
 * that reads it. Nothing here is a blanket coupon: an offer is either eligible
 * against the current box, with the amount it takes off, or ineligible with
 * the plain reason why. One discount applies at a time. Free delivery is
 * automatic and stacks with whichever discount is applied.
 *
 * Pure: takes the box and the customer, returns numbers. The server evaluates
 * the same rules in backend/offers.py.
 */

const money = (value) => `$${value.toFixed(2)}`;
const round = (value) => Math.round(value * 100) / 100;

/** Facts every rule needs, computed once from the box. */
function facts(basket, context) {
  const lines = basket.lines || [];
  const count = basket.count ?? lines.reduce((sum, line) => sum + (line.qty || 1), 0);
  const subtotal = basket.subtotal ?? lines.reduce((sum, line) => sum + line.item.price * (line.qty || 1), 0);
  const liveSeasons = context.liveSeasons || [];
  const liveIds = new Set(liveSeasons.map((season) => season.id));
  const seasonalUnits = lines
    .filter((line) => line.item.season && (liveIds.size === 0 || liveIds.has(line.item.season)))
    .reduce((sum, line) => sum + (line.qty || 1), 0);
  const favorites = context.favorites || [];
  const favoriteIds = new Set(favorites.map((f) => f.id));
  const favoriteLines = lines
    .filter((line) => favoriteIds.has(line.item.id))
    .sort((a, b) => (b.qty || 1) - (a.qty || 1));
  return {
    lines, count, subtotal,
    flavors: new Set(lines.map((line) => line.item.id)).size,
    seasonalUnits,
    liveSeasonName: liveSeasons[0]?.name || null,
    signedIn: Boolean(context.signedIn),
    repeatPattern: context.repeatPattern || null,
    favorites,
    favoriteLines,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Evaluate one rule. Returns { eligible, discount, why, progress, addon }. */
function evaluate(offer, f) {
  const rule = offer.rule || {};
  switch (rule.type) {
    case "percent": {
      if (rule.requires === "favorite") {
        if (!f.signedIn) return { eligible: false, why: "Sign in and your reorder rate applies to a box of favorites." };
        if (!f.favorites.length) return { eligible: false, why: "Order a couple of boxes first — this one prices your regulars." };
        const need = rule.minFavoriteUnits || 4;
        const hit = f.favoriteLines.find((line) => (line.qty || 1) >= need);
        if (hit) {
          return {
            eligible: true, discount: round(f.subtotal * rule.percent / 100),
            why: `${hit.qty} × ${hit.item.name} — you keep coming back for it.`,
          };
        }
        const closest = f.favoriteLines[0];
        const favoriteName = closest?.item.name || f.favorites[0].name || "a favorite";
        const have = closest?.qty || 0;
        return {
          eligible: false,
          why: `Add ${plural(need - have, "more")} ${favoriteName} — ${need} of a favorite unlocks it.`,
          progress: Math.round((have / need) * 100),
        };
      }
      const tiers = rule.tiers || [{ minItems: rule.minItems || 0, percent: rule.percent }];
      const tier = tiers.find((t) => f.count >= (t.minItems || 0) && f.flavors >= (t.minFlavors || 0));
      if (tier) {
        const better = tiers.find((t) => t.percent > tier.percent);
        const nudge = better && f.flavors < (better.minFlavors || 0)
          ? ` Mix in ${plural((better.minFlavors || 0) - f.flavors, "more flavor")} for ${better.percent}%.`
          : "";
        return {
          eligible: true, discount: round(f.subtotal * tier.percent / 100), percent: tier.percent,
          why: `${f.count} treats across ${plural(f.flavors, "flavor")} — the box takes ${tier.percent}% off.${nudge}`,
        };
      }
      const min = Math.min(...tiers.map((t) => t.minItems || 0));
      return {
        eligible: false,
        why: `Add ${plural(min - f.count, "more")} to fill the six-count.`,
        progress: Math.round((f.count / min) * 100),
      };
    }
    case "free-addon": {
      const min = rule.minItems || 12;
      if (f.count >= min) {
        return { eligible: true, discount: 0, addon: rule.addon, why: `${f.count} treats — the ${rule.addon.name.toLowerCase()} rides along free.` };
      }
      return { eligible: false, why: `Add ${plural(min - f.count, "more")} for the party box.`, progress: Math.round((f.count / min) * 100) };
    }
    case "fixed-per-item": {
      if (rule.requires === "seasonal") {
        if (!f.liveSeasonName) return { eligible: false, why: "No seasonal menu is live right now." };
        if (f.seasonalUnits === 0) return { eligible: false, why: `Add something from ${f.liveSeasonName} to use it.` };
        const units = Math.min(f.seasonalUnits, rule.maxUnits || Infinity);
        return {
          eligible: true, discount: round(rule.amount * units),
          why: `${plural(units, "seasonal treat")} in the box at ${money(rule.amount)} off each.`,
        };
      }
      return { eligible: false, why: "Not available." };
    }
    case "free-delivery": {
      const min = rule.minSubtotal || 45;
      if (f.subtotal >= min) {
        return { eligible: true, discount: 0, why: "Applied on its own when you choose delivery at checkout.", progress: 100 };
      }
      return {
        eligible: false,
        why: `${money(min - f.subtotal)} more and delivery is free. Applies on its own at checkout.`,
        progress: Math.round((f.subtotal / min) * 100),
      };
    }
    default:
      return { eligible: false, why: "Not available." };
  }
}

/**
 * Every offer, with whether the box has earned it and what it is worth.
 * Eligible ones come first, best value first.
 */
export function evaluateOffers(offers, basket, context = {}) {
  const f = facts(basket, context);
  return offers
    .map((offer) => {
      const result = evaluate(offer, f);
      return {
        ...offer,
        eligible: result.eligible,
        live: result.eligible,
        discount: result.discount || 0,
        addon: result.addon || null,
        why: result.why,
        progress: result.progress ?? (result.eligible ? 100 : null),
        percent: result.percent,
      };
    })
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.discount - a.discount);
}

/** The discount the box would take if the customer applied the best one. */
export function bestOffer(evaluated) {
  return evaluated.find((offer) => offer.eligible && !offer.auto && offer.discount > 0) || null;
}

/**
 * The receipt. `appliedId` is honored only while that offer is still
 * eligible; the caller learns from `applied` whether it survived.
 */
export function priceBox(offers, basket, { appliedId = null, fulfillment = "pickup", context = {} } = {}) {
  const evaluated = evaluateOffers(offers, basket, context);
  const f = facts(basket, context);
  const applied = appliedId ? evaluated.find((offer) => offer.id === appliedId && offer.eligible && !offer.auto) || null : null;
  const delivery = offers.find((offer) => offer.rule?.type === "free-delivery");
  const fee = delivery?.rule?.fee ?? 6.95;
  const threshold = delivery?.rule?.minSubtotal ?? 45;
  const deliveryFree = f.subtotal >= threshold;
  const deliveryFee = fulfillment === "delivery" && !deliveryFree ? fee : 0;
  const discount = applied ? applied.discount : 0;

  return {
    subtotal: round(f.subtotal),
    applied,
    discount: round(discount),
    addon: applied?.addon || null,
    fulfillment,
    deliveryFee: round(deliveryFee),
    deliveryFree: fulfillment === "delivery" && deliveryFree,
    total: round(Math.max(0, f.subtotal - discount + deliveryFee)),
    evaluated,
  };
}
