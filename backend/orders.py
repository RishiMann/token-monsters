"""Orders: placing them, following them, and moving them through the kitchen.

The browser sends the lines and the offer it applied; nothing it sends is
trusted for money. Items are resolved against today's menu, the receipt is
computed again with the same offer rules the browser used, and only then is
the order written. Each unit consumes its `uses` ingredients at the corner,
one six-count box per six units, and the day's item and corner sales move.

An order then walks a short lifecycle that the franchise console advances:

    pickup:    placed -> preparing -> ready            -> completed
    delivery:  placed -> preparing -> out_for_delivery -> completed

Either side can cancel while it is still `placed` (the console also while
`preparing`), which puts the ingredients back. Every change is appended to
order_events so the customer sees a timeline, not just a word.

Guests get a tracking token with their order; signed-in customers see their
own orders by session. Agent -> Tool -> Service -> Database: this is the service.
"""

import hmac
import math
import re
import secrets
from datetime import date, datetime, timedelta, timezone

import agent_tools
import db
import offers as offer_rules

DEFAULT_LOCATION = "frisco"
BOX_SKU = "PKG-008"

STEPS = {
    "pickup": ["placed", "preparing", "ready", "completed"],
    "delivery": ["placed", "preparing", "out_for_delivery", "completed"],
}
FINAL = {"completed", "cancelled", "fulfilled"}
LEAD_MINUTES = {"pickup": 20, "delivery": 40}
CUSTOMER_CANCELLABLE = {"placed"}
CONSOLE_CANCELLABLE = {"placed", "preparing"}

LABELS = {
    "placed": "Received",
    "preparing": "Preparing",
    "ready": "Ready for pickup",
    "out_for_delivery": "On its way",
    "completed": {"pickup": "Picked up", "delivery": "Delivered"},
    "cancelled": "Cancelled",
    "fulfilled": "Completed",
}
HEADLINES = {
    "placed": "We've got it — {corner} is on it.",
    "preparing": "Your box is being packed at {corner}.",
    "ready": "Ready at {corner}. Come and get it.",
    "out_for_delivery": "Your box just left {corner}.",
    "completed": {"pickup": "Picked up. Enjoy.", "delivery": "Delivered. Enjoy."},
    "cancelled": "This order was cancelled.",
    "fulfilled": "Completed.",
}
# What the console button says to move an order to the next step.
NEXT_ACTION = {
    "placed": "Start preparing",
    "preparing": {"pickup": "Mark ready", "delivery": "Send it out"},
    "ready": "Mark picked up",
    "out_for_delivery": "Mark delivered",
}


class OrderError(ValueError):
    """The order could not be placed or changed as asked; the message is safe to show."""


def _now():
    return datetime.now(timezone.utc)


def _iso(value):
    """Timestamps come back as datetimes from PostgreSQL and strings from SQLite."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    text = str(value)
    if len(text) == 10:                       # a bare date from the seed
        return f"{text}T00:00:00+00:00"
    try:
        parsed = datetime.fromisoformat(text.replace(" ", "T"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.isoformat()
    except ValueError:
        return text


def _pick(table, fulfillment):
    return table[fulfillment] if isinstance(table, dict) else table


def _location_for(user):
    """The customer's home corner, or the default."""
    if user and user.get("homeCorner"):
        row = db.query("SELECT id FROM locations WHERE lower(name) = lower(%s)", (user["homeCorner"],), one=True)
        if row:
            return row["id"]
    return DEFAULT_LOCATION


def _location_name(location_id):
    row = db.query("SELECT name FROM locations WHERE id = %s", (location_id,), one=True)
    return row["name"] if row else (location_id or "the corner").title()


def _stock_row(row):
    on_hand, reorder, on_order = float(row["on_hand"]), float(row["reorder_point"]), float(row["on_order"])
    status = "ok"
    if on_hand <= reorder:
        status = "inbound" if on_order > 0 else "critical"
    elif on_hand <= reorder * 1.25:
        status = "low"
    return {"sku": row["sku"], "name": row["name"], "unit": row["unit"],
            "on_hand": round(on_hand, 2), "reorder_point": reorder, "status": status}


_WINDOW_TIME = re.compile(r"(\d{1,2}):(\d{2})", re.IGNORECASE)
_MERIDIAN = re.compile(r"\b(AM|PM)\b", re.IGNORECASE)


def promised_time(window, fulfillment, now=None):
    """When the box should be ready or arrive.

    "As soon as possible" is now plus the corner's lead time. A window such as
    "Today, 5:00–5:30 PM" is read as that time today, in the server's clock;
    if it has already passed it falls back to the lead time.
    """
    now = now or _now()
    lead = timedelta(minutes=LEAD_MINUTES.get(fulfillment, 20))
    match = _WINDOW_TIME.search(window or "")
    if match:
        hour, minute = int(match.group(1)), int(match.group(2))
        # "Today, 5:00–5:30 PM" carries its AM/PM once, after the range.
        meridian_match = _MERIDIAN.search(window or "")
        meridian = meridian_match.group(1).upper() if meridian_match else ""
        if meridian == "PM" and hour < 12:
            hour += 12
        if meridian == "AM" and hour == 12:
            hour = 0
        local = now.astimezone()
        target = local.replace(hour=hour % 24, minute=minute, second=0, microsecond=0)
        if target > local:
            return target.astimezone(timezone.utc)
    return now + lead


def _catalog_index():
    """Every item ever sold, released or not, so history always has a name."""
    data = agent_tools._catalog()
    index = {}
    for item in [*data.get("weeklyMenu", []), *data.get("plantBased", [])]:
        index[item["id"]] = item
    for menu in data.get("eventMenus", []):
        for item in menu.get("items", []):
            index.setdefault(item["id"], item)
    return index


def _consumption(items):
    """Ingredients per unit, plus one six-count box per six units. items: [(catalog item, qty)]."""
    consumed = {}
    for item, qty in items:
        for sku, amount in (item.get("uses") or {}).items():
            consumed[sku] = round(consumed.get(sku, 0) + amount * qty, 3)
    units = sum(qty for _, qty in items)
    consumed[BOX_SKU] = consumed.get(BOX_SKU, 0) + math.ceil(units / 6)
    return consumed, units


def _event(order_id, status, note=None, at=None):
    db.execute("INSERT INTO order_events (order_id, status, at, note) VALUES (%s, %s, %s, %s)",
               (order_id, status, at or _now(), note))


# ── Placing ──────────────────────────────────────────────────────────────

def place(lines, fulfillment="pickup", applied_offer=None, user=None, channel="web",
          window=None, address=None, contact_name=None, note=None):
    """Records the order and returns it, plus the receipt, what it consumed and the stock it touched."""
    resolved = []
    for line in lines or []:
        item = agent_tools.item_by_id(str(line.get("id", "")))
        try:
            qty = int(line.get("quantity") or line.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0
        if not item or qty <= 0:
            raise OrderError(f"{line.get('id', 'an item')} is not on the counter today")
        resolved.append({"item": item, "qty": min(qty, 48)})
    if not resolved:
        raise OrderError("the box is empty")
    fulfillment = fulfillment if fulfillment in ("pickup", "delivery") else "pickup"
    address = (address or "").strip()[:200] or None
    if fulfillment == "delivery" and not address:
        raise OrderError("a delivery needs an address")
    contact_name = (contact_name or "").strip()[:80] or (user or {}).get("name") or None
    window = (window or "").strip()[:60] or "As soon as possible"
    note = (note or "").strip()[:280] or None

    customer = agent_tools._customer(user["id"] if user else None, {"lines": [
        {"id": l["item"]["id"], "quantity": l["qty"]} for l in resolved]})
    receipt = offer_rules.price(
        agent_tools._catalog().get("smartOffers", []), resolved,
        applied_id=applied_offer, fulfillment=fulfillment, customer=customer,
        live_seasons=agent_tools._live_seasons())

    location = _location_for(user)
    now = _now()
    promised = promised_time(window, fulfillment, now)
    token = secrets.token_urlsafe(12)
    order = db.query(
        """INSERT INTO orders (user_id, placed_at, channel, status, fulfillment, location_id, offer_id, total,
                               created_at, updated_at, promised_at, window_label, address, contact_name, note,
                               tracking_token)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (user["id"] if user else None, now.date(), channel, "placed", fulfillment, location,
         receipt["applied"]["id"] if receipt["applied"] else None, receipt["total"],
         now, now, promised, window, address, contact_name, note, token),
        one=True,
    )
    order_id = order["id"]
    for l in resolved:
        db.execute("INSERT INTO order_items (order_id, item_id, quantity, unit_price) VALUES (%s, %s, %s, %s)",
                   (order_id, l["item"]["id"], l["qty"], l["item"]["price"]))
    _event(order_id, "placed", f"Order received at {_location_name(location)}", now)

    # ── Stock: ingredients per unit, boxes per six units ──
    consumed, units = _consumption([(l["item"], l["qty"]) for l in resolved])
    for sku, amount in consumed.items():
        db.execute(
            """UPDATE inventory SET on_hand = CASE WHEN on_hand - %s < 0 THEN 0 ELSE on_hand - %s END
               WHERE location_id = %s AND sku = %s""",
            (amount, amount, location, sku))

    # ── Sales: the day's units per item and the corner's daily line ──
    today = now.date()
    for l in resolved:
        db.execute(
            """INSERT INTO item_sales (day, item_id, units) VALUES (%s, %s, %s)
               ON CONFLICT (day, item_id) DO UPDATE SET units = item_sales.units + EXCLUDED.units""",
            (today, l["item"]["id"], l["qty"]))
    db.execute(
        """INSERT INTO sales_daily (day, location_id, orders, revenue) VALUES (%s, %s, 1, %s)
           ON CONFLICT (day, location_id) DO UPDATE
           SET orders = sales_daily.orders + 1, revenue = sales_daily.revenue + EXCLUDED.revenue""",
        (today, location, receipt["total"]))

    rows = db.query(
        """SELECT i.sku, i.name, i.unit, i.on_hand, i.reorder_point, i.on_order
           FROM inventory i WHERE i.location_id = %s AND i.sku IN ({})""".format(
            ",".join(["%s"] * len(consumed))),
        (location, *consumed.keys()))
    stock = [_stock_row(r) for r in rows]

    return {
        **get(order_id),
        "token": token,                       # only ever returned here, to the browser that placed it
        "receipt": {k: receipt[k] for k in ("subtotal", "discount", "deliveryFee", "deliveryFree", "total")},
        "units": units,
        "consumed": consumed,
        "stock": sorted(stock, key=lambda r: r["on_hand"] - r["reorder_point"]),
    }


# ── Reading ──────────────────────────────────────────────────────────────

_ORDER_SQL = """
    SELECT o.id, o.user_id, o.placed_at, o.channel, o.status, o.fulfillment, o.location_id, o.offer_id,
           o.total, o.created_at, o.updated_at, o.promised_at, o.completed_at, o.window_label, o.address,
           o.contact_name, o.note, o.tracking_token, l.name AS location_name, u.name AS user_name, u.email
    FROM orders o
    LEFT JOIN locations l ON l.id = o.location_id
    LEFT JOIN users u ON u.id = o.user_id
"""


def _shape(row, items, events):
    fulfillment = row["fulfillment"] or "pickup"
    status = row["status"] or "fulfilled"
    corner = row["location_name"] or _location_name(row["location_id"])
    steps = STEPS.get(fulfillment, STEPS["pickup"])
    reached = {e["status"]: e["at"] for e in events}
    position = steps.index(status) if status in steps else (len(steps) if status in FINAL else -1)
    step_rows = []
    for index, key in enumerate(steps):
        step_rows.append({
            "key": key,
            "label": _pick(LABELS[key], fulfillment),
            "done": index < position or (index == position and status in FINAL),
            "current": index == position and status not in FINAL,
            "at": _iso(reached.get(key)),
        })
    total = float(row["total"]) if row["total"] is not None else round(
        sum(i["quantity"] * (i["unitPrice"] or 0) for i in items), 2)
    return {
        "id": row["id"],
        "status": status,
        "statusLabel": _pick(LABELS.get(status, status.title()), fulfillment),
        "headline": _pick(HEADLINES.get(status, ""), fulfillment).format(corner=corner),
        "nextAction": _pick(NEXT_ACTION.get(status), fulfillment) if status in NEXT_ACTION else None,
        "active": status not in FINAL,
        "canCancel": status in CUSTOMER_CANCELLABLE,
        "consoleCanCancel": status in CONSOLE_CANCELLABLE,
        "fulfillment": fulfillment,
        "channel": row["channel"],
        "location": {"id": row["location_id"], "name": corner},
        "window": row["window_label"],
        "address": row["address"],
        "customer": row["contact_name"] or row["user_name"] or "Guest",
        "email": row["email"],
        "note": row["note"],
        "signedIn": row["user_id"] is not None,
        "offer": row["offer_id"],
        "total": round(total, 2),
        "date": str(row["placed_at"])[:10],
        "placedAt": _iso(row["created_at"]) or _iso(row["placed_at"]),
        "updatedAt": _iso(row["updated_at"]),
        "promisedAt": _iso(row["promised_at"]),
        "completedAt": _iso(row["completed_at"]),
        "items": items,
        "units": sum(i["quantity"] for i in items),
        "steps": step_rows,
        "events": [{"status": e["status"], "label": _pick(LABELS.get(e["status"], e["status"]), fulfillment),
                    "at": _iso(e["at"]), "note": e["note"]} for e in events],
    }


def _items_for(order_ids):
    if not order_ids:
        return {}
    index = _catalog_index()
    rows = db.query(
        "SELECT order_id, item_id, quantity, unit_price FROM order_items WHERE order_id IN ({}) ORDER BY item_id"
        .format(",".join(["%s"] * len(order_ids))), tuple(order_ids))
    out = {}
    for r in rows:
        item = index.get(r["item_id"], {})
        price = float(r["unit_price"]) if r["unit_price"] is not None else item.get("price")
        out.setdefault(r["order_id"], []).append({
            "id": r["item_id"], "name": item.get("name", r["item_id"]), "quantity": int(r["quantity"]),
            "unitPrice": price, "image": item.get("image"), "emoji": item.get("emoji"), "tint": item.get("tint"),
        })
    return out


def _events_for(order_ids):
    if not order_ids:
        return {}
    rows = db.query(
        "SELECT order_id, status, at, note FROM order_events WHERE order_id IN ({}) ORDER BY at, id"
        .format(",".join(["%s"] * len(order_ids))), tuple(order_ids))
    out = {}
    for r in rows:
        out.setdefault(r["order_id"], []).append(r)
    return out


def _shape_all(rows):
    ids = [r["id"] for r in rows]
    items, events = _items_for(ids), _events_for(ids)
    return [_shape(r, items.get(r["id"], []), events.get(r["id"], [])) for r in rows]


def _row(order_id):
    row = db.query(_ORDER_SQL + " WHERE o.id = %s", (order_id,), one=True)
    if not row:
        raise OrderError(f"order #{order_id} was not found")
    return row


def get(order_id):
    return _shape_all([_row(order_id)])[0]


def authorized(order_id, user=None, token=None):
    """The owner by session, the placing browser by token, or an admin."""
    row = _row(order_id)
    if user and user.get("role") == "admin":
        return True
    if user and row["user_id"] == user.get("id"):
        return True
    if token and row["tracking_token"] and hmac.compare_digest(str(token), str(row["tracking_token"])):
        return True
    return False


def for_user(user_id, limit=20):
    """A customer's orders: the ones in progress first, then the newest."""
    rows = db.query(_ORDER_SQL + " WHERE o.user_id = %s ORDER BY o.placed_at DESC, o.created_at DESC, o.id DESC",
                    (user_id,))
    shaped = _shape_all(rows)
    active = [o for o in shaped if o["active"]]
    rest = [o for o in shaped if not o["active"]]
    # Seeded history shares one created_at (the first boot), so the order date leads.
    rest.sort(key=lambda o: (o["date"], o["placedAt"] or "", o["id"]), reverse=True)
    return (active + rest)[:limit]


def recent_for_user(user_id, hours=2, limit=10):
    """What a customer's page should follow: orders in progress, plus ones that finished within `hours`."""
    since = (_now() - timedelta(hours=hours)).isoformat()
    return [o for o in for_user(user_id, limit=50)
            if o["active"] or (o["completedAt"] and o["completedAt"] >= since)][:limit]


def lookup(refs):
    """Orders for a list of {id, token} a browser remembered. Wrong tokens are simply left out."""
    out = []
    for ref in (refs or [])[:20]:
        try:
            order_id = int(ref.get("id"))
        except (TypeError, ValueError, AttributeError):
            continue
        try:
            if authorized(order_id, token=ref.get("token")):
                out.append(get(order_id))
        except OrderError:
            continue
    return out


def board(hours=2, limit=60):
    """What the console sees: everything in progress, plus what finished in the last couple of hours."""
    since = _now() - timedelta(hours=hours)
    rows = db.query(
        _ORDER_SQL + """ WHERE o.status NOT IN ('completed', 'cancelled', 'fulfilled')
                         OR (o.completed_at IS NOT NULL AND o.completed_at >= %s)
                      ORDER BY o.created_at DESC, o.id DESC""", (since,))
    shaped = _shape_all(rows[:limit])
    shaped.sort(key=lambda o: (not o["active"], -(o["id"] or 0)))
    today = _now().date()
    todays = db.query(
        "SELECT status, count(*) AS n, coalesce(sum(total), 0) AS revenue FROM orders WHERE placed_at = %s GROUP BY status",
        (today,))
    counts = {r["status"]: int(r["n"]) for r in todays}
    channels = db.query(
        "SELECT channel, count(*) AS n FROM orders WHERE placed_at >= %s GROUP BY channel ORDER BY n DESC",
        (today - timedelta(days=7),))
    return {
        "orders": shaped,
        "active": sum(1 for o in shaped if o["active"]),
        "today": {
            "orders": sum(counts.values()),
            "revenue": round(sum(float(r["revenue"]) for r in todays if r["status"] != "cancelled"), 2),
            "byStatus": counts,
        },
        "channels": [{"channel": r["channel"], "orders": int(r["n"])} for r in channels],
    }


# ── Moving ───────────────────────────────────────────────────────────────

def set_status(order_id, status, note=None):
    """Moves an order to a status on its own path. Returns the order."""
    row = _row(order_id)
    fulfillment = row["fulfillment"] or "pickup"
    steps = STEPS.get(fulfillment, STEPS["pickup"])
    current = row["status"]
    if current in FINAL:
        raise OrderError(f"order #{order_id} is already {_pick(LABELS.get(current, current), fulfillment).lower()}")
    if status == "cancelled":
        return cancel(order_id, by="console", note=note)
    if status not in steps:
        raise OrderError(f"{status} is not a step for a {fulfillment} order")
    if steps.index(status) <= steps.index(current):
        raise OrderError(f"order #{order_id} is already past {status}")
    now = _now()
    completed = now if status == "completed" else None
    db.execute("UPDATE orders SET status = %s, updated_at = %s, completed_at = %s WHERE id = %s",
               (status, now, completed, order_id))
    _event(order_id, status, note, now)
    return get(order_id)


def advance(order_id, note=None):
    """Moves an order one step along its path."""
    row = _row(order_id)
    steps = STEPS.get(row["fulfillment"] or "pickup", STEPS["pickup"])
    current = row["status"]
    if current in FINAL or current not in steps:
        raise OrderError(f"order #{order_id} cannot be advanced from {current}")
    return set_status(order_id, steps[steps.index(current) + 1], note)


def cancel(order_id, by="customer", note=None):
    """Cancels an order and puts its ingredients, boxes and sales back."""
    row = _row(order_id)
    allowed = CONSOLE_CANCELLABLE if by == "console" else CUSTOMER_CANCELLABLE
    if row["status"] not in allowed:
        raise OrderError(
            "This order can't be cancelled any more — it's already being prepared." if by != "console"
            else f"order #{order_id} is {row['status']} and cannot be cancelled")
    items = _items_for([order_id]).get(order_id, [])
    index = _catalog_index()
    consumed, _ = _consumption([(index.get(i["id"], {}), i["quantity"]) for i in items])
    for sku, amount in consumed.items():
        db.execute("UPDATE inventory SET on_hand = on_hand + %s WHERE location_id = %s AND sku = %s",
                   (amount, row["location_id"], sku))
    day = row["placed_at"] if not isinstance(row["placed_at"], str) else date.fromisoformat(row["placed_at"][:10])
    for i in items:
        db.execute("UPDATE item_sales SET units = CASE WHEN units - %s < 0 THEN 0 ELSE units - %s END "
                   "WHERE day = %s AND item_id = %s", (i["quantity"], i["quantity"], day, i["id"]))
    db.execute(
        """UPDATE sales_daily SET orders = CASE WHEN orders - 1 < 0 THEN 0 ELSE orders - 1 END,
                                  revenue = CASE WHEN revenue - %s < 0 THEN 0 ELSE revenue - %s END
           WHERE day = %s AND location_id = %s""",
        (row["total"] or 0, row["total"] or 0, day, row["location_id"]))
    now = _now()
    db.execute("UPDATE orders SET status = 'cancelled', updated_at = %s, completed_at = %s WHERE id = %s",
               (now, now, order_id))
    _event(order_id, "cancelled", note or ("Cancelled by the customer" if by != "console" else "Cancelled by the corner"), now)
    return get(order_id)
