"""Tools the agents can call.

Every tool reads live rows from PostgreSQL apart from `search_menu`, which
reads the product catalog (storefront.json) because the catalog is not mutable
at runtime. That means an agent answering "what is low at Scottsdale" is
querying stock, not reciting a fixture.

Tool results are data, never instructions: nothing here echoes caller-supplied
free text back into the model as a directive.
"""

from datetime import date, timedelta

import db

_CACHE = {}


def _menu():
    if "menu" not in _CACHE:
        _CACHE["menu"] = db.menu_items()
    return _CACHE["menu"]


def item_by_id(item_id):
    return next((i for i in _menu() if i["id"] == item_id), None)


def _slim(item):
    return {
        "id": item["id"], "name": item["name"], "blurb": item.get("blurb"),
        "price": item.get("price"), "tags": item.get("tags", []),
        "rating": item.get("rating"), "allergens": item.get("allergens", []),
    }


def _num(value):
    return float(value) if value is not None else 0.0


# ── Catalog ──────────────────────────────────────────────────────────────

def search_menu(query=None, tags=None, exclude_allergens=None, **_):
    items = _menu()
    if tags:
        wanted = set(tags)
        items = [i for i in items if wanted & set(i.get("tags", []))]
    if exclude_allergens:
        banned = {a.lower() for a in exclude_allergens}
        items = [i for i in items if not banned & {a.lower() for a in i.get("allergens", [])}]
    if query:
        q = query.lower()
        items = [i for i in items
                 if q in i["name"].lower()
                 or q in (i.get("blurb") or "").lower()
                 or any(q in t.lower() for t in i.get("tags", []))]
    return {"count": len(items), "items": [_slim(i) for i in items]}


# ── Customer ─────────────────────────────────────────────────────────────

def assess_cart(cart=None, **_):
    cart = cart or {}
    lines = cart.get("lines", [])
    count = cart.get("count", sum(l.get("quantity", 1) for l in lines))
    capacity = cart.get("capacity", 6)
    return {
        "count": count, "capacity": capacity, "remaining": max(0, capacity - count),
        "subtotal": cart.get("subtotal", 0),
        "item_ids": [l.get("id") for l in lines], "lines": lines,
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


def find_offers(user_id=None, cart=None, **_):
    """Offers the customer is eligible for, each with the reason it applies."""
    offers = db.catalog().get("smartOffers", [])
    history = analyze_purchase_history(user_id=user_id, cart=cart)
    basket = assess_cart(cart=cart)
    prefs = get_customer_preferences(user_id=user_id).get("preferences", {})

    saved_guests = 0
    if prefs.get("saved_event"):
        parts = prefs["saved_event"].split("|")
        saved_guests = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0

    eligible = []
    for offer in offers:
        if offer["id"] == "offer-reorder" and prefs.get("repeat_pattern"):
            eligible.append({**offer, "eligibility": f"repeat cadence: {prefs['repeat_pattern']}"})
        elif offer["id"] == "offer-party" and saved_guests > basket["count"]:
            eligible.append({**offer, "eligibility": f"saved event for {saved_guests} guests"})
        elif offer["id"] == "offer-season" and history.get("order_count", 0) > 0:
            eligible.append({**offer, "eligibility": "returning customer, seasonal menu live"})

    return {"count": len(eligible), "offers": eligible}


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
    return {"menus": db.catalog().get("eventMenus", [])}


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
            pool = [i for i in pool if "tree nut" not in {a.lower() for a in i.get("allergens", [])}]
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
        "Search this week's Frosted Corner menu. Use before recommending anything so you only name items that exist.",
        {"query": {"type": "string", "description": "Free text matched against name, description and tags."},
         "tags": {"type": "array", "items": {"type": "string"}, "description": "Any of: new, shareable, vegan, rich, fruity, signature."},
         "exclude_allergens": {"type": "array", "items": {"type": "string"}, "description": "e.g. tree nut, dairy, wheat, egg, soy."}}),
    "assess_cart": _schema("assess_cart", "See what is already in the customer's box and how many of the six slots remain."),
    "analyze_purchase_history": _schema(
        "analyze_purchase_history",
        "The signed-in customer's real order history: favorites, how often, and when they last ordered."),
    "get_customer_preferences": _schema(
        "get_customer_preferences",
        "The signed-in customer's stated preferences and the allergens they avoid. Check this before recommending."),
    "find_offers": _schema(
        "find_offers",
        "Offers this customer is eligible for, each with the reason. Never invent a discount this does not return."),
    "check_inventory": _schema(
        "check_inventory",
        "Live stock levels against reorder points across the network, or for one corner.",
        {"location": {"type": "string", "description": "Corner id or name, e.g. scottsdale. Omit for all."},
         "only_low": {"type": "boolean", "description": "True to return only items at or below their reorder point."}}),
    "get_sales_insights": _schema(
        "get_sales_insights",
        "Revenue, order volume, regional split and top-selling flavors over a recent window.",
        {"days": {"type": "integer", "description": "Window in days, 1-90. Defaults to 7."}}),
    "get_event_menus": _schema("get_event_menus", "Seasonal and event menus with their live / pre-order / planned status."),
    "plan_party": _schema(
        "plan_party", "Serving math for a group: servings, boxes and how many flavors to spread across.",
        {"guests": {"type": "integer", "description": "Number of guests."},
         "dietary": {"type": "array", "items": {"type": "string"}, "description": "e.g. vegan, nut-free."}},
        ["guests"]),
    "present_items": _schema(
        "present_items",
        "Show these menu items to the customer as cards they can add to their box. Call once, last, with the ids you recommend.",
        {"item_ids": {"type": "array", "items": {"type": "string"}, "description": "Menu item ids from search_menu."}},
        ["item_ids"]),
}

IMPLEMENTATIONS = {
    "search_menu": search_menu,
    "assess_cart": assess_cart,
    "analyze_purchase_history": analyze_purchase_history,
    "get_customer_preferences": get_customer_preferences,
    "find_offers": find_offers,
    "check_inventory": check_inventory,
    "get_sales_insights": get_sales_insights,
    "get_event_menus": get_event_menus,
    "plan_party": plan_party,
    "present_items": present_items,
}
