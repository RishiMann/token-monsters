"""Mock data generator.

Seeds accounts, preferences, order history, per-location inventory, supply
orders and 90 days of sales. Deterministic (fixed random seed) so every
teammate and every redeploy gets the same numbers, which keeps a demo
reproducible and makes the sales charts stable between runs.

Only fills empty tables, so it is safe to call on every boot.
"""

import random
from datetime import date, timedelta

import db
from auth import hash_password

RNG = random.Random(20260922)

LOCATIONS = [
    ("frisco",     "Frisco Corner",     "North TX"),
    ("plano",      "Plano Corner",      "North TX"),
    ("austin",     "South Congress",    "Central TX"),
    ("houston",    "Heights Corner",    "Gulf"),
    ("scottsdale", "Scottsdale Corner", "Southwest"),
]

# sku, name, unit, base stock, reorder point, lead days, items it feeds
SUPPLIES = [
    ("FLR-001", "Pastry flour",       "kg", 240, 120, 3),
    ("BTR-002", "Cultured butter",    "kg",  96,  90, 2),
    ("CHC-003", "Dark chocolate 70%", "kg",  70,  60, 5),
    ("CRM-004", "Cream cheese",       "kg",  62,  45, 2),
    ("FRT-005", "Strawberry puree",   "L",   48,  40, 4),
    ("CTR-006", "Lemon curd base",    "L",   62,  35, 3),
    ("SPC-007", "Speculoos spread",   "kg",  40,  30, 6),
    ("PKG-008", "Six-count boxes",    "units", 4200, 2500, 7),
    ("MTC-009", "Matcha powder",      "kg",  16,  10, 9),
]

# SKUs deliberately run low per corner, so the admin console shows a real
# spread instead of everything green. Scottsdale is low across the board.
PRESSURE = {
    "frisco":  ("CHC-003",),
    "plano":   ("SPC-007", "MTC-009"),
    "austin":  ("BTR-002", "FRT-005", "CHC-003"),
    "houston": ("MTC-009",),
}

ACCOUNTS = [
    # email, password, name, role, home corner, plan
    ("alex@frostedcorner.com",  "treat", "Alex Rivera",  "customer", "Frisco Corner",   "The Table"),
    ("sam@frostedcorner.com",   "treat", "Sam Okonkwo",  "customer", "South Congress",  "The Weekly Corner"),
    ("jordan@frostedcorner.com","treat", "Jordan Bell",  "customer", "Heights Corner",  None),
    ("hq@frostedcorner.com",    "admin", "Morgan Sato",  "admin",    None,              None),
]

PREFERENCES = {
    "alex@frostedcorner.com": {
        "sweetness": "balanced", "texture": "light", "adventurousness": "curious",
        "repeat_pattern": "Friday pickup", "allergens_avoid": "",
        "saved_event": "Saturday garden party|14|2026-09-26",
    },
    "sam@frostedcorner.com": {
        "sweetness": "rich", "texture": "dense", "adventurousness": "adventurous",
        "repeat_pattern": "Sunday delivery", "allergens_avoid": "tree nut",
    },
    "jordan@frostedcorner.com": {
        "sweetness": "light", "texture": "airy", "adventurousness": "cautious",
        "repeat_pattern": "", "allergens_avoid": "dairy",
    },
}

# Who gravitates to what, so history is not uniform noise.
TASTE = {
    "alex@frostedcorner.com":   ["brown-butter", "lemon-cloud", "pink-velvet", "strawberry-stack"],
    "sam@frostedcorner.com":    ["midnight-fudge", "biscoff", "brown-butter"],
    "jordan@frostedcorner.com": ["coconut-matcha", "lemon-cloud", "almond-fig"],
}


def _empty(table):
    row = db.query(f"SELECT count(*) AS n FROM {table}", one=True)
    return (row or {}).get("n", 0) == 0


def seed():
    """Fill any empty table. Returns a dict of what was written."""
    written = {}
    today = date.today()
    item_ids = [i["id"] for i in db.menu_items()]

    # ── Accounts, preferences, order history ──────────────────────────
    fresh = _empty("users")
    added = ensure_demo_accounts()
    if added:
        written["users"] = added

    if fresh:
        for email, prefs in PREFERENCES.items():
            user = db.query("SELECT id FROM users WHERE email = %s", (email,), one=True)
            for key, value in prefs.items():
                db.execute(
                    "INSERT INTO preferences (user_id, key, value) VALUES (%s, %s, %s) "
                    "ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value",
                    (user["id"], key, value),
                )
        written["preferences"] = sum(len(p) for p in PREFERENCES.values())

    if _empty("orders"):
        count = 0
        for email, favourites in TASTE.items():
            user = db.query("SELECT id FROM users WHERE email = %s", (email,), one=True)
            if not user:
                continue
            for weeks_ago in range(1, RNG.randint(5, 9)):
                placed = today - timedelta(days=weeks_ago * 7 + RNG.randint(0, 3))
                order = db.query(
                    "INSERT INTO orders (user_id, placed_at, channel) VALUES (%s, %s, %s) RETURNING id",
                    (user["id"], placed, RNG.choice(["app", "app", "web", "in-store"])),
                    one=True,
                )
                # Mostly favourites, with the occasional try-something-new.
                picks = RNG.sample(favourites, min(len(favourites), RNG.randint(1, 3)))
                if RNG.random() < 0.3:
                    picks.append(RNG.choice(item_ids))
                for item_id in set(picks):
                    db.execute(
                        "INSERT INTO order_items (order_id, item_id, quantity) VALUES (%s, %s, %s) "
                        "ON CONFLICT DO NOTHING",
                        (order["id"], item_id, RNG.randint(1, 3)),
                    )
                count += 1
        written["orders"] = count

    # ── Network: locations, stock, supply orders ──────────────────────
    if _empty("locations"):
        for loc_id, name, region in LOCATIONS:
            db.execute(
                """INSERT INTO locations (id, name, region, orders_week, revenue_week, change_pct)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (loc_id, name, region, RNG.randint(500, 950),
                 round(RNG.uniform(11000, 21500), 2), round(RNG.uniform(-3, 12), 2)),
            )
        written["locations"] = len(LOCATIONS)

    if _empty("inventory"):
        rows = 0
        for loc_id, _, _ in LOCATIONS:
            # Pressure points are explicit rather than random, so the console
            # tells the same story on every machine and every reseed.
            squeeze = 0.4 if loc_id == "scottsdale" else RNG.uniform(1.05, 1.5)
            for sku, name, unit, base, reorder, lead in SUPPLIES:
                if sku in PRESSURE.get(loc_id, ()):
                    on_hand = round(reorder * RNG.uniform(0.55, 0.9), 2)
                else:
                    on_hand = round(base * squeeze * RNG.uniform(0.9, 1.2), 2)
                on_order = round(base * 0.5, 2) if on_hand < reorder and RNG.random() < 0.5 else 0
                db.execute(
                    """INSERT INTO inventory (location_id, sku, name, unit, on_hand, reorder_point, on_order, lead_time_days)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (loc_id, sku, name, unit, on_hand, reorder, on_order, lead),
                )
                rows += 1
        written["inventory"] = rows

    if _empty("supply_orders"):
        statuses = ["delivered", "in-transit", "in-transit", "submitted"]
        for index, (loc_id, _, _) in enumerate(LOCATIONS):
            placed = today - timedelta(days=RNG.randint(2, 9))
            db.execute(
                """INSERT INTO supply_orders (id, location_id, placed, eta, status, total, lines)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (f"SO-{1040 + index}", loc_id, placed, placed + timedelta(days=RNG.randint(4, 7)),
                 statuses[index % len(statuses)], round(RNG.uniform(1800, 4300), 2), RNG.randint(4, 9)),
            )
        written["supply_orders"] = len(LOCATIONS)

    # ── 90 days of sales, with a gentle upward trend ──────────────────
    if _empty("sales_daily"):
        days = rows = 0
        for offset in range(90, 0, -1):
            day = today - timedelta(days=offset)
            trend = 1 + (90 - offset) * 0.0022          # ~+20% over the window
            weekend = 1.25 if day.weekday() >= 5 else 1.0
            for loc_id, _, _ in LOCATIONS:
                orders = int(RNG.randint(60, 130) * trend * weekend)
                db.execute(
                    "INSERT INTO sales_daily (day, location_id, orders, revenue) VALUES (%s, %s, %s, %s)",
                    (day, loc_id, orders, round(orders * RNG.uniform(19.5, 25.0), 2)),
                )
                rows += 1
            for item_id in item_ids:
                db.execute(
                    "INSERT INTO item_sales (day, item_id, units) VALUES (%s, %s, %s) "
                    "ON CONFLICT DO NOTHING",
                    (day, item_id, int(RNG.randint(20, 90) * trend * weekend)),
                )
            days += 1
        written["sales_days"] = days
        written["sales_rows"] = rows

    return written


def ensure_demo_accounts():
    """Creates any of the demo accounts that are missing. Returns how many were added.

    Runs on every boot, not only on an empty table, so a database that already
    held other users still gets them.
    """
    added = 0
    for email, password, name, role, corner, plan in ACCOUNTS:
        if db.query("SELECT 1 FROM users WHERE email = %s", (email,), one=True):
            continue
        digest, salt = hash_password(password)
        db.execute(
            """INSERT INTO users (email, password_hash, password_salt, name, role, home_corner, plan)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (email, digest, salt, name, role, corner, plan),
        )
        added += 1
    return added


def reset_demo_accounts():
    """Puts the seeded accounts back to their documented passwords. Returns how many were reset."""
    count = 0
    for email, password, name, role, corner, plan in ACCOUNTS:
        digest, salt = hash_password(password)
        if db.execute("UPDATE users SET password_hash = %s, password_salt = %s, role = %s WHERE email = %s",
                      (digest, salt, role, email)):
            count += 1
        else:
            db.execute(
                """INSERT INTO users (email, password_hash, password_salt, name, role, home_corner, plan)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (email, digest, salt, name, role, corner, plan))
            count += 1
    db.execute("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN (%s, %s, %s, %s))",
               tuple(a[0] for a in ACCOUNTS))
    return count


if __name__ == "__main__":
    # python backend/seed.py --reset-demo-accounts   (reads DATABASE_URL / .env like the server)
    import sys
    from pathlib import Path as _Path
    try:
        import server  # noqa: F401  (loads .env)
    except Exception:
        pass
    db.init_schema()
    if "--reset-demo-accounts" in sys.argv:
        print(f"Reset {reset_demo_accounts()} demo accounts on {db.driver()}: "
              + ", ".join(f"{a[0]} / {a[1]}" for a in ACCOUNTS))
    else:
        print(f"Seeded: {seed() or 'nothing to do'} ({db.driver()})")
