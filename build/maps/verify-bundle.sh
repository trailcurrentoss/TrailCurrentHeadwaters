#!/usr/bin/env bash
# Verify a map bundle produced by build.sh.
#
# Extracts the zip to a scratch directory, checks that the four expected
# artifacts are present, validates manifest.json against the schema, and
# re-hashes every artifact to confirm the SHA-256 declared in manifest.json
# matches actual content.
#
# Usage:
#   verify-bundle.sh <path/to/maps-YYYY.MM.DD.zip>
#   verify-bundle.sh                          # verify the newest zip in dist/
#
# Exits 0 on pass, non-zero on any failure with a clear message.
# Cleans up its scratch directory on both success and failure.
#
# Cross-platform: Linux, macOS (bash 3), Windows via WSL2.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIST_DIR="${SCRIPT_DIR}/dist"
SCHEMA_FILE="${SCRIPT_DIR}/manifest.schema.json"

log()  { printf '[verify] %s\n' "$*"; }
fail() { printf '[verify] FAIL: %s\n' "$*" >&2; exit 1; }

# Pick a sha256 tool portably.
if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    fail "need sha256sum or shasum on PATH"
fi

# Resolve the target bundle.
if [ $# -eq 0 ]; then
    BUNDLE=$(ls -t "${DIST_DIR}"/maps-*.zip 2>/dev/null | head -n1 || true)
    if [ -z "$BUNDLE" ]; then
        printf '\n[verify] FAIL: no bundle to verify.\n' >&2
        printf '  No path was passed on the command line, and no maps-*.zip files exist in:\n' >&2
        printf '    %s\n' "$DIST_DIR" >&2
        printf '\n  If you have not built a bundle yet:\n' >&2
        printf '    ./build.sh --region california      # smoke-test build (fast)\n' >&2
        printf '    ./build.sh --region north-america   # default full build\n' >&2
        printf '  Then re-run this script.\n' >&2
        printf '\n  Or verify a bundle already on disk elsewhere by passing its path:\n' >&2
        printf '    ./verify-bundle.sh /path/to/maps-YYYY.MM.DD.zip\n' >&2
        exit 1
    fi
    log "using newest bundle: $BUNDLE"
elif [ $# -eq 1 ]; then
    BUNDLE="$1"
else
    fail "usage: verify-bundle.sh [<bundle.zip>]"
fi

if [ ! -f "$BUNDLE" ]; then
    printf '\n[verify] FAIL: bundle file does not exist at the given path.\n' >&2
    printf '  Requested: %s\n' "$BUNDLE" >&2
    printf '\n  Bundles currently in %s:\n' "$DIST_DIR" >&2
    if ls -1 "$DIST_DIR"/maps-*.zip >/dev/null 2>&1; then
        ls -1t "$DIST_DIR"/maps-*.zip | sed 's/^/    /' >&2
    else
        printf '    (none)\n' >&2
    fi
    printf '\n  Run with no arguments to verify the newest bundle in dist/ automatically.\n' >&2
    exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
    printf '\n[verify] FAIL: unzip not on PATH.\n' >&2
    printf '  Install it via ./bootstrap.sh (recommended — handles apt/dnf/brew automatically),\n' >&2
    printf '  or directly:\n' >&2
    printf '    Ubuntu/Debian:  sudo apt-get install -y unzip\n' >&2
    printf '    Fedora:         sudo dnf install -y unzip\n' >&2
    printf '    macOS:          brew install unzip\n' >&2
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    printf '\n[verify] FAIL: python3 not on PATH.\n' >&2
    printf '  Install it via ./bootstrap.sh (recommended), or directly per your platform.\n' >&2
    exit 1
fi

# Extract to a fresh scratch dir, cleaned up on exit.
SCRATCH=$(mktemp -d -t tc-verify-XXXXXX)
trap 'rm -rf "$SCRATCH"' EXIT INT TERM
log "extracting to $SCRATCH"
unzip -q -d "$SCRATCH" "$BUNDLE"

# === Check 1: exact file set ===
expected="manifest.json photon_data.tar tiles.pmtiles valhalla_tiles.tar"
actual=$(cd "$SCRATCH" && ls | sort | tr '\n' ' ' | sed 's/ $//')
expected_sorted=$(printf '%s\n' $expected | sort | tr '\n' ' ' | sed 's/ $//')
if [ "$actual" != "$expected_sorted" ]; then
    printf '\n[verify] FAIL: bundle contents do not match the expected file set.\n' >&2
    printf '  Expected exactly: %s\n' "$expected_sorted" >&2
    printf '  Actually got:     %s\n' "$actual" >&2
    printf '\n  This usually means:\n' >&2
    printf '    1. The zip was not produced by build.sh (a hand-assembled bundle would\n' >&2
    printf '       often have extra files or miss one).\n' >&2
    printf '    2. The zip was truncated during download or upload.\n' >&2
    printf '    3. build.sh Stage 5 (Package) was interrupted; re-run build.sh with\n' >&2
    printf '       --force on the missing artifact stage.\n' >&2
    exit 1
fi
log "OK  bundle contains exactly: $expected_sorted"

# === Check 2: manifest.json validates against schema ===
if [ -f "$SCHEMA_FILE" ] && python3 -c 'import jsonschema' 2>/dev/null; then
    python3 - "$SCHEMA_FILE" "$SCRATCH/manifest.json" <<'PY'
import json, sys, jsonschema
schema = json.load(open(sys.argv[1]))
manifest = json.load(open(sys.argv[2]))
jsonschema.validate(manifest, schema)
PY
    log "OK  manifest.json validates against schema"
else
    log "SKIP schema validation (schema missing or jsonschema not installed)"
fi

# === Check 3: per-artifact SHA-256 matches manifest ===
cd "$SCRATCH"
python3 -c "import json; m = json.load(open('manifest.json')); [print(k, v['sha256'], v['bytes']) for k, v in m['artifacts'].items()]" \
    > "$SCRATCH/_expected.txt"

any_fail=0
while read -r name expected_sha expected_bytes; do
    [ -z "$name" ] && continue
    if [ ! -f "$name" ]; then
        printf '[verify] FAIL: manifest.json declares "%s" but the file is not in the bundle.\n' "$name" >&2
        printf '  This is a corrupted or hand-edited bundle. Re-run build.sh for this region\n' >&2
        printf '  to regenerate a clean bundle.\n' >&2
        any_fail=1
        continue
    fi
    actual_sha=$(sha256_of "$name")
    actual_bytes=$(python3 -c "import os,sys; print(os.path.getsize(sys.argv[1]))" "$name")
    if [ "$actual_sha" != "$expected_sha" ]; then
        printf '[verify] FAIL: %s SHA-256 does not match manifest.json\n' "$name" >&2
        printf '     expected: %s\n' "$expected_sha" >&2
        printf '     actual:   %s\n' "$actual_sha" >&2
        printf '     Bundle is corrupted (most likely truncated during download or upload).\n' >&2
        printf '     Re-download the zip or re-run build.sh --region <name> to regenerate.\n' >&2
        any_fail=1
    elif [ "$actual_bytes" != "$expected_bytes" ]; then
        printf '[verify] FAIL: %s size does not match manifest.json (expected %s bytes, got %s)\n' "$name" "$expected_bytes" "$actual_bytes" >&2
        printf '     Bundle is corrupted. Re-download or regenerate.\n' >&2
        any_fail=1
    else
        log "OK  $name  ($actual_bytes bytes, sha256 verified)"
    fi
done < "$SCRATCH/_expected.txt"

[ "$any_fail" -eq 0 ] || fail "one or more artifact checks failed"

# === Summary ===
region=$(python3 -c "import json; print(json.load(open('manifest.json'))['region'])")
display=$(python3 -c "import json; print(json.load(open('manifest.json'))['region_display_name'])")
build_date=$(python3 -c "import json; print(json.load(open('manifest.json'))['build_date'])")
pbf_date=$(python3 -c "import json; print(json.load(open('manifest.json'))['pbf_date'])")

log ""
log "==> $BUNDLE"
log "    region:       $region  ($display)"
log "    build_date:   $build_date"
log "    pbf_date:     $pbf_date"
log "==> PASS"
