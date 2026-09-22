/**
 * Static content for the Frosted Corner storefront prototype.
 *
 * This is the seam where real services plug in later: every export here is
 * shaped the way an API response would be, so `app.js` never needs to change
 * when the data starts arriving over the network instead of from this file.
 */

/** This week's rotating lineup. Frosted Corner refreshes six flavors weekly. */
export const weeklyMenu = [
  {
    id: "pink-velvet",
    name: "Pink Velvet Crumb",
    blurb: "Cream cheese frosting · velvet crumb",
    price: 5.5,
    emoji: "🧁",
    tint: "pink",
    badge: "Fan favorite",
    tags: ["signature", "shareable"],
    rating: 4.9,
    allergens: ["wheat", "dairy", "egg"]
  },
  {
    id: "brown-butter",
    name: "Brown Butter Chip",
    blurb: "Sea salt · dark chocolate pools",
    price: 4.75,
    emoji: "🍪",
    tint: "gold",
    badge: "Always on",
    tags: ["signature"],
    rating: 4.8,
    allergens: ["wheat", "dairy", "egg", "soy"]
  },
  {
    id: "lemon-cloud",
    name: "Lemon Glaze Cloud",
    blurb: "Lemon curd · toasted meringue",
    price: 5.25,
    emoji: "🍋",
    tint: "butter",
    badge: "New this week",
    tags: ["new", "fruity"],
    rating: 4.7,
    allergens: ["wheat", "egg"]
  },
  {
    id: "biscoff",
    name: "Biscoff Butterscotch",
    blurb: "Speculoos swirl · burnt sugar",
    price: 5.75,
    emoji: "🍯",
    tint: "caramel",
    badge: "New this week",
    tags: ["new", "rich"],
    rating: 4.9,
    allergens: ["wheat", "dairy", "soy"]
  },
  {
    id: "strawberry-stack",
    name: "Strawberry Shortcake",
    blurb: "Vanilla bean cream · shortcake crumb",
    price: 5.95,
    emoji: "🍓",
    tint: "berry",
    badge: "Party-sized",
    tags: ["shareable", "fruity"],
    rating: 4.8,
    allergens: ["wheat", "dairy", "egg"]
  },
  {
    id: "midnight-fudge",
    name: "Midnight Fudge",
    blurb: "Molten ganache core · cocoa nib",
    price: 6.0,
    emoji: "🍫",
    tint: "cocoa",
    badge: "Warm served",
    tags: ["rich"],
    rating: 4.9,
    allergens: ["wheat", "dairy", "egg", "soy"]
  }
];

/** Plant-based rotation, surfaced through the "Plant-based" filter. */
export const plantBased = [
  {
    id: "coconut-matcha",
    name: "Coconut Matcha",
    blurb: "Stone-ground matcha · coconut cream",
    price: 5.5,
    emoji: "🍵",
    tint: "mint",
    badge: "Plant-based",
    tags: ["vegan", "new"],
    rating: 4.6,
    allergens: ["wheat", "tree nut"]
  },
  {
    id: "almond-fig",
    name: "Almond Fig Tart",
    blurb: "Roasted fig · almond frangipane",
    price: 6.25,
    emoji: "🫐",
    tint: "plum",
    badge: "Plant-based",
    tags: ["vegan", "fruity"],
    rating: 4.7,
    allergens: ["wheat", "tree nut"]
  }
];

export const fullMenu = [...weeklyMenu, ...plantBased];

/**
 * Event-driven menus. The brief calls for menus that follow festivals,
 * holidays and promotions rather than one static catalog.
 */
export const eventMenus = [
  {
    id: "harvest",
    name: "Harvest Festival",
    window: "Sep 20 – Oct 31",
    status: "live",
    tint: "caramel",
    emoji: "🍂",
    blurb: "Brown sugar, spiced pear and maple pecan, built for cool evenings.",
    highlights: ["Maple Pecan Stack", "Spiced Pear Galette", "Cider Donut Box"]
  },
  {
    id: "holiday",
    name: "Holiday Table",
    window: "Nov 24 – Dec 31",
    status: "preorder",
    tint: "berry",
    emoji: "❄️",
    blurb: "Gift towers and dessert tables sized for a full house.",
    highlights: ["Peppermint Bark Slab", "Gingerbread Corner", "Cocoa Tasting Flight"]
  },
  {
    id: "lunar",
    name: "Lunar New Year",
    window: "Feb 6 – Feb 20",
    status: "planned",
    tint: "gold",
    emoji: "🧧",
    blurb: "Red bean, sesame and citrus in a share-first gift format.",
    highlights: ["Black Sesame Swirl", "Red Bean Pillow", "Mandarin Cloud"]
  },
  {
    id: "graduation",
    name: "Graduation Season",
    window: "May 1 – Jun 15",
    status: "planned",
    tint: "mint",
    emoji: "🎓",
    blurb: "Colorway-matched boxes for school colors and big group orders.",
    highlights: ["Custom Color Frosting", "Sheet Box of 24", "Name-piped Toppers"]
  }
];

/**
 * Personalized offers. The brief is explicit that these should be reasoned
 * recommendations, not blanket discounts, so each carries its own rationale.
 */
export const smartOffers = [
  {
    id: "offer-reorder",
    label: "Because you reorder on Fridays",
    title: "Your usual, 15% off",
    detail: "Brown Butter Chip × 4, ready for 5:30pm pickup at Frisco Corner.",
    reason: "You've ordered this pairing 6 of the last 8 Fridays.",
    value: "Save $2.85",
    tint: "gold",
    emoji: "🔁"
  },
  {
    id: "offer-party",
    label: "Because your party is Saturday",
    title: "Upgrade to the Party Box",
    detail: "Swap 6 singles for a 12-count spread and add a flavor flight free.",
    reason: "Your saved event has 14 guests — a 6-count runs short.",
    value: "Free flight ($9)",
    tint: "berry",
    emoji: "🎉"
  },
  {
    id: "offer-season",
    label: "Because you liked citrus last month",
    title: "First taste of Harvest",
    detail: "Add the Spiced Pear Galette to any box this week at launch price.",
    reason: "Citrus and orchard-fruit buyers convert 3× on this item.",
    value: "$1.50 off",
    tint: "caramel",
    emoji: "🍐"
  }
];

/** Subscription tiers — the brief asks for subscription-based dessert plans. */
export const plans = [
  {
    id: "corner-weekly",
    name: "The Weekly Corner",
    cadence: "week",
    price: 18,
    pitch: "Two of the week's new flavors, every Thursday.",
    perks: ["2 treats weekly", "Skip or swap anytime", "Member-only flavors"],
    featured: false
  },
  {
    id: "corner-table",
    name: "The Table",
    cadence: "week",
    price: 42,
    pitch: "A six-count box sized for a household, with AI picking the mix.",
    perks: ["6 treats weekly", "Concierge picks your box", "Priority event menus", "Free delivery"],
    featured: true
  },
  {
    id: "corner-host",
    name: "The Host",
    cadence: "month",
    price: 95,
    pitch: "For the person who always volunteers to bring dessert.",
    perks: ["Two party spreads monthly", "Dedicated planner agent", "Custom colorways", "Early holiday booking"],
    featured: false
  }
];

/** Reviews, plus the synthesized summary the review agent produces. */
export const reviews = [
  {
    id: "r1",
    name: "Jules M.",
    initials: "JM",
    stars: 5,
    tint: "pink",
    verified: "Verified celebration",
    body: "The concierge picked the Strawberry Shortcake for my sister's garden party and it was the centerpiece. Gone in minutes.",
    featured: true
  },
  {
    id: "r2",
    name: "Ari K.",
    initials: "AK",
    stars: 5,
    tint: "butter",
    verified: "Verified customer",
    body: "Bright, buttery, not too sweet. The Lemon Glaze Cloud is my new personality.",
    featured: false
  },
  {
    id: "r3",
    name: "Riley S.",
    initials: "RS",
    stars: 5,
    tint: "cocoa",
    verified: "Verified customer",
    body: "Ordered by voice on the drive home and it was boxed and waiting. Genuinely felt like magic.",
    featured: false
  },
  {
    id: "r4",
    name: "Dev P.",
    initials: "DP",
    stars: 4,
    tint: "mint",
    verified: "Verified customer",
    body: "Great plant-based options, which is rare. Would love one more nut-free pick in the rotation.",
    featured: false
  }
];

export const reviewSummary = {
  rating: 4.9,
  count: 1284,
  headline: "What 1,284 people keep saying",
  points: [
    { label: "Flavor accuracy", detail: "Concierge picks match the occasion", score: 96 },
    { label: "Order speed", detail: "Pickup ready inside 20 minutes", score: 92 },
    { label: "Party sizing", detail: "Quantities land for group orders", score: 89 }
  ],
  watchout: "Most common request: more nut-free options in the weekly rotation."
};

/**
 * The agent roster. Rendered in the UI as the "AI crew", and used as the
 * routing table the conversational surfaces hand off to.
 */
export const agents = [
  {
    id: "recommendation",
    name: "Recommendation Agent",
    role: "Finds the right flavor",
    emoji: "✦",
    tint: "pink",
    blurb: "Reads taste history, occasion and who's eating, then shortlists from the live menu.",
    surfaces: ["Dessert Concierge", "Menu 'picked for you'"],
    signals: ["Past orders", "Saved events", "Allergen profile", "Local stock"]
  },
  {
    id: "offers",
    name: "Offers Agent",
    role: "Earns the discount",
    emoji: "◎",
    tint: "gold",
    blurb: "Prices a reason, not a blanket coupon — every offer states why it exists.",
    surfaces: ["Smart Offers rail", "Checkout upgrades"],
    signals: ["Reorder cadence", "Basket gap", "Margin floor", "Event calendar"]
  },
  {
    id: "orders",
    name: "Orders Agent",
    role: "Takes the order",
    emoji: "◰",
    tint: "berry",
    blurb: "Conversational and voice ordering, plus live status from oven to counter.",
    surfaces: ["Voice ordering", "Order tracker"],
    signals: ["Store queue", "Bake windows", "Pickup ETA", "Payment state"]
  },
  {
    id: "support",
    name: "Support Agent",
    role: "Fixes the problem",
    emoji: "◍",
    tint: "mint",
    blurb: "Allergen questions, substitutions and remakes, with a human handoff when it matters.",
    surfaces: ["Help bubble", "Post-order follow-up"],
    signals: ["Order history", "Allergen table", "Refund policy", "Store contact"]
  },
  {
    id: "planner",
    name: "Party Planner Agent",
    role: "Does the math",
    emoji: "◈",
    tint: "plum",
    blurb: "Turns a headcount and a vibe into a spread that actually feeds the room.",
    surfaces: ["Party planner", "Event menus"],
    signals: ["Guest count", "Dietary mix", "Budget", "Venue timing"]
  },
  {
    id: "inventory",
    name: "Inventory Agent",
    role: "Keeps shelves full",
    emoji: "▦",
    tint: "caramel",
    blurb: "Franchise-to-HQ supply ordering, with reorder points tuned per location.",
    surfaces: ["Franchise portal"],
    signals: ["Sell-through", "Lead times", "Waste rate", "Promo forecast"],
    audience: "franchise"
  },
  {
    id: "insights",
    name: "Insights Agent",
    role: "Explains the numbers",
    emoji: "◐",
    tint: "cocoa",
    blurb: "Turns order and sales data into the weekly read HQ actually uses.",
    surfaces: ["HQ dashboard"],
    signals: ["Basket mix", "Flavor velocity", "Region trends", "Churn risk"],
    audience: "franchise"
  }
];

/** Occasion presets for the concierge. */
export const occasions = [
  { id: "just-because", label: "Just because", emoji: "☀️" },
  { id: "birthday", label: "Birthday", emoji: "🎈" },
  { id: "dinner-party", label: "Dinner party", emoji: "🍽️" },
  { id: "thank-you", label: "Thank you", emoji: "💌" },
  { id: "office", label: "Office treat", emoji: "🧑‍💻" },
  { id: "kids", label: "Kids' party", emoji: "🎠" }
];
