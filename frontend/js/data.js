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
export const eventMenus = source.eventMenus || [];
const today = new Date();
const isLive = (menu) => {
    if (!menu.opens || !menu.closes) return false;
    const opens = new Date(`${menu.opens}T00:00:00`);
    const closes = new Date(`${menu.closes}T23:59:59`);
    return today >= opens && today <= closes;
};
export const seasonalMenu = eventMenus
    .filter(isLive)
    .flatMap((menu) => (menu.items || []).map((item) => ({
        ...item,
        badge: item.badge || "Seasonal",
        seasonName: menu.name
    })));
export const upcomingSeasonalMenus = eventMenus.filter((menu) => !isLive(menu));
export const fullMenu = [...weeklyMenu, ...plantBased, ...seasonalMenu];
export const smartOffers = source.smartOffers || [];
export const plans = source.plans || [];
export const reviews = source.reviews || [];
export const reviewSummary = source.reviewSummary || { rating: 0, count: 0, headline: "", points: [], watchout: "" };
export const agents = source.agents || [];
export const occasions = source.occasions || [];
export const announcements = source.announcements || [];
