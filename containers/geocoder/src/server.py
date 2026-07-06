#!/usr/bin/env python3
"""Tiny offline reverse-geocode HTTP service.

Endpoints:
    GET /reverse?lat=<f>&lon=<f>
        → 200 {"place": str, "region": str, "country": str, "cc": str, "distance_km": float}
        → 404 {"error": "no match"}
        → 400 on missing/invalid params

    GET /nearby?lat=<f>&lon=<f>&limit=<int>&radius_km=<f>
        → 200 {"results": [{"place","region","country","cc","distance_km"}, ...]}
        → 400 on missing/invalid params
        limit defaults to 5 (max 20); radius_km defaults to 100 (max 500).
        Excludes the exact nearest hit (that's what /reverse already gave you) —
        so "cities nearby" reads as a list of neighbours around the current spot.

The lookup pre-filters with a bounding-box on the indexed lat/lon columns
then picks by smallest squared angular distance. This is exact for
city-level resolution — meaningful within a few tens of kilometers where
great-circle vs. flat-plane distance diverge negligibly.

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


def _nearby_rows(lat: float, lon: float, radius_deg: float, limit: int):
    """Return up to `limit` rows ordered by squared angular distance."""
    conn = get_conn()
    return conn.execute(
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
        LIMIT ?
        """,
        (lat, radius_deg, lat, radius_deg,
         lon, radius_deg, lon, radius_deg,
         lat, lat, lon, lon, limit),
    ).fetchall()


def _row_to_dict(row, lat, lon):
    dist = haversine_km(lat, lon, row["lat"], row["lon"])
    return {
        "place": row["place"],
        "region": row["region"],
        "country": row["country"],
        "cc": row["cc"],
        "distance_km": round(dist, 2),
    }


def reverse_geocode(lat: float, lon: float, radius: float = BOX_DEGREES):
    rows = _nearby_rows(lat, lon, radius, limit=1)
    if not rows:
        return None
    return _row_to_dict(rows[0], lat, lon)


def nearby_cities(lat: float, lon: float, radius_km: float, limit: int):
    # Pull one extra row so we can drop the exact nearest (which callers get
    # from /reverse already) and still return `limit` neighbours.
    radius_deg = max(radius_km / 111.0, 0.1)
    rows = _nearby_rows(lat, lon, radius_deg, limit=limit + 1)
    results = []
    for row in rows:
        entry = _row_to_dict(row, lat, lon)
        if entry["distance_km"] > radius_km:
            continue
        results.append(entry)
    # Skip the top row (the reverse-geocode hit) so the list reads as
    # "other cities around you." If the caller wants the nearest itself,
    # they hit /reverse.
    if results:
        results = results[1:]
    return results[:limit]


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
        if u.path == "/reverse":
            self._handle_reverse(u)
            return
        if u.path == "/nearby":
            self._handle_nearby(u)
            return
        self._json(404, {"error": "not found"})

    def _parse_latlon(self, u):
        params = parse_qs(u.query)
        try:
            lat = float(params.get("lat", [None])[0])
            lon = float(params.get("lon", [None])[0])
        except (TypeError, ValueError):
            return None, None, params, "lat and lon query params required"
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            return None, None, params, "lat/lon out of range"
        return lat, lon, params, None

    def _handle_reverse(self, u):
        lat, lon, _params, err = self._parse_latlon(u)
        if err:
            self._json(400, {"error": err})
            return
        result = reverse_geocode(lat, lon)
        if result is None:
            # Widen once — RV in a remote area might be > 1° from any city.
            result = reverse_geocode(lat, lon, radius=5.0)
        if result is None:
            self._json(404, {"error": "no match"})
            return
        self._json(200, result)

    def _handle_nearby(self, u):
        lat, lon, params, err = self._parse_latlon(u)
        if err:
            self._json(400, {"error": err})
            return
        try:
            limit = int(params.get("limit", ["5"])[0])
        except (TypeError, ValueError):
            limit = 5
        try:
            radius_km = float(params.get("radius_km", ["100"])[0])
        except (TypeError, ValueError):
            radius_km = 100.0
        limit = max(1, min(limit, 20))
        radius_km = max(1.0, min(radius_km, 500.0))
        results = nearby_cities(lat, lon, radius_km, limit)
        self._json(200, {"results": results})

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
