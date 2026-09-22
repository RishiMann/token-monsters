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

    def do_GET(self) -> None:
        sources = {
            "/api/context": CONTEXT_SOURCE,
            "/api/storefront": STOREFRONT_SOURCE,
        }
        source = sources.get(self.path)
        if source:
            payload = json.dumps(json.loads(source.read_text(encoding="utf-8"))).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
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
