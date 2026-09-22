"""Server for the Frosted Corner frontend.

This intentionally uses Python's standard library so the prototype has no
third-party dependency requirements. API routes can be added here later.

Runs unchanged locally and on Azure App Service: App Service injects PORT and
routes traffic from its front end, so when PORT is present we bind every
interface instead of loopback.
"""

import os
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PORT = int(os.environ.get("PORT", "8000"))
# A bare loopback bind is unreachable from App Service's front end, so any
# platform that hands us a PORT gets 0.0.0.0. HOST overrides both.
HOST = os.environ.get("HOST") or ("0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
ROOT = Path(__file__).resolve().parent.parent / "frontend"
CONTEXT_SOURCE = Path(__file__).resolve().parent / "context.json"
STOREFRONT_SOURCE = Path(__file__).resolve().parent / "storefront.json"


class AppHandler(SimpleHTTPRequestHandler):
    """Serve the frontend from the project root."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self) -> None:
        if self.path != "/api/agent":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 64_000:
                raise ValueError("payload too large")
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json({"error": "invalid request body"}, status=400)
            return

        try:
            from agent_runtime import AgentUnavailable, run
        except ImportError as exc:
            self._json({"error": f"agent runtime unavailable: {exc}"}, status=503)
            return

        try:
            payload = run(
                str(body.get("agent", "recommendation")),
                text=str(body.get("text", ""))[:2000],
                cart=body.get("cart") or {},
            )
        except AgentUnavailable as exc:
            # The frontend falls back to its rule-based path on 503.
            self._json({"error": str(exc)}, status=503)
            return
        except Exception as exc:
            self._json({"error": f"agent failed: {exc}"}, status=500)
            return

        self._json(payload)

    def _json(self, payload, status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        sources = {
            "/api/context": CONTEXT_SOURCE,
            "/api/storefront": STOREFRONT_SOURCE,
        }
        source = sources.get(self.path)
        if source:
            try:
                self._json(json.loads(source.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError) as exc:
                self._json({"error": f"data source unavailable: {exc}"}, status=500)
            return
        super().do_GET()


def main() -> None:
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
