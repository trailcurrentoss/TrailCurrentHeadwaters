#!/bin/sh
# Runs inside the photon-fetch container (see docker-compose.build.yml).
# Downloads the Photon dump archive from photon.komoot.io's public server
# and stages it under /work/download/.
#
# Inputs (env vars, both required):
#   PHOTON_DUMP_URL  — full URL of the Photon dump (.tar.bz2) to fetch.
#                      Sourced from the region YAML.
#
# Outputs (in /work, bind-mounted from build/maps/work/<region>/photon/):
#   download/<basename>.tar.bz2   the Photon archive
#
# The build.sh orchestrator handles extract into work/<region>/photon/extracted/
# after this container exits.

set -eu

if [ -z "${PHOTON_DUMP_URL:-}" ]; then
    echo "photon-fetch: PHOTON_DUMP_URL env var is empty" >&2
    exit 2
fi

# alpine's base image has no curl; install what we need.
apk add --no-cache curl ca-certificates >/dev/null

mkdir -p /work/download
cd /work/download

filename=$(basename "$PHOTON_DUMP_URL")

echo "photon-fetch: fetching $PHOTON_DUMP_URL"

# --time-cond lets re-runs skip the download when upstream hasn't changed.
if [ -f "$filename" ]; then
    curl --fail --location --output "$filename" \
         --time-cond "$filename" "$PHOTON_DUMP_URL" \
        || { echo "photon-fetch: failed to fetch $PHOTON_DUMP_URL" >&2; exit 1; }
else
    curl --fail --location --output "$filename" "$PHOTON_DUMP_URL" \
        || { echo "photon-fetch: failed to fetch $PHOTON_DUMP_URL" >&2; exit 1; }
fi

# Upstream Photon publishes a .md5 sidecar next to each archive.
# Format: "<hex-md5>  <filename>" (two-space separator, standard md5sum output).
# MD5 is fine here — this is integrity of a public download, not a security boundary.
if curl --fail --silent --location --output "${filename}.md5" "${PHOTON_DUMP_URL}.md5"; then
    expected=$(awk '{print $1}' "${filename}.md5")
    actual=$(md5sum "$filename" | awk '{print $1}')
    if [ "$expected" != "$actual" ]; then
        echo "photon-fetch: MD5 mismatch for $filename" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
    echo "photon-fetch: $filename verified against upstream MD5"
else
    rm -f "${filename}.md5"
    echo "photon-fetch: no upstream MD5 sidecar for $filename (continuing)"
fi

echo "photon-fetch: done. Downloaded:"
ls -lh /work/download
