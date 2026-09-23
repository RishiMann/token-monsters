/** Builds agent-readable context from the backend context data source. */

import { eventMenus, fullMenu, weeklyMenu } from "./data.js";
import { liveSeasons } from "./seasons.js";

const CONTEXT_ENDPOINT = "/api/context";
const DEFAULT_NEEDS = ["customer", "history", "cart", "market", "signals"];

export async function fetchContextSource({ signal } = {}) {
    try {
        const response = await fetch(CONTEXT_ENDPOINT, { signal });
        if (!response.ok) throw new Error(`Context source returned ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error("Unable to load agent context", error);
        return {};
    }
}

const itemById = (id) => fullMenu.find((item) => item.id === id);

function normalizeCart(cart) {
    const lines = Array.isArray(cart) ? cart : cart?.lines || [];
    return lines.map((line) => {
        const item = line.item || itemById(line.id);
        return item ? { id: item.id, name: item.name, quantity: line.qty ?? line.quantity ?? 1, price: item.price } : null;
    }).filter(Boolean);
}

function summarizeHistory(source) {
    const counts = new Map();
    const orders = Array.isArray(source.orderHistory) ? source.orderHistory : [];
    orders.forEach((order) => order.items.forEach(({ id, quantity }) => {
        counts.set(id, (counts.get(id) || 0) + quantity);
    }));

    const favorites = [...counts.entries()]
        .sort(([, first], [, second]) => second - first)
        .map(([id, quantity]) => ({ item: itemById(id), quantity }))
        .filter(({ item }) => item)
        .slice(0, 4);

    return {
        orderCount: orders.length,
        lastOrder: orders[0] || null,
        repeatPattern: source.customer?.repeatPattern || null,
        favorites,
        totalTreats: [...counts.values()].reduce((sum, quantity) => sum + quantity, 0),
        orders
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

function summarizeMarket(source) {
    const popular = (Array.isArray(source.popularity) ? source.popularity : [])
        .map((signal) => ({ ...signal, item: itemById(signal.id) }))
        .filter((signal) => signal.item);
    const liveSeasonal = liveSeasons(eventMenus)[0] || eventMenus[0] || { id: null, name: "", highlights: [] };

    return {
        popular,
        habits: Array.isArray(source.marketHabits) ? source.marketHabits : [],
        liveSeasonal: { id: liveSeasonal.id, name: liveSeasonal.name, highlights: liveSeasonal.highlights },
        weeklyLineup: weeklyMenu.map(({ id, name, rating, tags }) => ({ id, name, rating, tags }))
    };
}

export async function generateContext({ cart = [], now = new Date(), needs = DEFAULT_NEEDS } = {}) {
    const source = await fetchContextSource();
    const history = summarizeHistory(source);
    const basket = summarizeCart(cart);
    const market = summarizeMarket(source);
    const favoriteIds = history.favorites.map(({ item }) => item.id);
    const cartIds = new Set(basket.lines.map((line) => line.id));
    const completeContext = {
        generatedAt: now.toISOString(),
        customer: {
            ...(source.customer || {}),
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
            partyGap: source.customer?.savedEvent?.guests > basket.count
                ? source.customer.savedEvent.guests - basket.count
                : 0
        }
    };

    return Object.fromEntries(
        ["generatedAt", ...needs].filter((section) => section in completeContext)
            .map((section) => [section, completeContext[section]])
    );
}
