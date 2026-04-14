#!/usr/bin/env python3

import json
import os
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


PORT = int(os.environ.get("PORT", "3001"))
APP_DIR = Path(os.environ.get("LOTUS_APP_DIR", "/opt/lotus-light"))
DIST_DIR = Path(os.environ.get("LOTUS_DIST_DIR", str(APP_DIR / "dist"))).resolve()


class LotusUiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST_DIR), **kwargs)

    def _send_json(self, payload: dict[str, object], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _is_spa_route(self, path: str) -> bool:
        clean_path = path.rstrip("/")
        return clean_path != "" and Path(clean_path).suffix == ""

    def _serve_health(self) -> None:
        self._send_json(
            {
                "status": "ok",
                "service": "lotus-light-ui",
                "port": PORT,
                "distReady": DIST_DIR.is_dir(),
            }
        )

    def do_HEAD(self) -> None:
        if urlparse(self.path).path == "/api/health":
            self._serve_health()
            return
        super().do_HEAD()

    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/health":
            self._serve_health()
            return

        if self._is_spa_route(path):
            self.path = "/index.html"

        super().do_GET()

    def log_message(self, format: str, *args) -> None:
        print(f"[lotus-ui] {self.address_string()} - {format % args}")


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), LotusUiHandler)
    print(f"[lotus-ui] Serving {DIST_DIR} on :{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()