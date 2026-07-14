#!/usr/bin/env bash
# TrailCurrent Headwaters — offline maps build pipeline.
#
# Orchestrates: PBF update (pyosmium) → PMTiles (Planetiler) → Photon dump
# (download + extract) → Valhalla routing tiles → bundle into maps-<date>.zip.
#
# Region-agnostic outputs by design:
#   dist/maps-<date>.zip              (no region string in filename)
#   inside the zip:
#     manifest.json                   (region name lives here, not in a path)
#     tiles.pmtiles
#     photon_data.tar
#     valhalla_tiles.tar
#
# Usage:
#   ./build.sh --region <name>        run a full build
#   ./build.sh --list-regions         show available regions
#   ./build.sh --region <name> --update-pbf-only    refresh PBF, then stop
#   ./build.sh --region <name> --dry-run            print what would run, no exec
#   ./build.sh --help
#
# Cross-platform: Linux + macOS + WSL. Requires bash 3+, docker, docker compose,
# python3 with PyYAML, curl, tar, zip, and one of sha256sum / shasum.
# Every invocation runs preflight first — you get a clear "install X to fix"
# message and non-zero exit if anything's missing. Run ./bootstrap.sh on a
# fresh machine to install the small deps automatically.

set -euo pipefail

# -----------------------------------------------------------------------------
# Paths & constants
# -----------------------------------------------------------------------------
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REGIONS_DIR="${SCRIPT_DIR}/regions"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.build.yml"
WORK_ROOT="${SCRIPT_DIR}/work"
DIST_DIR="${SCRIPT_DIR}/dist"
SCHEMA_VERSION=1

# Photon search index — ALWAYS use the global Photon 1.0 dump.
# Rationale: Photon publishes ~250 country-scoped archives plus a handful of
# global archives (per Photon version). Combining per-country archives into a
# single photon_data/ is fragile (overlapping index shards). Choosing a single
# country scope per region introduces variation and edge cases (what about
# state-only bundles? what about multi-country regions?). Using the global
# archive for every bundle is one URL, one file, zero decisions. The ~57 GB
# storage cost is insignificant against the 512 GB / 1 TB recommended drive.
#
# Version pin: we track Photon 1.0 (current stable as of 2026-07). The dump
# format is Photon-version-specific; upgrading Photon means updating this URL
# to match (e.g. photon-db-planet-1.1-latest.tar.bz2 when 1.1 ships).
# Override via env var only if you need a different Photon version.
: "${PHOTON_DUMP_URL:=https://download1.graphhopper.com/public/photon-db-planet-1.0-latest.tar.bz2}"

# -----------------------------------------------------------------------------
# Small helpers
# -----------------------------------------------------------------------------
log()   { printf '[build.sh] %s\n' "$*" >&2; }
die()   { printf '[build.sh] ERROR: %s\n' "$*" >&2; exit 1; }

# Pick a sha256 implementation portably.
if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    die "need sha256sum or shasum on PATH"
fi

# -----------------------------------------------------------------------------
# CLI parsing
# -----------------------------------------------------------------------------
usage() {
    cat <<'EOF'
Usage:
  build.sh --region <name>              full build for a region (idempotent —
                                        skips stages whose output already exists)
  build.sh --list-regions               list built-in region YAMLs
  build.sh --region <name> --update-pbf-only
                                        refresh the local PBF extract only
  build.sh --region <name> --force      re-run every stage even if output exists
  build.sh --region <name> --dry-run    print what would run, exec nothing
  build.sh --region <name> --skip-preflight
                                        skip environment checks (power users)
  build.sh --help                       show this message

Every invocation runs environment checks (preflight) before doing any work.
If anything's missing, build.sh prints a clear fix and exits 0 changes made.
Run ./bootstrap.sh first if you're on a fresh machine.

The output bundle is always dist/maps-<date>.zip — the region name lives inside
manifest.json, never in a filesystem path. See build/maps/README.md for
the reasoning.
EOF
}

REGION=""
LIST_REGIONS=0
DRY_RUN=0
UPDATE_PBF_ONLY=0
FORCE=0
SKIP_PREFLIGHT=0

while [ $# -gt 0 ]; do
    case "$1" in
        --region)
            [ $# -ge 2 ] || die "--region requires a value"
            REGION="$2"
            shift 2
            ;;
        --list-regions)
            LIST_REGIONS=1
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --update-pbf-only)
            UPDATE_PBF_ONLY=1
            shift
            ;;
        --force)
            FORCE=1
            shift
            ;;
        --skip-preflight)
            SKIP_PREFLIGHT=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown argument: $1 (try --help)"
            ;;
    esac
done

if [ "$LIST_REGIONS" -eq 1 ]; then
    for yaml in "${REGIONS_DIR}"/*.yaml; do
        [ -f "$yaml" ] || continue
        name=$(basename "$yaml" .yaml)
        printf '  %s\n' "$name"
    done
    exit 0
fi

[ -n "$REGION" ] || { usage; die "must supply --region (see --list-regions)"; }

REGION_YAML="${REGIONS_DIR}/${REGION}.yaml"
if [ ! -f "$REGION_YAML" ]; then
    printf '\n[build.sh] ERROR: unknown region "%s".\n' "$REGION" >&2
    printf '  Looked for: %s\n' "$REGION_YAML" >&2
    printf '\n  Regions currently defined:\n' >&2
    for y in "${REGIONS_DIR}"/*.yaml; do
        [ -f "$y" ] || continue
        printf '    %s\n' "$(basename "$y" .yaml)" >&2
    done
    printf '\n  To add "%s" as a new region, copy an existing YAML and edit it:\n' "$REGION" >&2
    printf '    cp regions/japan.yaml regions/%s.yaml\n' "$REGION" >&2
    printf '    $EDITOR regions/%s.yaml\n' "$REGION" >&2
    printf '  See build/maps/README.md section "Add a new region" for details.\n' >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# Preflight — verify the environment can actually run a build.
#   - Fast (a few seconds).
#   - Read-only; no state mutation.
#   - Idempotent; safe to re-run.
#   - Fails with actionable per-platform install advice, not just "MISSING".
# -----------------------------------------------------------------------------
preflight() {
    plat="unknown"
    if [ "$(uname -s)" = "Darwin" ]; then plat="macos"
    elif [ "$(uname -s)" = "Linux" ]; then plat="linux"
    fi
    fix() {
        # $1 = short name; rest = per-platform hint prefixed with "linux:" / "macos:".
        name="$1"; shift
        printf '\n  %s missing.\n' "$name" >&2
        for hint in "$@"; do
            key="${hint%%:*}"; val="${hint#*:}"
            if [ "$key" = "$plat" ] || [ "$key" = "any" ]; then
                printf '    %s\n' "$val" >&2
            fi
        done
        printf '\n  Or run: ./bootstrap.sh\n' >&2
        exit 1
    }

    # Commands
    for cmd in python3 curl tar zip unzip awk sed; do
        command -v "$cmd" >/dev/null 2>&1 || fix "$cmd" \
            "linux: apt:  sudo apt-get install -y $cmd" \
            "linux: dnf:  sudo dnf install -y $cmd" \
            "macos: brew: brew install $cmd"
    done

    # sha256 tool
    command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
        || fix "sha256sum / shasum" \
            "linux: apt:  sudo apt-get install -y coreutils" \
            "macos: shasum ships with macOS — check your PATH"

    # Docker
    command -v docker >/dev/null 2>&1 || fix "docker" \
        "linux: Install Docker Engine: https://docs.docker.com/engine/install/" \
        "linux: Then: sudo usermod -aG docker \$USER && log out/in" \
        "macos: Install Docker Desktop: https://www.docker.com/products/docker-desktop/"

    docker info >/dev/null 2>&1 || fix "docker daemon (installed but not reachable)" \
        "linux: sudo systemctl start docker" \
        "macos: Launch Docker Desktop and wait for the whale icon"

    # docker compose
    if docker compose version >/dev/null 2>&1; then
        COMPOSE="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE="docker-compose"
    else
        fix "docker compose" \
            "linux: apt:  sudo apt-get install -y docker-compose-plugin" \
            "linux: dnf:  sudo dnf install -y docker-compose-plugin" \
            "macos: comes bundled with Docker Desktop — reinstall if missing"
    fi

    # PyYAML
    python3 -c 'import yaml' 2>/dev/null || fix "python3 PyYAML module" \
        "linux: apt:  sudo apt-get install -y python3-yaml" \
        "linux: dnf:  sudo dnf install -y python3-pyyaml" \
        "macos: pip:  pip3 install --user pyyaml"

    log "preflight: OK (platform=$plat, compose='$COMPOSE')"
}

if [ "$SKIP_PREFLIGHT" -eq 1 ]; then
    log "preflight: SKIPPED (--skip-preflight)"
    # Still need COMPOSE defined; assume v2.
    docker compose version >/dev/null 2>&1 && COMPOSE="docker compose" || COMPOSE="docker-compose"
else
    preflight
fi

# -----------------------------------------------------------------------------
# Region YAML → env vars
# -----------------------------------------------------------------------------
# Parse the region YAML into shell variables. Python emits KEY=VALUE lines that
# we source. Values are shell-quoted so URLs with special chars survive.
eval "$(python3 - "$REGION_YAML" <<'PY'
import sys, shlex, yaml
with open(sys.argv[1]) as f:
    r = yaml.safe_load(f)

def emit(k, v):
    print(f"REGION_{k}={shlex.quote(str(v))}")

emit("REGION_NAME",       r["region"])
emit("DISPLAY_NAME",      r["display_name"])
emit("DESCRIPTION",       r.get("description", "").strip())
# Newline-separated PBF URLs for docker env compatibility.
emit("PBF_SOURCES",       "\n".join(r["pbf_sources"]))
bb = r["bbox"]
emit("BBOX_WEST",   bb["west"])
emit("BBOX_SOUTH",  bb["south"])
emit("BBOX_EAST",   bb["east"])
emit("BBOX_NORTH",  bb["north"])
PY
)"

# Confirm the region field inside the YAML matches its filename — catches
# copy-paste errors when authoring a new region.
if [ "$REGION_REGION_NAME" != "$REGION" ]; then
    printf '\n[build.sh] ERROR: region YAML "region:" field does not match its filename.\n' >&2
    printf '  File:          %s\n' "$REGION_YAML" >&2
    printf '  Filename says: %s\n' "$REGION" >&2
    printf '  YAML says:     %s\n' "$REGION_REGION_NAME" >&2
    printf '\n  Fix: edit %s and set the "region:" field to "%s", so it matches the filename.\n' "$REGION_YAML" "$REGION" >&2
    printf '  (Or rename the YAML to %s.yaml if the intent was actually "%s".)\n' "$REGION_REGION_NAME" "$REGION_REGION_NAME" >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# Layout
# -----------------------------------------------------------------------------
WORK_DIR="${WORK_ROOT}/${REGION}"
PBF_DIR="${WORK_DIR}/pbf"
PMTILES_DIR="${WORK_DIR}/pmtiles"
PHOTON_DIR="${WORK_DIR}/photon"
VALHALLA_DIR="${WORK_DIR}/valhalla"
STAGE_DIR="${WORK_DIR}/stage"

mkdir -p "$PBF_DIR" "$PMTILES_DIR" "$PHOTON_DIR" "$VALHALLA_DIR" "$STAGE_DIR" "$DIST_DIR"

# Env exported for docker-compose.build.yml.
export REGION
export PBF_SOURCES="$REGION_PBF_SOURCES"
export PHOTON_DUMP_URL

# -----------------------------------------------------------------------------
# Dry-run banner
# -----------------------------------------------------------------------------
BUILD_DATE_UTC=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
BUILD_DATE_YMD=$(date -u '+%Y.%m.%d')

log "region:        $REGION ($REGION_DISPLAY_NAME)"
log "work dir:      $WORK_DIR"
log "output dir:    $DIST_DIR"
log "date stamp:    $BUILD_DATE_YMD (UTC)"
log "pbf sources:"
printf '%s\n' "$REGION_PBF_SOURCES" | sed 's/^/  - /' >&2
log "photon dump:   $PHOTON_DUMP_URL (global — search covers everywhere on Earth)"

run() {
    log "> $*"
    [ "$DRY_RUN" -eq 1 ] && return 0
    "$@"
}

# Stage-skip helper. Returns 0 (skip) if an output already exists AND --force
# was not passed. Callers wrap each stage's body in `if ! stage_should_skip ...`.
stage_should_skip() {
    stage_name="$1"
    sentinel="$2"
    if [ "$FORCE" -eq 1 ]; then
        return 1
    fi
    if [ -e "$sentinel" ]; then
        log "Stage $stage_name: output already present at $sentinel — skipping (use --force to rebuild)"
        return 0
    fi
    return 1
}

# -----------------------------------------------------------------------------
# Stage 1: PBF update
# -----------------------------------------------------------------------------
# pbf-update.sh is intrinsically idempotent (pyosmium-up-to-date is a no-op
# when the PBF is current; --time-cond skips the initial download). Always run.
log "=== Stage 1/5: PBF update ==="
run $COMPOSE -f "$COMPOSE_FILE" run --rm pbf-update

if [ "$UPDATE_PBF_ONLY" -eq 1 ]; then
    log "--update-pbf-only requested — stopping after PBF stage."
    exit 0
fi

# Verify PBFs actually landed (dry-run skips this).
if [ "$DRY_RUN" -eq 0 ]; then
    pbf_count=$(find "$PBF_DIR" -maxdepth 1 -name '*.osm.pbf' | wc -l)
    if [ "$pbf_count" -eq 0 ]; then
        printf '\n[build.sh] ERROR: Stage 1 (PBF update) completed but produced no *.osm.pbf files.\n' >&2
        printf '  Expected files in: %s\n' "$PBF_DIR" >&2
        printf '\n  Most common causes:\n' >&2
        printf '    1. Network failure downloading from download.geofabrik.de\n' >&2
        printf '    2. Geofabrik moved / renamed the URL in regions/%s.yaml\n' "$REGION" >&2
        printf '    3. Insufficient disk space in %s\n' "$PBF_DIR" >&2
        printf '\n  To diagnose:\n' >&2
        printf '    docker logs "$(docker ps -aq --filter name=maps-pbf-update-run --latest)" 2>&1 | tail -50\n' >&2
        printf '    df -h %s\n' "$PBF_DIR" >&2
        printf '    curl -I <the pbf_sources URL from regions/%s.yaml>\n' "$REGION" >&2
        exit 1
    fi
fi

# Latest PBF mtime — used as the source-date in the manifest.
if [ "$DRY_RUN" -eq 0 ]; then
    PBF_DATE=$(python3 -c '
import os, sys, datetime, glob
pbfs = glob.glob(sys.argv[1] + "/*.osm.pbf")
newest = max(os.path.getmtime(p) for p in pbfs)
print(datetime.datetime.fromtimestamp(newest, datetime.timezone.utc).strftime("%Y-%m-%d"))
' "$PBF_DIR")
else
    PBF_DATE="0000-00-00"
fi

# -----------------------------------------------------------------------------
# Stage 2: Planetiler → PMTiles
# -----------------------------------------------------------------------------
log "=== Stage 2/5: Planetiler → tiles.pmtiles ==="

# Planetiler openmaptiles profile reads a single PBF, so if the region declares
# multiple PBFs we merge them first with osmium (in the pbf-update container).
merged_pbf="${PBF_DIR}/_merged.osm.pbf"

if [ "$DRY_RUN" -eq 0 ]; then
    # Use find (safe against no-matches under `set -e -o pipefail`).
    pbf_files=$(find "$PBF_DIR" -maxdepth 1 -name '*.osm.pbf' \
                    -not -name '_merged.osm.pbf' -exec basename {} \; \
                | tr '\n' ' ')
    count=$(printf '%s\n' $pbf_files | wc -w | tr -d ' ')
    if [ "$count" -eq 1 ]; then
        # shellcheck disable=SC2086
        cp -f "${PBF_DIR}/"$pbf_files "$merged_pbf"
    else
        log "merging $count PBFs into _merged.osm.pbf via osmium"
        # shellcheck disable=SC2086
        run $COMPOSE -f "$COMPOSE_FILE" run --rm --entrypoint sh pbf-update \
            -c "cd /pbf && osmium merge $pbf_files -o _merged.osm.pbf --overwrite"
    fi
fi

# Now run Planetiler against the merged PBF (skip if tiles.pmtiles exists).
if ! stage_should_skip "2 (Planetiler)" "${PMTILES_DIR}/tiles.pmtiles"; then
    run $COMPOSE -f "$COMPOSE_FILE" run --rm planetiler \
        --download --area=planet --osm-path=/data/pbf/_merged.osm.pbf \
        --output=/data/pmtiles/tiles.pmtiles \
        --bounds="${REGION_BBOX_WEST},${REGION_BBOX_SOUTH},${REGION_BBOX_EAST},${REGION_BBOX_NORTH}" \
        --force

    if [ "$DRY_RUN" -eq 0 ]; then
        if [ ! -f "${PMTILES_DIR}/tiles.pmtiles" ]; then
            printf '\n[build.sh] ERROR: Stage 2 (Planetiler) did not produce tiles.pmtiles.\n' >&2
            printf '  Expected: %s\n' "${PMTILES_DIR}/tiles.pmtiles" >&2
            printf '\n  Most common causes:\n' >&2
            printf '    1. Planetiler CLI arguments changed in a new image version — see\n' >&2
            printf '       "Known risk hotspots" in PLANS/Validation-Steps.md.\n' >&2
            printf '    2. Ran out of RAM. Planetiler needs ~16 GB; check mem_limit in\n' >&2
            printf '       docker-compose.build.yml (currently 24g) vs. what your host allows.\n' >&2
            printf '    3. Bounds outside PBF data (misconfigured bbox in regions/%s.yaml).\n' "$REGION" >&2
            printf '\n  To see what Planetiler actually did or complained about:\n' >&2
            printf '    docker logs "$(docker ps -aq --filter name=tc-maps-planetiler --latest)" 2>&1 | tail -100\n' >&2
            exit 1
        fi
    fi
fi

# -----------------------------------------------------------------------------
# Stage 3: Photon dump download + extract
# -----------------------------------------------------------------------------
log "=== Stage 3/5: Photon dump ==="

if ! stage_should_skip "3 (Photon)" "${PHOTON_DIR}/extracted/photon_data"; then
    run $COMPOSE -f "$COMPOSE_FILE" run --rm photon-fetch

    if [ "$DRY_RUN" -eq 0 ]; then
        archive=$(find "${PHOTON_DIR}/download" -maxdepth 1 -name '*.tar.bz2' | head -n1)
        if [ -z "$archive" ]; then
            printf '\n[build.sh] ERROR: Stage 3 (Photon fetch) produced no *.tar.bz2 in %s.\n' "${PHOTON_DIR}/download" >&2
            printf '\n  The Photon dump download comes from photon.komoot.io. Most common causes:\n' >&2
            printf '    1. Network / DNS failure reaching photon.komoot.io.\n' >&2
            printf '    2. Upstream moved or renamed the file (URL is hardcoded in build.sh — grep\n' >&2
            printf '       for PHOTON_DUMP_URL).\n' >&2
            printf '    3. Insufficient disk space (dump is ~57 GB compressed).\n' >&2
            printf '\n  To diagnose:\n' >&2
            printf '    docker logs "$(docker ps -aq --filter name=tc-maps-photon-fetch --latest)" 2>&1 | tail -50\n' >&2
            printf '    curl -I "$PHOTON_DUMP_URL"\n' >&2
            printf '    df -h %s\n' "$PHOTON_DIR" >&2
            exit 1
        fi

        log "extracting Photon dump into ${PHOTON_DIR}/extracted/"
        rm -rf "${PHOTON_DIR}/extracted"
        mkdir -p "${PHOTON_DIR}/extracted"
        tar -xjf "$archive" -C "${PHOTON_DIR}/extracted"

        # Photon archives contain a top-level photon_data/ directory. Sanity check.
        if [ ! -d "${PHOTON_DIR}/extracted/photon_data" ]; then
            printf '\n[build.sh] ERROR: Photon archive extracted, but no top-level photon_data/ directory found.\n' >&2
            printf '  This means the archive layout at photon.komoot.io changed since this script was written.\n' >&2
            printf '\n  What is actually inside %s:\n' "${PHOTON_DIR}/extracted" >&2
            ls -la "${PHOTON_DIR}/extracted" >&2
            printf '\n  Fix: identify the top-level directory in the extracted archive and update the\n' >&2
            printf '  tar-source path in build.sh Stage 3 (search for "photon_data" — should be one place).\n' >&2
            printf '  Report the change upstream too so this script can be updated.\n' >&2
            exit 1
        fi
    fi
fi

# -----------------------------------------------------------------------------
# Stage 4: Valhalla tiles
# -----------------------------------------------------------------------------
# gis-ops/docker-valhalla builds tiles AND THEN starts an HTTP server that
# never exits on its own. We run detached, poll for the completion sentinel
# (valhalla_tiles.tar), then stop the container. Robust regardless of what
# env vars the image supports for "build only" mode.
log "=== Stage 4/5: Valhalla tile build ==="

if ! stage_should_skip "4 (Valhalla)" "${VALHALLA_DIR}/valhalla_tiles.tar"; then
    if [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "${VALHALLA_DIR}"
        cp -f "$merged_pbf" "${VALHALLA_DIR}/source.osm.pbf"

        container_name="tc-maps-valhalla-builder-${REGION}"
        # Clean up any leftover container from a previous interrupted run.
        docker rm -f "$container_name" >/dev/null 2>&1 || true

        log "starting Valhalla builder detached (will stop when valhalla_tiles.tar appears)"
        # shellcheck disable=SC2086
        $COMPOSE -f "$COMPOSE_FILE" run -d --name "$container_name" valhalla-builder

        # Ensure the container is cleaned up even on Ctrl+C.
        # shellcheck disable=SC2064
        trap "docker rm -f $container_name >/dev/null 2>&1 || true" EXIT INT TERM

        log "polling for ${VALHALLA_DIR}/valhalla_tiles.tar (build progress in docker logs)"
        # 6 hours: enough for continent-scale regions (NA, Europe). California
        # finishes in ~20 min, Japan/Australia in ~30-45 min, NA in ~2-3 hr on
        # typical build hardware. Override via TC_VALHALLA_TIMEOUT_SECONDS env
        # var if you're on very slow hardware or building the planet.
        timeout_seconds="${TC_VALHALLA_TIMEOUT_SECONDS:-21600}"
        elapsed=0
        interval=30
        prev_size=-1
        stable_polls=0
        while [ "$elapsed" -lt "$timeout_seconds" ]; do
            if [ -f "${VALHALLA_DIR}/valhalla_tiles.tar" ]; then
                cur_size=$(stat -c '%s' "${VALHALLA_DIR}/valhalla_tiles.tar" 2>/dev/null \
                        || stat -f '%z' "${VALHALLA_DIR}/valhalla_tiles.tar")
                if [ "$cur_size" = "$prev_size" ] && [ "$cur_size" -gt 0 ]; then
                    stable_polls=$((stable_polls + 1))
                    # Two consecutive stable polls (60s of no size change) = done.
                    if [ "$stable_polls" -ge 2 ]; then
                        log "valhalla_tiles.tar stable at $cur_size bytes — build complete"
                        break
                    fi
                else
                    stable_polls=0
                    log "  valhalla_tiles.tar growing: $cur_size bytes"
                fi
                prev_size=$cur_size
            fi
            # If the container died on its own (crash or completion), break.
            if ! docker inspect -f '{{.State.Running}}' "$container_name" 2>/dev/null | grep -q true; then
                log "Valhalla container is no longer running — proceeding to check output"
                break
            fi
            sleep "$interval"
            elapsed=$((elapsed + interval))
        done

        log "stopping Valhalla container"
        docker rm -f "$container_name" >/dev/null 2>&1 || true
        trap - EXIT INT TERM

        # Verify tiles were actually produced. If not, give a self-sufficient
        # error that names the most likely cause (timeout) and exact fix commands.
        if [ ! -d "${VALHALLA_DIR}/valhalla_tiles" ] || [ ! -f "${VALHALLA_DIR}/valhalla_tiles.tar" ]; then
            tar_size=0
            [ -f "${VALHALLA_DIR}/valhalla_tiles.tar" ] && tar_size=$(stat -c '%s' "${VALHALLA_DIR}/valhalla_tiles.tar" 2>/dev/null || stat -f '%z' "${VALHALLA_DIR}/valhalla_tiles.tar")
            printf '\n[build.sh] ERROR: Valhalla stage did not complete.\n' >&2
            printf '  Expected: %s and %s\n' "${VALHALLA_DIR}/valhalla_tiles/" "${VALHALLA_DIR}/valhalla_tiles.tar" >&2
            printf '  Got:      valhalla_tiles.tar size = %s bytes (0 = never created)\n' "$tar_size" >&2
            printf '  Ran for:  %s of %s seconds allowed\n' "$elapsed" "$timeout_seconds" >&2
            printf '\n  Most common cause: the region is too large for the timeout window.\n' >&2
            printf '  Current timeout:  %s seconds (raise via TC_VALHALLA_TIMEOUT_SECONDS env var).\n' "$timeout_seconds" >&2
            printf '  For continent-scale regions (NA, Europe), 21600 (6 h) is safe.\n' >&2
            printf '\n  To see what the builder was doing when it was killed, inspect the container logs\n' >&2
            printf '  BEFORE re-running (the container is removed on the next build.sh invocation):\n' >&2
            printf '    docker logs "tc-maps-valhalla-builder-%s" 2>&1 | tail -100\n' "$REGION" >&2
            printf '\n  To re-run with a longer timeout (example: 8 hours):\n' >&2
            printf '    TC_VALHALLA_TIMEOUT_SECONDS=28800 ./build.sh --region %s\n' "$REGION" >&2
            printf '\n  Partial state in %s will be picked up on re-run (see gis-ops/docker-valhalla docs).\n' "$VALHALLA_DIR" >&2
            exit 1
        fi
    else
        # Dry-run: just show what would happen.
        log "> $COMPOSE -f $COMPOSE_FILE run -d --name tc-maps-valhalla-builder-${REGION} valhalla-builder"
        log "> (poll for ${VALHALLA_DIR}/valhalla_tiles.tar to stabilize)"
        log "> docker rm -f tc-maps-valhalla-builder-${REGION}"
    fi
fi

# -----------------------------------------------------------------------------
# Stage 5: Package
# -----------------------------------------------------------------------------
log "=== Stage 5/5: Package bundle ==="

if [ "$DRY_RUN" -eq 1 ]; then
    log "(dry-run: skipping tar / hash / zip / manifest)"
    exit 0
fi

# Fresh stage dir.
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

log "staging tiles.pmtiles"
cp "${PMTILES_DIR}/tiles.pmtiles" "${STAGE_DIR}/tiles.pmtiles"

log "tarring photon_data → photon_data.tar (this can take a while)"
tar -C "${PHOTON_DIR}/extracted" -cf "${STAGE_DIR}/photon_data.tar" photon_data

log "tarring valhalla_tiles → valhalla_tiles.tar"
tar -C "${VALHALLA_DIR}" -cf "${STAGE_DIR}/valhalla_tiles.tar" valhalla_tiles

# Sizes + hashes.
size_of()  { python3 -c 'import os,sys; print(os.path.getsize(sys.argv[1]))' "$1"; }
sha_tiles=$(sha256_of "${STAGE_DIR}/tiles.pmtiles")
sha_photon=$(sha256_of "${STAGE_DIR}/photon_data.tar")
sha_valhalla=$(sha256_of "${STAGE_DIR}/valhalla_tiles.tar")
sz_tiles=$(size_of "${STAGE_DIR}/tiles.pmtiles")
sz_photon=$(size_of "${STAGE_DIR}/photon_data.tar")
sz_valhalla=$(size_of "${STAGE_DIR}/valhalla_tiles.tar")

log "writing manifest.json"
python3 - "$STAGE_DIR/manifest.json" <<PY
import json, sys
manifest = {
  "schema_version": ${SCHEMA_VERSION},
  "region": "${REGION}",
  "region_display_name": "${REGION_DISPLAY_NAME}",
  "build_date": "${BUILD_DATE_UTC}",
  "pbf_date": "${PBF_DATE}",
  "artifacts": {
    "tiles.pmtiles":       {"sha256": "${sha_tiles}",    "bytes": ${sz_tiles}},
    "photon_data.tar":     {"sha256": "${sha_photon}",   "bytes": ${sz_photon}},
    "valhalla_tiles.tar":  {"sha256": "${sha_valhalla}", "bytes": ${sz_valhalla}}
  },
  "odbl_notice": "Map data © OpenStreetMap contributors, distributed under the Open Database License (ODbL) v1.0 (https://opendatacommons.org/licenses/odbl/). Anyone redistributing this bundle must retain attribution and comply with ODbL share-alike requirements.",
  "build_tool_versions": {
    "build_sh": "phase-1"
  }
}
with open(sys.argv[1], "w") as f:
    json.dump(manifest, f, indent=2, sort_keys=True)
PY

# Same-day monotonic suffix: maps-YYYY.MM.DD.zip, then .2.zip, .3.zip, ...
BUNDLE="${DIST_DIR}/maps-${BUILD_DATE_YMD}.zip"
if [ -e "$BUNDLE" ]; then
    i=2
    while [ -e "${DIST_DIR}/maps-${BUILD_DATE_YMD}.${i}.zip" ]; do
        i=$((i + 1))
    done
    BUNDLE="${DIST_DIR}/maps-${BUILD_DATE_YMD}.${i}.zip"
fi

log "creating $BUNDLE"
# -j strips paths so the archive is flat, matching what map-watcher expects.
( cd "$STAGE_DIR" && zip -0 -j "$BUNDLE" \
    manifest.json tiles.pmtiles photon_data.tar valhalla_tiles.tar )

log "done."
log "bundle: $BUNDLE"
log "manifest region: $REGION  build_date: $BUILD_DATE_UTC  pbf_date: $PBF_DATE"
