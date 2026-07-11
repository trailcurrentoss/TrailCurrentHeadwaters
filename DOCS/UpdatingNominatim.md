# Nominatim Search Data

> **Note**: Nominatim data generation is a **one-time task** during initial setup, and an infrequent task thereafter (e.g., once per year to refresh OpenStreetMap data).

## Overview

The `nominatim` service provides forward-geocoding (place / address search) for the map's search box. It imports an OpenStreetMap `.osm.pbf` extract into a PostgreSQL database on first startup.

**Required location:** `data/nominatim/map.osm.pbf`

The nominatim container starts, imports the file into its PostgreSQL volume on first run, then keeps serving from the database on subsequent restarts. The PBF file itself is only read once during import.

## How to Get the PBF File

### Option 1: Copy from a Team Member

If another team member already has a `map.osm.pbf` (or their region equivalent), copy it:

```bash
mkdir -p data/nominatim
cp /path/to/existing/region-latest.osm.pbf data/nominatim/map.osm.pbf
```

### Option 2: Reuse the PBF from `PbfTileConverter`

If you already generated map tiles with the `PbfTileConverter` utility (see [UpdatingMapTiles.md](UpdatingMapTiles.md)), that utility already downloaded and cached the region PBF. You can point Nominatim at the same file — no re-download needed:

```bash
# From the repo root, symlink (or copy) the cached PBF.
# Replace <region-name> with whatever you passed to convert.sh
# (e.g., colorado, us, germany).
ln -sf ../../../Utilities/PbfTileConverter/<region-name>-latest.osm.pbf \
       data/nominatim/map.osm.pbf
```

### Option 3: Download Directly from Geofabrik

Nominatim doesn't need Planetiler — the raw PBF from [Geofabrik](https://download.geofabrik.de/) is all it needs. Pick the region that matches your deployment:

```bash
mkdir -p data/nominatim
cd data/nominatim
# Small test region (~200MB):
curl -O https://download.geofabrik.de/north-america/us/colorado-latest.osm.pbf
mv colorado-latest.osm.pbf map.osm.pbf

# Or full US (~9GB):
curl -O https://download.geofabrik.de/north-america/us-latest.osm.pbf
mv us-latest.osm.pbf map.osm.pbf

# Or Germany:
curl -O https://download.geofabrik.de/europe/germany-latest.osm.pbf
mv germany-latest.osm.pbf map.osm.pbf
```

Browse all available regions at [https://download.geofabrik.de/](https://download.geofabrik.de/).

## First-Run Import

Once the file is at `data/nominatim/map.osm.pbf`, start the stack:

```bash
docker compose up -d nominatim
docker compose logs -f nominatim
```

The container imports the PBF into PostgreSQL. This is slow:

| Region       | PBF size | Import time  | Disk usage |
|--------------|----------|--------------|------------|
| Single state | 100 MB - 2 GB   | 10 min - 1 hour | 2 - 20 GB |
| Full US      | ~10 GB   | 8 - 20 hours | ~100 GB    |
| Europe       | ~30 GB   | 1 - 2 days   | ~300 GB    |
| Planet       | ~80 GB   | 3 - 5 days   | ~1 TB      |

Watch the log for `Import complete` — after that, the search API responds at the internal Docker address `http://nominatim:8080/`. The backend proxies it as `GET /api/geocode/search?q=<text>`.

## Verifying the Search Service

Once the import completes:

```bash
# From the host (backend proxies through auth-protected route,
# so hit the container directly for a quick smoke test):
docker compose exec backend curl -s "http://nominatim:8080/search?q=denver&format=jsonv2&limit=3" | head
```

Expected: a JSON array of results with `display_name`, `lat`, `lon`, etc.

## Regenerating the Import

Nominatim only re-imports if the underlying PostgreSQL volume is empty. To force a re-import (e.g., after replacing the PBF with a newer dataset):

```bash
docker compose down nominatim
docker volume rm trailcurrent_nominatim-data
# Replace data/nominatim/map.osm.pbf with the new file, then:
docker compose up -d nominatim
```

## Region Sizing Reference

Pick the smallest region that covers your operating area. Nominatim's import cost scales roughly with PBF size, and query performance degrades on very large databases.

- Single US state / small country: ideal for development and single-region deployments.
- Continent-scale: only worth it if you routinely travel across borders.
- Planet: not recommended for on-vehicle compute — the on-disk database is ~1 TB.
