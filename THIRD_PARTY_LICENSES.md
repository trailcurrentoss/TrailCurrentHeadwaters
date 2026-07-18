# Third-Party Licenses and Attribution

TrailCurrent In-Vehicle Compute is MIT-licensed (see [LICENSE](LICENSE)). It bundles and depends on a number of third-party components. Each is redistributed under its own upstream license, listed below.

This file is a living document. When we add a new runtime dependency, container image, or data source, it gets a row here.

> **Runtime data — OpenStreetMap:** the map bundles produced by [`build/maps/build.sh`](build/maps/) and installed on a device are derived from OpenStreetMap data. See the [OpenStreetMap data (ODbL)](#openstreetmap-data-odbl) section for the attribution and share-alike requirements that apply to anyone redistributing a bundle.

---

## Frontend runtime (bundled into the frontend container image)

### MapLibre GL JS

- **Version:** 4.7.1
- **License:** BSD-3-Clause
- **Copyright:** © MapLibre contributors. Portions © Mapbox (pre-fork).
- **Source:** <https://github.com/maplibre/maplibre-gl-js>
- **Role:** Renders the offline vector map in the PWA.
- **How we ship it:** downloaded from npm at Docker build time and baked into the frontend container at `/usr/share/nginx/html/libs/maplibre/`. See [`containers/frontend/Dockerfile`](containers/frontend/Dockerfile).

### PMTiles.js

- **Version:** 3.2.0
- **License:** BSD-3-Clause
- **Copyright:** © Protomaps LLC and PMTiles contributors.
- **Source:** <https://github.com/protomaps/PMTiles>
- **Role:** Registers the `pmtiles://` protocol with MapLibre so the offline PMTiles archive can be read via HTTP Range requests against a static file.
- **How we ship it:** downloaded from npm at Docker build time and baked into the frontend container at `/usr/share/nginx/html/libs/pmtiles/`.

### OpenMapTiles style JSONs

- **Version:** OpenMapTiles v3.x (derived styles: `3d` and `3d-dark`).
- **License:** BSD-3-Clause (styles are hand-authored derivatives of the OpenMapTiles reference style).
- **Copyright:** © OpenMapTiles project and contributors, plus TrailCurrent modifications.
- **Source:** <https://github.com/openmaptiles/openmaptiles>
- **Role:** Defines the visual appearance of the map (layers, colors, typography, 3D building extrusions).
- **How we ship it:** [`containers/frontend/public/maps-static/styles/{3d,3d-dark}/style.json`](containers/frontend/public/maps-static/styles/) — the source `sources.openmaptiles.url` field has been rewritten to point at our PMTiles endpoint.

### Font glyph atlases (PBFs)

- **License notice bundled at:** [`containers/frontend/public/maps-static/fonts/LICENSE`](containers/frontend/public/maps-static/fonts/LICENSE)
- **Source of the PBF glyph format:** <https://github.com/openmaptiles/fonts> v2.0 (MIT).
- **Included font families:**
  - **Noto Sans** (Regular, Bold, Italic) — SIL Open Font License 1.1 — © Google Inc. — <https://fonts.google.com/noto>
  - **Roboto** (Regular, Medium, Condensed Italic) — Apache License 2.0 — © Google Inc. — <https://fonts.google.com/specimen/Roboto>
  - **Metropolis** (Regular, Light, Light Italic, Medium Italic) — Unlicense (Public Domain) — Chris Simpson — <https://fontsarena.com/metropolis-by-chris-simpson/>
- **How we ship it:** committed to the repo (pre-generated PBFs; regenerating from source `.ttf` files would require a font-atlas build step). They land in the frontend container at `/usr/share/nginx/html/maps-static/fonts/`.

### Sprite atlas

The MapLibre sprite (packed PNG + JSON index used to render POI icons, road
shields, and other symbol layers) is generated from several sources.

- **POI icons — Mapbox Maki v8.0.0**
  - **License:** CC0 1.0 Universal (Public Domain Dedication)
  - **Upstream:** <https://github.com/mapbox/maki/tree/v8.0.0>
  - **Copyright:** Mapbox and contributors, dedicated to the public domain.
  - Icons are renamed at build time from `foo-bar.svg` → `foo_bar_11.svg` to
    match the `{class}_11` naming the OpenMapTiles v3 style expects at
    runtime. Additional `<class>_11.svg` aliases are generated for OMT POI
    class values that don't map 1:1 to a Maki filename (`sports_centre` →
    Maki `pitch`, `office` → Maki `commercial`, etc.). The alias table lives
    in [`containers/frontend/tools/map-sprite/build.sh`](containers/frontend/tools/map-sprite/build.sh).
- **US road shields, `oneway` arrow, `wave` pattern, ferry-terminal &
  bicycle-rental icons** — TrailCurrent project artwork, MIT (matches the
  rest of this repo). Preserved verbatim across sprite rebuilds via the
  `PROTECTED` allowlist in `build.sh`.
- **Build tool — spreet v0.13.1** (used by contributors, not shipped)
  - **License:** MIT
  - **Upstream:** <https://github.com/flother/spreet>

- **Runtime files:**
  [`containers/frontend/public/maps-static/sprites/`](containers/frontend/public/maps-static/sprites/)
- **How to regenerate:**
  [`containers/frontend/tools/map-sprite/README.md`](containers/frontend/tools/map-sprite/README.md)

### Node/npm transitive frontend deps

The frontend `package.json` is intentionally minimal — MapLibre and PMTiles are the only npm-sourced runtime bundles. Add an entry here if that changes.

---

## Backend runtime (bundled into the backend container image)

The backend container is a Node.js application. Its transitive dependency licenses are captured in [`containers/backend/package.json`](containers/backend/package.json) and their upstream licenses ship inside `node_modules/` at container build time (standard npm behavior — each package retains its own LICENSE file).

Notable direct dependencies (see `containers/backend/package.json` for the full list):

| Package | License | Role |
| --- | --- | --- |
| `express` | MIT | HTTP server |
| `mongodb` | Apache-2.0 | MongoDB driver |
| `mqtt` | MIT | Local MQTT broker client |
| `busboy` | MIT | Streamed multipart upload parser |
| `paho-mqtt` (via Python watchers) | EPL-2.0 or EDL-1.0 | MQTT client used by `deployment-watcher.py` and `map-watcher.py` |

---

## On-device Python (systemd services under `local_code/`)

- **paho-mqtt** — Eclipse Public License 2.0 (EPL) or Eclipse Distribution License 1.0 (BSD-3-Clause). We use it as a library, no source changes; either license permits redistribution as-is.

---

## On-device geocoding — Photon

- **Software:** [Photon](https://github.com/komoot/photon) — Apache License 2.0 — © komoot GmbH and contributors.
- **Container image:** [`rtuszik/photon-docker:2.3`](https://github.com/rtuszik/photon-docker) — Apache License 2.0 — an unofficial community-maintained Docker packaging of the Photon software. Multi-arch (amd64 + arm64).
- **Role:** Runs on the CM5 as the `photon` compose service; serves `/api/geocode/search` and `/api/geocode/reverse` via the backend proxy.
- **Index data:** derived from OpenStreetMap. See [OpenStreetMap data (ODbL)](#openstreetmap-data-odbl) — the same attribution/share-alike obligations apply to any Photon index shipped in a map bundle.
- **How we ship it:** the image tarball is baked into the deployment package by `build-and-save-images.sh` (as `images/photon.tar`) so it can be `docker load`-ed on the CM5 without internet access. The `photon_data/` search index rides inside the map bundle at `data/maps/current/photon_data/`.

---

## On-device routing — Valhalla

- **Software:** [Valhalla](https://github.com/valhalla/valhalla) — MIT License — © Valhalla contributors (Mapzen/Kevin Kreiser lineage).
- **Container image:** [`ghcr.io/nilsnolde/docker-valhalla/valhalla`](https://github.com/nilsnolde/docker-valhalla) — MIT License — a community-maintained Docker packaging of the Valhalla software (successor to the archived `gis-ops/docker-valhalla` referenced in earlier design docs). Multi-arch (amd64 + arm64).
- **Role:** Runs on the CM5 as the `valhalla` compose service; serves `/api/route` and `/api/route/matrix` via the backend proxy.
- **Tile data:** pre-built routing tiles derived from OpenStreetMap. See [OpenStreetMap data (ODbL)](#openstreetmap-data-odbl) for attribution + share-alike obligations that apply to any Valhalla tileset shipped in a map bundle.
- **How we ship it:** the image tarball is baked into the deployment package by `build-and-save-images.sh` (as `images/valhalla.tar`) for airgap `docker load`. The `valhalla_tiles/` directory rides inside the map bundle at `data/maps/current/valhalla_tiles/`.

---

## OpenStreetMap data (ODbL)

Every map bundle (`build/maps/dist/maps-<date>.zip`) contains data derived from OpenStreetMap:

- **License:** Open Database License (ODbL) v1.0.
- **URL:** <https://opendatacommons.org/licenses/odbl/>
- **Copyright:** © OpenStreetMap contributors.

**Attribution:** the running PWA displays "© OpenStreetMap contributors" via MapLibre's `AttributionControl` in every map view, in both light and dark themes. This satisfies the ODbL attribution requirement for the interactive product.

**Share-alike:** anyone who redistributes a bundle (or a derivative of the underlying OSM data extracted from a bundle) must comply with ODbL 4.4 — the produced database must itself be available under ODbL. This obligation is on the redistributor of the data, not on the TrailCurrent code (which is MIT-licensed and separate from the OSM data).

Each bundle's `manifest.json` includes an `odbl_notice` field summarizing this in-band, so the requirement is visible to anyone who unpacks a bundle.

---

## Build-time only tools

Not bundled into any shipped artifact; used only on the developer's build machine to produce map bundles. Listed for transparency.

| Tool | License | Role |
| --- | --- | --- |
| [Planetiler](https://github.com/onthegomap/planetiler) | Apache-2.0 | PBF → PMTiles conversion |
| [Photon global dumps from photon.komoot.io](https://github.com/komoot/photon) | Apache-2.0 | Pre-built global geocoding index; the tarball is fetched by `build/maps/build.sh` and embedded into the map bundle. Runtime usage of Photon itself is documented in the [On-device geocoding — Photon](#on-device-geocoding--photon) section above. |
| [nilsnolde/docker-valhalla](https://github.com/nilsnolde/docker-valhalla) | MIT | Build-time Valhalla tile generation container used by `build/maps/build.sh` to produce `valhalla_tiles.tar`. Runtime usage of the same image is documented in the [On-device routing — Valhalla](#on-device-routing--valhalla) section above. |
| [osmium](https://osmcode.org/osmium-tool/) | GPL-3.0 (used at build time only, not linked or bundled) | PBF utility invoked by build.sh |
| [pyosmium](https://osmcode.org/pyosmium/) | BSL-1.0 | PBF diff / update — build-time only |

---

## Reporting a license gap

If you spot a runtime component in the repo or the shipped containers that isn't listed here, please open an issue. This file is authoritative for what we distribute — if it doesn't cover something, that's a bug.
