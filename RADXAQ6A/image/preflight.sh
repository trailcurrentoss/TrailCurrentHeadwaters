#!/usr/bin/env bash
# ============================================================================
# TrailCurrent Headwaters — Q6A build host preflight
#
# Verifies the build host has everything needed to run build.sh, clones
# the rsdk keyring repos, and checks for the Headwaters deployment payload
# (Docker image tarballs + map tiles) in the repo root.
#
# Idempotent — safe to re-run any time.
#
# Usage:
#   ./RADXAQ6A/image/preflight.sh
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RSDK_DIR="${SCRIPT_DIR}/rsdk"
KEYRINGS_DIR="${RSDK_DIR}/externals/keyrings"
FIRMWARE_DIR="${SCRIPT_DIR}/firmware"

GREEN='\033[38;5;70m'
TEAL='\033[38;5;30m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}\xE2\x9C\x93${RESET} $*"; }
fail() { echo -e "  ${RED}\xE2\x9C\x97${RESET} $*"; ERRORS=$((ERRORS+1)); }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }
step() { echo ""; echo -e "${BOLD}${TEAL}── ${1} ──${RESET}"; }

ERRORS=0

echo ""
echo -e "${BOLD}${GREEN}Trail${TEAL}Current${RESET} ${BOLD}Headwaters — Q6A Build Host Preflight${RESET}"
echo ""

# ── 1. APT build dependencies ───────────────────────────────────────────────
step "1. APT build dependencies"

REQUIRED_TOOLS=(jsonnet bdebstrap guestfish qemu-aarch64-static sgdisk parted git curl gpg dtc rsync unzip nasm iasl pkg-config aarch64-linux-gnu-gcc)
MISSING_PKGS=()

for tool in "${REQUIRED_TOOLS[@]}"; do
    if command -v "$tool" >/dev/null 2>&1; then
        ok "$tool"
    else
        fail "$tool — missing"
        case "$tool" in
            jsonnet)            MISSING_PKGS+=(jsonnet) ;;
            bdebstrap)          MISSING_PKGS+=(bdebstrap) ;;
            guestfish)          MISSING_PKGS+=(libguestfs-tools) ;;
            qemu-aarch64-static) MISSING_PKGS+=(qemu-user-static binfmt-support) ;;
            sgdisk)             MISSING_PKGS+=(gdisk) ;;
            parted)             MISSING_PKGS+=(parted) ;;
            git)                MISSING_PKGS+=(git) ;;
            curl)               MISSING_PKGS+=(curl) ;;
            gpg)                MISSING_PKGS+=(gpg) ;;
            dtc)                MISSING_PKGS+=(device-tree-compiler) ;;
            rsync)              MISSING_PKGS+=(rsync) ;;
            unzip)              MISSING_PKGS+=(unzip) ;;
            # embloader build tooling — needed to compile the patched
            # systemd-boot fork (see embloader/build-embloader.sh).
            nasm)               MISSING_PKGS+=(nasm) ;;
            iasl)               MISSING_PKGS+=(acpica-tools) ;;
            pkg-config)         MISSING_PKGS+=(pkg-config) ;;
            aarch64-linux-gnu-gcc) MISSING_PKGS+=(gcc-aarch64-linux-gnu) ;;
        esac
    fi
done

# uuid-dev provides /usr/include/uuid/uuid.h, required by EDK2's BaseTools
if [ -e /usr/include/uuid/uuid.h ]; then
    ok "uuid/uuid.h header"
else
    fail "uuid/uuid.h header — missing"
    MISSING_PKGS+=(uuid-dev)
fi

if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    UNIQ_PKGS=$(printf '%s\n' "${MISSING_PKGS[@]}" | sort -u | tr '\n' ' ')
    echo ""
    echo "  To install missing dependencies:"
    echo "    sudo apt install -y $UNIQ_PKGS"
fi

# dtc must support the overlay symbols flag (-@). Any device-tree-compiler
# from Ubuntu 22.04+ has this; older versions silently produce garbage.
if command -v dtc >/dev/null 2>&1; then
    if dtc --help 2>&1 | grep -q -- '-@'; then
        ok "dtc supports -@ (overlay mode)"
    else
        fail "dtc is installed but does not support -@ — upgrade device-tree-compiler"
    fi
fi

# ── 2. QEMU binfmt for arm64 ────────────────────────────────────────────────
step "2. QEMU arm64 binfmt"

if [ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
    ok "qemu-aarch64 binfmt registered"
else
    fail "qemu-aarch64 binfmt not registered"
    echo "  Try: sudo systemctl restart binfmt-support"
fi

# ── 3. rsdk keyrings ────────────────────────────────────────────────────────
step "3. rsdk keyring repos"

mkdir -p "$KEYRINGS_DIR"

clone_or_skip() {
    local name="$1"
    local url="$2"
    local target="${KEYRINGS_DIR}/${name}"

    if [ -d "$target/.git" ] || [ -f "$target/Makefile" ]; then
        ok "${name} keyring (already cloned)"
    else
        echo "  cloning ${name}..."
        rm -rf "$target"
        if git clone --depth=1 --quiet "$url" "$target"; then
            ok "${name} keyring"
        else
            fail "${name} keyring (clone failed)"
        fi
    fi
}

clone_or_skip debian   https://salsa.debian.org/release-team/debian-archive-keyring.git
clone_or_skip ubuntu   https://git.launchpad.net/ubuntu/+source/ubuntu-keyring
clone_or_skip radxa    https://github.com/radxa-pkg/radxa-archive-keyring.git
clone_or_skip vscodium https://gitlab.com/paulcarroty/vscodium-deb-rpm-repo.git

# ── 4. Repo deployment payload ──────────────────────────────────────────────
step "4. Repo deployment payload (Docker images, map tiles, compose)"

# The rootfs.jsonnet hook 5 expects these to be staged. We don't hard-fail
# on missing ones because the user may intentionally build an image without
# map tiles during development, but warn loudly so they see the consequence.

for f in docker-compose.yml .env.example deploy.sh scripts/generate-certs.sh; do
    if [ -f "$REPO_ROOT/$f" ]; then
        ok "$f"
    else
        fail "$REPO_ROOT/$f missing (required)"
    fi
done

if [ -d "$REPO_ROOT/config/mosquitto" ]; then
    ok "config/mosquitto/"
else
    fail "config/mosquitto/ missing (required)"
fi

if ls "$REPO_ROOT"/images/*.tar 1>/dev/null 2>&1; then
    COUNT=$(ls "$REPO_ROOT"/images/*.tar | wc -l)
    SIZE=$(du -sh "$REPO_ROOT"/images/ 2>/dev/null | cut -f1)
    ok "images/*.tar — $COUNT tarballs, $SIZE total"
else
    warn "images/*.tar missing — run ./build-and-save-images.sh from repo root"
    warn "  image will build but backend/frontend/mosquitto/mongodb/tileserver will not start"
fi

if [ -f "$REPO_ROOT/data/tileserver/map.mbtiles" ]; then
    SIZE=$(du -h "$REPO_ROOT/data/tileserver/map.mbtiles" | cut -f1)
    ok "data/tileserver/map.mbtiles ($SIZE)"
else
    warn "data/tileserver/map.mbtiles missing — tileserver container will not start"
    warn "  see DOCS/UpdatingMapTiles.md or copy from a team member"
fi

# ── 5. Device-tree overlay sources ──────────────────────────────────────────
step "5. Vendored device-tree overlays (compiled on build host)"

CAN_DTS="$SCRIPT_DIR/overlays/qcs6490-radxa-dragon-q6a-spi12-cs0-mcp2515-16mhz.dts"
if [ -f "$CAN_DTS" ]; then
    ok "MCP2515 CAN overlay source present"
    # Also sanity-check that it compiles — catches syntax errors before build
    if command -v dtc >/dev/null 2>&1; then
        TMP_DTBO=$(mktemp --suffix=.dtbo)
        if dtc -@ -q -I dts -O dtb -o "$TMP_DTBO" "$CAN_DTS" 2>/dev/null; then
            ok "MCP2515 CAN overlay compiles cleanly ($(du -b "$TMP_DTBO" | cut -f1) bytes)"
            rm -f "$TMP_DTBO"
        else
            fail "MCP2515 CAN overlay fails to compile — check syntax in $(basename "$CAN_DTS")"
            rm -f "$TMP_DTBO"
        fi
    fi
else
    fail "$CAN_DTS missing — CAN bus won't work on the built image"
fi

# ── 6. SPI NOR firmware files ───────────────────────────────────────────────
step "6. SPI NOR firmware (for first-time board flashing)"

for f in dragon-q6a_flat_build_wp_260120.zip edl-ng-dist.zip; do
    if [ -f "${FIRMWARE_DIR}/${f}" ]; then
        ok "firmware/${f} ($(du -h "${FIRMWARE_DIR}/${f}" | cut -f1))"
    else
        fail "firmware/${f} missing"
    fi
done

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [ "$ERRORS" -eq 0 ]; then
    echo -e "${BOLD}${GREEN}Preflight passed${RESET} — ready to run ${BOLD}sudo ./RADXAQ6A/image/build.sh${RESET}"
    echo ""
    exit 0
else
    echo -e "${BOLD}${RED}Preflight failed${RESET} with ${ERRORS} error(s) — fix the issues above and re-run."
    echo ""
    exit 1
fi
