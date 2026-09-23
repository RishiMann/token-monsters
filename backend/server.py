"""Server for the Frosted Corner frontend and API.

Standard library only apart from the database driver and the model SDK, both
imported lazily so the storefront still serves if either is missing.

Runs unchanged locally and on Azure App Service: App Service injects PORT and
routes traffic from its front end, so when PORT is present we bind every
interface instead of loopback.
"""

import json
import os
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

        self.send_error(404)

    def _serve_file(self, path):
        try:
            self._json(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            self._json({"error": f"data source unavailable: {exc}"}, status=500)

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
            """SELECT o.id, o.placed_at, o.channel,
                      json_agg(json_build_object('id', oi.item_id, 'quantity', oi.quantity)) AS items
               FROM orders o JOIN order_items oi ON oi.order_id = o.id
               WHERE o.user_id = %s GROUP BY o.id ORDER BY o.placed_at DESC LIMIT 10""",
            (user_id,),
        )
        return [{"id": r["id"], "date": str(r["placed_at"]),
                 "channel": r["channel"], "items": r["items"]} for r in rows]

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
            weekly = db.query(
                """SELECT to_char(date_trunc('week', day), 'IYYY-"W"IW') AS label,
                          sum(revenue) AS revenue
                   FROM sales_daily WHERE day > current_date - 42
                   GROUP BY 1 ORDER BY 1"""
            )
            return self._json({
                "locations": locations,
                "inventory": agent_tools.check_inventory()["items"],
                "supplyOrders": supply,
                "insights": agent_tools.get_sales_insights(days=7),
                "weekly": weekly,
            })
        except Exception as exc:
            return self._json({"error": f"operations unavailable: {exc}"}, status=503)

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
        self._json({"error": f"accounts unavailable: {exc}"}, status=503)

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
