import { eventMenus, smartOffers } from "./data.js";

const idsInCart = (context) => new Set((context?.cart?.lines || []).map((line) => line.id));

/** Returns the facts an agent needs to avoid recommending duplicate items. */
export function assessCart(context = {}) {
    const cart = context.cart || {};
    const lines = cart.lines || [];
    const cartIds = idsInCart(context);

    return {
        count: cart.count || 0,
        capacity: cart.capacity || 6,
        remaining: cart.remaining ?? Math.max(0, 6 - (cart.count || 0)),
        subtotal: cart.subtotal || 0,
        flavorCount: cart.flavorCount || new Set(lines.map((line) => line.id)).size,
        needsVariety: Boolean(cart.needsVariety),
        itemIds: [...cartIds],
        lines: lines.map((line) => ({ id: line.id, name: line.name, quantity: line.quantity }))
    };
}

/** Summarizes repeat behavior and returns favorites that are not already boxed. */
export function analyzePurchaseHistory(context = {}) {
    const history = context.history || {};
    const cartIds = idsInCart(context);
    const favorites = (history.favorites || []).map(({ item, quantity }) => ({
        id: item.id,
        name: item.name,
        quantity,
        inCart: cartIds.has(item.id)
    }));
    const availableFavorites = favorites.filter((favorite) => !favorite.inCart);

    return {
        orderCount: history.orderCount || 0,
        totalTreats: history.totalTreats || 0,
        repeatPattern: history.repeatPattern || context.customer?.repeatPattern || null,
        lastOrder: history.lastOrder || null,
        favorites,
        availableFavorites,
        pattern: history.repeatPattern
            ? `repeat-cadence:${history.repeatPattern.toLowerCase().replace(/\s+/g, "-")}`
            : favorites.length
                ? "repeat-favorites"
                : "new-customer"
    };
}

/** Returns eligible regular offers and live seasonal opportunities with reasons. */
export function findRecommendationDeals(context = {}, { cart, history } = {}) {
    const basket = cart || assessCart(context);
    const purchases = history || analyzePurchaseHistory(context);
    const savedEvent = context.customer?.savedEvent;
    const regular = [];

    smartOffers.forEach((offer) => {
        if (offer.id === "offer-reorder" && purchases.repeatPattern) {
            regular.push({ ...offer, type: "regular", eligibility: "repeat-purchase" });
        }
        if (offer.id === "offer-party" && savedEvent?.guests > basket.count) {
            regular.push({ ...offer, type: "regular", eligibility: "saved-event" });
        }
    });

    const liveSeasonal = eventMenus.find((menu) => menu.status === "live");
    const seasonal = liveSeasonal
        ? [{
            type: "seasonal",
            eligibility: "live-seasonal-menu",
            id: liveSeasonal.id,
            title: liveSeasonal.name,
            detail: liveSeasonal.blurb,
            highlights: liveSeasonal.highlights,
            reason: `The ${liveSeasonal.name} menu is live now.`
        }]
        : [];

    const seasonalOffer = smartOffers.find((offer) => offer.id === "offer-season");
    if (seasonalOffer && liveSeasonal) {
        seasonal.push({ ...seasonalOffer, type: "seasonal", eligibility: "live-seasonal-offer" });
    }

    return { regular, seasonal, hasDeal: regular.length > 0 || seasonal.length > 0 };
}

/** Tool bundle exposed to recommendation agents and future model adapters. */
export const recommendationTools = {
    assessCart,
    analyzePurchaseHistory,
    findRecommendationDeals
};

export function runRecommendationTools(context = {}) {
    const cart = assessCart(context);
    const history = analyzePurchaseHistory(context);
    const deals = findRecommendationDeals(context, { cart, history });
    return { cart, history, deals };
}
