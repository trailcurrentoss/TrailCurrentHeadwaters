#!/usr/bin/env python3
"""Build the SQLite index from raw GeoNames data.

Called from the Dockerfile at build time. Reads three TSV files that the
Dockerfile has already downloaded from download.geonames.org and produces
/data/geocoder.db — a compact SQLite DB the runtime server queries by
(lat, lon) → (place, region, country).

Runtime shape:
    cities(id INTEGER PK, name TEXT, admin1 TEXT, cc TEXT, lat REAL, lon REAL)
    admin1(code TEXT PK, name TEXT)      -- state/province names
    countries(cc TEXT PK, name TEXT)     -- country names

Lookup query at runtime is a bounding-box + squared-distance nearest, which
is exact within ~1° and O(a few hundred rows) after the index filter.
"""

import csv
import os
import sqlite3
import sys

DATA_DIR = os.environ.get("DATA_DIR", "/data")
CITIES_FILE = os.path.join(DATA_DIR, "cities1000.txt")
ADMIN1_FILE = os.path.join(DATA_DIR, "admin1CodesASCII.txt")
COUNTRY_FILE = os.path.join(DATA_DIR, "countryInfo.txt")
DB_PATH = os.path.join(DATA_DIR, "geocoder.db")


def load_admin1(conn):
    # Format: <cc>.<admin1_code> \t <admin1_name> \t <admin1_ascii> \t <geoname_id>
    n = 0
    with open(ADMIN1_FILE, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO admin1(code, name) VALUES (?, ?)",
                (parts[0], parts[1]),
            )
            n += 1
    print(f"  admin1: {n} rows")


def load_countries(conn):
    # Format has # comments; columns are ISO-2, ISO-3, ISO-numeric, FIPS, name, ...
    n = 0
    with open(COUNTRY_FILE, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 5:
                continue
            iso2 = parts[0].strip()
            name = parts[4].strip()
            if iso2 and name:
                conn.execute(
                    "INSERT OR REPLACE INTO countries(cc, name) VALUES (?, ?)",
                    (iso2, name),
                )
                n += 1
    print(f"  countries: {n} rows")


def load_cities(conn):
    # cities1000 columns (0-indexed):
    #   0  geonameid
    #   1  name
    #   2  asciiname
    #   3  alternatenames
    #   4  latitude
    #   5  longitude
    #   6  feature class
    #   7  feature code
    #   8  country code (cc)
    #  10  admin1 code
    n = 0
    with open(CITIES_FILE, encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
        for row in reader:
            if len(row) < 11:
                continue
            try:
                gid = int(row[0])
                lat = float(row[4])
                lon = float(row[5])
            except ValueError:
                continue
            name = row[1]
            cc = row[8]
            admin1_key = f"{cc}.{row[10]}" if row[10] else None
            conn.execute(
                "INSERT OR REPLACE INTO cities(id, name, admin1_key, cc, lat, lon) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (gid, name, admin1_key, cc, lat, lon),
            )
            n += 1
    print(f"  cities: {n} rows")


def main():
    for f in (CITIES_FILE, ADMIN1_FILE, COUNTRY_FILE):
        if not os.path.exists(f):
            print(f"Missing input: {f}", file=sys.stderr)
            sys.exit(1)

    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
        CREATE TABLE admin1 (code TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE countries (cc TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE cities (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            admin1_key TEXT,
            cc TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL
        );
        CREATE INDEX cities_lat ON cities(lat);
        CREATE INDEX cities_lon ON cities(lon);
    """)

    print("Loading admin1...")
    load_admin1(conn)
    conn.commit()

    print("Loading countries...")
    load_countries(conn)
    conn.commit()

    print("Loading cities...")
    load_cities(conn)
    conn.commit()

    conn.execute("VACUUM")
    conn.close()

    size_mb = os.path.getsize(DB_PATH) / (1024 * 1024)
    print(f"Wrote {DB_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
