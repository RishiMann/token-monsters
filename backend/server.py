"""Server for the Frosted Corner frontend and API.

Standard library only apart from the database driver and the model SDK, both
imported lazily so the storefront still serves if either is missing.

Runs unchanged locally and on Azure App Service: App Service injects PORT and
routes traffic from its front end, so when PORT is present we bind every
interface instead of loopback.
"""

import json
import os
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8000"))
# A bare loopback bind is unreachable from App Service's front end, so any
# platform that hands us a PORT gets 0.0.0.0. HOST overrides both.
HOST = os.environ.get("HOST") or ("0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
ROOT = Path(__file__).resolve().parent.parent / "frontend"
BACKEND = Path(__file__).resolve().parent

# Secure cookies need HTTPS; local development is plain http.
COOKIES_SECURE = "PORT" in os.environ

# Shown when the storefront is running without a database. The browsing
# experience still works; only anything account-shaped is unavailable.
OFFLINE_MESSAGE = (
    "Accounts are offline on this deployment. Browsing, the menu and the "
    "concierge all work; sign-in needs the database, which runs locally."
)


class AppHandler(SimpleHTTPRequestHandler):
    """Serves the frontend, plus the JSON API under /api."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ── helpers ──────────────────────────────────────────────────────

    def _json(self, payload, status=200, cookie=None):
        data = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 64_000:
            raise ValueError("payload too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def _session_user(self):
        """The signed-in user for this request, or None."""
        try:
            import auth
            return auth.session_user(auth.token_from_cookies(self.headers.get("Cookie")))
        except Exception:
            return None

    def log_message(self, fmt, *args):  # keep the access log terse
        super().log_message(fmt, *args)

    # ── GET ──────────────────────────────────────────────────────────

    def do_GET(self):
        if not self.path.startswith("/api/"):
            return super().do_GET()

        if self.path == "/api/storefront":
            return self._serve_file(BACKEND / "storefront.json")

        if self.path == "/api/auth/me":
            user = self._session_user()
            return self._json({"user": user} if user else {"user": None})

        if self.path.startswith("/api/me"):
            return self._me()

        if self.path.startswith("/api/operations"):
            return self._operations()

        if self.path == "/api/context":
            return self._context()

        if self.path == "/api/health":
            return self._health()

        self.send_error(404)

    def _serve_file(self, path):
        try:
            self._json(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            self._json({"error": f"data source unavailable: {exc}"}, status=500)

    def _health(self):
        """Which storage the running process actually ended up on."""
        payload = {"ok": True}
        try:
            import db
            payload["driver"] = db.driver()
            payload["users"] = (db.query(
                "SELECT count(*) AS n FROM users", one=True) or {}).get("n")
        except Exception as exc:
            payload["ok"] = False
            payload["detail"] = str(exc)[:300]
        self._json(payload)

    def _context(self):
        """Agent-readable context for the storefront.

        context.json supplies the market signals. For a signed-in customer the
        customer and order-history sections are replaced with their real rows,
        so the agents reason about that person rather than the sample profile.
        """
        try:
            source = json.loads((BACKEND / "context.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return self._json({"error": f"context unavailable: {exc}"}, status=500)

        user = self._session_user()
        if user:
            try:
                import auth
                prefs = auth.preferences(user["id"])
                source["customer"] = {
                    **source.get("customer", {}),
                    "name": user["name"],
                    "homeCorner": user.get("homeCorner"),
                    "plan": user.get("plan"),
                    **prefs,
                }
                source["orderHistory"] = self._order_history(user["id"])
            except Exception:
                pass  # fall back to the sample profile rather than failing

        self._json(source)

    def _order_history(self, user_id):
        """Past orders in the shape context.js expects."""
        import db
        rows = db.query(
            """
            SELECT o.id, o.placed_at, i.item_id, i.quantity
            FROM orders o JOIN order_items i ON i.order_id = o.id
            WHERE o.user_id = %s
            ORDER BY o.placed_at DESC
            """,
            (user_id,),
        )
        orders = {}
        for row in rows:
            order = orders.setdefault(
                row["id"], {"date": str(row["placed_at"])[:10], "items": []}
            )
            order["items"].append({"id": row["item_id"], "quantity": row["quantity"]})
        return list(orders.values())

    def _me(self):
        """Profile payload: the signed-in customer's own data."""
        user = self._session_user()
        if not user:
            return self._json({"error": "not signed in"}, status=401)
        try:
            import auth, agent_tools
            return self._json({
                "user": user,
                "preferences": auth.preferences(user["id"]),
                "history": agent_tools.analyze_purchase_history(user_id=user["id"]),
                "offers": agent_tools.find_offers(user_id=user["id"])["offers"],
                "orders": self._orders(user["id"]),
            })
        except Exception as exc:
            return self._json({"error": str(exc)}, status=503)

    def _orders(self, user_id):
        import db
        rows = db.query(
            """SELECT o.id, o.placed_at, o.channel, oi.item_id, oi.quantity
               FROM orders o JOIN order_items oi ON oi.order_id = o.id
               WHERE o.user_id = %s ORDER BY o.placed_at DESC""",
            (user_id,),
        )
        orders = {}
        for row in rows:
            order = orders.setdefault(row["id"], {
                "id": row["id"],
                "date": str(row["placed_at"])[:10],
                "channel": row["channel"],
                "items": [],
            })
            order["items"].append({"id": row["item_id"], "quantity": row["quantity"]})
        return list(orders.values())[:10]

    def _operations(self):
        """Franchise console data. Admin only — this is the server-side check."""
        user = self._session_user()
        if not user:
            return self._json({"error": "not signed in"}, status=401)
        if user["role"] != "admin":
            return self._json({"error": "forbidden"}, status=403)

        try:
            import db, agent_tools
            locations = db.query(
                """SELECT l.id, l.name, l.region, l.orders_week, l.revenue_week, l.change_pct,
                          round(100.0 * avg(CASE WHEN i.on_hand > i.reorder_point THEN 1 ELSE 0 END)) AS stock_health
                   FROM locations l LEFT JOIN inventory i ON i.location_id = l.id
                   GROUP BY l.id ORDER BY l.name"""
            )
            supply = db.query(
                """SELECT s.id, l.name AS location, s.placed, s.eta, s.status, s.total, s.lines
                   FROM supply_orders s JOIN locations l ON l.id = s.location_id
                   ORDER BY s.placed DESC"""
            )
            since = date.today() - timedelta(days=42)
            daily = db.query(
                "SELECT day, revenue FROM sales_daily WHERE day > %s ORDER BY day",
                (since,),
            )
            buckets = {}
            for row in daily:
                day = row["day"]
                if not hasattr(day, "isocalendar"):
                    day = date.fromisoformat(str(day)[:10])
                year, week, _ = day.isocalendar()
                label = f"{year}-W{week:02d}"
                buckets[label] = buckets.get(label, 0) + float(row["revenue"])
            weekly = [{"label": label, "revenue": round(total, 2)}
                      for label, total in sorted(buckets.items())]
            return self._json({
                "locations": locations,
                "inventory": agent_tools.check_inventory()["items"],
                "supplyOrders": supply,
                "insights": agent_tools.get_sales_insights(days=7),
                "weekly": weekly,
            })
        except Exception as exc:
            print(f"operations failed: {exc}")
            return self._json({"error": OFFLINE_MESSAGE}, status=503)

    # ── POST ─────────────────────────────────────────────────────────

    def do_POST(self):
        routes = {
            "/api/auth/signup": self._signup,
            "/api/auth/login": self._login,
            "/api/auth/logout": self._logout,
            "/api/agent": self._agent,
        }
        handler = routes.get(self.path)
        if not handler:
            return self.send_error(404)
        try:
            body = self._body()
        except (ValueError, json.JSONDecodeError):
            return self._json({"error": "invalid request body"}, status=400)
        handler(body)

    def _signup(self, body):
        try:
            import auth
            user, token = auth.sign_up(body.get("email"), body.get("password"), body.get("name"))
            self._json({"user": user}, status=201, cookie=auth.cookie_header(token, COOKIES_SECURE))
        except Exception as exc:
            self._auth_error(exc)

    def _login(self, body):
        try:
            import auth
            user, token = auth.sign_in(body.get("email"), body.get("password"))
            self._json({"user": user}, cookie=auth.cookie_header(token, COOKIES_SECURE))
        except Exception as exc:
            self._auth_error(exc)

    def _logout(self, _body):
        try:
            import auth
            auth.sign_out(auth.token_from_cookies(self.headers.get("Cookie")))
            self._json({"ok": True}, cookie=auth.clear_cookie_header())
        except Exception:
            self._json({"ok": True}, cookie="fc_session=; Path=/; Max-Age=0")

    def _auth_error(self, exc):
        try:
            import auth
            if isinstance(exc, auth.AuthError):
                return self._json({"error": str(exc)}, status=400)
        except ImportError:
            pass
        # Internal detail goes to the log, not to the visitor's screen.
        print(f"auth failed: {exc}")
        self._json({"error": OFFLINE_MESSAGE}, status=503)

    def _agent(self, body):
        try:
            from agent_runtime import AgentUnavailable, run
        except ImportError as exc:
            return self._json({"error": f"agent runtime unavailable: {exc}"}, status=503)

        user = self._session_user()
        try:
            payload = run(
                str(body.get("agent", "recommendation")),
                text=str(body.get("text", ""))[:2000],
                cart=body.get("cart") or {},
                user_id=user["id"] if user else None,
            )
            self._json(payload)
        except AgentUnavailable as exc:
            # The frontend falls back to its rule-based path on 503.
            self._json({"error": str(exc)}, status=503)
        except Exception as exc:
            self._json({"error": f"agent failed: {exc}"}, status=500)


def main() -> None:
    # Best effort: a missing database must not stop the storefront serving.
    try:
        import db, seed
        if db.database_url():
            db.init_schema()
            written = seed.seed()
            if written:
                print(f"Database seeded: {written}")
            print("Database ready.")
        else:
            print("DATABASE_URL not set — accounts and franchise data are unavailable.")
    except Exception as exc:
        print(f"Database unavailable ({exc}); serving without accounts.")
        print("Start PostgreSQL and run `createdb frostedcorner`, "
              "or set DATABASE_URL. See README.md.")

    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Frosted Corner running at http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
