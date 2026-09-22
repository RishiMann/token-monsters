/**
 * Builds the context packet shared by the storefront agents.
 *
 * The fixture signals are intentionally shaped like service responses. Replace
 * the fixture arrays with API data later without changing agent callers.
 */

import { eventMenus, fullMenu, weeklyMenu } from "./data.js";

const ORDER_HISTORY = [
    { date: "2026-09-18", items: [{ id: "brown-butter", quantity: 4 }, { id: "lemon-cloud", quantity: 2 }], channel: "pickup", occasion: "Friday treat" },
    { date: "2026-09-11", items: [{ id: "brown-butter", quantity: 4 }, { id: "pink-velvet", quantity: 2 }], channel: "pickup", occasion: "Friday treat" },
    { date: "2026-09-04", items: [{ id: "brown-butter", quantity: 2 }, { id: "strawberry-stack", quantity: 2 }], channel: "delivery", occasion: "family dessert" },
    { date: "2026-08-29", items: [{ id: "lemon-cloud", quantity: 2 }, { id: "coconut-matcha", quantity: 2 }], channel: "pickup", occasion: "brunch" }
];

const CUSTOMER_PROFILE = {
    id: "demo-customer-001",
    name: "Alex",
    location: "Frisco Corner",
    savedEvent: { name: "Saturday garden party", guests: 14, date: "2026-09-26" },
    dietary: [],
    preferences: { sweetness: "balanced", texture: "light", adventurousness: "curious" }
};

const MARKET_HABITS = [
    { signal: "Friday pickup", detail: "Customers tend to reorder familiar flavors for end-of-week pickup.", strength: 0.82 },
    { signal: "mixed boxes", detail: "Six-count boxes perform best when they include at least three flavors.", strength: 0.76 },
    { signal: "occasion-led orders", detail: "Party and thank-you orders skew toward shareable, fruit-forward picks.", strength: 0.71 },
    { signal: "seasonal discovery", detail: "Customers who buy citrus are more likely to try orchard flavors next.", strength: 0.68 }
];

const POPULARITY = [
    { id: "pink-velvet", orders: 842, trend: "steady" },
    { id: "midnight-fudge", orders: 796, trend: "rising" },
    { id: "brown-butter", orders: 774, trend: "steady" },
    { id: "strawberry-stack", orders: 731, trend: "rising" },
    { id: "lemon-cloud", orders: 688, trend: "rising" },
    { id: "coconut-matcha", orders: 412, trend: "new audience" }
];

const itemById = (id) => fullMenu.find((item) => item.id === id);

function normalizeCart(cart) {
    const lines = Array.isArray(cart) ? cart : cart?.lines || [];
    return lines.map((line) => {
        const item = line.item || itemById(line.id);
        return item ? { id: item.id, name: item.name, quantity: line.qty ?? line.quantity ?? 1, price: item.price } : null;
    }).filter(Boolean);
}

function summarizeHistory() {
    const counts = new Map();
    ORDER_HISTORY.forEach((order) => order.items.forEach(({ id, quantity }) => {
        counts.set(id, (counts.get(id) || 0) + quantity);
    }));

    const favorites = [...counts.entries()]
        .sort(([, first], [, second]) => second - first)
        .map(([id, quantity]) => ({ item: itemById(id), quantity }))
        .filter(({ item }) => item)
        .slice(0, 4);

    return {
        orderCount: ORDER_HISTORY.length,
        lastOrder: ORDER_HISTORY[0],
        repeatPattern: "Friday pickup",
        favorites,
        totalTreats: [...counts.values()].reduce((sum, quantity) => sum + quantity, 0),
        orders: ORDER_HISTORY
    };
}

function summarizeCart(cart) {
    const lines = normalizeCart(cart);
    const count = lines.reduce((sum, line) => sum + line.quantity, 0);
    const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
    const itemIds = new Set(lines.map((line) => line.id));
    const remaining = Math.max(0, 6 - count);

    return {
        lines,
        count,
        subtotal: Number(subtotal.toFixed(2)),
        capacity: 6,
        remaining,
        isFull: count >= 6,
        flavorCount: itemIds.size,
        needsVariety: count >= 3 && itemIds.size < 3
    };
}

function summarizeMarket() {
    const popular = POPULARITY.map((signal) => ({ ...signal, item: itemById(signal.id) })).filter((signal) => signal.item);
    const liveSeasonal = eventMenus.find((menu) => menu.status === "live") || eventMenus[0];

    return {
        popular,
        habits: MARKET_HABITS,
        liveSeasonal: { id: liveSeasonal.id, name: liveSeasonal.name, highlights: liveSeasonal.highlights },
        weeklyLineup: weeklyMenu.map(({ id, name, rating, tags }) => ({ id, name, rating, tags }))
    };
}

export function generateContext({ cart = [], now = new Date() } = {}) {
    const history = summarizeHistory();
    const basket = summarizeCart(cart);
    const market = summarizeMarket();
    const favoriteIds = history.favorites.map(({ item }) => item.id);
    const cartIds = new Set(basket.lines.map((line) => line.id));

    return {
        generatedAt: now.toISOString(),
        customer: {
            ...CUSTOMER_PROFILE,
            favoriteIds,
            repeatPattern: history.repeatPattern
        },
        history,
        cart: basket,
        market,
        signals: {
            personalizedFavorites: history.favorites.filter(({ item }) => !cartIds.has(item.id)).map(({ item }) => item),
            popularNext: market.popular.filter(({ item }) => !cartIds.has(item.id)).slice(0, 3).map(({ item }) => item),
            boxGap: basket.remaining,
            partyGap: CUSTOMER_PROFILE.savedEvent.guests > basket.count
                ? CUSTOMER_PROFILE.savedEvent.guests - basket.count
                : 0
        }
    };
}

export { ORDER_HISTORY, MARKET_HABITS };
