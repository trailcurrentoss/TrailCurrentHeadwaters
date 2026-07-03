#!/bin/bash
set -e

# TrailCurrent CM5 Wireless-Base Image Builder
#
# Builds a custom Raspberry Pi OS image for the CM5 mounted on a
# Waveshare CM5-IO-Wireless-Base carrier board. Identical to build.sh
# except the MCP2515 CAN interrupt is wired to GPIO17 (matching the
# onboard isolated CAN on the wireless base) instead of GPIO25 (used
# by the RS485 CAN HAT (B) variant).
#
# Prerequisites:
#   - Debian/Ubuntu build host (arm64 native or x86_64 with QEMU)
#   - Run with sudo (rpi-image-gen requires root for chroot operations)
#
# Usage:
#   sudo ./build-wireless.sh [username] [password]
#
# Arguments:
#   username  - Default login user (default: trailcurrent)
#   password  - Default login password (default: trailcurrent)
#
# Output:
#   ../rpi-image-gen/work/image-trailcurrent-cm5-wireless-base/trailcurrent-cm5-wireless-base.img

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RPIIG_DIR="$SCRIPT_DIR/../rpi-image-gen"
REPO_ROOT="$SCRIPT_DIR/../.."

TC_USER="${1:-trailcurrent}"
TC_PASS="${2:-trailcurrent}"

# Check prerequisites: Docker images and map tiles must exist
echo "Checking prerequisites..."

if ! ls "$REPO_ROOT"/images/*.tar 1>/dev/null 2>&1; then
    echo "ERROR: No Docker image tarballs found at images/*.tar"
    echo "Run ./build-and-save-images.sh from the repo root first."
    exit 1
fi
echo "  Docker image tarballs: OK"

if [ ! -f "$REPO_ROOT/data/tileserver/map.mbtiles" ]; then
    echo "WARNING: map.mbtiles not found at data/tileserver/map.mbtiles"
    echo "  The image will be built without map tiles."
    echo "  The tileserver container will not start without this file."
    read -rp "  Continue anyway? [y/N] " answer
    if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
        exit 1
    fi
else
    MBTILES_SIZE=$(du -h "$REPO_ROOT/data/tileserver/map.mbtiles" | cut -f1)
    echo "  Map tiles ($MBTILES_SIZE): OK"
fi

echo ""

# Hash the password so we can use IGconf_device_user1passhash
# instead of user1pass (which has strict complexity validation)
TC_PASSHASH=$(openssl passwd -6 "$TC_PASS")

# Clone rpi-image-gen if not present
if [ ! -d "$RPIIG_DIR" ]; then
    echo "Cloning rpi-image-gen..."
    git clone https://github.com/raspberrypi/rpi-image-gen.git "$RPIIG_DIR"
fi

# Install build dependencies if not already done
if [ ! -f "$RPIIG_DIR/.deps_installed" ]; then
    echo "Installing build dependencies..."
    "$RPIIG_DIR/install_deps.sh"
    touch "$RPIIG_DIR/.deps_installed"
fi

# Set target architecture for cross-compilation on x86_64 hosts.
# On native arm64 hosts this is harmless (TOOLCHAIN_MODE=native).
export ARCH=arm64

# ── Clear stale build state ───────────────────────────────────────────
# rpi-image-gen builds are stateful. mmdebstrap mounts procfs, sysfs,
# and devtmpfs inside the chroot during package install. If a prior
# build failed mid-way, those mounts are still live. Both rpi-image-gen's
# `clean` subcommand and bdebstrap's own `--force` use plain rm-style
# tree deletion that fails with "Read-only file system" (on /proc entries
# like `fb`) or "Invalid argument" (on /proc/1/task/*) as long as the
# mounts are up.
#
# Sequence:
#   1. Unmount every mount inside work/ (deepest-first, lazy fallback if
#      something is still holding a handle open).
#   2. Force-remove the whole chroot-v* tree — cheap; mmdebstrap rebuilds
#      it from Debian packages every run anyway.
#   3. Call rpi-image-gen clean to remove the config-specific image
#      output dir. That call leaves the OTHER variant's completed .img
#      untouched.
WORK_DIR="$RPIIG_DIR/work"
if [ -d "$WORK_DIR" ]; then
    echo "Clearing stale build state..."
    # Enumerate mounts by reading /proc/mounts directly. `findmnt -R $path`
    # only works when $path is itself a mountpoint; work/ is a plain dir,
    # so findmnt walks up to /media/... and misses the mounts we care about.
    # tac reverses mount-creation order → deepest-first, which is the safe
    # umount order (child bind-mounts before their parent).
    UMOUNT_TARGETS=$(tac /proc/mounts | awk -v p="$WORK_DIR/" 'index($2, p) == 1 {print $2}')
    if [ -n "$UMOUNT_TARGETS" ]; then
        printf '%s\n' "$UMOUNT_TARGETS" | while read -r mp; do
            umount "$mp" 2>/dev/null || umount -l "$mp" 2>/dev/null || true
        done
    fi
    # After mounts are gone, blow away the whole chroot tree — cheap;
    # mmdebstrap rebuilds it from Debian packages every run anyway.
    rm -rf "$WORK_DIR"/chroot-v* 2>/dev/null || true
    # Clean the config-specific image output dir. Leaves the OTHER variant's
    # completed .img untouched (only paths tied to THIS config are removed).
    yes | "$RPIIG_DIR"/rpi-image-gen clean \
        -S "$SCRIPT_DIR" \
        -c trailcurrent-cm5-wireless-base.yaml || true
fi

# Build the image
cd "$RPIIG_DIR"
./rpi-image-gen build \
    -S "$SCRIPT_DIR" \
    -c trailcurrent-cm5-wireless-base.yaml \
    -- \
    IGconf_device_user1="$TC_USER" \
    IGconf_device_user1passhash="$TC_PASSHASH" \
    IGconf_device_user1sudo=nopasswd

IMG_PATH="$RPIIG_DIR/work/image-trailcurrent-cm5-wireless-base/trailcurrent-cm5-wireless-base.img"

echo ""
echo "================================================"
echo "Image built successfully!"
echo "================================================"
echo ""
echo "Output: $IMG_PATH"
echo ""
echo "Target hardware: CM5 on Waveshare CM5-IO-Wireless-Base carrier"
echo "CAN: onboard isolated MCP2515, SPI0/CE0, 16 MHz xtal, INT=GPIO17"
echo ""
echo "Flash to CM5 NVMe:"
echo "  1. Fit the EMMC_DISABLE jumper on the carrier board (CM5 with eMMC only)"
echo "  2. Connect the carrier USB-C to this computer"
echo "  3. Apply power to the carrier board"
echo "  4. sudo ../usbboot/rpiboot -d mass-storage-gadget64"
echo "  5. Wait for the NVMe to appear as /dev/sdX (check dmesg or lsblk)"
echo "  6. sudo dd if=$IMG_PATH of=/dev/sdX bs=4M status=progress conv=fsync"
echo "  7. sync"
echo "  8. Remove EMMC_DISABLE jumper, disconnect USB, power cycle"
echo ""
echo "On first boot the CM5 will automatically:"
echo "  - Expand root partition to fill the NVMe drive"
echo "  - Configure EEPROM for auto-boot on power"
echo "  - Generate TLS certificates"
echo "  - Set up the Python virtual environment"
echo "  - Load Docker images from baked-in tarballs"
echo ""
echo "On first SSH login, an interactive setup wizard will:"
echo "  - Prompt for MQTT and admin passwords"
echo "  - Auto-generate encryption keys"
echo "  - Write .env and start all services"
echo ""
echo "See CM5/SETUP.md for the full getting-started guide."
echo ""
