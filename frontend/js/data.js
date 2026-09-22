/**
 * Runtime storefront data.
 *
 * The server owns the catalog and merchandising content. Top-level await
 * keeps the existing named exports available after the source has loaded.
 */

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

export const weeklyMenu = source.weeklyMenu || [];
export const plantBased = source.plantBased || [];
export const fullMenu = [...weeklyMenu, ...plantBased];
export const eventMenus = source.eventMenus || [];
export const smartOffers = source.smartOffers || [];
export const plans = source.plans || [];
export const reviews = source.reviews || [];
export const reviewSummary = source.reviewSummary || { rating: 0, count: 0, headline: "", points: [], watchout: "" };
export const agents = source.agents || [];
export const occasions = source.occasions || [];
export const announcements = source.announcements || [];
