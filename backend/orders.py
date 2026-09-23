"""Placing an order: record it, price it, and take it out of the corner's stock.

The browser sends the lines and the offer it applied; nothing it sends is
trusted for money. Items are resolved against today's menu, the receipt is
computed again with the same offer rules the browser used, and only then is
the order written. Each unit consumes its `uses` ingredients at the corner,
one six-count box per six units, and the day's item and corner sales move.

Agent -> Tool -> Service -> Database: this is the service.
"""

import math
from datetime import date

import agent_tools
import db
import offers as offer_rules

DEFAULT_LOCATION = "frisco"
BOX_SKU = "PKG-008"


class OrderError(ValueError):
    """The order could not be placed as sent; the message is safe to show."""


def _location_for(user):
    """The customer's home corner, or the default."""
    if user and user.get("homeCorner"):
        row = db.query("SELECT id FROM locations WHERE lower(name) = lower(%s)", (user["homeCorner"],), one=True)
        if row:
            return row["id"]
    return DEFAULT_LOCATION


def _stock_row(row):
    on_hand, reorder, on_order = float(row["on_hand"]), float(row["reorder_point"]), float(row["on_order"])
    status = "ok"
    if on_hand <= reorder:
        status = "inbound" if on_order > 0 else "critical"
    elif on_hand <= reorder * 1.25:
        status = "low"
    return {"sku": row["sku"], "name": row["name"], "unit": row["unit"],
            "on_hand": round(on_hand, 2), "reorder_point": reorder, "status": status}


def place(lines, fulfillment="pickup", applied_offer=None, user=None, channel="web"):
    """Records the order and returns {id, total, receipt, location, consumed, stock}."""
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

    customer = agent_tools._customer(user["id"] if user else None, {"lines": [
        {"id": l["item"]["id"], "quantity": l["qty"]} for l in resolved]})
    receipt = offer_rules.price(
        agent_tools._catalog().get("smartOffers", []), resolved,
        applied_id=applied_offer, fulfillment=fulfillment, customer=customer,
        live_seasons=agent_tools._live_seasons())

    location = _location_for(user)
    today = date.today()
    order = db.query(
        """INSERT INTO orders (user_id, placed_at, channel, status, fulfillment, location_id, offer_id, total)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (user["id"] if user else None, today, channel, "placed", fulfillment, location,
         receipt["applied"]["id"] if receipt["applied"] else None, receipt["total"]),
        one=True,
    )
    order_id = order["id"]
    for l in resolved:
        db.execute("INSERT INTO order_items (order_id, item_id, quantity) VALUES (%s, %s, %s)",
                   (order_id, l["item"]["id"], l["qty"]))

    # ── Stock: ingredients per unit, boxes per six units ──
    consumed = {}
    for l in resolved:
        for sku, amount in (l["item"].get("uses") or {}).items():
            consumed[sku] = round(consumed.get(sku, 0) + amount * l["qty"], 3)
    units = sum(l["qty"] for l in resolved)
    consumed[BOX_SKU] = consumed.get(BOX_SKU, 0) + math.ceil(units / 6)
    for sku, amount in consumed.items():
        db.execute(
            """UPDATE inventory SET on_hand = CASE WHEN on_hand - %s < 0 THEN 0 ELSE on_hand - %s END
               WHERE location_id = %s AND sku = %s""",
            (amount, amount, location, sku))

    # ── Sales: the day's units per item and the corner's daily line ──
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
        "id": order_id,
        "total": receipt["total"],
        "receipt": {k: receipt[k] for k in ("subtotal", "discount", "deliveryFee", "deliveryFree", "total")},
        "offer": receipt["applied"]["id"] if receipt["applied"] else None,
        "fulfillment": fulfillment,
        "location": location,
        "units": units,
        "consumed": consumed,
        "stock": sorted(stock, key=lambda r: r["on_hand"] - r["reorder_point"]),
    }
