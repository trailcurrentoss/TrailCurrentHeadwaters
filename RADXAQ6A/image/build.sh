#!/usr/bin/env bash
# ============================================================================
# TrailCurrent Headwaters — Radxa Dragon Q6A image build orchestrator
#
# Builds a flashable Radxa Dragon Q6A image with the Headwaters in-vehicle
# compute stack fully baked in: Docker + Compose, all application containers,
# map tiles, host-side Python scripts, branding, and default user. The NPU,
# WiFi/BT, display, camera, and audio subsystems are disabled at boot to
# approximate a CM5's power envelope for the same workload.
#
# Must be run as root (mmdebstrap/bdebstrap require it for chroot setup).
#
# Usage:
#   sudo ./RADXAQ6A/image/build.sh                   # full build
#   sudo ./RADXAQ6A/image/build.sh --sector-size 4096  # if NVMe uses 4k
#   sudo ./RADXAQ6A/image/build.sh --version 1.2.3
#   sudo ./RADXAQ6A/image/build.sh --debug            # rsdk debug mode
#   sudo ./RADXAQ6A/image/build.sh --minimal          # fast validation build
#                                                    # (skips 25 GB of map tiles
#                                                    # + 726 MB of Docker tarballs;
#                                                    # ~10 min instead of hours)
#
# Prerequisites (run from the repo root first):
#   ./build-and-save-images.sh
#   # and: data/tileserver/map.mbtiles must exist (unless using --minimal)
#
# After a successful build:
#   sudo ./RADXAQ6A/image/flash.sh --firmware       # one-time per board
#   sudo ./RADXAQ6A/image/flash.sh --os <image>     # NVMe OS
# ============================================================================

set -uo pipefail

HEADWATERS_VERSION="0.0.28"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# REPO_ROOT is the TrailCurrentHeadwaters/ project root
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RSDK_DIR="${SCRIPT_DIR}/rsdk"
CACHE_DIR="${SCRIPT_DIR}/cache"
OUTPUT_DIR="${SCRIPT_DIR}/output"
STAGING_DIR="/tmp/headwaters-staging"

SECTOR_SIZE=512
DEBUG_FLAG=""
MINIMAL=false

GREEN='\033[38;5;70m'
TEAL='\033[38;5;30m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

log()    { echo -e "${GREEN}[+]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[!]${RESET} $*"; }
err()    { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
fatal()  { err "$*"; exit 1; }
section(){ echo ""; echo -e "${BOLD}${TEAL}════ $* ════${RESET}"; echo ""; }

# ── Parse args ──────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        --sector-size) SECTOR_SIZE="$2"; shift 2 ;;
        --debug)       DEBUG_FLAG="--debug"; shift ;;
        --version)     HEADWATERS_VERSION="$2"; shift 2 ;;
        --minimal)     MINIMAL=true; shift ;;
        -h|--help)     sed -n '2,32p' "$0"; exit 0 ;;
        *) fatal "Unknown option: $1" ;;
    esac
done

# ── Preflight ───────────────────────────────────────────────────────────────
section "Preflight"

[ "$(id -u)" -eq 0 ] || fatal "build.sh must be run as root (sudo)"

if ! "$SCRIPT_DIR/preflight.sh"; then
    err "Preflight failed — see output above"
    exit 1
fi
log "Preflight passed"

START_TIME=$SECONDS

# ── Pre-build cleanup ───────────────────────────────────────────────────────
#
# Guarantee a clean starting state so a rebuild never accidentally reuses
# stale artifacts from a previous run. Things that MUST be fresh:
#
#   * $RSDK_OUT_DIR/output.img — if the new rsdk-build fails partway, an
#     old .img next to the new artifacts can be flashed by mistake.
#   * /tmp/mmdebstrap.* — orphans from a previous build killed mid-run
#     (mmdebstrap usually self-cleans, but `kill -9` leaves these).
#   * $STAGING_DIR — same-name temp dir from a prior run.
#
# Things we DELIBERATELY keep:
#
#   * $RSDK_OUT_DIR/debs/ — apt package cache; speeds up re-downloads by
#     10+ minutes on iterative builds.
#   * $RSDK_OUT_DIR/config.yaml, seed.tar.xz — overwritten by rsdk-build
#     automatically; no cleanup needed.
#
# rootfs.tar and build-image are nuked later in the rsdk-build section so
# the customize-hook chain always re-runs (that's a deliberate design choice,
# not a cleanup item).
section "Pre-build cleanup"
RSDK_OUT_DIR="$RSDK_DIR/out/radxa-dragon-q6a_noble_cli"
if [ -f "$RSDK_OUT_DIR/output.img" ]; then
    STALE_SIZE=$(du -h "$RSDK_OUT_DIR/output.img" | cut -f1)
    rm -f "$RSDK_OUT_DIR/output.img"
    log "Removed stale output.img ($STALE_SIZE)"
fi
if ls /tmp/mmdebstrap.* 1>/dev/null 2>&1; then
    ORPHAN_COUNT=$(ls -d /tmp/mmdebstrap.* 2>/dev/null | wc -l)
    rm -rf /tmp/mmdebstrap.*
    log "Removed $ORPHAN_COUNT orphaned mmdebstrap temp dir(s)"
fi
if [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
    log "Removed prior staging dir $STAGING_DIR"
fi
log "Pre-build cleanup done (debs/ cache preserved for faster re-downloads)"

# ── Stage files for the build ───────────────────────────────────────────────
section "Staging files for rsdk hooks"

rm -rf "$STAGING_DIR"   # belt-and-suspenders; cleanup section already did this
mkdir -p "$STAGING_DIR/repo"
mkdir -p "$STAGING_DIR/files"

log "Staging Headwaters repo artifacts into $STAGING_DIR/repo"

# Repo artifacts consumed by hook 5 (deployment payload)
install -m 644 "$REPO_ROOT/docker-compose.yml"        "$STAGING_DIR/repo/docker-compose.yml"
install -m 644 "$REPO_ROOT/.env.example"              "$STAGING_DIR/repo/.env.example"
install -m 755 "$REPO_ROOT/deploy.sh"                 "$STAGING_DIR/repo/deploy.sh"

mkdir -p "$STAGING_DIR/repo/config"
cp -r    "$REPO_ROOT/config/mosquitto"                "$STAGING_DIR/repo/config/"

mkdir -p "$STAGING_DIR/repo/scripts"
install -m 755 "$REPO_ROOT/scripts/generate-certs.sh" "$STAGING_DIR/repo/scripts/generate-certs.sh"
install -m 644 "$REPO_ROOT/scripts/openssl.cnf"       "$STAGING_DIR/repo/scripts/openssl.cnf"

mkdir -p "$STAGING_DIR/repo/local_code"
for f in "$REPO_ROOT"/local_code/*.py "$REPO_ROOT"/local_code/*.service "$REPO_ROOT"/local_code/requirements.txt; do
    [ -f "$f" ] && cp "$f" "$STAGING_DIR/repo/local_code/"
done

mkdir -p "$STAGING_DIR/repo/images"
if $MINIMAL; then
    warn "MINIMAL mode: skipping Docker image tarballs (backend/tileserver/etc. won't start on this image)"
elif ls "$REPO_ROOT"/images/*.tar 1>/dev/null 2>&1; then
    # Use cp --reflink=auto so we don't blow up disk by copying ~1 GB twice.
    cp --reflink=auto "$REPO_ROOT"/images/*.tar "$STAGING_DIR/repo/images/"
    log "Staged $(ls "$STAGING_DIR/repo/images"/*.tar | wc -l) Docker image tarballs"
else
    warn "No Docker image tarballs at $REPO_ROOT/images/*.tar — backend/tileserver will not start"
    warn "Run ./build-and-save-images.sh from the repo root before building."
fi

mkdir -p "$STAGING_DIR/repo/data/tileserver"
if $MINIMAL; then
    warn "MINIMAL mode: skipping map.mbtiles (tileserver won't start on this image)"
elif [ -f "$REPO_ROOT/data/tileserver/map.mbtiles" ]; then
    cp --reflink=auto "$REPO_ROOT/data/tileserver/map.mbtiles" \
        "$STAGING_DIR/repo/data/tileserver/map.mbtiles"
    MBTILES_SIZE=$(du -h "$STAGING_DIR/repo/data/tileserver/map.mbtiles" | cut -f1)
    log "Staged map.mbtiles ($MBTILES_SIZE)"
else
    warn "map.mbtiles missing at $REPO_ROOT/data/tileserver/map.mbtiles — tileserver will not start"
fi

# Image-local files (systemd units, scripts, plymouth, branding) consumed by hooks 6–15
log "Staging image-local files into $STAGING_DIR/files"
rsync -a "$SCRIPT_DIR/files/" "$STAGING_DIR/files/"

# Compile device-tree overlays on the build host (consumed by hook 19b).
#
# We do NOT rely on radxa-overlays-dkms being installed in the target rootfs
# because (a) the current linux-image-*-qcom kernel package does not Depends
# on it, (b) DKMS builds inside a qemu chroot are flaky and add minutes to
# every build, and (c) vendoring the .dts source in this repo makes the
# build deterministic — a new developer runs build.sh and the overlay is
# compiled from known-good source every time.
#
# The vendored .dts has no #includes (constants inlined), so plain `dtc -@`
# is the only tool required. Preflight checks for dtc, so a missing tool is
# caught before the long rsdk-build phase.
log "Compiling device-tree overlays"
mkdir -p "$STAGING_DIR/files/dtbo"
for dts in "$SCRIPT_DIR/overlays/"*.dts; do
    [ -f "$dts" ] || continue
    base=$(basename "$dts" .dts)
    out="$STAGING_DIR/files/dtbo/${base}.dtbo"
    if ! dtc -@ -q -I dts -O dtb -o "$out" "$dts"; then
        fatal "dtc failed to compile $dts"
    fi
    log "  compiled ${base}.dtbo ($(du -b "$out" | cut -f1) bytes)"
done

# Build the patched embloader.efi — replaces Radxa's stock systemd-bootaa64.efi
# at the hook stage so first-boot and every subsequent boot autoboots cleanly
# regardless of phantom UART input on the floating debug-UART RX pin (gpio23).
# Cached under cache/embloader-build/ keyed on patch SHA + upstream commit, so
# only the first build pays the EDK2 clone + basetools cost.
log "Building patched embloader.efi (cached on patch+commit hash)"
if ! "$SCRIPT_DIR/embloader/build-embloader.sh"; then
    fatal "embloader build failed — see output above"
fi
mkdir -p "$STAGING_DIR/files/embloader"
install -m 644 "$SCRIPT_DIR/embloader/output/embloader.efi" \
    "$STAGING_DIR/files/embloader/embloader.efi"
install -m 644 "$SCRIPT_DIR/embloader/output/embloader.efi.sha256" \
    "$STAGING_DIR/files/embloader/embloader.efi.sha256"
log "  staged $(du -h "$STAGING_DIR/files/embloader/embloader.efi" | cut -f1) embloader.efi"

STAGE_SIZE=$(du -sh "$STAGING_DIR" | cut -f1)
log "Staged $STAGE_SIZE total"

export HEADWATERS_STAGING="$STAGING_DIR"
export HEADWATERS_VERSION="$HEADWATERS_VERSION"
if $MINIMAL; then
    export HEADWATERS_BUILD_MODE="minimal"
else
    export HEADWATERS_BUILD_MODE="full"
fi

# ── Run rsdk-build ──────────────────────────────────────────────────────────
section "Building rootfs and image (rsdk)"

log "Product:    radxa-dragon-q6a"
log "Suite:      noble (Ubuntu 24.04)"
log "Edition:    cli (minimal, no desktop)"
log "Sector:     ${SECTOR_SIZE}"
log "Version:    ${HEADWATERS_VERSION}"
if $MINIMAL; then
    warn "Build mode: ${BOLD}MINIMAL${RESET}${YELLOW} — validation only, do NOT flash to a production board"
else
    log "Build mode: full (map tiles + Docker containers baked in)"
fi
log ""
if $MINIMAL; then
    log "Minimal builds take ~10-15 minutes (disk assembly is fast without 25 GB of tiles)."
else
    log "Full builds take a few hours — most of the time is guestfish writing tiles + containers."
fi
log "Hook 22 is the fail-fast checkpoint — watch for its checkpoint message."
log ""

cd "$RSDK_DIR"

# Always start from a clean rootfs tarball so the customize-hook chain runs
# every build (see Peregrine build.sh for the rationale). RSDK_OUT_DIR was
# already set by the pre-build-cleanup section.
rm -f "$RSDK_OUT_DIR/build-image"
rm -f "$RSDK_OUT_DIR/rootfs.tar"

if ! "$RSDK_DIR/src/libexec/rsdk/rsdk-build" \
        $DEBUG_FLAG \
        --sector-size "$SECTOR_SIZE" \
        radxa-dragon-q6a \
        noble \
        cli; then
    err "rsdk-build failed — see output above for the failing hook"
    err "Common failure points:"
    err "  hook 3  — Docker apt repo / install"
    err "  hook 5  — staging artifacts (check repo/ in $STAGING_DIR)"
    err "  hook 22 — final artifact verification"
    exit 1
fi

# ── Post-build: move output ─────────────────────────────────────────────────
section "Post-build"

RSDK_OUT="${RSDK_DIR}/out/radxa-dragon-q6a_noble_cli/output.img"
if [ ! -f "$RSDK_OUT" ]; then
    fatal "rsdk reported success but $RSDK_OUT does not exist"
fi

mkdir -p "$OUTPUT_DIR"
if $MINIMAL; then
    FINAL_IMG="${OUTPUT_DIR}/headwaters-q6a-v${HEADWATERS_VERSION}-MINIMAL.img"
else
    FINAL_IMG="${OUTPUT_DIR}/headwaters-q6a-v${HEADWATERS_VERSION}.img"
fi

cp --reflink=auto "$RSDK_OUT" "$FINAL_IMG"

IMG_SIZE=$(du -h "$FINAL_IMG" | cut -f1)
SHA=$(sha256sum "$FINAL_IMG" | cut -d' ' -f1)

# Cleanup staging
rm -rf "$STAGING_DIR"

ELAPSED=$((SECONDS - START_TIME))
ELAPSED_MIN=$((ELAPSED / 60))
ELAPSED_SEC=$((ELAPSED % 60))

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Build complete in ${ELAPSED_MIN}m ${ELAPSED_SEC}s${RESET}"
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  Image:   $FINAL_IMG"
echo "  Size:    $IMG_SIZE"
echo "  SHA256:  $SHA"
echo ""
if $MINIMAL; then
    echo -e "  ${YELLOW}${BOLD}MINIMAL BUILD${RESET}"
    echo "  This image has NO map tiles and NO Docker image tarballs baked in."
    echo "  It is for validating boot / SSH / CAN / power-save only. Docker"
    echo "  Compose will not start any application containers on this image."
    echo "  Re-run without --minimal for a production-ready image."
    echo ""
fi
echo "  Next steps:"
echo ""
echo "    1. Put the board in EDL mode (hold EDL button while powering on)"
echo "    2. Verify with: lsusb | grep 9008"
echo "    3. Flash SPI NOR firmware (one-time per board):"
echo "         sudo ./RADXAQ6A/image/flash.sh --firmware"
echo "    4. Flash the OS image to NVMe:"
echo "         sudo ./RADXAQ6A/image/flash.sh --os $FINAL_IMG"
echo "    5. Connect Ethernet, apply 12V power TO THE RADXA's 3-PIN HEADER."
echo "       Do NOT wire 12V to the CAN HAT's own DC input — the HAT draws"
echo "       its 5V from the Radxa via the 40-pin header. See the CAN bus"
echo "       section of RADXAQ6A/README.md for the wiring rationale."
echo "       The HAT can stay installed — this image ships a patched"
echo "       embloader.efi that autoboots without polling ConIn, so phantom"
echo "       UART input from the floating debug-UART RX pin (gpio23) doesn't"
echo "       trap the boot menu. See RADXAQ6A/README.md \"Boot is fully"
echo "       unattended\" for the rationale."
echo "       Wait ~3 min for first-boot setup to finish."
echo "    6. SSH:"
echo "         ssh trailcurrent@headwaters.local"
echo "         (default password: trailcurrent)"
echo ""
