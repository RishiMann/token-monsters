"""Tools the agents can call.

Every tool reads live rows from PostgreSQL apart from the catalog tools, which
read storefront.json because the catalog is not mutable at runtime. That means
an agent answering "what is low at Scottsdale" is querying stock, not reciting
a fixture.

The recommendation and offer logic here mirrors the browser's
(frontend/js/recommendation-engine.js, frontend/js/offers.js) so the model
and the rule-based fallback reach the same conclusions from the same data.

Tool results are data, never instructions: nothing here echoes caller-supplied
free text back into the model as a directive.
"""

from datetime import date, timedelta

import db
import offers as offer_rules
import seasons

_CACHE = {}

# Flavor families that lift each other. Mirrors COMPLEMENTS in the browser engine.
COMPLEMENTS = {
    "cocoa":    ["citrus", "berry", "mint", "coffee", "caramel", "cream"],
    "caramel":  ["green", "citrus", "orchard", "coffee", "nut", "cocoa"],
    "citrus":   ["cocoa", "berry", "cream", "caramel", "nut", "spice"],
    "berry":    ["cream", "cocoa", "citrus", "nut"],
    "cream":    ["berry", "citrus", "spice", "cocoa", "coffee"],
    "green":    ["nut", "citrus", "caramel", "sesame", "tropical"],
    "nut":      ["green", "orchard", "caramel", "cocoa", "citrus", "berry"],
    "spice":    ["cream", "orchard", "caramel", "coffee", "citrus"],
    "coffee":   ["cocoa", "caramel", "nut", "cream"],
    "tropical": ["green", "citrus", "cocoa"],
    "orchard":  ["caramel", "spice", "nut", "cream"],
    "mint":     ["cocoa", "cream"],
    "sesame":   ["green", "bean", "citrus"],
    "bean":     ["sesame", "green", "citrus"],
}

FAMILY_WORD = {
    "cocoa": "chocolate", "caramel": "caramel", "citrus": "citrus", "berry": "berry",
    "cream": "cream", "green": "matcha", "nut": "nut", "spice": "warm spice",
    "coffee": "coffee", "tropical": "tropical fruit", "orchard": "orchard fruit",
    "mint": "mint", "sesame": "sesame", "bean": "sweet bean",
}

BOX_TARGET = 6


def _today_key():
    return date.today().isoformat()


def _catalog():
    """storefront.json, cached per day so release dates flip over at midnight."""
    if _CACHE.get("day") != _today_key():
        _CACHE.clear()
        _CACHE["day"] = _today_key()
        _CACHE["catalog"] = db.catalog()
        _CACHE["menu"] = db.menu_items()
    return _CACHE["catalog"]


def _menu():
    _catalog()
    return _CACHE["menu"]


def item_by_id(item_id):
    return next((i for i in _menu() if i["id"] == item_id), None)


def _profile(item):
    return item.get("profile") or {"family": None, "rich": 2, "bright": 2, "texture": None,
                                   "occasions": [], "pairsWith": []}


def _slim(item):
    return {
        "id": item["id"], "name": item["name"], "blurb": item.get("blurb"),
        "price": item.get("price"), "tags": item.get("tags", []),
        "rating": item.get("rating"), "allergens": item.get("allergens", []),
        "dietary": item.get("dietary", []), "family": _profile(item).get("family"),
        "season": item.get("season"),
    }


def _num(value):
    return float(value) if value is not None else 0.0


def _lines(cart):
    """Cart payload lines -> [{item, qty}], dropping ids that are not on sale."""
    out = []
    for line in (cart or {}).get("lines", []):
        item = item_by_id(line.get("id"))
        if item:
            out.append({"item": item, "qty": int(line.get("qty") or line.get("quantity") or 1)})
    return out


def _live_seasons():
    return seasons.live_seasons(_catalog().get("eventMenus", []))


# ── Catalog ──────────────────────────────────────────────────────────────

def search_menu(query=None, tags=None, exclude_allergens=None, family=None, occasion=None, **_):
    items = _menu()
    if tags:
        wanted = set(tags)
        items = [i for i in items if wanted & set(i.get("tags", []))]
    if exclude_allergens:
        banned = {a.lower() for a in exclude_allergens}
        items = [i for i in items if not banned & {a.lower() for a in i.get("allergens", [])}]
    if family:
        items = [i for i in items if _profile(i).get("family") == family.lower()]
    if occasion:
        items = [i for i in items if occasion in _profile(i).get("occasions", [])]
    if query:
        q = query.lower()
        items = [i for i in items
                 if q in i["name"].lower()
                 or q in (i.get("blurb") or "").lower()
                 or any(q in t.lower() for t in i.get("tags", []))
                 or q in (_profile(i).get("family") or "")]
    return {"count": len(items), "items": [_slim(i) for i in items]}


# ── Customer ─────────────────────────────────────────────────────────────

def assess_cart(cart=None, **_):
    cart = cart or {}
    lines = _lines(cart)
    count = sum(l["qty"] for l in lines)
    subtotal = round(sum(l["item"]["price"] * l["qty"] for l in lines), 2)
    return {
        "count": count, "capacity": BOX_TARGET, "remaining": max(0, BOX_TARGET - count),
        "subtotal": subtotal,
        "flavors": len({l["item"]["id"] for l in lines}),
        "families": sorted({_profile(l["item"]).get("family") for l in lines if _profile(l["item"]).get("family")}),
        "applied_offer": cart.get("appliedOffer"),
        "item_ids": [l["item"]["id"] for l in lines],
        "lines": [{"id": l["item"]["id"], "name": l["item"]["name"], "quantity": l["qty"],
                   "price": l["item"]["price"]} for l in lines],
    }


def suggest_pairings(cart=None, occasion=None, exclude_allergens=None, limit=5, user_id=None, **_):
    """Rank what to add next against what is already in the box, with reasons.

    Same rules as the browser engine: explicit pairings, complementary flavor
    families, richness/brightness balance, texture contrast, occasion fit,
    plant-based consistency, live seasonal menus and the customer's favorites.
    """
    lines = _lines(cart)
    in_box = {l["item"]["id"] for l in lines}
    banned = {a.lower() for a in (exclude_allergens or [])}
    catalog = _menu()
    live = {m["id"]: m for m in _live_seasons()}
    history = analyze_purchase_history(user_id=user_id, cart=cart)
    favorites = {f["id"]: f["units"] for f in history.get("favorites", [])}
    scored, trace = {}, []

    def consider(item, points, key, reason):
        if not item or item["id"] in in_box:
            return
        if banned & {a.lower() for a in item.get("allergens", [])}:
            return
        entry = scored.setdefault(item["id"], {"item": item, "score": 0, "signals": []})
        entry["score"] += points
        entry["signals"].append({"key": key, "points": points, "reason": reason})

    if not lines:
        trace.append("Box is empty — starting from ratings" + (f" and {occasion}" if occasion else ""))
        for item in catalog:
            consider(item, (item.get("rating", 4) - 4) * 10, "rating", f"rated {item.get('rating')} this week")
            if occasion and occasion in _profile(item).get("occasions", []):
                consider(item, 5, "occasion", f"made for {occasion.replace('-', ' ')}")
            if item["id"] in favorites:
                consider(item, 4, "favorite", f"ordered {favorites[item['id']]} times before")
            if item.get("season") in live:
                consider(item, 2, "season", f"{live[item['season']]['name']} is on now")
    else:
        count = sum(l["qty"] for l in lines)
        rich = sum(_profile(l["item"]).get("rich", 2) * l["qty"] for l in lines)
        bright = sum(_profile(l["item"]).get("bright", 2) * l["qty"] for l in lines)
        families = {_profile(l["item"]).get("family") for l in lines} - {None}
        textures = {_profile(l["item"]).get("texture") for l in lines} - {None}
        all_vegan = all("vegan" in l["item"].get("tags", []) for l in lines)
        occasions = {}
        for l in lines:
            for occ in _profile(l["item"]).get("occasions", []):
                occasions[occ] = occasions.get(occ, 0) + l["qty"]
        trace.append(f"Read the box: {count} items")

        for l in lines:
            for pair in _profile(l["item"]).get("pairsWith", []):
                consider(item_by_id(pair["id"]), 6, "pairing", f"{pair['why']}, next to {l['item']['name']}")
        trace.append("Matched explicit pairings")

        for item in catalog:
            family = _profile(item).get("family")
            if not family:
                continue
            for box_family in families:
                if family in COMPLEMENTS.get(box_family, []):
                    consider(item, 3, "complement",
                             f"{FAMILY_WORD.get(family, family)} against the {FAMILY_WORD.get(box_family, box_family)} in the box")
            if family in families:
                consider(item, -2, "repeat", f"another {FAMILY_WORD.get(family, family)} pick")

        if rich >= bright + 4:
            trace.append("Box skews rich — weighting bright flavors up")
            for item in catalog:
                if _profile(item).get("bright", 0) >= 2:
                    consider(item, 4, "balance", "balances a rich box with something bright")
        elif bright >= rich + 4:
            trace.append("Box skews light — weighting richer flavors up")
            for item in catalog:
                if _profile(item).get("rich", 0) >= 3:
                    consider(item, 4, "balance", "adds depth to a light box")

        if len(textures) == 1:
            only = next(iter(textures))
            trace.append(f"Every item is {only} — looking for contrast")
            for item in catalog:
                texture = _profile(item).get("texture")
                if texture and texture != only:
                    consider(item, 2, "texture", f"{texture} against a {only} box")
        elif count >= 3:
            for item in catalog:
                texture = _profile(item).get("texture")
                if texture and texture not in textures:
                    consider(item, 1, "texture", "a texture the box doesn't have yet")

        lead = occasion
        if not lead and occasions:
            best, weight = max(occasions.items(), key=lambda kv: kv[1])
            if weight >= max(2, count * 0.6):
                lead = best
        if lead:
            trace.append(f"Box fits {lead.replace('-', ' ')} — favoring picks made for it")
            for item in catalog:
                if lead in _profile(item).get("occasions", []):
                    consider(item, 4 if occasion else 2, "occasion", f"fits a {lead.replace('-', ' ')} box")

        if all_vegan:
            trace.append("Everything so far is plant-based — keeping it that way")
            for item in catalog:
                vegan = "vegan" in item.get("tags", [])
                consider(item, 4 if vegan else -8, "dietary", "keeps the box plant-based" if vegan else "not plant-based")

        for item in catalog:
            if item["id"] in favorites:
                consider(item, 3, "favorite", f"ordered {favorites[item['id']]} times before")
            if item.get("season") in live:
                consider(item, 2, "season", f"{live[item['season']]['name']} runs until {live[item['season']]['closes']}")

    ranked = sorted((e for e in scored.values() if e["score"] > 0),
                    key=lambda e: (-e["score"], -(e["item"].get("rating") or 0), e["item"]["id"]))
    limit = max(1, min(int(limit or 5), 8))
    trace.append(f"Ranked {len(scored)} candidates")
    return {
        "count": len(ranked[:limit]),
        "trace": trace,
        "candidates": [{
            **_slim(e["item"]),
            "score": e["score"],
            "reason": max(e["signals"], key=lambda s: s["points"])["reason"],
            "signals": [s["key"] for s in e["signals"]],
        } for e in ranked[:limit]],
    }


def analyze_purchase_history(user_id=None, cart=None, **_):
    """Real orders for the signed-in customer."""
    if not user_id:
        return {"signed_in": False, "order_count": 0, "favorites": [], "available_favorites": []}

    in_cart = {l.get("id") for l in (cart or {}).get("lines", [])}
    rows = db.query(
        """SELECT oi.item_id, sum(oi.quantity) AS units, count(DISTINCT o.id) AS orders,
                  max(o.placed_at) AS last_ordered
           FROM orders o JOIN order_items oi ON oi.order_id = o.id
           WHERE o.user_id = %s
           GROUP BY oi.item_id ORDER BY units DESC""",
        (user_id,),
    )
    total = db.query(
        "SELECT count(*) AS n, max(placed_at) AS last FROM orders WHERE user_id = %s",
        (user_id,), one=True,
    )

    favorites = []
    for row in rows:
        item = item_by_id(row["item_id"])
        if item:
            favorites.append({
                "id": item["id"], "name": item["name"], "units": int(row["units"]),
                "orders": int(row["orders"]),
                "last_ordered": str(row["last_ordered"]),
                "in_cart": item["id"] in in_cart,
            })

    return {
        "signed_in": True,
        "order_count": int(total["n"]) if total else 0,
        "last_order": str(total["last"]) if total and total["last"] else None,
        "favorites": favorites[:5],
        "available_favorites": [f for f in favorites[:5] if not f["in_cart"]],
    }


def get_customer_preferences(user_id=None, **_):
    """Stated preferences and allergens for the signed-in customer."""
    if not user_id:
        return {"signed_in": False, "preferences": {}}
    rows = db.query("SELECT key, value FROM preferences WHERE user_id = %s", (user_id,))
    prefs = {r["key"]: r["value"] for r in rows if r["value"]}
    avoid = [a.strip() for a in prefs.get("allergens_avoid", "").split(",") if a.strip()]
    return {"signed_in": True, "preferences": prefs, "allergens_to_avoid": avoid}


def _customer(user_id, cart):
    """What the offer rules need to know about the person."""
    history = analyze_purchase_history(user_id=user_id, cart=cart)
    prefs = get_customer_preferences(user_id=user_id).get("preferences", {})
    return {
        "signed_in": history.get("signed_in", False),
        "favorites": history.get("favorites", []),
        "repeat_pattern": prefs.get("repeat_pattern") or None,
    }


def find_offers(user_id=None, cart=None, **_):
    """Every offer against this box: eligible ones with their value, the rest with what unlocks them."""
    evaluated = offer_rules.evaluate_offers(
        _catalog().get("smartOffers", []), _lines(cart), _customer(user_id, cart), _live_seasons())
    eligible = [{**o, "eligibility": o["why"]} for o in evaluated if o["eligible"]]
    return {
        "count": len(eligible),
        "offers": eligible,
        "ineligible": [{"id": o["id"], "title": o["title"], "why": o["why"]} for o in evaluated if not o["eligible"]],
    }


def price_box(user_id=None, cart=None, applied_offer=None, fulfillment="pickup", **_):
    """The receipt for this box: subtotal, the applied discount if it holds, delivery, total."""
    cart = cart or {}
    fulfillment = fulfillment if fulfillment in ("pickup", "delivery") else "pickup"
    return offer_rules.price(
        _catalog().get("smartOffers", []), _lines(cart),
        applied_id=applied_offer or cart.get("appliedOffer"), fulfillment=fulfillment,
        customer=_customer(user_id, cart), live_seasons=_live_seasons())


# ── Network / franchise ──────────────────────────────────────────────────

def check_inventory(location=None, only_low=False, **_):
    """Live stock against reorder points, optionally for one corner."""
    sql = """SELECT i.location_id, l.name AS location, i.sku, i.name, i.unit,
                    i.on_hand, i.reorder_point, i.on_order, i.lead_time_days
             FROM inventory i JOIN locations l ON l.id = i.location_id"""
    params = []
    if location:
        sql += " WHERE l.id = %s OR lower(l.name) = lower(%s)"
        params = [location, location]
    sql += " ORDER BY (i.on_hand - i.reorder_point), l.name"

    rows = []
    for row in db.query(sql, tuple(params)):
        on_hand, reorder, on_order = _num(row["on_hand"]), _num(row["reorder_point"]), _num(row["on_order"])
        status = "ok"
        if on_hand <= reorder:
            status = "inbound" if on_order > 0 else "critical"
        elif on_hand <= reorder * 1.25:
            status = "low"
        if only_low and status == "ok":
            continue
        rows.append({
            "location": row["location"], "sku": row["sku"], "name": row["name"],
            "on_hand": on_hand, "unit": row["unit"], "reorder_point": reorder,
            "on_order": on_order, "lead_time_days": row["lead_time_days"], "status": status,
        })

    return {
        "count": len(rows),
        "critical": sum(1 for r in rows if r["status"] == "critical"),
        "items": rows[:40],
    }


def get_sales_insights(days=7, **_):
    """Revenue, orders and top flavors over a recent window."""
    days = max(1, min(int(days), 90))
    # Window boundaries are computed here rather than in SQL, so the same
    # queries run on PostgreSQL and on the SQLite fallback.
    today = date.today()
    since = today - timedelta(days=days)
    prev_since = today - timedelta(days=days * 2)

    totals = db.query(
        """SELECT coalesce(sum(orders),0) AS orders, coalesce(sum(revenue),0) AS revenue
           FROM sales_daily WHERE day > %s""", (since,), one=True)
    prev = db.query(
        """SELECT coalesce(sum(revenue),0) AS revenue FROM sales_daily
           WHERE day > %s AND day <= %s""",
        (prev_since, since), one=True)

    by_region = db.query(
        """SELECT l.region, sum(s.revenue) AS revenue
           FROM sales_daily s JOIN locations l ON l.id = s.location_id
           WHERE s.day > %s
           GROUP BY l.region ORDER BY revenue DESC""", (since,))
    top = db.query(
        """SELECT item_id, sum(units) AS units FROM item_sales
           WHERE day > %s
           GROUP BY item_id ORDER BY units DESC LIMIT 6""", (since,))

    current, previous = _num(totals["revenue"]), _num(prev["revenue"]) if prev else 0.0
    change = round((current - previous) / previous * 100, 1) if previous else None

    return {
        "window_days": days,
        "orders": int(totals["orders"]),
        "revenue": round(current, 2),
        "revenue_change_pct": change,
        "by_region": [{"region": r["region"], "revenue": round(_num(r["revenue"]), 2)} for r in by_region],
        "top_items": [
            {"id": r["item_id"],
             "name": (item_by_id(r["item_id"]) or {}).get("name", r["item_id"]),
             "units": int(r["units"])}
            for r in top
        ],
    }


def get_event_menus(**_):
    """Seasonal menus with today's status, each item's release date, and what is next."""
    menus = _catalog().get("eventMenus", [])
    return {
        "today": _today_key(),
        "menus": seasons.with_state(menus),
        "upcoming": seasons.upcoming_releases(menus, limit=6),
    }


def plan_party(guests=12, dietary=None, **_):
    guests = max(1, int(guests))
    servings = -(-guests * 3 // 2)
    boxes = -(-servings // 6)
    pool = _menu()
    if dietary:
        wants = {d.lower() for d in dietary}
        if {"vegan", "plant-based"} & wants:
            pool = [i for i in pool if "vegan" in i.get("tags", [])] or pool
        if "nut-free" in wants:
            pool = [i for i in pool if not {"tree nut", "peanut"} & {a.lower() for a in i.get("allergens", [])}]
    return {
        "guests": guests, "servings": servings, "boxes": boxes,
        "suggested_variety": min(6, max(3, round(guests / 4))),
        "eligible_items": [_slim(i) for i in pool],
    }


def present_items(item_ids=None, **_):
    ids = [i for i in (item_ids or []) if item_by_id(i)]
    return {"presented": ids, "ok": True}


# ── Schemas ──────────────────────────────────────────────────────────────

def _schema(name, description, properties=None, required=None):
    return {
        "name": name, "description": description,
        "input_schema": {
            "type": "object", "properties": properties or {},
            **({"required": required} if required else {}),
            "additionalProperties": False,
        },
    }


SCHEMAS = {
    "search_menu": _schema(
        "search_menu",
        "Search today's Frosted Corner menu, seasonal items included. Use before recommending anything so you only name items that exist.",
        {"query": {"type": "string", "description": "Free text matched against name, description, tags and flavor family."},
         "tags": {"type": "array", "items": {"type": "string"}, "description": "Any of: new, shareable, vegan, rich, fruity, signature."},
         "family": {"type": "string", "description": "Flavor family: cocoa, caramel, citrus, berry, cream, green, nut, spice, coffee, tropical, orchard, mint, sesame, bean."},
         "occasion": {"type": "string", "description": "One of: just-because, birthday, dinner-party, thank-you, office, kids."},
         "exclude_allergens": {"type": "array", "items": {"type": "string"}, "description": "e.g. tree nut, peanut, dairy, wheat, egg, soy, sesame."}}),
    "assess_cart": _schema("assess_cart", "See what is already in the customer's box, how many of the six slots remain, and any offer they applied."),
    "suggest_pairings": _schema(
        "suggest_pairings",
        "Rank what to add next against what is already in the box: explicit pairings, flavor balance, texture contrast, occasion fit, plant-based consistency, seasonal menus and favorites. Each candidate carries the reason. Call this before recommending.",
        {"occasion": {"type": "string", "description": "An occasion the customer stated: just-because, birthday, dinner-party, thank-you, office, kids."},
         "exclude_allergens": {"type": "array", "items": {"type": "string"}, "description": "Allergens to exclude outright."},
         "limit": {"type": "integer", "description": "How many candidates to return, 1-8. Defaults to 5."}}),
    "analyze_purchase_history": _schema(
        "analyze_purchase_history",
        "The signed-in customer's real order history: favorites, how often, and when they last ordered."),
    "get_customer_preferences": _schema(
        "get_customer_preferences",
        "The signed-in customer's stated preferences and the allergens they avoid. Check this before recommending."),
    "find_offers": _schema(
        "find_offers",
        "Every offer against this box: the eligible ones with what they take off and why, and the rest with what would unlock them. Never invent a discount this does not return."),
    "price_box": _schema(
        "price_box",
        "The receipt for the current box: subtotal, the applied offer if it still holds, delivery fee or free delivery, and the total.",
        {"applied_offer": {"type": "string", "description": "Offer id to apply, e.g. offer-bundle. Defaults to whatever the customer applied."},
         "fulfillment": {"type": "string", "description": "pickup or delivery."}}),
    "check_inventory": _schema(
        "check_inventory",
        "Live stock levels against reorder points across the network, or for one corner.",
        {"location": {"type": "string", "description": "Corner id or name, e.g. scottsdale. Omit for all."},
         "only_low": {"type": "boolean", "description": "True to return only items at or below their reorder point."}}),
    "get_sales_insights": _schema(
        "get_sales_insights",
        "Revenue, order volume, regional split and top-selling flavors over a recent window.",
        {"days": {"type": "integer", "description": "Window in days, 1-90. Defaults to 7."}}),
    "get_event_menus": _schema("get_event_menus", "Seasonal and event menus with today's live / pre-order / planned status, each item's release date and whether it has released, plus the next releases."),
    "plan_party": _schema(
        "plan_party", "Serving math for a group: servings, boxes and how many flavors to spread across.",
        {"guests": {"type": "integer", "description": "Number of guests."},
         "dietary": {"type": "array", "items": {"type": "string"}, "description": "e.g. vegan, nut-free."}},
        ["guests"]),
    "present_items": _schema(
        "present_items",
        "Show these menu items to the customer as cards they can add to their box. Call once, last, with the ids you recommend.",
        {"item_ids": {"type": "array", "items": {"type": "string"}, "description": "Menu item ids from search_menu or suggest_pairings."}},
        ["item_ids"]),
}

IMPLEMENTATIONS = {
    "search_menu": search_menu,
    "assess_cart": assess_cart,
    "suggest_pairings": suggest_pairings,
    "analyze_purchase_history": analyze_purchase_history,
    "get_customer_preferences": get_customer_preferences,
    "find_offers": find_offers,
    "price_box": price_box,
    "check_inventory": check_inventory,
    "get_sales_insights": get_sales_insights,
    "get_event_menus": get_event_menus,
    "plan_party": plan_party,
    "present_items": present_items,
}
