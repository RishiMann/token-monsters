/**
 * Runtime storefront data.
 *
 * The server owns the catalog and merchandising content. Top-level await
 * keeps the existing named exports available after the source has loaded.
 * Seasonal items only join the menu once their menu is live and their own
 * release date has passed; the calendar shows the rest.
 */

import { releasedSeasonalItems, withState } from "./seasons.js";

let source = {};
export let dataLoadError = null;

try {
    const response = await fetch("/api/storefront");
    if (!response.ok) throw new Error(`Storefront source returned ${response.status}`);
    source = await response.json();
} catch (error) {
    dataLoadError = error;
    console.error("Unable to load storefront data", error);
}

const today = new Date();

export const weeklyMenu = source.weeklyMenu || [];
export const plantBased = source.plantBased || [];
export const eventMenus = source.eventMenus || [];

/** Seasonal items on the counter today. */
export const seasonalMenu = releasedSeasonalItems(eventMenus, today);

/** Every seasonal item, released or not, for the calendar and detail pages. */
export const allSeasonalItems = eventMenus.flatMap((menu) => (menu.items || []).map((item) => ({
    ...item,
    badge: item.badge || "Seasonal",
    seasonName: menu.name,
    seasonOpens: menu.opens,
    seasonCloses: menu.closes,
})));

/** Menus annotated with live / preorder / planned / closed for today. */
export const seasonalMenus = withState(eventMenus, today);

/** What a customer can buy right now. */
export const fullMenu = [...weeklyMenu, ...plantBased, ...seasonalMenu];

export const smartOffers = source.smartOffers || [];
export const plans = source.plans || [];
export const reviews = source.reviews || [];
export const reviewSummary = source.reviewSummary || { rating: 0, count: 0, headline: "", points: [], watchout: "" };
export const agents = source.agents || [];
export const occasions = source.occasions || [];
export const announcements = source.announcements || [];

/** Occasion id -> label, for readable agent reasons. */
export const occasionLabels = Object.fromEntries(occasions.map((o) => [o.id, o.label.toLowerCase()]));

/** Any item by id, on sale or not. */
export const findItem = (id) =>
    fullMenu.find((item) => item.id === id) || allSeasonalItems.find((item) => item.id === id) || null;

/** Whether an item can go in the box today. */
export const isOnSale = (id) => fullMenu.some((item) => item.id === id);
