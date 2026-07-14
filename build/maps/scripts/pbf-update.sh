#!/bin/sh
# Runs inside the pbf-update container (see docker-compose.build.yml).
# Downloads each PBF listed in $PBF_SOURCES if we don't already have it locally,
# then runs pyosmium-up-to-date to catch it up to current OSM.
#
# Inputs:
#   PBF_SOURCES  — newline-separated list of Geofabrik PBF URLs.
#
# Outputs (in /pbf, which is bind-mounted from work/<region>/pbf/):
#   <basename>.osm.pbf   for each source URL, kept up to date.

set -eu

if [ -z "${PBF_SOURCES:-}" ]; then
    echo "pbf-update: PBF_SOURCES env var is empty" >&2
    exit 2
fi

cd /pbf

# PBF_SOURCES is newline-separated. Each line is a full URL.
printf '%s\n' "$PBF_SOURCES" | while IFS= read -r url; do
    [ -z "$url" ] && continue
    filename=$(basename "$url")
    if [ -f "$filename" ]; then
        echo "pbf-update: updating existing $filename via pyosmium-up-to-date"
        # pyosmium-up-to-date consumes and rewrites the file in place.
        # If the file is already current, it exits 3 (documented in pyosmium docs);
        # treat that as success.
        pyosmium-up-to-date "$filename" || rc=$?
        rc=${rc:-0}
        if [ "$rc" -eq 3 ]; then
            echo "pbf-update: $filename already up to date"
        elif [ "$rc" -ne 0 ]; then
            echo "pbf-update: pyosmium-up-to-date exited $rc for $filename" >&2
            exit "$rc"
        fi
    else
        echo "pbf-update: downloading initial extract for $filename"
        curl --fail --location --output "$filename" "$url"
    fi
    unset rc
done

echo "pbf-update: done. Contents of /pbf:"
ls -lh /pbf
