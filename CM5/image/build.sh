#!/bin/bash
set -e

# TrailCurrent CM5 Image Builder -- builds BOTH carrier-board variants
# in a single invocation:
#
#   1. Base           -- any CM5 IO board + Waveshare RS485 CAN HAT (B)
#                        (MCP2515 interrupt on GPIO25)
#   2. Wireless-Base  -- Waveshare CM5-IO-Wireless-Base carrier
#                        (onboard MCP2515, interrupt on GPIO17)
#
# Both variants share the ENTIRE OS + application stack (Docker images,
# systemd units, setup-AP portal, first-boot provisioning). The only
# difference is the CAN overlay in config.txt. Building both from a
# single script prevents the two variants from silently drifting out of
# sync -- fixing a bug in the setup portal and forgetting to rebuild the
# wireless image would mean two customers on two carriers get two
# different behaviours.
#
# Prerequisites:
#   - Debian/Ubuntu build host (arm64 native or x86_64 with QEMU)
#   - Run with sudo (rpi-image-gen requires root for chroot operations)
#   - ./build-and-save-images.sh has been run to produce images/*.tar
#
# Usage:
#   sudo ./build.sh [username] [password]
#
# Arguments (both variants get the same credentials):
#   username  - Default login user (default: trailcurrent)
#   password  - Default login password (default: trailcurrent)
#
# Output:
#   ../rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img
#   ../rpi-image-gen/work/image-trailcurrent-cm5-wireless-base/trailcurrent-cm5-wireless-base.img
#
# Distribution model:
#   Developers build. End users receive the two .img files and flash
#   whichever matches their carrier. See CM5/SETUP.md for the flashing
#   procedure and per-variant hardware wiring.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RPIIG_DIR="$SCRIPT_DIR/../rpi-image-gen"
REPO_ROOT="$SCRIPT_DIR/../.."

TC_USER="${1:-trailcurrent}"
TC_PASS="${2:-trailcurrent}"
WORK_DIR="$RPIIG_DIR/work"

# ── One-time prereq checks and setup ────────────────────────────────────
echo "Checking prerequisites..."

if ! ls "$REPO_ROOT"/images/*.tar 1>/dev/null 2>&1; then
    echo "ERROR: No Docker image tarballs found at images/*.tar" >&2
    echo "  Run ./build-and-save-images.sh from the repo root first." >&2
    exit 1
fi
echo "  Docker image tarballs: OK"

# Map data is no longer baked into the image. Users install their region's
# map bundle via the PWA Maps upload flow after first boot. See
# PLANS/Offline-Maps-Migration.md "Confirmed decisions -> Initial payload"
# for the reasoning.

echo ""

# Hash the password so we can use IGconf_device_user1passhash
# instead of user1pass (which has strict complexity validation).
TC_PASSHASH=$(openssl passwd -6 "$TC_PASS")

# Clone rpi-image-gen if not present.
if [ ! -d "$RPIIG_DIR" ]; then
    echo "Cloning rpi-image-gen..."
    git clone https://github.com/raspberrypi/rpi-image-gen.git "$RPIIG_DIR"
fi

# Install build dependencies once (marker file avoids reinstall on rebuild).
if [ ! -f "$RPIIG_DIR/.deps_installed" ]; then
    echo "Installing build dependencies..."
    "$RPIIG_DIR/install_deps.sh"
    touch "$RPIIG_DIR/.deps_installed"
fi

# Set target architecture for cross-compilation on x86_64 hosts.
# On native arm64 hosts this is harmless (TOOLCHAIN_MODE=native).
export ARCH=arm64

# ── Per-variant build function ──────────────────────────────────────────
# Each invocation:
#   1. Unmounts any stale mounts inside work/
#   2. Removes work/chroot-v* (shared between variants -- must be fresh)
#   3. Removes work/image-<variant> (the specific variant's output dir)
#   4. Runs rpi-image-gen against this variant's config YAML
#   5. Runs verify-image.sh on the produced .img
# Any step failure causes the whole script to exit non-zero -- the two
# variants must succeed together or neither ships.
build_variant() {
    local variant="$1"       # human name, printed
    local config="$2"        # rpi-image-gen config YAML (in SCRIPT_DIR)
    local imgdir="$3"        # work/image-<imgdir>/
    local imgfile="$4"       # <imgfile>.img inside imgdir

    local imgpath="$WORK_DIR/$imgdir/$imgfile"

    echo ""
    echo "================================================"
    echo "  Building variant: $variant"
    echo "================================================"
    echo ""

    # ---- Clean stale build state (per-variant, per-run) ----------------
    if [ -d "$WORK_DIR" ]; then
        # tac reverses mount-creation order -> deepest-first, which is
        # the safe umount order. Reading /proc/mounts directly because
        # findmnt -R only works when the path is itself a mountpoint.
        local umount_targets
        umount_targets=$(tac /proc/mounts | awk -v p="$WORK_DIR/" 'index($2, p) == 1 {print $2}')
        if [ -n "$umount_targets" ]; then
            printf '%s\n' "$umount_targets" | while read -r mp; do
                umount "$mp" 2>/dev/null || umount -l "$mp" 2>/dev/null || true
            done
        fi

        # Nuke the whole chroot. If the rm fails, STOP -- a stale chroot
        # is exactly how stale files get baked into the .img silently.
        if ! rm -rf "$WORK_DIR"/chroot-v*; then
            echo "ERROR ($variant): failed to remove $WORK_DIR/chroot-v*" >&2
            echo "  Most likely cause: not running with sudo, or a mount is" >&2
            echo "  still held open on something inside chroot-v*." >&2
            echo "  Fix: run 'sudo rm -rf $WORK_DIR/chroot-v*' and re-run this script." >&2
            exit 1
        fi
        if compgen -G "$WORK_DIR/chroot-v*" > /dev/null; then
            echo "ERROR ($variant): chroot dirs still present after cleanup:" >&2
            ls -d "$WORK_DIR"/chroot-v* >&2
            exit 1
        fi

        # rpi-image-gen's built-in clean handles the per-config metadata.
        # We ignore its exit code because we then do our own rm regardless.
        yes | "$RPIIG_DIR"/rpi-image-gen clean \
            -S "$SCRIPT_DIR" \
            -c "$config" || true

        # Belt-and-braces: remove this variant's image dir explicitly.
        if ! rm -rf "$WORK_DIR/$imgdir"; then
            echo "ERROR ($variant): failed to remove $WORK_DIR/$imgdir" >&2
            echo "  Fix: 'sudo rm -rf $WORK_DIR/$imgdir' and re-run this script." >&2
            exit 1
        fi
    fi

    # ---- Build --------------------------------------------------------
    ( cd "$RPIIG_DIR" && ./rpi-image-gen build \
        -S "$SCRIPT_DIR" \
        -c "$config" \
        -- \
        IGconf_device_user1="$TC_USER" \
        IGconf_device_user1passhash="$TC_PASSHASH" \
        IGconf_device_user1sudo=nopasswd )

    # ---- Verify -------------------------------------------------------
    # Verify the ACTUAL .img we're about to ship. verify-image.sh uses
    # debugfs (userspace ext4 code, block-size independent) to read
    # files straight out of the ext4 partition without loop-mounting,
    # which works even though the CM5's 16 KB ext4 block size exceeds
    # what the build-host kernel can mount.
    "$SCRIPT_DIR/verify-image.sh" "$imgpath" "$SCRIPT_DIR"

    # Return the image path via a global (bash makes returning strings awkward).
    LAST_IMG_PATH="$imgpath"
}

# ── Build both variants (order: base first, wireless second) ────────────
# Serial by design. rpi-image-gen re-uses work/chroot-v* between configs;
# building the two in parallel would race on chroot content and produce
# undefined output. Serial is ~2x slower on cold apt caches, but the apt
# bootstrap dirs (work/bootstrap, work/cache) ARE shared, so the wireless
# variant reuses everything the base variant already downloaded.

build_variant "Base (RS485 CAN HAT (B), INT=GPIO25)" \
    "trailcurrent-cm5-base.yaml" \
    "image-trailcurrent-cm5-base" \
    "trailcurrent-cm5-base.img"
BASE_IMG="$LAST_IMG_PATH"

build_variant "Wireless-Base (Waveshare CM5-IO-Wireless-Base, INT=GPIO17)" \
    "trailcurrent-cm5-wireless-base.yaml" \
    "image-trailcurrent-cm5-wireless-base" \
    "trailcurrent-cm5-wireless-base.img"
WIRELESS_IMG="$LAST_IMG_PATH"

# ── Final summary ───────────────────────────────────────────────────────
echo ""
echo "================================================"
echo "  BOTH IMAGES BUILT AND VERIFIED"
echo "================================================"
echo ""
echo "Base variant:"
echo "  $BASE_IMG"
echo "  Target: CM5 IO board + Waveshare RS485 CAN HAT (B) (INT=GPIO25)"
echo ""
echo "Wireless-Base variant:"
echo "  $WIRELESS_IMG"
echo "  Target: Waveshare CM5-IO-Wireless-Base carrier (INT=GPIO17)"
echo ""
echo "Flashing procedure (either variant):"
echo "  1. Fit the EMMC_DISABLE jumper on the carrier board (CM5 with eMMC only)"
echo "  2. Connect the carrier USB-C to this computer"
echo "  3. Apply power to the carrier board"
echo "  4. sudo ../usbboot/rpiboot -d mass-storage-gadget64"
echo "  5. Wait for the NVMe to appear as /dev/sdX (check dmesg or lsblk)"
echo "  6. sudo dd if=<image path> of=/dev/sdX bs=4M status=progress conv=fsync"
echo "  7. sync"
echo "  8. Remove EMMC_DISABLE jumper, disconnect USB, power cycle"
echo ""
echo "On first boot each variant will:"
echo "  - Expand root partition, configure EEPROM for auto-boot, generate TLS certs"
echo "  - Load baked-in Docker images"
echo "  - Bring up the Headwaters-XXXX WiFi setup access point"
echo "  - Wait for the customer to complete setup from their phone -- no SSH,"
echo "    keyboard, or monitor required at any point"
echo ""
echo "Both images require a CM5 with onboard WiFi (setup portal cannot"
echo "come up without it)."
echo ""
echo "See CM5/SETUP.md for the full getting-started guide."
echo ""
