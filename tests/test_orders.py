"""Placing an order records it and moves the corner's stock.

Runs against a throwaway SQLite database. Run:
.venv/bin/python -m unittest tests/test_orders.py
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/orders-test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import db  # noqa: E402
import seed  # noqa: E402
import orders  # noqa: E402
import agent_tools  # noqa: E402


class OrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_schema()
        seed.seed()

    def stock(self, sku, location="frisco"):
        return float(db.query("SELECT on_hand FROM inventory WHERE location_id = %s AND sku = %s",
                              (location, sku), one=True)["on_hand"])

    def test_guest_order_moves_stock_and_sales(self):
        chocolate, flour, boxes = self.stock("CHC-003"), self.stock("FLR-001"), self.stock("PKG-008")
        result = orders.place([{"id": "midnight-fudge", "quantity": 4}, {"id": "lemon-cloud", "quantity": 2}],
                              fulfillment="delivery", applied_offer="offer-bundle")
        self.assertIsInstance(result["id"], int)
        self.assertEqual(result["location"], "frisco")
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
        self.assertEqual(result["location"], "austin")


if __name__ == "__main__":
    unittest.main()
