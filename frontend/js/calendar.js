/**
 * The seasonal release calendar.
 *
 * A month grid with every seasonal item pinned to the day it releases, a
 * legend of the menus with their live / pre-order / planned state, and a
 * "coming up" list. Everything is computed from today's date: released items
 * read as on the counter, future ones show a countdown, and the whole thing
 * re-renders itself at midnight so it never goes stale on an open tab.
 */

import { releasesByDate, upcomingReleases, withState, daysUntil } from "./seasons.js";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const money = (value) => `$${Number(value).toFixed(2)}`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATE_LABEL = { live: "Live now", preorder: "Pre-order", planned: "Planned", closed: "Closed" };

const iso = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const monthTitle = (date) => date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
const shortDate = (isoDate) =>
  new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function countdown(days) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} ago`;
  if (days < 14) return `in ${days} days`;
  const weeks = Math.round(days / 7);
  return `in ${weeks} week${weeks === 1 ? "" : "s"}`;
}

/**
 * Mounts the calendar into `root`. Returns { destroy }.
 * options: { menus, today, onOpenItem(id) }
 */
export function initCalendar(root, { menus, today = new Date(), onOpenItem } = {}) {
  if (!root) return { destroy() {} };

  let now = today;
  let cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  let selected = iso(now);
  let midnightTimer = null;

  const releases = () => releasesByDate(menus, now);

  function bounds() {
    const dates = [...releases().keys()].sort();
    const first = dates[0] ? new Date(`${dates[0]}T00:00:00`) : now;
    const last = dates[dates.length - 1] ? new Date(`${dates[dates.length - 1]}T00:00:00`) : now;
    const earliest = new Date(Math.min(first, now));
    const latest = new Date(Math.max(last, now));
    return {
      min: new Date(earliest.getFullYear(), earliest.getMonth(), 1),
      max: new Date(latest.getFullYear(), latest.getMonth(), 1),
    };
  }

  function legend() {
    return withState(menus, now).map((menu) => `
      <button class="cal-season tint-${esc(menu.tint)} state-${menu.state}" type="button"
              data-cal-jump="${esc(menu.opens)}" title="Jump to ${esc(menu.name)}">
        <span class="cal-season-emoji" aria-hidden="true">${menu.emoji}</span>
        <span class="cal-season-body">
          <strong>${esc(menu.name)}</strong>
          <small>${esc(menu.window)}</small>
        </span>
        <span class="cal-season-state">${STATE_LABEL[menu.state]}</span>
      </button>`).join("");
  }

  function grid() {
    const byDate = releases();
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayIso = iso(now);
    const cells = [];

    for (let i = 0; i < firstDay; i += 1) cells.push('<div class="cal-day is-outside" aria-hidden="true"></div>');

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = iso(new Date(year, month, day));
      const entries = byDate.get(date) || [];
      const classes = ["cal-day"];
      if (date === todayIso) classes.push("is-today");
      if (date === selected) classes.push("is-selected");
      if (entries.length) classes.push("has-releases");
      if (date < todayIso) classes.push("is-past");
      const label = entries.length
        ? `${shortDate(date)}: ${entries.map((e) => e.item.name).join(", ")}`
        : shortDate(date);
      cells.push(`
        <button class="${classes.join(" ")}" type="button" data-cal-day="${date}" aria-label="${esc(label)}"
                aria-pressed="${date === selected}">
          <span class="cal-num">${day}</span>
          <span class="cal-events">
            ${entries.map((entry) => `
              <span class="cal-event tint-${esc(entry.menu.tint)}${entry.released ? " is-released" : ""}"
                    title="${esc(entry.item.name)}">
                <img src="${esc(entry.item.image)}" alt="" loading="lazy" width="40" height="30" />
                <span class="cal-event-name">${esc(entry.item.name)}</span>
              </span>`).join("")}
          </span>
        </button>`);
    }

    return `
      <div class="cal-weekdays" aria-hidden="true">${WEEKDAYS.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cal-grid" role="grid">${cells.join("")}</div>`;
  }

  function dayPanel() {
    const entries = releases().get(selected) || [];
    const days = daysUntil(selected, now);
    const heading = selected === iso(now) ? "Today" : shortDate(selected);
    if (!entries.length) {
      const next = upcomingReleases(menus, now, { limit: 1 })[0];
      return `
        <div class="cal-day-panel">
          <p class="cal-day-title">${esc(heading)}</p>
          <p class="cal-day-empty">Nothing releases on this day.${next
            ? ` Next up is ${esc(next.item.name)} on ${esc(shortDate(next.date))}.` : ""}</p>
        </div>`;
    }
    return `
      <div class="cal-day-panel">
        <p class="cal-day-title">${esc(heading)} · ${entries.length === 1 ? "1 release" : `${entries.length} releases`}
          <span class="cal-day-when">${esc(countdown(days))}</span></p>
        <div class="cal-day-items">
          ${entries.map((entry) => `
            <article class="cal-item tint-${esc(entry.menu.tint)}">
              <img src="${esc(entry.item.image)}" alt="${esc(entry.item.name)}" loading="lazy" width="400" height="300" />
              <div class="cal-item-body">
                <span class="cal-item-menu">${esc(entry.menu.name)}</span>
                <strong>${esc(entry.item.name)}</strong>
                <small>${esc(entry.item.blurb)}</small>
                <div class="cal-item-foot">
                  <span>${money(entry.item.price)}</span>
                  ${entry.released
                    ? `<button class="chip chip-solid" type="button" data-add="${esc(entry.item.id)}">Add to box</button>`
                    : `<button class="chip" type="button" data-open-item="${esc(entry.item.id)}">Preview</button>`}
                </div>
              </div>
            </article>`).join("")}
        </div>
      </div>`;
  }

  function upcoming() {
    const list = upcomingReleases(menus, now, { limit: 6 });
    if (!list.length) return `<p class="cal-day-empty">Every seasonal item is on the counter.</p>`;
    return `
      <ol class="cal-upcoming-list">
        ${list.map(({ item, menu, date, daysUntil: days }) => `
          <li class="cal-upcoming tint-${esc(menu.tint)}">
            <button class="cal-upcoming-open" type="button" data-cal-goto="${date}" aria-label="Show ${esc(item.name)} on the calendar">
              <img src="${esc(item.image)}" alt="" loading="lazy" width="56" height="42" />
            </button>
            <div class="cal-upcoming-body">
              <strong>${esc(item.name)}</strong>
              <small>${esc(menu.name)} · ${esc(shortDate(date))} · ${esc(countdown(days))}</small>
            </div>
            <button class="chip" type="button" data-open-item="${esc(item.id)}">Preview</button>
          </li>`).join("")}
      </ol>`;
  }

  function render() {
    const { min, max } = bounds();
    root.innerHTML = `
      <div class="calendar">
        <div class="cal-head">
          <button class="icon-button" type="button" data-cal-prev aria-label="Previous month"
                  ${cursor <= min ? "disabled" : ""}>‹</button>
          <h3 class="cal-title" aria-live="polite">${esc(monthTitle(cursor))}</h3>
          <button class="icon-button" type="button" data-cal-next aria-label="Next month"
                  ${cursor >= max ? "disabled" : ""}>›</button>
          <button class="chip cal-today" type="button" data-cal-today>Today</button>
        </div>
        <div class="cal-legend">${legend()}</div>
        ${grid()}
        ${dayPanel()}
      </div>
      <aside class="cal-side" aria-label="Coming up">
        <p class="eyebrow">Coming up</p>
        ${upcoming()}
      </aside>`;
  }

  function goto(date) {
    const target = new Date(`${date}T00:00:00`);
    cursor = new Date(target.getFullYear(), target.getMonth(), 1);
    selected = date;
    render();
    root.querySelector(`[data-cal-day="${date}"]`)?.focus({ preventScroll: true });
  }

  function onClick(event) {
    if (event.target.closest("[data-cal-prev]")) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
      return render();
    }
    if (event.target.closest("[data-cal-next]")) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      return render();
    }
    if (event.target.closest("[data-cal-today]")) return goto(iso(now));
    const jump = event.target.closest("[data-cal-jump]");
    if (jump) return goto(jump.dataset.calJump);
    const go = event.target.closest("[data-cal-goto]");
    if (go) return goto(go.dataset.calGoto);
    const day = event.target.closest("[data-cal-day]");
    if (day) {
      selected = day.dataset.calDay;
      return render();
    }
    const open = event.target.closest("[data-open-item]");
    if (open && onOpenItem) {
      event.stopPropagation();
      onOpenItem(open.dataset.openItem);
    }
  }

  function onKey(event) {
    const day = event.target.closest?.("[data-cal-day]");
    if (!day) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!delta) return;
    event.preventDefault();
    const next = new Date(`${day.dataset.calDay}T00:00:00`);
    next.setDate(next.getDate() + delta);
    goto(iso(next));
  }

  /** Re-render on the stroke of midnight so "today" and countdowns stay true. */
  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 5, 0);
    midnightTimer = setTimeout(() => {
      now = new Date();
      render();
      scheduleMidnight();
    }, Math.max(1000, next - Date.now()));
  }

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  render();
  scheduleMidnight();

  return {
    destroy() {
      clearTimeout(midnightTimer);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
    },
  };
}
