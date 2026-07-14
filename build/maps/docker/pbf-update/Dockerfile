# PBF update container.
# Uses pyosmium's up-to-date tool to incrementally sync a local Geofabrik
# extract against upstream OSM diffs — avoids re-downloading the full PBF
# each build.
# Also provides the osmium-tool CLI so build.sh can merge multiple
# per-country PBFs into _merged.osm.pbf for Planetiler and Valhalla.
#
# Built by docker-compose.build.yml service `pbf-update`.
#
# Debian bookworm-slim (not Alpine) because:
#   - Alpine 3.20's community repo does not ship py3-osmium.
#   - Debian ships both osmium-tool (C++ CLI, provides `osmium merge`) and
#     pyosmium (Python bindings + `pyosmium-up-to-date` script) as
#     first-class packages, no wheel compilation.

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash \
        curl \
        ca-certificates \
        osmium-tool \
        pyosmium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /pbf
