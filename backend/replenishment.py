"""Predictive replenishment: the inventory agent's forecast and the supply order to HQ.

Every storefront order takes ingredients out of a corner's stock, and the
day's item sales are recorded network-wide. From those two facts this module
works out, per corner and per SKU, how fast stock is burning, how many days
of cover are left, and how much to order so the corner stays covered through
the supplier's lead time. It drafts that order automatically; the franchisee
approves it in one click, HQ marks it shipped and delivered, and delivery
puts the stock back on the shelf.

    draft -> submitted -> in-transit -> delivered   (or a draft is dismissed)

Burn rates: item_sales is per item per day across the network; sales_daily is
per corner. A corner's share of the network's orders over the window
apportions the item units to it, then each item's `uses` recipe turns units
into ingredients, plus one six-count box per six units.
"""

import math
from datetime import date, datetime, timedelta, timezone

import agent_tools
import db

WINDOW_DAYS = 14        # how far back the burn rate looks
COVER_DAYS = 14         # days of cover to hold beyond the lead time
BOX_SKU = "PKG-008"

# Wholesale cost per unit, for the order total. The seed has no prices.
COST = {
    "FLR-001": 1.40, "BTR-002": 9.50, "CHC-003": 14.00, "CRM-004": 7.20, "FRT-005": 6.80,
    "CTR-006": 5.90, "SPC-007": 8.40, "PKG-008": 0.42, "MTC-009": 48.00,
}

STATUS_LABEL = {
    "draft": "Suggested", "submitted": "Sent to HQ", "in-transit": "In transit",
    "delivered": "Delivered", "cancelled": "Cancelled",
}
NEXT = {"submitted": ("ship", "Mark shipped"), "in-transit": ("deliver", "Mark delivered")}


class SupplyError(ValueError):
    """The supply order could not be changed as asked; the message is safe to show."""


def _now():
    return datetime.now(timezone.utc)


def _num(value):
    return float(value or 0)


def _iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()
    return str(value)


# ── Burn rates and forecast ──────────────────────────────────────────────

def _catalog_uses():
    """item id -> uses, for every item ever sold."""
    data = agent_tools._catalog()
    items = [*data.get("weeklyMenu", []), *data.get("plantBased", [])]
    for menu in data.get("eventMenus", []):
        items.extend(menu.get("items", []))
    return {i["id"]: (i.get("uses") or {}) for i in items}


def burn_rates(location_id, days=WINDOW_DAYS, today=None):
    """Daily consumption per SKU at a corner over the window, as {sku: units_per_day}."""
    today = today or date.today()
    since = today - timedelta(days=days)
    units = db.query("SELECT item_id, sum(units) AS units FROM item_sales WHERE day > %s GROUP BY item_id", (since,))
    network = db.query("SELECT coalesce(sum(orders), 0) AS n FROM sales_daily WHERE day > %s", (since,), one=True)
    mine = db.query("SELECT coalesce(sum(orders), 0) AS n FROM sales_daily WHERE day > %s AND location_id = %s",
                    (since, location_id), one=True)
    corners = db.query("SELECT count(*) AS n FROM locations", one=True)["n"] or 1
    share = (_num(mine["n"]) / _num(network["n"])) if _num(network["n"]) else 1 / corners

    uses = _catalog_uses()
    burn = {}
    total_units = 0.0
    for row in units:
        item_units = _num(row["units"]) * share
        total_units += item_units
        for sku, amount in uses.get(row["item_id"], {}).items():
            burn[sku] = burn.get(sku, 0.0) + amount * item_units
    burn[BOX_SKU] = burn.get(BOX_SKU, 0.0) + total_units / 6
    return {sku: round(value / days, 3) for sku, value in burn.items()}


def forecast(location_id=None, today=None):
    """Per corner and SKU: burn, days of cover, lead time, status and the suggested order quantity."""
    today = today or date.today()
    sql = """SELECT i.location_id, l.name AS location, i.sku, i.name, i.unit, i.on_hand, i.reorder_point,
                    i.on_order, i.lead_time_days
             FROM inventory i JOIN locations l ON l.id = i.location_id"""
    params = ()
    if location_id:
        sql += " WHERE i.location_id = %s OR lower(l.name) = lower(%s)"
        params = (location_id, location_id)
    rows = db.query(sql + " ORDER BY l.name, i.sku", params)

    rates = {}
    out = []
    for row in rows:
        loc = row["location_id"]
        if loc not in rates:
            rates[loc] = burn_rates(loc, today=today)
        burn = rates[loc].get(row["sku"], 0.0)
        on_hand, on_order, reorder = _num(row["on_hand"]), _num(row["on_order"]), _num(row["reorder_point"])
        lead = int(row["lead_time_days"] or 3)
        cover = (on_hand / burn) if burn > 0 else None                     # days until empty, from the shelf
        cover_with_inbound = ((on_hand + on_order) / burn) if burn > 0 else None
        target = burn * (lead + COVER_DAYS)
        need = target - on_hand - on_order
        # Never let the shelf sit below its reorder point once the order lands.
        need = max(need, reorder - on_hand - on_order)
        suggested = math.ceil(need) if need > 0 and burn > 0 else 0
        if burn == 0 and on_hand <= reorder and on_order == 0:
            suggested = math.ceil(reorder * 1.5 - on_hand)
        # order_now: at or under the reorder point, or would run dry before an
        # order placed today could land, with nothing already on the way.
        # inbound: short, but a supply order is coming. soon: worth ordering
        # in this cycle so the shelf stays covered through the lead time.
        runs_dry = cover is not None and cover <= lead + 3
        short = cover_with_inbound is not None and cover_with_inbound <= lead + COVER_DAYS
        if on_order == 0 and (on_hand <= reorder or runs_dry):
            status = "order_now"
        elif on_order > 0 and (on_hand <= reorder or short):
            status = "inbound"
        elif short or suggested > 0:
            status = "soon"
        else:
            status = "ok"
        out.append({
            "location": {"id": loc, "name": row["location"]},
            "sku": row["sku"], "name": row["name"], "unit": row["unit"],
            "on_hand": round(on_hand, 2), "on_order": round(on_order, 2), "reorder_point": reorder,
            "burn_per_day": burn,
            "days_of_cover": round(cover, 1) if cover is not None else None,
            "stockout_date": (today + timedelta(days=int(cover))).isoformat() if cover is not None else None,
            "lead_time_days": lead,
            "suggested_qty": suggested,
            "unit_cost": COST.get(row["sku"], 0),
            "status": status,
        })
    order = {"order_now": 0, "soon": 1, "inbound": 2, "ok": 3}
    out.sort(key=lambda r: (order[r["status"]], r["days_of_cover"] if r["days_of_cover"] is not None else 1e9))
    return out


# ── Drafting ─────────────────────────────────────────────────────────────

def _next_id():
    row = db.query("SELECT count(*) AS n FROM supply_orders", one=True)
    n = 1050 + int(row["n"] or 0)
    while db.query("SELECT 1 FROM supply_orders WHERE id = %s", (f"SO-{n}",), one=True):
        n += 1
    return f"SO-{n}"


def _reason(row):
    """Why this line is on the order, in the franchisee's terms."""
    unit, cover, lead = row["unit"], row["days_of_cover"], row["lead_time_days"]
    if row["on_hand"] <= row["reorder_point"]:
        return (f"{row['on_hand']} {unit} on hand, under the {row['reorder_point']:g} {unit} reorder point"
                + (f"; {cover} days of cover" if cover is not None else ""))
    if row["status"] == "order_now":
        return f"{cover} days of cover against a {lead}-day lead time"
    return f"burning {row['burn_per_day']} {unit}/day; {cover} days left against a {lead}-day lead time"


def refresh_drafts(location_id=None, today=None):
    """(Re)builds the agent's draft supply order for each corner. Returns the draft ids."""
    today = today or date.today()
    rows = forecast(location_id, today)
    by_loc = {}
    for r in rows:
        by_loc.setdefault(r["location"]["id"], []).append(r)
    ids = []
    for loc, items in by_loc.items():
        lines = [r for r in items if r["suggested_qty"] > 0 and r["status"] in ("order_now", "soon")]
        existing = db.query("SELECT id FROM supply_orders WHERE location_id = %s AND status = 'draft'", (loc,), one=True)
        if not lines:
            if existing:
                db.execute("DELETE FROM supply_orders WHERE id = %s", (existing["id"],))
            continue
        total = round(sum(r["suggested_qty"] * r["unit_cost"] for r in lines), 2)
        lead = max(r["lead_time_days"] for r in lines)
        if existing:
            order_id = existing["id"]
            db.execute("DELETE FROM supply_order_lines WHERE order_id = %s", (order_id,))
            db.execute("UPDATE supply_orders SET placed = %s, eta = %s, total = %s, lines = %s WHERE id = %s",
                       (today, today + timedelta(days=lead), total, len(lines), order_id))
        else:
            order_id = _next_id()
            db.execute(
                """INSERT INTO supply_orders (id, location_id, placed, eta, status, total, lines, source, created_at)
                   VALUES (%s, %s, %s, %s, 'draft', %s, %s, 'agent', %s)""",
                (order_id, loc, today, today + timedelta(days=lead), total, len(lines), _now()))
        for r in lines:
            db.execute(
                """INSERT INTO supply_order_lines (order_id, sku, name, unit, quantity, unit_cost, reason)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (order_id, r["sku"], r["name"], r["unit"], r["suggested_qty"], r["unit_cost"], _reason(r)))
        ids.append(order_id)
    return ids


# ── Reading ──────────────────────────────────────────────────────────────

def _lines_for(order_ids):
    if not order_ids:
        return {}
    rows = db.query(
        "SELECT order_id, sku, name, unit, quantity, unit_cost, reason FROM supply_order_lines WHERE order_id IN ({}) ORDER BY sku"
        .format(",".join(["%s"] * len(order_ids))), tuple(order_ids))
    out = {}
    for r in rows:
        out.setdefault(r["order_id"], []).append({
            "sku": r["sku"], "name": r["name"], "unit": r["unit"], "quantity": _num(r["quantity"]),
            "unitCost": _num(r["unit_cost"]), "reason": r["reason"]})
    return out


def _shape(row, lines):
    status = row["status"]
    verb, label = NEXT.get(status, (None, None))
    return {
        "id": row["id"],
        "location": {"id": row["location_id"], "name": row["location_name"]},
        "status": status, "statusLabel": STATUS_LABEL.get(status, status),
        "source": row.get("source") or "manual",
        "placed": str(row["placed"])[:10], "eta": str(row["eta"])[:10],
        "total": round(_num(row["total"]), 2), "lineCount": int(row["lines"] or 0),
        "note": row.get("note"),
        "lines": lines,
        "nextAction": verb, "nextLabel": label,
        "createdAt": _iso(row.get("created_at")), "submittedAt": _iso(row.get("submitted_at")),
        "shippedAt": _iso(row.get("shipped_at")), "deliveredAt": _iso(row.get("delivered_at")),
    }


_SQL = """SELECT s.id, s.location_id, l.name AS location_name, s.placed, s.eta, s.status, s.total, s.lines,
                 s.source, s.note, s.created_at, s.submitted_at, s.shipped_at, s.delivered_at
          FROM supply_orders s JOIN locations l ON l.id = s.location_id"""


def _row(order_id):
    row = db.query(_SQL + " WHERE s.id = %s", (order_id,), one=True)
    if not row:
        raise SupplyError(f"supply order {order_id} was not found")
    return row


def get(order_id):
    row = _row(order_id)
    return _shape(row, _lines_for([order_id]).get(order_id, []))


def board(today=None):
    """What the console shows: the forecast, the agent's drafts, and the orders in flight or recently done."""
    refresh_drafts(today=today)
    rows = forecast(today=today)
    orders = db.query(_SQL + " ORDER BY s.placed DESC, s.id DESC")
    lines = _lines_for([r["id"] for r in orders])
    shaped = [_shape(r, lines.get(r["id"], [])) for r in orders]
    drafts = [o for o in shaped if o["status"] == "draft"]
    others = [o for o in shaped if o["status"] != "draft"][:20]
    return {
        "forecast": rows,
        "drafts": drafts,
        "orders": others,
        "summary": {
            "order_now": sum(1 for r in rows if r["status"] == "order_now"),
            "soon": sum(1 for r in rows if r["status"] == "soon"),
            "drafts": len(drafts),
            "draft_value": round(sum(o["total"] for o in drafts), 2),
            "inbound_value": round(sum(o["total"] for o in others if o["status"] in ("submitted", "in-transit")), 2),
            "window_days": WINDOW_DAYS,
        },
    }


# ── Moving ───────────────────────────────────────────────────────────────

def approve(order_id, note=None):
    """The franchisee sends the draft to HQ; the quantities go on order."""
    row = _row(order_id)
    if row["status"] != "draft":
        raise SupplyError(f"{order_id} is already {STATUS_LABEL.get(row['status'], row['status']).lower()}")
    for line in _lines_for([order_id]).get(order_id, []):
        db.execute("UPDATE inventory SET on_order = on_order + %s WHERE location_id = %s AND sku = %s",
                   (line["quantity"], row["location_id"], line["sku"]))
    db.execute("UPDATE supply_orders SET status = 'submitted', submitted_at = %s, note = %s WHERE id = %s",
               (_now(), (note or "")[:200] or None, order_id))
    return get(order_id)


def ship(order_id):
    row = _row(order_id)
    if row["status"] != "submitted":
        raise SupplyError(f"{order_id} cannot ship from {row['status']}")
    db.execute("UPDATE supply_orders SET status = 'in-transit', shipped_at = %s WHERE id = %s", (_now(), order_id))
    return get(order_id)


def deliver(order_id):
    """HQ's delivery lands: the shelf goes up, the on-order figure comes down."""
    row = _row(order_id)
    if row["status"] not in ("in-transit", "submitted"):
        raise SupplyError(f"{order_id} cannot be delivered from {row['status']}")
    for line in _lines_for([order_id]).get(order_id, []):
        db.execute(
            """UPDATE inventory SET on_hand = on_hand + %s,
                                    on_order = CASE WHEN on_order - %s < 0 THEN 0 ELSE on_order - %s END
               WHERE location_id = %s AND sku = %s""",
            (line["quantity"], line["quantity"], line["quantity"], row["location_id"], line["sku"]))
    db.execute("UPDATE supply_orders SET status = 'delivered', delivered_at = %s, eta = %s WHERE id = %s",
               (_now(), date.today(), order_id))
    return get(order_id)


def dismiss(order_id):
    """Drops the agent's draft. It comes back on the next refresh if the numbers still call for it."""
    row = _row(order_id)
    if row["status"] != "draft":
        raise SupplyError(f"only a draft can be dismissed; {order_id} is {row['status']}")
    db.execute("DELETE FROM supply_orders WHERE id = %s", (order_id,))
    return {"id": order_id, "dismissed": True}
