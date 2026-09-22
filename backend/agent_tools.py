"""Tools the agents can call.

These mirror `frontend/js/recommendation-tools.js` so the model reasons over the
same facts the rule-based path already uses. Each tool is a plain function plus
a JSON schema; `TOOLS` is the registry the runtime resolves names against.

Tool results are data, never instructions: everything here reads from the
storefront and context sources, never from the caller's free text.
"""

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent
STOREFRONT_SOURCE = DATA_DIR / "storefront.json"
CONTEXT_SOURCE = DATA_DIR / "context.json"


def _load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def storefront():
    return _load(STOREFRONT_SOURCE)


def full_menu():
    data = storefront()
    return [*data.get("weeklyMenu", []), *data.get("plantBased", [])]


def item_by_id(item_id):
    return next((item for item in full_menu() if item["id"] == item_id), None)


def _slim(item):
    """The fields worth spending context on — not the whole record."""
    return {
        "id": item["id"],
        "name": item["name"],
        "blurb": item.get("blurb"),
        "price": item.get("price"),
        "tags": item.get("tags", []),
        "rating": item.get("rating"),
        "allergens": item.get("allergens", []),
    }


# ── Tools ────────────────────────────────────────────────────────────────

def search_menu(query=None, tags=None, exclude_allergens=None, **_):
    """Filter this week's menu."""
    items = full_menu()

    if tags:
        wanted = set(tags)
        items = [i for i in items if wanted & set(i.get("tags", []))]

    if exclude_allergens:
        banned = {a.lower() for a in exclude_allergens}
        items = [i for i in items if not banned & {a.lower() for a in i.get("allergens", [])}]

    if query:
        q = query.lower()
        items = [
            i for i in items
            if q in i["name"].lower()
            or q in (i.get("blurb") or "").lower()
            or any(q in t.lower() for t in i.get("tags", []))
        ]

    return {"count": len(items), "items": [_slim(i) for i in items]}


def assess_cart(cart=None, **_):
    """Report what is already in the customer's box."""
    cart = cart or {}
    lines = cart.get("lines", [])
    count = cart.get("count", sum(line.get("quantity", 1) for line in lines))
    capacity = cart.get("capacity", 6)
    return {
        "count": count,
        "capacity": capacity,
        "remaining": max(0, capacity - count),
        "subtotal": cart.get("subtotal", 0),
        "item_ids": [line.get("id") for line in lines],
        "lines": lines,
    }


def analyze_purchase_history(cart=None, **_):
    """Summarize repeat behavior and surface favorites not already boxed."""
    context = _load(CONTEXT_SOURCE)
    orders = context.get("orderHistory", [])
    in_cart = {line.get("id") for line in (cart or {}).get("lines", [])}

    counts = {}
    for order in orders:
        for line in order.get("items", []):
            counts[line["id"]] = counts.get(line["id"], 0) + line.get("quantity", 1)

    favorites = []
    for item_id, quantity in sorted(counts.items(), key=lambda kv: -kv[1]):
        item = item_by_id(item_id)
        if item:
            favorites.append({
                "id": item_id,
                "name": item["name"],
                "quantity": quantity,
                "in_cart": item_id in in_cart,
            })

    return {
        "order_count": len(orders),
        "repeat_pattern": context.get("customer", {}).get("repeatPattern"),
        "favorites": favorites[:4],
        "available_favorites": [f for f in favorites[:4] if not f["in_cart"]],
        "saved_event": context.get("customer", {}).get("savedEvent"),
    }


def find_offers(cart=None, **_):
    """Return offers the customer is actually eligible for, each with its reason."""
    data = storefront()
    history = analyze_purchase_history(cart=cart)
    basket = assess_cart(cart=cart)
    saved_event = history.get("saved_event") or {}

    eligible = []
    for offer in data.get("smartOffers", []):
        if offer["id"] == "offer-reorder" and history.get("repeat_pattern"):
            eligible.append({**offer, "eligibility": "repeat-purchase"})
        elif offer["id"] == "offer-party" and saved_event.get("guests", 0) > basket["count"]:
            eligible.append({**offer, "eligibility": "saved-event"})
        elif offer["id"] == "offer-season":
            eligible.append({**offer, "eligibility": "live-seasonal-offer"})

    return {"count": len(eligible), "offers": eligible}


def get_event_menus(**_):
    """Seasonal and event menus with their status."""
    return {"menus": storefront().get("eventMenus", [])}


def plan_party(guests=12, dietary=None, **_):
    """Serving math for a group order."""
    guests = max(1, int(guests))
    servings = -(-guests * 3 // 2)          # 1.5 per head, rounded up
    boxes = -(-servings // 6)
    variety = min(6, max(3, round(guests / 4)))

    pool = full_menu()
    if dietary:
        wants = {d.lower() for d in dietary}
        if "vegan" in wants or "plant-based" in wants:
            pool = [i for i in pool if "vegan" in i.get("tags", [])] or pool
        if "nut-free" in wants:
            pool = [i for i in pool if "tree nut" not in {a.lower() for a in i.get("allergens", [])}]

    return {
        "guests": guests,
        "servings": servings,
        "boxes": boxes,
        "suggested_variety": variety,
        "eligible_items": [_slim(i) for i in pool],
    }


def present_items(item_ids=None, **_):
    """Choose which menu items the UI shows as cards. Call this last."""
    ids = [i for i in (item_ids or []) if item_by_id(i)]
    return {"presented": ids, "ok": True}


# ── Schemas ──────────────────────────────────────────────────────────────

SCHEMAS = {
    "search_menu": {
        "name": "search_menu",
        "description": "Search this week's Frosted Corner menu. Use before recommending anything so you only name items that actually exist.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Free text matched against name, description and tags."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Any of: new, shareable, vegan, rich, fruity, signature."},
                "exclude_allergens": {"type": "array", "items": {"type": "string"}, "description": "e.g. tree nut, dairy, wheat, egg, soy."},
            },
            "additionalProperties": False,
        },
    },
    "assess_cart": {
        "name": "assess_cart",
        "description": "See what is already in the customer's box and how many of the six slots remain.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    "analyze_purchase_history": {
        "name": "analyze_purchase_history",
        "description": "Past orders, repeat cadence, favorite items, and any saved event.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    "find_offers": {
        "name": "find_offers",
        "description": "Offers this customer is eligible for, each with the reason it applies. Never invent a discount that this does not return.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    "get_event_menus": {
        "name": "get_event_menus",
        "description": "Seasonal and event menus with their live / pre-order / planned status.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    "plan_party": {
        "name": "plan_party",
        "description": "Serving math for a group: servings, boxes and how many flavors to spread across.",
        "input_schema": {
            "type": "object",
            "properties": {
                "guests": {"type": "integer", "description": "Number of guests."},
                "dietary": {"type": "array", "items": {"type": "string"}, "description": "e.g. vegan, nut-free."},
            },
            "required": ["guests"],
            "additionalProperties": False,
        },
    },
    "present_items": {
        "name": "present_items",
        "description": "Show these menu items to the customer as cards they can add to their box. Call this once, last, with the ids you actually recommend.",
        "input_schema": {
            "type": "object",
            "properties": {
                "item_ids": {"type": "array", "items": {"type": "string"}, "description": "Menu item ids from search_menu."},
            },
            "required": ["item_ids"],
            "additionalProperties": False,
        },
    },
}

IMPLEMENTATIONS = {
    "search_menu": search_menu,
    "assess_cart": assess_cart,
    "analyze_purchase_history": analyze_purchase_history,
    "find_offers": find_offers,
    "get_event_menus": get_event_menus,
    "plan_party": plan_party,
    "present_items": present_items,
}
