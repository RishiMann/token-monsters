/**
 * The live agent surfaces, wired to the storefront's data.
 *
 * The reasoning lives in recommendation-engine.js and offers.js, both pure.
 * This module hands them today's catalog, the live seasons and whatever the
 * context pipeline knows about the customer, so callers in the UI stay short.
 */

import { fullMenu, eventMenus, smartOffers, occasionLabels } from "./data.js";
import { recommend as engineRecommend, familiesIn, itemsInFamilies } from "./recommendation-engine.js";
import { liveSeasons as seasonsLive } from "./seasons.js";
import { evaluateOffers, priceBox, bestOffer } from "./offers.js";

/** Seasonal menus open today, with their released line-ups. */
export function liveSeasons(today = new Date()) {
  return seasonsLive(eventMenus, today);
}

/** History and popularity signals in the shape the engine takes. */
function signalsFrom(context) {
  const favorites = (context?.history?.favorites || [])
    .filter(({ item }) => item)
    .map(({ item, quantity }) => ({ id: item.id, name: item.name, units: quantity || 1 }));
  const popular = (context?.market?.popular || []).map((entry) => entry.item?.id).filter(Boolean);
  return { favorites, popular };
}

/**
 * What to suggest next for this box, and why.
 * options: { limit, avoid, occasion, context }
 */
export function recommend(lines, options = {}) {
  const { context, ...rest } = options;
  return engineRecommend(fullMenu, lines, {
    seasons: liveSeasons(),
    occasionLabels,
    ...signalsFrom(context),
    ...rest,
  });
}

/** What the offer rules need to know about this customer. */
export function offerContext({ context = null, signedIn = false } = {}) {
  const { favorites } = signalsFrom(context);
  return {
    liveSeasons: liveSeasons(),
    signedIn,
    favorites: signedIn ? favorites : [],
    repeatPattern: signedIn ? context?.customer?.repeatPattern || null : null,
  };
}

/** Every offer against this box, eligible first. */
export function offersFor(snapshot, customer = {}) {
  return evaluateOffers(smartOffers, snapshot, offerContext(customer));
}

/** The receipt for this box. */
export function receipt(snapshot, { appliedId = null, fulfillment = "pickup", customer = {} } = {}) {
  return priceBox(smartOffers, snapshot, { appliedId, fulfillment, context: offerContext(customer) });
}

export { bestOffer, familiesIn, itemsInFamilies };

/** Items on sale that answer a craving in free text. */
export function itemsForCraving(text) {
  return itemsInFamilies(fullMenu, familiesIn(text));
}
