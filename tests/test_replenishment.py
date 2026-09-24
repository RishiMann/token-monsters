"""The inventory agent: burn rates, forecast, drafted supply orders and their lifecycle.

Runs against a throwaway SQLite database, or a scratch PostgreSQL one with TEST_DATABASE_URL set. Run:
.venv/bin/python -m unittest tests/test_replenishment.py
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_TMP}/replenishment-test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import db  # noqa: E402
import seed  # noqa: E402
import replenishment  # noqa: E402
import agent_tools  # noqa: E402


class ReplenishmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("TEST_DATABASE_URL"):
            for table in ("supply_order_lines", "supply_orders", "order_events", "order_items", "orders", "sessions",
                          "preferences", "users", "inventory", "sales_daily", "item_sales", "locations"):
                db.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        db.init_schema()
        seed.seed()

    def inv(self, sku, location="frisco"):
        row = db.query("SELECT on_hand, on_order FROM inventory WHERE location_id = %s AND sku = %s", (location, sku), one=True)
        return float(row["on_hand"]), float(row["on_order"])

    def test_burn_rates_come_from_sales_and_recipes(self):
        burn = replenishment.burn_rates("frisco")
        self.assertGreater(burn["FLR-001"], 0)          # flour is in most recipes
        self.assertGreater(burn["PKG-008"], 0)          # one box per six units
        self.assertGreater(burn["FLR-001"], burn["MTC-009"])   # matcha is a pinch in a couple of items
        network = sum(replenishment.burn_rates(loc)["FLR-001"] for loc in ("frisco", "plano", "austin", "houston", "scottsdale"))
        self.assertGreater(network, burn["FLR-001"])   # a corner is a share of the network

    def test_forecast_flags_the_squeezed_sku_and_sizes_the_order(self):
        # Each test works a different corner, so they cannot disturb each other.
        rows = replenishment.forecast("plano")
        by_sku = {r["sku"]: r for r in rows}
        speculoos = by_sku["SPC-007"]                   # seeded below its reorder point at Plano
        self.assertIn(speculoos["status"], ("order_now", "inbound"))
        self.assertIsNotNone(speculoos["days_of_cover"])
        self.assertTrue(speculoos["stockout_date"])
        # The most urgent row comes first, and it is sized to cover the lead time plus the target.
        first = rows[0]
        self.assertIn(first["status"], ("order_now", "soon", "inbound"))
        needy = [r for r in rows if r["suggested_qty"] > 0]
        self.assertTrue(needy)
        for r in needy:
            target = r["burn_per_day"] * (r["lead_time_days"] + replenishment.COVER_DAYS)
            self.assertGreaterEqual(r["suggested_qty"] + r["on_hand"] + r["on_order"], min(target, r["reorder_point"]) - 1)
        # A shelf that is fine says so.
        self.assertTrue(any(r["status"] == "ok" and r["suggested_qty"] == 0 for r in rows))

    def test_draft_lifecycle_moves_stock(self):
        ids = replenishment.refresh_drafts("frisco")
        self.assertEqual(len(ids), 1)
        draft = replenishment.get(ids[0])
        self.assertEqual(draft["status"], "draft"); self.assertEqual(draft["source"], "agent")
        self.assertTrue(draft["lines"]); self.assertGreater(draft["total"], 0)
        line = draft["lines"][0]
        on_hand, on_order = self.inv(line["sku"])

        # Refreshing again reuses the same draft rather than piling up.
        self.assertEqual(replenishment.refresh_drafts("frisco"), ids)
        with self.assertRaises(replenishment.SupplyError):
            replenishment.ship(ids[0])                  # not sent yet

        sent = replenishment.approve(ids[0], note="please rush")
        self.assertEqual(sent["status"], "submitted"); self.assertEqual(sent["note"], "please rush")
        self.assertAlmostEqual(self.inv(line["sku"])[1], on_order + line["quantity"], places=2)
        with self.assertRaises(replenishment.SupplyError):
            replenishment.approve(ids[0])               # twice
        # With the order on its way, the agent has nothing new to draft for that SKU.
        again = replenishment.refresh_drafts("frisco")
        self.assertNotIn(line["sku"], [l["sku"] for i in again for l in replenishment.get(i)["lines"]])

        self.assertEqual(replenishment.ship(ids[0])["status"], "in-transit")
        landed = replenishment.deliver(ids[0])
        self.assertEqual(landed["status"], "delivered")
        after_hand, after_order = self.inv(line["sku"])
        self.assertAlmostEqual(after_hand, on_hand + line["quantity"], places=2)
        self.assertAlmostEqual(after_order, on_order, places=2)

    def test_dismiss_only_drafts_and_board_shape(self):
        ids = replenishment.refresh_drafts("scottsdale")   # seeded low across the board
        self.assertEqual(len(ids), 1)
        self.assertTrue(replenishment.dismiss(ids[0])["dismissed"])
        with self.assertRaises(replenishment.SupplyError):
            replenishment.get(ids[0])
        board = replenishment.board()
        self.assertIn("forecast", board); self.assertIn("drafts", board); self.assertIn("summary", board)
        self.assertTrue(any(o["location"]["id"] == "scottsdale" for o in board["drafts"]))   # it came back
        self.assertGreaterEqual(board["summary"]["order_now"], 1)

    def test_agent_tools(self):
        fc = agent_tools.forecast_stock(location="austin")   # seeded short on butter, strawberry and chocolate
        self.assertGreaterEqual(fc["order_now"], 1)
        self.assertTrue(fc["drafts"])
        draft_id = fc["drafts"][0]["id"]
        self.assertTrue(agent_tools.approve_supply_order(order_id=draft_id)["ok"])
        self.assertFalse(agent_tools.approve_supply_order(order_id=draft_id)["ok"])
        self.assertFalse(agent_tools.approve_supply_order(order_id="SO-nope")["ok"])


if __name__ == "__main__":
    unittest.main()
