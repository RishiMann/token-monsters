"""Local development server for the Miette & Co. frontend.

This intentionally uses Python's standard library so the prototype has no
third-party dependency requirements. API routes can be added here later.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST = "127.0.0.1"
PORT = 8000
ROOT = Path(__file__).resolve().parent.parent / "frontend"


class AppHandler(SimpleHTTPRequestHandler):
    """Serve the frontend from the project root."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Miette & Co. running at http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
