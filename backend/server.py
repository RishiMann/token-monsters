"""Server for the Frosted Corner frontend and API.

Standard library only apart from the database driver and the model SDK, both
imported lazily so the storefront still serves if either is missing.

Runs unchanged locally and on Azure App Service: App Service injects PORT and
routes traffic from its front end, so when PORT is present we bind every
interface instead of loopback.
"""

import json
import os
import re
import sys
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def _load_dotenv(path):
    """KEY=VALUE lines from a local .env, never overriding the real environment.

    App Service supplies settings as environment variables; a developer machine
    keeps them in an untracked .env so the model endpoint and key stay out of
    the repository.
    """
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(Path(__file__).resolve().parent.parent / ".env")

PORT = int(os.environ.get("PORT", "8000"))
# A bare loopback bind is unreachable from App Service's front end, so any
# platform that hands us a PORT gets 0.0.0.0. HOST overrides both.
HOST = os.environ.get("HOST") or ("0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
ROOT = Path(__file__).resolve().parent.parent / "frontend"
BACKEND = Path(__file__).resolve().parent

# Secure cookies need HTTPS. App Service terminates TLS in front of the app and
# says so with X-Forwarded-Proto; a plain http://localhost never gets the flag,
# whatever the environment looks like, or the browser would drop the cookie.
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

    def _secure(self):
        """Whether the session cookie may carry Secure for this request."""
        proto = (self.headers.get("X-Forwarded-Proto") or "").lower()
        if proto:
            return proto == "https"
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return COOKIES_SECURE and host not in ("localhost", "127.0.0.1", "")

    def _session_user(self):
        """The signed-in user for this request, or None."""
        try:
            import auth
            return auth.session_user(auth.token_from_cookies(self.headers.get("Cookie")))
        except Exception:
            return None

    def log_message(self, fmt, *args):  # keep the access log terse
        super().log_message(fmt, *args)

    def end_headers(self):
        # Pages, scripts and styles must revalidate on every load, or a browser
        # keeps running last week's modules against this week's API. Images
        # keep the default heuristic caching.
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/") and (path.endswith((".js", ".css", ".html", "/")) or "." not in path.rsplit("/", 1)[-1]):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

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

        if self.path.startswith("/api/orders"):
            return self._get_orders()

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
        """Which storage the process ended up on, and whether the model runtime can run.

        Reports presence, never values: the endpoint host and deployment name
        are not secrets, the key is, so only its presence is shown.
        """
        payload = {"ok": True, "python": sys.version.split()[0]}
        try:
            import db
            payload["driver"] = db.driver()
            payload["database_setting"] = db.database_url_source()
            payload["users"] = (db.query(
                "SELECT count(*) AS n FROM users", one=True) or {}).get("n")
            admin = db.query("SELECT role FROM users WHERE email = %s", ("hq@frostedcorner.com",), one=True)
            payload["demo_admin"] = admin["role"] if admin else "missing"
            payload["boot"] = BOOT
            if getattr(db, "RECOVERED", None):
                payload["recovered_from"] = db.RECOVERED
        except Exception as exc:
            payload["ok"] = False
            payload["detail"] = str(exc)[:300]
        model = {"endpoint_set": bool(os.environ.get("AZURE_OPENAI_ENDPOINT")),
                 "deployment": os.environ.get("AZURE_OPENAI_DEPLOYMENT") or None,
                 "key_set": bool(os.environ.get("AZURE_OPENAI_API_KEY"))}
        try:
            import openai
            model["sdk"] = openai.__version__
        except ImportError:
            model["sdk"] = None
        payload["model"] = model
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
            WHERE o.user_id = %s AND o.status <> 'cancelled'
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
        import orders
        return orders.for_user(user_id, limit=12)

    # ── Orders: tracking and the console board ──────────────────────

    ORDER_PATH = re.compile(r"^/api/orders/(\d+)(?:/(advance|status|cancel|dismiss))?$")

    def _get_orders(self):
        """GET /api/orders/mine (session) and GET /api/orders/<id>?t=<token> (owner, token or admin)."""
        parts = urlsplit(self.path)
        try:
            import orders
            if parts.path == "/api/orders/mine":
                user = self._session_user()
                if not user:
                    return self._json({"error": "not signed in"}, status=401)
                return self._json({"orders": orders.for_user(user["id"])})
            match = self.ORDER_PATH.match(parts.path)
            if not match or match.group(2):
                return self.send_error(404)
            order_id = int(match.group(1))
            token = (parse_qs(parts.query).get("t") or [None])[0]
            if not orders.authorized(order_id, self._session_user(), token):
                return self._json({"error": "not your order"}, status=403)
            return self._json({"order": orders.get(order_id)})
        except Exception as exc:
            return self._order_failure(exc)

    def _track_orders(self, body):
        """POST /api/orders/track {refs: [{id, token}]} — what a browser remembered placing."""
        try:
            import orders
            refs = body.get("refs")
            found = orders.lookup(refs if isinstance(refs, list) else [])
            user = self._session_user()
            if user:
                seen = {o["id"] for o in found}
                found += [o for o in orders.recent_for_user(user["id"]) if o["id"] not in seen]
            found.sort(key=lambda o: (not o["active"], -(o["id"] or 0)))
            self._json({"orders": found})
        except Exception as exc:
            self._order_failure(exc)

    def _order_action(self, order_id, action, body):
        """advance / status: console only. cancel / dismiss: the owner, the placing browser, or the console."""
        try:
            import orders
            user = self._session_user()
            is_admin = bool(user) and user.get("role") == "admin"
            note = str(body.get("note") or "")[:200] or None
            if action in ("cancel", "dismiss"):
                if not orders.authorized(order_id, user, body.get("token")):
                    return self._json({"error": "not your order"}, status=403)
                if action == "dismiss":
                    order = orders.dismiss(order_id)
                else:
                    order = orders.cancel(order_id, by="console" if is_admin else "customer", note=note)
            else:
                if not is_admin:
                    return self._json({"error": "forbidden"}, status=403)
                if action == "advance":
                    order = orders.advance(order_id, note=note)
                else:
                    order = orders.set_status(order_id, str(body.get("status") or ""), note=note)
            self._json({"order": order})
        except Exception as exc:
            self._order_failure(exc)

    def _order_failure(self, exc):
        try:
            import orders
            if isinstance(exc, orders.OrderError):
                return self._json({"error": str(exc)}, status=400 if "not found" not in str(exc) else 404)
        except ImportError:
            pass
        print(f"orders failed: {exc!r}", file=sys.stderr, flush=True)
        self._json({"error": OFFLINE_MESSAGE, "demo": True}, status=503)

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
            import orders
            return self._json({
                "locations": locations,
                "inventory": agent_tools.check_inventory()["items"],
                "supplyOrders": supply,
                "insights": agent_tools.get_sales_insights(days=7),
                "weekly": weekly,
                "orders": orders.board(),
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
            "/api/orders": self._place_order,
        }
        handler = routes.get(self.path)
        action = self.ORDER_PATH.match(self.path)
        if self.path == "/api/orders/track":
            handler = self._track_orders
        elif action and action.group(2):
            order_id, verb = int(action.group(1)), action.group(2)
            handler = lambda body: self._order_action(order_id, verb, body)
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
            self._json({"user": user}, status=201, cookie=auth.cookie_header(token, self._secure()))
        except Exception as exc:
            self._auth_error(exc)

    def _login(self, body):
        try:
            import auth
            user, token = auth.sign_in(body.get("email"), body.get("password"))
            self._json({"user": user}, cookie=auth.cookie_header(token, self._secure()))
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

    def _place_order(self, body):
        """Records a checkout and moves the corner's stock. Needs the database."""
        try:
            import db, orders
            payload = orders.place(
                body.get("lines") or [],
                fulfillment=str(body.get("fulfillment") or "pickup"),
                applied_offer=body.get("appliedOffer") or None,
                user=self._session_user(),
                window=str(body.get("window") or ""),
                address=str(body.get("address") or ""),
                contact_name=str(body.get("name") or ""),
                note=str(body.get("note") or ""),
            )
            self._json(payload, status=201)
        except Exception as exc:
            try:
                import orders as orders_module
                if isinstance(exc, orders_module.OrderError):
                    return self._json({"error": str(exc)}, status=400)
            except ImportError:
                pass
            print(f"order failed: {exc!r}", file=sys.stderr, flush=True)
            self._json({"error": OFFLINE_MESSAGE, "demo": True}, status=503)

    def _agent(self, body):
        """One conversational turn with the model. The browser sends the history."""
        try:
            from agent_runtime import AgentError, AgentUnavailable, run
        except ImportError as exc:
            return self._json({"error": f"agent runtime unavailable: {exc}"}, status=503)

        user = self._session_user()
        history = body.get("history")
        refs = body.get("orders")
        try:
            payload = run(
                surface=str(body.get("agent") or "concierge"),
                text=str(body.get("text", ""))[:2000],
                cart=body.get("cart") or {},
                user=user,
                history=history if isinstance(history, list) else None,
                order_refs=refs if isinstance(refs, list) else None,
            )
            self._json(payload)
        except AgentUnavailable as exc:
            # Not configured: the frontend stops asking for the rest of the session.
            self._json({"error": str(exc)}, status=503)
        except AgentError as exc:
            # The model failed this turn: the frontend falls back once and retries next time.
            print(f"agent turn failed ({exc.reason}): {exc}", file=sys.stderr, flush=True)
            self._json({"error": "the model did not answer", "reason": exc.reason}, status=502)
        except Exception as exc:
            print(f"agent failed: {exc!r}", file=sys.stderr, flush=True)
            self._json({"error": "agent failed"}, status=500)


# What happened to the database at boot, reported by /api/health so a
# deployment can be diagnosed without reading its log.
BOOT = {}


def _boot_database():
    """Schema, seed and demo accounts, each as its own step so one failure is named, not hidden."""
    import db, seed
    try:
        db.init_schema()
        BOOT["schema"] = "ok"
    except Exception as exc:
        BOOT["schema"] = f"failed: {exc}"[:300]
        raise
    try:
        written = seed.seed()
        BOOT["seed"] = written or "nothing to do"
        if written:
            print(f"Database seeded: {written}")
    except Exception as exc:
        BOOT["seed"] = f"failed: {exc}"[:300]
        print(f"Seed failed: {exc!r}", file=sys.stderr, flush=True)
    try:
        # Runs again on its own: the seed above may have stopped before it got here.
        added = seed.ensure_demo_accounts()
        BOOT["demo_accounts"] = f"added {added}" if added else "present"
    except Exception as exc:
        BOOT["demo_accounts"] = f"failed: {exc}"[:300]
        print(f"Demo accounts failed: {exc!r}", file=sys.stderr, flush=True)
    print(f"Database ready ({db.driver()}).")


def main() -> None:
    # Best effort: a missing database must not stop the storefront serving.
    try:
        _boot_database()
    except Exception as exc:
        BOOT["error"] = str(exc)[:300]
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
