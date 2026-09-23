/**
 * Seasonal menus and release dates, computed from today's date.
 *
 * A menu is live between `opens` and `closes`; each item inside it has its
 * own `releaseDate`, so a live menu can still have items that are not on the
 * counter yet. Everything here is a pure function of the menus and a date, so
 * the storefront, the calendar and the agents all agree on what is available.
 */

const DAY = 86400000;

export const dayStart = (iso) => new Date(`${iso}T00:00:00`);
const dayEnd = (iso) => new Date(`${iso}T23:59:59`);

/** Whole days from `from` to the start of `iso`, negative when it has passed. */
export function daysUntil(iso, from = new Date()) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  return Math.round((dayStart(iso) - start) / DAY);
}

/** live | preorder | planned | closed, plus how far away the opening is. */
export function seasonState(menu, today = new Date()) {
  if (!menu.opens || !menu.closes) return { state: "planned", daysUntil: null };
  const opens = dayStart(menu.opens);
  const closes = dayEnd(menu.closes);
  let state = "closed";
  if (today >= opens && today <= closes) state = "live";
  else if (today < opens) state = daysUntil(menu.opens, today) <= 56 ? "preorder" : "planned";
  return { state, daysUntil: daysUntil(menu.opens, today) };
}

/** Whether one item inside a menu is on the counter today. */
export function isReleased(item, menu, today = new Date()) {
  if (seasonState(menu, today).state !== "live") return false;
  const release = item.releaseDate || menu.opens;
  return today >= dayStart(release);
}

/**
 * Every menu annotated with its state and its items split into what is on
 * the counter and what is still to come.
 */
export function withState(menus, today = new Date()) {
  return menus.map((menu) => {
    const { state, daysUntil: away } = seasonState(menu, today);
    const items = menu.items || [];
    return {
      ...menu,
      state,
      daysUntil: away,
      released: items.filter((item) => isReleased(item, menu, today)),
      upcoming: items.filter((item) => !isReleased(item, menu, today)),
    };
  });
}

/** The seasonal items a customer can buy today, tagged with their menu. */
export function releasedSeasonalItems(menus, today = new Date()) {
  return withState(menus, today).flatMap((menu) =>
    menu.released.map((item) => ({
      ...item,
      badge: item.badge || "Seasonal",
      seasonName: menu.name,
      seasonCloses: menu.closes,
    }))
  );
}

/** Menus currently open, for the surfaces that talk about "what is live". */
export function liveSeasons(menus, today = new Date()) {
  return withState(menus, today).filter((menu) => menu.state === "live");
}

/**
 * Upcoming releases across every menu, soonest first. Includes items in a
 * live menu that have not released yet and everything in future menus.
 */
export function upcomingReleases(menus, today = new Date(), { limit = Infinity } = {}) {
  const list = [];
  for (const menu of withState(menus, today)) {
    if (menu.state === "closed") continue;
    for (const item of menu.upcoming) {
      const date = item.releaseDate || menu.opens;
      list.push({ item, menu, date, daysUntil: daysUntil(date, today) });
    }
  }
  return list
    .sort((a, b) => a.date.localeCompare(b.date) || a.item.name.localeCompare(b.item.name))
    .slice(0, limit);
}

/** Every release, past and future, keyed by ISO date — what the calendar draws. */
export function releasesByDate(menus, today = new Date()) {
  const byDate = new Map();
  for (const menu of withState(menus, today)) {
    for (const item of menu.items || []) {
      const date = item.releaseDate || menu.opens;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({
        item, menu, date,
        released: isReleased(item, menu, today),
        daysUntil: daysUntil(date, today),
      });
    }
  }
  return byDate;
}
