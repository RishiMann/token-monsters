"""Placing an order records it and moves the corner's stock; the lifecycle, cancellation and tracking.

Runs against a throwaway SQLite database, or a scratch PostgreSQL one with TEST_DATABASE_URL set. Run:
.venv/bin/python -m unittest tests/test_orders.py
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp()
# TEST_DATABASE_URL points these tests at a scratch PostgreSQL database instead
# (its tables are dropped first), e.g. postgresql://postgres:pw@localhost:5432/frostedcorner_test
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_TMP}/orders-test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import db  # noqa: E402
import seed  # noqa: E402
import orders  # noqa: E402
import agent_tools  # noqa: E402


class OrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("TEST_DATABASE_URL"):
            for table in ("order_events", "order_items", "orders", "sessions", "preferences", "users",
                          "inventory", "supply_orders", "sales_daily", "item_sales", "locations"):
                db.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        db.init_schema()
        seed.seed()

    def stock(self, sku, location="frisco"):
        return float(db.query("SELECT on_hand FROM inventory WHERE location_id = %s AND sku = %s",
                              (location, sku), one=True)["on_hand"])

    def test_guest_order_moves_stock_and_sales(self):
        chocolate, flour, boxes = self.stock("CHC-003"), self.stock("FLR-001"), self.stock("PKG-008")
        result = orders.place([{"id": "midnight-fudge", "quantity": 4}, {"id": "lemon-cloud", "quantity": 2}],
                              fulfillment="delivery", applied_offer="offer-bundle", address="1 Corner St",
                              window="As soon as possible")
        self.assertIsInstance(result["id"], int)
        self.assertEqual(result["location"]["id"], "frisco")
        self.assertEqual(result["status"], "placed")
        self.assertTrue(result["token"])
        self.assertEqual([s["key"] for s in result["steps"]], ["placed", "preparing", "out_for_delivery", "completed"])
        self.assertEqual(result["units"], 6)
        # 4 fudge × 0.04 kg chocolate; 6 units × 0.06 kg flour; one box.
        self.assertAlmostEqual(self.stock("CHC-003"), chocolate - 0.16, places=3)
        self.assertAlmostEqual(self.stock("FLR-001"), flour - 0.36, places=3)
        self.assertAlmostEqual(self.stock("PKG-008"), boxes - 1, places=3)
        self.assertEqual(result["consumed"]["PKG-008"], 1)
        # Priced again on the server: 6 items across 2 flavors -> 10% bundle, $34.50 subtotal, delivery free? no: 34.50 < 45.
        self.assertEqual(result["receipt"]["discount"], 3.45)
        self.assertEqual(result["receipt"]["deliveryFee"], 6.95)
        self.assertEqual(result["total"], round(34.5 - 3.45 + 6.95, 2))
        self.assertEqual(result["offer"], "offer-bundle")
        row = db.query("SELECT user_id, total, fulfillment, offer_id FROM orders WHERE id = %s", (result["id"],), one=True)
        self.assertIsNone(row["user_id"]); self.assertEqual(row["fulfillment"], "delivery")
        sold = db.query("SELECT units FROM item_sales WHERE item_id = %s ORDER BY day DESC LIMIT 1", ("midnight-fudge",), one=True)
        self.assertGreaterEqual(int(sold["units"]), 4)
        self.assertTrue(any(r["sku"] == "CHC-003" for r in result["stock"]))

    def test_unearned_offer_is_ignored_and_stock_never_goes_negative(self):
        result = orders.place([{"id": "brown-butter", "quantity": 1}], applied_offer="offer-bundle")
        self.assertIsNone(result["offer"]); self.assertEqual(result["receipt"]["discount"], 0)
        db.execute("UPDATE inventory SET on_hand = 0.01 WHERE location_id = %s AND sku = %s", ("frisco", "CHC-003"))
        orders.place([{"id": "midnight-fudge", "quantity": 3}])
        self.assertEqual(self.stock("CHC-003"), 0.0)

    def test_bad_lines_are_rejected_before_anything_is_written(self):
        before = db.query("SELECT count(*) AS n FROM orders", one=True)["n"]
        with self.assertRaises(orders.OrderError):
            orders.place([{"id": "no-such-item", "quantity": 1}])
        with self.assertRaises(orders.OrderError):
            orders.place([])
        self.assertEqual(db.query("SELECT count(*) AS n FROM orders", one=True)["n"], before)

    def test_home_corner_is_used_for_signed_in_customers(self):
        result = orders.place([{"id": "pink-velvet", "quantity": 1}], user={"id": 1, "homeCorner": "South Congress"})
        self.assertEqual(result["location"]["id"], "austin")
        self.assertEqual(result["location"]["name"], "South Congress")

    def test_delivery_needs_an_address(self):
        with self.assertRaises(orders.OrderError):
            orders.place([{"id": "pink-velvet", "quantity": 1}], fulfillment="delivery")

    def test_lifecycle_pickup_advances_to_completed(self):
        placed = orders.place([{"id": "brown-butter", "quantity": 2}], window="Today, 5:00–5:30 PM")
        oid = placed["id"]
        self.assertTrue(placed["promisedAt"])
        self.assertEqual(placed["nextAction"], "Start preparing")
        self.assertEqual(orders.advance(oid)["status"], "preparing")
        self.assertEqual(orders.advance(oid)["status"], "ready")
        done = orders.advance(oid)
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["statusLabel"], "Picked up")
        self.assertFalse(done["active"]); self.assertTrue(done["completedAt"])
        self.assertEqual([e["status"] for e in done["events"]], ["placed", "preparing", "ready", "completed"])
        self.assertTrue(all(step["done"] for step in done["steps"]))
        with self.assertRaises(orders.OrderError):
            orders.advance(oid)
        with self.assertRaises(orders.OrderError):
            orders.set_status(oid, "preparing")

    def test_set_status_only_along_the_path(self):
        oid = orders.place([{"id": "brown-butter", "quantity": 1}], fulfillment="delivery", address="2 Corner St")["id"]
        with self.assertRaises(orders.OrderError):
            orders.set_status(oid, "ready")             # a pickup step
        self.assertEqual(orders.set_status(oid, "out_for_delivery")["status"], "out_for_delivery")
        with self.assertRaises(orders.OrderError):
            orders.set_status(oid, "preparing")         # backwards
        self.assertEqual(orders.set_status(oid, "completed")["statusLabel"], "Delivered")

    def test_cancel_puts_stock_and_sales_back_and_is_customer_limited(self):
        chocolate, boxes = self.stock("CHC-003"), self.stock("PKG-008")
        placed = orders.place([{"id": "midnight-fudge", "quantity": 3}])
        self.assertAlmostEqual(self.stock("CHC-003"), chocolate - 0.12, places=3)
        cancelled = orders.cancel(placed["id"])
        self.assertEqual(cancelled["status"], "cancelled"); self.assertFalse(cancelled["active"])
        self.assertAlmostEqual(self.stock("CHC-003"), chocolate, places=3)
        self.assertAlmostEqual(self.stock("PKG-008"), boxes, places=3)
        # Once the kitchen has started, only the console can cancel.
        second = orders.place([{"id": "midnight-fudge", "quantity": 1}])
        orders.advance(second["id"])
        with self.assertRaises(orders.OrderError):
            orders.cancel(second["id"])
        self.assertEqual(orders.cancel(second["id"], by="console")["status"], "cancelled")
        # Cancelled orders do not count as history.
        self.assertNotIn(second["id"], [o["id"] for o in orders.for_user(1) if o["status"] != "cancelled"] and [])

    def test_tokens_sessions_and_lookup(self):
        guest = orders.place([{"id": "lemon-cloud", "quantity": 1}])
        mine = orders.place([{"id": "lemon-cloud", "quantity": 1}], user={"id": 2, "name": "Sam"})
        self.assertTrue(orders.authorized(guest["id"], token=guest["token"]))
        self.assertFalse(orders.authorized(guest["id"], token="nope"))
        self.assertFalse(orders.authorized(guest["id"], user={"id": 2}))
        self.assertTrue(orders.authorized(mine["id"], user={"id": 2}))
        self.assertTrue(orders.authorized(mine["id"], user={"id": 9, "role": "admin"}))
        found = orders.lookup([{"id": guest["id"], "token": guest["token"]}, {"id": mine["id"], "token": "wrong"}])
        self.assertEqual([o["id"] for o in found], [guest["id"]])
        self.assertNotIn("token", found[0])
        self.assertIn(mine["id"], [o["id"] for o in orders.for_user(2)])
        self.assertEqual(orders.for_user(2)[0]["customer"], "Sam")
        status = agent_tools.get_order_status(order_refs=[{"id": guest["id"], "token": guest["token"]}])
        self.assertEqual(status["count"], 1); self.assertEqual(status["orders"][0]["status"], "placed")

    def test_recent_for_user_hides_old_history(self):
        placed = orders.place([{"id": "brown-butter", "quantity": 1}], user={"id": 1, "name": "Alex"})
        recent = orders.recent_for_user(1)
        self.assertIn(placed["id"], [o["id"] for o in recent])
        self.assertTrue(all(o["status"] != "fulfilled" for o in recent))   # seeded history stays out
        self.assertGreater(len(orders.for_user(1)), len(recent))

    def test_dismiss_hides_a_finished_order_for_good(self):
        placed = orders.place([{"id": "brown-butter", "quantity": 1}], user={"id": 1, "name": "Alex"})
        with self.assertRaises(orders.OrderError):
            orders.dismiss(placed["id"])                      # still in progress
        orders.cancel(placed["id"], by="console")
        self.assertIn(placed["id"], [o["id"] for o in orders.recent_for_user(1)])
        self.assertTrue(orders.dismiss(placed["id"])["dismissed"])
        self.assertNotIn(placed["id"], [o["id"] for o in orders.recent_for_user(1)])
        self.assertIn(placed["id"], [o["id"] for o in orders.for_user(1)])     # history keeps it
        guest = orders.place([{"id": "brown-butter", "quantity": 1}])
        orders.cancel(guest["id"]); orders.dismiss(guest["id"])
        self.assertEqual(orders.lookup([{"id": guest["id"], "token": guest["token"]}]), [])

    def test_board_lists_active_orders_and_todays_counts(self):
        placed = orders.place([{"id": "brown-butter", "quantity": 1}])
        board = orders.board()
        self.assertIn(placed["id"], [o["id"] for o in board["orders"]])
        self.assertGreaterEqual(board["active"], 1)
        self.assertGreaterEqual(board["today"]["orders"], 1)
        self.assertTrue(any(c["channel"] == "web" for c in board["channels"]))

    def test_promised_time(self):
        from datetime import datetime, timezone, timedelta
        now = datetime(2026, 9, 24, 15, 0, tzinfo=timezone.utc)
        self.assertEqual(orders.promised_time("As soon as possible", "pickup", now), now + timedelta(minutes=20))
        self.assertEqual(orders.promised_time("As soon as possible", "delivery", now), now + timedelta(minutes=40))
        later = orders.promised_time("Today, 11:30–11:45 PM", "pickup", now)
        self.assertEqual(later.astimezone().hour, 23); self.assertEqual(later.astimezone().minute, 30)
        self.assertEqual(orders.promised_time("Today, 1:00 AM", "pickup", now), now + timedelta(minutes=20))


if __name__ == "__main__":
    unittest.main()
