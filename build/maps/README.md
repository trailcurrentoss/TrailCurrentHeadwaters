# Offline maps build pipeline

Builds the region-scoped offline maps bundle that a Headwaters vehicle consumes
for tiles, search, and routing. Output is a single region-agnostic zip:

```
dist/maps-<date>.zip
├── manifest.json          (region name lives here, not in any path)
├── tiles.pmtiles          (Planetiler PMTiles, MapLibre-compatible)
├── photon_data.tar        (Photon geocoding index)
└── valhalla_tiles.tar     (Valhalla routing tiles)
```

A vehicle receives this bundle via the PWA Maps upload page and applies it
atomically. See the top-level `MAPS_MIGRATION_PLAN` for the full architecture.

## Quick start (fresh clone → bundle)

Three commands from repo root:

```sh
cd build/maps
./bootstrap.sh                    # installs system deps; idempotent, safe to re-run
./build.sh --region california    # runs preflight, then builds; idempotent
./verify-bundle.sh                # sanity-checks the newest bundle in dist/
```

That's it. `bootstrap.sh` autodetects Linux (apt / dnf) or macOS (Homebrew)
and installs Python 3, PyYAML, curl, tar, zip, unzip, jsonschema. Docker is
the one dependency it does not auto-install — Docker Desktop on macOS is a
GUI installer, and Docker Engine on Linux needs a group re-login — but
`bootstrap.sh` prints exact instructions if it's missing.

`build.sh` runs an environment preflight before touching anything. If
something's off, it exits with a per-platform "install X" message. If
everything's good, it proceeds.

Every script is idempotent. Re-running never does harm; it just skips what's
already done.

## System requirements (what bootstrap installs)

You can install these manually if you'd rather. `bootstrap.sh` does it for
you but here's what it's doing:

| Dependency | Ubuntu/Debian | Fedora | macOS (Homebrew) | Auto-install? |
|---|---|---|---|---|
| Python 3 | `python3` | `python3` | `python@3` | ✅ |
| PyYAML | `python3-yaml` | `python3-pyyaml` | `pip3 install pyyaml` | ✅ |
| jsonschema | `python3-jsonschema` | `python3-jsonschema` | `pip3 install jsonschema` | ✅ |
| curl | `curl` | `curl` | `curl` | ✅ |
| tar | `tar` | `tar` | `gnu-tar` | ✅ |
| zip / unzip | `zip unzip` | `zip unzip` | `zip unzip` | ✅ |
| bash 3+ | `bash` | `bash` | preinstalled | ✅ |
| **Docker Engine** | see [docker.com](https://docs.docker.com/engine/install/) | see [docker.com](https://docs.docker.com/engine/install/) | Docker Desktop | ❌ manual |
| **docker compose v2 plugin** | `docker-compose-plugin` | `docker-compose-plugin` | bundled with Docker Desktop | ❌ manual (part of Docker install) |

Windows: not tested. Contributors on Windows should use WSL2 with an Ubuntu
distro and run `bootstrap.sh` inside WSL. First Windows contributor gets to
own that experience.

## Choose a region

`build.sh --region <name>` drives everything. The region name matches a YAML
file under `regions/`. Filenames and paths on disk (including the output zip)
never mention the region — every downstream script reads one and only one
pattern, and the region label lives inside `manifest.json`.

### Run the default

The default region is **North America** (US + Canada + Mexico):

```sh
./build.sh --region north-america
```

Produces `dist/maps-YYYY.MM.DD.zip`.

### Pick a different pre-defined region

List what's shipped:

```sh
./build.sh --list-regions
```

Current templates:

> **Before you clone this repo:** these bundles are large. A 256 GB drive
> is not enough for a North America or Europe build. See the "Hardware and
> network requirements" section below for the full picture; check the
> "Total" column in the table here against your available disk before
> starting a full build.

Every bundle carries the same ~88 GB Photon global search index. Only
tiles + routing scale with region coverage, so the table splits the
shared floor from the region-specific delta:

| Region | Coverage | Photon (shared) | Tiles + routing | Total |
|---|---|---|---|---|
| `california` | California only (fast smoke test) | 88 GB | 3 GB | **91 GB** (measured 2026-07-12) |
| `japan` | Japan | 88 GB | ~4 GB | ~92 GB (est.) |
| `australia` | Australia | 88 GB | ~4 GB | ~92 GB (est.) |
| `united-states` | US only | 88 GB | ~35 GB | ~123 GB (est., scaled from NA actuals × US share) |
| `north-america` | US + Canada + Mexico | 88 GB | **40 GB** | **129 GB** (measured 2026-07-13) |
| `europe` | Whole Europe extract | 88 GB | ~45 GB | ~133 GB (est., roughly comparable to NA per km²) |

Measured rows carry the build date. Non-measured rows are best-effort
projections from NA actuals; each region's row is updated with real
numbers on first successful build.

Add another ~2–3× the bundle size on top for working state during the
build (intermediate PBFs, Planetiler node maps, extracted Photon
directory, Valhalla staging). A full North America build wants ~400 GB
free — not 129 GB — even though the bundle itself is 129 GB.

**Why every bundle is at least ~88 GB.** Every bundle ships Photon's
global search index, so a vehicle can find "Tokyo" or "Berlin" regardless
of the tile/routing region — it just can't render tiles or compute routes
outside its region. Photon's dump is ~57 GB downloaded (bz2-compressed)
and ~88 GB on disk as the tar we bundle. That's the floor for every
bundle. See "Search scope" below for how runtime scoping works.

### Add a new region

No script changes needed — just add a YAML with three real fields.

1. Copy the closest template:
   ```sh
   cp regions/japan.yaml regions/switzerland.yaml
   ```
2. Edit the new file:
   - `region:` and the filename must match (`switzerland` ↔ `switzerland.yaml`).
   - `display_name:` free-form label shown in the PWA.
   - `pbf_sources:` one or more Geofabrik PBF URLs. These drive tiles and routing.
   - `bbox:` WGS84 west/south/east/north — used to crop rendering.
   - `estimated_footprint_gb:` best-effort sizing (build.sh will emit real
     numbers on stdout after the first successful run).
   Note: **there is no per-region Photon setting** — the global Photon index
   is downloaded once per build and included in every bundle. If you're
   adding a region, ignore Photon entirely; it just works.
3. Build it:
   ```sh
   ./build.sh --region switzerland
   ```

## Hardware and network requirements

Not installed by `bootstrap.sh`, listed here so you know before you start:

- **Disk**: 400–600 GB free during a full North America build (working state
  + intermediate artifacts + final bundle). Regional builds need less
  proportionally. `build.sh` preflight checks for at least 200 GB.
- **RAM**: 24 GB comfortable, 16 GB workable — Planetiler is the
  memory-heavy stage; adjust `mem_limit` in `docker-compose.build.yml` if
  needed.
- **Network**: initial PBF and Photon dump downloads are large (tens of GB);
  subsequent builds reuse cached files and only fetch OSM diffs. Fully
  offline builds work once the caches are warm.

## Docker images used (all multi-arch)

Every image the pipeline uses publishes both `linux/amd64` and `linux/arm64/v8`,
so Apple Silicon Macs (M1/M2/M3/M4) pull native arm64 images without QEMU
emulation. Verified 2026-07-12.

| Image | Role |
|---|---|
| `debian:bookworm-slim` | pbf-update container base |
| `alpine:3.20` | photon-fetch container base |
| `ghcr.io/onthegomap/planetiler:latest` | PMTiles builder |
| `ghcr.io/gis-ops/docker-valhalla/valhalla:latest` | Valhalla tile builder |

If you change an image in future work, re-verify multi-arch support:

```sh
docker manifest inspect <image>:<tag> | grep architecture
# should include: amd64 AND arm64
```

## Layout

```
build/maps/
├── bootstrap.sh                # install system deps (idempotent)
├── build.sh                    # main orchestrator (this is what you run)
├── verify-bundle.sh            # sanity-check a produced bundle zip
├── docker-compose.build.yml    # Planetiler + Valhalla + fetcher containers
├── manifest.schema.json        # JSON schema for the bundle manifest
├── docker/
│   └── pbf-update/Dockerfile   # image for pyosmium PBF updater
├── scripts/
│   ├── pbf-update.sh           # runs inside pbf-update container
│   └── photon-fetch.sh         # runs inside photon-fetch container
├── regions/
│   ├── north-america.yaml      # default
│   ├── united-states.yaml
│   ├── europe.yaml
│   ├── california.yaml
│   ├── japan.yaml
│   └── australia.yaml
├── work/<region>/              # per-region intermediate state (git-ignored)
│   ├── pbf/                    # Geofabrik extracts, kept up to date across runs
│   ├── pmtiles/                # Planetiler output
│   ├── photon/download/        # cached Photon archive
│   ├── photon/extracted/       # extracted photon_data/
│   ├── valhalla/               # Valhalla tile build
│   └── stage/                  # bundle staging area
└── dist/                       # final maps-<date>.zip lives here (git-ignored)
```

`work/<region>/` and `dist/` are excluded from git (see project `.gitignore`).
Switching `--region` uses a different `work/` subtree, so alternating between
regions does not clobber the previous region's cached PBF or Photon archive.

## What each stage does

1. **PBF update** — pulls the region's Geofabrik PBF extracts (initial full
   download the first time; `pyosmium-up-to-date` incremental diffs after that).
2. **Planetiler** — reads the merged PBF, produces `tiles.pmtiles` cropped to
   the region's bounding box.
3. **Photon fetch** — downloads the Photon index archive from
   photon.komoot.io. This is a pre-built index — no Nominatim, no PostgreSQL,
   no import step.
4. **Valhalla tile build** — reads the merged PBF, produces the routing tile
   pack.
5. **Package** — computes SHA-256 for each artifact, writes `manifest.json`
   (region name embedded, not in the path), zips into
   `dist/maps-<date>.zip`. Same-day rebuilds get a monotonic suffix
   (`.2`, `.3`, ...) — no user prompt.

## Common invocations

```sh
# Full build for the default region.
./build.sh --region north-america

# Small/fast smoke test — proves the pipeline end-to-end without a huge build.
./build.sh --region california

# Only refresh the PBF, don't rebuild tiles/routing/etc.
# Useful in cron: pull the diff overnight, then let a human trigger the full
# build when they want a bundle.
./build.sh --region north-america --update-pbf-only

# Show what would run without executing anything.
./build.sh --region north-america --dry-run
```

## Search scope (runtime, not build-time)

Every bundle contains the full global Photon index — search-anywhere-on-Earth
is a property of every bundle by design. Whether a given search *query* returns
worldwide or location-scoped results is decided at query time in the backend,
not at build time.

Photon supports both scoping mechanisms out of the box:

1. **Location bias** (`?lat=X&lon=Y`) — Photon ranks results near the given
   coordinates higher, without excluding distant ones. The vehicle already
   knows its own GPS from Bearing (published on the MQTT stream); the plan
   for Phase 3 backend work is to auto-pass those coordinates on every search
   so "coffee" returns nearby coffee shops first without the user having to
   ask for that.

2. **Bounding-box restriction** (`?bbox=west,south,east,north`) — Photon
   excludes results outside the box entirely. This is the escape hatch if
   Elasticsearch query performance on a Pi5 4 GB against the ~57 GB global
   index becomes a problem. A user setting like "restrict search to my
   country" (or to the region my bundle covers, read from `manifest.json`)
   can add a `bbox` filter to every query and cut the search space
   dramatically.

Both are pure backend / frontend concerns — the Photon index itself is
identical across all bundles. Nothing about scoping affects this build
pipeline.

## Data licensing

Bundles contain OSM-derived data licensed under the Open Database License
(ODbL) v1.0. `manifest.json` embeds an `odbl_notice` field carrying the
attribution + license text inside the bundle itself, so anyone extracting
or redistributing the bundle sees the requirement without having to consult
the repo.

MapLibre in the vehicle already renders "© OpenStreetMap contributors" via
its built-in attribution control.

## Sanity checks (no full build required)

- `./bootstrap.sh --check` — report missing deps without installing.
- `./build.sh --list-regions` — list the built-in region YAMLs.
- `./build.sh --region <name> --dry-run` — print exactly what stages would run
  without downloading anything or spinning up containers. Great for
  confirming a new region YAML parses correctly.
- `./build.sh --help` — flags reference.
- `./verify-bundle.sh` — sanity-check the newest bundle in `dist/`.
