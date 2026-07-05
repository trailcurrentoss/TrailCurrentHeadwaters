#!/usr/bin/env python3
"""Tiny offline reverse-geocode HTTP service.

Endpoint:
    GET /reverse?lat=<f>&lon=<f>
        → 200 {"place": str, "region": str, "country": str, "cc": str, "distance_km": float}
        → 404 {"error": "no match"}
        → 400 on missing/invalid params

The lookup pre-filters with a bounding-box on the indexed lat/lon columns
then picks the row with smallest squared angular distance. This is exact
for city-level "where am I?" resolution — meaningful within a few tens of
kilometers where great-circle vs. flat-plane distance diverge negligibly.

No dependencies beyond Python stdlib. Runs on port 8000.
"""

import json
import math
import os
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "geocoder.db")
PORT = int(os.environ.get("PORT", "8000"))
# Bounding-box radius (degrees). ~1° ≈ 111 km at the equator, so this
# covers everything within a couple hundred km — plenty for finding the
# nearest city while still keeping the index scan cheap.
BOX_DEGREES = float(os.environ.get("BOX_DEGREES", "1.0"))

_conn: sqlite3.Connection | None = None


def get_conn():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
    return _conn


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    a = math.radians(lat1)
    b = math.radians(lat2)
    da = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(da / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def reverse_geocode(lat: float, lon: float, radius: float = BOX_DEGREES):
    conn = get_conn()
    row = conn.execute(
        """
        SELECT c.name AS place, c.cc AS cc, c.lat AS lat, c.lon AS lon,
               COALESCE(a.name, '') AS region,
               COALESCE(co.name, c.cc) AS country
        FROM cities c
        LEFT JOIN admin1 a  ON a.code = c.admin1_key
        LEFT JOIN countries co ON co.cc = c.cc
        WHERE c.lat BETWEEN ? - ? AND ? + ?
          AND c.lon BETWEEN ? - ? AND ? + ?
        ORDER BY (c.lat - ?) * (c.lat - ?) + (c.lon - ?) * (c.lon - ?)
        LIMIT 1
        """,
        (lat, radius, lat, radius, lon, radius, lon, radius, lat, lat, lon, lon),
    ).fetchone()
    if row is None:
        return None
    dist = haversine_km(lat, lon, row["lat"], row["lon"])
    return {
        "place": row["place"],
        "region": row["region"],
        "country": row["country"],
        "cc": row["cc"],
        "distance_km": round(dist, 2),
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # CORS — permissive because this container is behind Overlook's nginx
        # proxy on the same rig; no cross-origin browser calls hit it directly.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            self._json(200, {"ok": True})
            return
        if u.path != "/reverse":
            self._json(404, {"error": "not found"})
            return
        params = parse_qs(u.query)
        try:
            lat = float(params.get("lat", [None])[0])
            lon = float(params.get("lon", [None])[0])
        except (TypeError, ValueError):
            self._json(400, {"error": "lat and lon query params required"})
            return
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            self._json(400, {"error": "lat/lon out of range"})
            return
        result = reverse_geocode(lat, lon)
        if result is None:
            # Widen once — RV in a remote area might be > 1° from any city.
            result = reverse_geocode(lat, lon, radius=5.0)
        if result is None:
            self._json(404, {"error": "no match"})
            return
        self._json(200, result)

    def log_message(self, fmt, *args):
        # Terse one-line log.
        sys.stderr.write(f"[geocoder] {fmt % args}\n")


def main():
    if not os.path.exists(DB_PATH):
        print(f"Missing {DB_PATH} — did build_index.py run?", file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Geocoder listening on :{PORT} (db: {DB_PATH})", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
