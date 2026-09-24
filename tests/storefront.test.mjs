/**
 * Checks the recommendation engine, offer rules and season logic against the
 * real catalog. Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recommend, familiesIn, itemsInFamilies } from "../frontend/js/recommendation-engine.js";
import { evaluateOffers, priceBox, bestOffer } from "../frontend/js/offers.js";
import { releasedSeasonalItems, liveSeasons, upcomingReleases, seasonState } from "../frontend/js/seasons.js";

const data = JSON.parse(readFileSync(new URL("../backend/storefront.json", import.meta.url), "utf8"));
const today = new Date("2026-09-23T12:00:00");
const catalog = [...data.weeklyMenu, ...data.plantBased, ...releasedSeasonalItems(data.eventMenus, today)];
const seasons = liveSeasons(data.eventMenus, today);
const byId = (id) => { const i = catalog.find((x) => x.id === id); assert.ok(i, `${id} in catalog`); return i; };
const line = (id, qty = 1) => ({ item: byId(id), qty });
const fam = (item) => item.profile.family;
const ids = (r) => r.items.map((p) => p.item.id);

test("seasons: harvest live today, only released items on sale", () => {
  assert.deepEqual(seasons.map((s) => s.id), ["harvest"]);
  const released = releasedSeasonalItems(data.eventMenus, today).map((i) => i.id).sort();
  assert.deepEqual(released, ["maple-pecan", "spiced-pear"]);
  const next = upcomingReleases(data.eventMenus, today, { limit: 2 });
  assert.equal(next[0].item.id, "cider-donut");
  assert.equal(next[0].daysUntil, 4);
  assert.equal(seasonState(data.eventMenus[1], today).state, "preorder");
  assert.equal(seasonState(data.eventMenus[3], today).state, "planned");
});

test("catalog: every item has a profile the engine can use", () => {
  assert.equal(catalog.length, 26);
  for (const item of catalog) {
    assert.ok(item.profile?.family, `${item.id} family`);
    assert.ok(Array.isArray(item.profile.pairsWith), `${item.id} pairsWith`);
  }
});

test("empty box: three picks, headline, confidence", () => {
  const r = recommend(catalog, [], { seasons });
  assert.equal(r.items.length, 3);
  assert.equal(r.headline, "Where most people start");
  for (const p of r.items) assert.ok(p.confidence >= 50 && p.confidence <= 97, `confidence ${p.confidence}`);
});

test("empty box with an occasion filters to it", () => {
  const r = recommend(catalog, [], { occasion: "birthday", occasionLabels: { birthday: "a birthday" } });
  assert.equal(r.headline, "Picked for a birthday");
  for (const p of r.items) assert.ok(p.item.profile.occasions.includes("birthday"), p.item.id);
});

test("adding chocolate surfaces more rich, chocolatey picks", () => {
  const r = recommend(catalog, [line("midnight-fudge")], { focus: "midnight-fudge", seasons });
  assert.equal(r.headline, "Because you added Midnight Fudge");
  assert.equal(r.items.length, 3);
  assert.ok(!ids(r).includes("midnight-fudge"));
  for (const p of r.items.slice(0, 2)) {
    assert.ok(fam(p.item) === "cocoa" || p.item.profile.rich >= 3, `${p.item.id} is chocolate or rich`);
  }
  assert.ok(r.trace[0].startsWith("You just added Midnight Fudge — chocolate, rich"));
});

test("the picks change when the focus changes", () => {
  const box = [line("midnight-fudge"), line("lemon-cloud")];
  const afterFudge = recommend(catalog, box, { focus: "midnight-fudge", seasons });
  const afterLemon = recommend(catalog, box, { focus: "lemon-cloud", seasons });
  assert.equal(afterLemon.headline, "Because you added Lemon Glaze Cloud");
  assert.notDeepEqual(ids(afterFudge), ids(afterLemon));
  assert.ok(afterLemon.items.slice(0, 2).every((p) => fam(p.item) === "citrus" || p.item.profile.bright >= 3),
    `citrus follows citrus: ${ids(afterLemon)}`);
});

test("a seasonal item in the box is reasoned about (was invisible before)", () => {
  const r = recommend(catalog, [line("maple-pecan")], { seasons, limit: 5 });
  assert.equal(r.headline, "Because you added Maple Pecan Stack");
  assert.equal(r.items.length, 5);
  assert.ok(ids(r).includes("spiced-pear"), "explicit pairing surfaces");
  assert.ok(fam(r.items[0].item) === "nut" || r.items[0].item.profile.rich >= 3, `top pick ${r.items[0].item.id} is nutty or rich like the pecan stack`);
  assert.ok(r.items.every((p) => p.reason.length > 10));
});

test("an all plant-based box stays plant-based", () => {
  const r = recommend(catalog, [line("coconut-matcha"), line("oat-choc-chip")], { seasons });
  for (const p of r.items) assert.ok(p.item.tags.includes("vegan"), `${p.item.id} is vegan`);
  assert.ok(r.trace.some((t) => /plant-based/.test(t)));
});

test("allergen avoidance is a hard exclusion", () => {
  const r = recommend(catalog, [line("biscoff")], { avoid: ["tree nut"], seasons });
  for (const p of r.items) assert.ok(!p.item.allergens.includes("tree nut"), p.item.id);
});

test("a kids' box still leans on kids' picks", () => {
  const r = recommend(catalog, [line("pink-velvet"), line("strawberry-stack"), line("banana-pudding")], { seasons, occasionLabels: { kids: "a kids' party" } });
  assert.ok(r.trace.some((t) => /kids' party/.test(t)), r.trace.join(" | "));
  assert.ok(r.items.filter((p) => p.item.profile.occasions.includes("kids")).length >= 1);
});

test("favorites from history are surfaced and never duplicate the box", () => {
  const r = recommend(catalog, [line("lemon-cloud")], { favorites: [{ id: "brown-butter", units: 6 }], seasons, limit: 5 });
  assert.ok(ids(r).includes("brown-butter"), `favorite in the top five: ${ids(r)}`);
  assert.ok(!ids(r).includes("lemon-cloud"));
  const dup = recommend(catalog, [line("brown-butter")], { favorites: [{ id: "brown-butter", units: 6 }], seasons });
  assert.ok(!ids(dup).includes("brown-butter"));
});

test("a nearly full box says so in the trace", () => {
  const r = recommend(catalog, [line("lemon-cloud", 2), line("biscoff", 3)], { seasons });
  assert.equal(r.headline, "Because you added Biscoff Butterscotch");
  assert.ok(r.trace.some((t) => /1 slot left/.test(t)));
});

test("free-text cravings map to families via profiles", () => {
  assert.deepEqual(familiesIn("something chocolatey and a bit of lemon"), ["cocoa", "citrus"]);
  const hits = itemsInFamilies(catalog, ["coffee"]).map((i) => i.id);
  assert.deepEqual(hits, ["tiramisu-cup"]);
});

// ── Offers ────────────────────────────────────────────────────────────────
const offers = data.smartOffers;
const basket = (...lines) => ({ lines, count: lines.reduce((n, l) => n + l.qty, 0), subtotal: lines.reduce((n, l) => n + l.qty * l.item.price, 0) });
const ctx = { liveSeasons: seasons };

test("empty box earns nothing", () => {
  const ev = evaluateOffers(offers, basket(), ctx);
  assert.ok(ev.every((o) => !o.eligible));
  assert.equal(bestOffer(ev), null);
  assert.match(ev.find((o) => o.id === "offer-bundle").why, /Add 6 more/);
});

test("six-count bundle: 10% with one flavor, 15% with three", () => {
  const one = evaluateOffers(offers, basket(line("brown-butter", 6)), ctx).find((o) => o.id === "offer-bundle");
  assert.equal(one.eligible, true); assert.equal(one.percent, 10);
  assert.equal(one.discount, Math.round(6 * 4.75 * 0.10 * 100) / 100);
  assert.match(one.why, /Mix in 2 more flavors for 15%/);
  const three = evaluateOffers(offers, basket(line("brown-butter", 2), line("lemon-cloud", 2), line("biscoff", 2)), ctx).find((o) => o.id === "offer-bundle");
  assert.equal(three.percent, 15);
});

test("party box at twelve adds the free tasting sampler", () => {
  const b = basket(line("brown-butter", 6), line("lemon-cloud", 6));
  const party = evaluateOffers(offers, b, ctx).find((o) => o.id === "offer-party");
  assert.equal(party.eligible, true);
  assert.equal(party.addon.name, "Tasting sampler");
  const short = evaluateOffers(offers, basket(line("brown-butter", 10)), ctx).find((o) => o.id === "offer-party");
  assert.match(short.why, /Add 2 more/);
});

test("seasonal offer needs a live seasonal item in the box", () => {
  const none = evaluateOffers(offers, basket(line("brown-butter")), ctx).find((o) => o.id === "offer-season");
  assert.equal(none.eligible, false); assert.match(none.why, /Harvest Festival/);
  const yes = evaluateOffers(offers, basket(line("maple-pecan", 2), line("brown-butter")), ctx).find((o) => o.id === "offer-season");
  assert.equal(yes.eligible, true); assert.equal(yes.discount, 3);
});

test("reorder rate needs sign-in and four of a favorite", () => {
  const b = basket(line("brown-butter", 4));
  const out = evaluateOffers(offers, b, ctx).find((o) => o.id === "offer-reorder");
  assert.equal(out.eligible, false); assert.match(out.why, /Sign in/);
  const signed = { ...ctx, signedIn: true, favorites: [{ id: "brown-butter", units: 12 }], repeatPattern: "Friday pickup" };
  const yes = evaluateOffers(offers, b, signed).find((o) => o.id === "offer-reorder");
  assert.equal(yes.eligible, true); assert.equal(yes.discount, Math.round(4 * 4.75 * 0.15 * 100) / 100);
  const three = evaluateOffers(offers, basket(line("brown-butter", 3)), signed).find((o) => o.id === "offer-reorder");
  assert.match(three.why, /Add 1 more Brown Butter Chip/);
});

test("checkout math: discount, delivery fee, free delivery threshold", () => {
  const small = basket(line("brown-butter", 6));
  const pickup = priceBox(offers, small, { appliedId: "offer-bundle", fulfillment: "pickup", context: ctx });
  assert.equal(pickup.applied.id, "offer-bundle");
  assert.equal(pickup.total, Math.round((28.5 - 2.85) * 100) / 100);
  const delivery = priceBox(offers, small, { appliedId: "offer-bundle", fulfillment: "delivery", context: ctx });
  assert.equal(delivery.deliveryFee, 6.95);
  assert.equal(delivery.total, Math.round((28.5 - 2.85 + 6.95) * 100) / 100);
  const big = basket(line("midnight-fudge", 6), line("biscoff", 3));
  const free = priceBox(offers, big, { fulfillment: "delivery", context: ctx });
  assert.equal(free.deliveryFee, 0); assert.equal(free.deliveryFree, true);
});

test("an applied offer drops off when the box stops qualifying", () => {
  const r = priceBox(offers, basket(line("brown-butter", 5)), { appliedId: "offer-bundle", context: ctx });
  assert.equal(r.applied, null); assert.equal(r.discount, 0);
});
