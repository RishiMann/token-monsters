/**
 * Demo data for when the server has no database.
 *
 * Mirrors backend/seed.py: the same corners, supplies, pressure points and
 * tastes, generated with a fixed seed so the numbers are identical on every
 * machine and every reload. Used only on the demo sign-in path; with a
 * database configured the pages read the real rows from the API instead.
 */

import { fullMenu, smartOffers } from "./data.js";

/** Deterministic PRNG, so a demo never shifts under you mid-presentation. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOCATIONS = [
  { id: "frisco", name: "Frisco Corner", region: "North TX" },
  { id: "plano", name: "Plano Corner", region: "North TX" },
  { id: "austin", name: "South Congress", region: "Central TX" },
  { id: "houston", name: "Heights Corner", region: "Gulf" },
  { id: "scottsdale", name: "Scottsdale Corner", region: "Southwest" }
];

// sku, name, unit, base stock, reorder point, lead days
const SUPPLIES = [
  ["FLR-001", "Pastry flour", "kg", 240, 120, 3],
  ["BTR-002", "Cultured butter", "kg", 96, 90, 2],
  ["CHC-003", "Dark chocolate 70%", "kg", 70, 60, 5],
  ["CRM-004", "Cream cheese", "kg", 62, 45, 2],
  ["FRT-005", "Strawberry puree", "L", 48, 40, 4],
  ["CTR-006", "Lemon curd base", "L", 62, 35, 3],
  ["SPC-007", "Speculoos spread", "kg", 40, 30, 6],
  ["PKG-008", "Six-count boxes", "units", 4200, 2500, 7],
  ["MTC-009", "Matcha powder", "kg", 16, 10, 9]
];

// Deliberate low points, so the console shows a real spread, not all green.
const PRESSURE = {
  frisco: ["CHC-003"],
  plano: ["SPC-007", "MTC-009"],
  austin: ["BTR-002", "FRT-005", "CHC-003"],
  houston: ["MTC-009"]
};

const TASTE = {
  "alex@frostedcorner.com": ["brown-butter", "lemon-cloud", "pink-velvet", "strawberry-stack"],
  "sam@frostedcorner.com": ["midnight-fudge", "biscoff", "brown-butter"],
  "jordan@frostedcorner.com": ["coconut-matcha", "lemon-cloud", "almond-fig"]
};

const PREFERENCES = {
  "alex@frostedcorner.com": {
    sweetness: "balanced", texture: "light", adventurousness: "curious",
    repeat_pattern: "Friday pickup", allergens_avoid: "",
    saved_event: "Saturday garden party|14|2026-09-26"
  },
  "sam@frostedcorner.com": {
    sweetness: "rich", texture: "dense", adventurousness: "adventurous",
    repeat_pattern: "Sunday delivery", allergens_avoid: "tree nut"
  },
  "jordan@frostedcorner.com": {
    sweetness: "light", texture: "airy", adventurousness: "cautious",
    repeat_pattern: "", allergens_avoid: "dairy"
  }
};

const round2 = (value) => Math.round(value * 100) / 100;
const iso = (date) => date.toISOString().slice(0, 10);
const daysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
};

function statusFor(row) {
  if (row.on_hand <= row.reorder_point * 0.6) return "critical";
  if (row.on_order > 0) return "inbound";
  if (row.on_hand <= row.reorder_point) return "low";
  return "ok";
}

/** Inventory, corners, supply orders and sales, in the console's shapes. */
export function demoOperations() {
  const random = rng(20260922);
  const inventory = [];

  for (const location of LOCATIONS) {
    const squeeze = location.id === "scottsdale" ? 0.4 : 1.05 + random() * 0.45;
    for (const [sku, name, unit, base, reorder, lead] of SUPPLIES) {
      const pressured = (PRESSURE[location.id] || []).includes(sku);
      const onHand = pressured
        ? round2(reorder * (0.55 + random() * 0.35))
        : round2(base * squeeze * (0.9 + random() * 0.3));
      const onOrder = onHand < reorder && random() < 0.5 ? round2(base * 0.5) : 0;
      const row = {
        sku, name, unit, location: location.name,
        on_hand: onHand, reorder_point: reorder,
        on_order: onOrder, lead_time_days: lead
      };
      row.status = statusFor(row);
      inventory.push(row);
    }
  }

  const locations = LOCATIONS.map((location) => {
    const rows = inventory.filter((row) => row.location === location.name);
    const healthy = rows.filter((row) => row.status === "ok").length;
    return {
      ...location,
      orders_week: 500 + Math.floor(random() * 450),
      revenue_week: round2(11000 + random() * 10500),
      change_pct: round2(-3 + random() * 15),
      stock_health: Math.round((healthy / rows.length) * 100)
    };
  });

  const statuses = ["delivered", "in-transit", "in-transit", "submitted", "in-transit"];
  const supplyOrders = LOCATIONS.map((location, index) => {
    const placed = daysAgo(2 + Math.floor(random() * 7));
    const eta = new Date(placed);
    eta.setDate(eta.getDate() + 4 + Math.floor(random() * 3));
    return {
      id: `SO-${1040 + index}`,
      location: location.name,
      placed: iso(placed),
      eta: iso(eta),
      status: statuses[index % statuses.length],
      total: round2(1800 + random() * 2500),
      lines: 4 + Math.floor(random() * 5)
    };
  });

  // Six weeks of revenue with a gentle upward trend.
  const weekly = [];
  for (let week = 5; week >= 0; week -= 1) {
    const day = daysAgo(week * 7);
    const [year, weekNumber] = isoWeek(day);
    weekly.push({
      label: `${year}-W${String(weekNumber).padStart(2, "0")}`,
      revenue: round2(72000 + (5 - week) * 2400 + random() * 4000)
    });
  }

  const revenue = round2(weekly[weekly.length - 1].revenue);
  const orders = Math.round(revenue / 22.4);
  const byRegion = [...new Set(LOCATIONS.map((l) => l.region))].map((region) => ({
    region,
    revenue: round2(
      locations.filter((l) => l.region === region)
        .reduce((sum, l) => sum + l.revenue_week, 0)
    )
  })).sort((a, b) => b.revenue - a.revenue);

  const topItems = fullMenu.slice(0, 6).map((item, index) => ({
    id: item.id,
    name: item.name,
    units: 900 - index * 110 + Math.floor(random() * 40)
  }));

  return {
    demo: true,
    locations,
    inventory,
    supplyOrders,
    weekly,
    insights: {
      window_days: 7,
      orders,
      revenue,
      revenue_change_pct: 5.3,
      by_region: byRegion,
      top_items: topItems
    }
  };
}

function isoWeek(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return [target.getUTCFullYear(), week];
}

/** A customer profile in the shape /api/me returns. */
export function demoProfile(user) {
  const random = rng(20260922 + (user.id || 0));
  const favourites = TASTE[user.email] || [];
  const preferences = PREFERENCES[user.email] || {};

  // A freshly created demo account has no history yet, which is correct.
  if (!favourites.length) {
    return {
      demo: true, user, preferences,
      history: { signed_in: true, order_count: 0, favorites: [] },
      offers: [], orders: []
    };
  }

  const orders = [];
  const orderCount = 5 + Math.floor(random() * 3);
  for (let index = 0; index < orderCount; index += 1) {
    const placed = daysAgo((index + 1) * 7 + Math.floor(random() * 3));
    const picks = favourites.slice(0, 1 + Math.floor(random() * 3));
    orders.push({
      id: 1000 + index,
      date: iso(placed),
      channel: ["app", "app", "web", "in-store"][Math.floor(random() * 4)],
      items: picks.map((id) => ({ id, quantity: 1 + Math.floor(random() * 3) }))
    });
  }

  const tally = new Map();
  for (const order of orders) {
    for (const line of order.items) {
      const entry = tally.get(line.id) || { units: 0, orders: 0, last: order.date };
      entry.units += line.quantity;
      entry.orders += 1;
      if (order.date > entry.last) entry.last = order.date;
      tally.set(line.id, entry);
    }
  }

  const favorites = [...tally.entries()]
    .map(([id, entry]) => ({
      id,
      name: (fullMenu.find((item) => item.id === id) || {}).name || id,
      units: entry.units,
      orders: entry.orders,
      last_ordered: entry.last,
      in_cart: false
    }))
    .sort((a, b) => b.units - a.units);

  return {
    demo: true,
    user,
    preferences,
    history: {
      signed_in: true,
      order_count: orders.length,
      last_order: orders[0].date,
      favorites
    },
    offers: smartOffers.slice(0, 3),
    orders
  };
}
