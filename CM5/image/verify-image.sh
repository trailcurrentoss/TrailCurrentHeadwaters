#!/bin/bash
# verify-image.sh -- prove that a freshly built CM5 image contains the
# CURRENT source, not a stale bake from a cached chroot.
#
# Called by build.sh once per variant right after each image is
# produced. Any mismatch between what's inside the .img and what's
# in the layer/files/ tree fails the build LOUDLY, so a bad bake
# never ships past the operator.
#
# Usage:
#   verify-image.sh <path/to/image.img> <path/to/CM5/image/dir>
#
# Exit codes:
#   0  everything matches, image is good to flash
#   1  mismatch or missing file; do not flash
#
# Requires root because it reads the .img file and calls losetup /
# debugfs. The build scripts already require root for rpi-image-gen
# anyway.
#
# HOW WE READ THE EXT4 PARTITION:
#   rpi-image-gen builds root.ext4 with a 16 KB block size to match
#   the CM5's 16 KB page size. The build-host kernel's ext4 driver
#   maxes out at 4 KB blocks, so loop-mounting the ext4 partition
#   fails with "bad superblock" on any typical dev machine.
#
#   Solution: `debugfs` (from e2fsprogs) uses its own userspace ext4
#   code and doesn't care about kernel block-size limits. We locate
#   the root partition inside the .img and use `debugfs -R` to read
#   files directly out of it -- verifying the ACTUAL .img the operator
#   is about to flash, not any intermediate build artifact.
set -euo pipefail

IMG="${1:-}"
SRC_DIR="${2:-}"

if [ -z "$IMG" ] || [ -z "$SRC_DIR" ]; then
    echo "usage: verify-image.sh <image.img> <CM5/image/>" >&2
    exit 2
fi
if [ ! -f "$IMG" ]; then
    echo "verify-image: image not found: $IMG" >&2
    exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
    echo "verify-image: must be run as root (losetup + reading root-owned .img)" >&2
    exit 1
fi
if ! command -v debugfs >/dev/null 2>&1; then
    echo "verify-image: 'debugfs' not on PATH" >&2
    echo "  Install: sudo apt-get install -y e2fsprogs" >&2
    exit 1
fi

# ---- Locate the root partition inside the .img -------------------------
# rpi-image-gen produces a two-partition MBR image:
#   p1 = FAT boot partition
#   p2 = ext4 root partition (16 KB blocks)
# losetup -Pf attaches the whole .img and exposes each partition as a
# separate loop device without mounting anything.
LOOP=""
cleanup() {
    set +e
    if [ -n "$LOOP" ]; then losetup -d "$LOOP" 2>/dev/null; fi
}
trap cleanup EXIT INT TERM

LOOP=$(losetup -Pf --show "$IMG")
EXT4_DEV="${LOOP}p2"

if [ ! -b "$EXT4_DEV" ]; then
    echo "verify-image: expected ext4 root partition at $EXT4_DEV" >&2
    echo "  losetup did not create the partition device. Either the .img" >&2
    echo "  has a different partition layout or -P (partition scanning)" >&2
    echo "  is not supported on this kernel." >&2
    exit 1
fi

# ---- Small helpers over debugfs ---------------------------------------
# debugfs -R runs a single command against the ext4 device and exits.
# Anything on stderr (except the version banner) is a warning; -w is not
# used, so we're strictly read-only against the .img.
EXT4="$EXT4_DEV"

# Return type via stdout: "regular", "symlink", "directory", or "missing".
# debugfs prints "Type: regular" (NOT "regular file"), "Type: symlink",
# "Type: directory". Match those exact strings -- getting this wrong makes
# every regular file look "missing" and the whole verification passes 0.
ext_type() {
    local path="$1"
    local out
    out=$(debugfs -R "stat $path" "$EXT4" 2>&1)
    if echo "$out" | grep -qE "Type: regular([[:space:]]|$)"; then echo "regular"
    elif echo "$out" | grep -qE "Type: symlink([[:space:]]|$)"; then echo "symlink"
    elif echo "$out" | grep -qE "Type: directory([[:space:]]|$)"; then echo "directory"
    else echo "missing"
    fi
}

# Read a symlink target from the ext4 (both fast-link and regular).
# debugfs prints fast links wrapped in double quotes, e.g.
#     Fast link dest: "/dev/null"
# so we strip the surrounding quotes before returning.
ext_readlink() {
    local path="$1"
    local out
    out=$(debugfs -R "stat $path" "$EXT4" 2>&1)
    local fast
    fast=$(echo "$out" | grep -oE "Fast link dest: .*" | sed -e 's/Fast link dest: //' -e 's/^"//' -e 's/"$//')
    if [ -n "$fast" ]; then
        printf '%s' "$fast"
        return 0
    fi
    # Long link: contents are readable via `cat`.
    debugfs -R "cat $path" "$EXT4" 2>/dev/null
}

# Byte-for-byte diff a baked file against a source file. Returns 0 on match.
ext_diff() {
    local path="$1" src="$2" tmp
    tmp=$(mktemp)
    debugfs -R "cat $path" "$EXT4" > "$tmp" 2>/dev/null
    if [ ! -s "$tmp" ]; then
        rm -f "$tmp"; return 1
    fi
    if diff -q "$tmp" "$src" > /dev/null 2>&1; then
        rm -f "$tmp"; return 0
    fi
    rm -f "$tmp"; return 1
}

echo
echo "================================================"
echo "  Verifying image against source"
echo "================================================"
echo "  Image:  $IMG"
echo "  Source: $SRC_DIR/layer/files/"
echo "  Loop:   $LOOP  (root=$EXT4)"
echo

failures=0
report_fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }
report_ok()   { echo "  OK:   $*"; }

# ---- Sanity probe: can debugfs even read the filesystem? ---------------
# If every check reports "missing", this block tells us WHY: debugfs
# may be silently failing on the 16 KB block size, the .img partition
# layout, or a debugfs version mismatch. Emitting the raw output here
# collapses N rounds of "add more logging" into one.
probe_out=$(debugfs -R "ls /usr/local/bin" "$EXT4" 2>&1 | head -5)
if ! echo "$probe_out" | grep -q "trailcurrent"; then
    echo "  DIAG: debugfs probe of /usr/local/bin returned:"
    printf '        %s\n' "$probe_out" | head -10
    echo "        (if this list is empty or looks wrong, debugfs is not"
    echo "         reading the ext4 partition -- see block-size / debugfs"
    echo "         version notes at top of this file)"
    echo
fi

# ---- 1. Critical scripts must match source byte-for-byte ---------------
# These are the files that ended up baked stale in the failed build that
# motivated this whole verification step. If ANY of them differ from
# source, the operator's edits haven't reached the image.
declare -a FILE_PAIRS=(
    "/usr/local/bin/trailcurrent-setup-ap.sh:layer/files/trailcurrent-setup-ap.sh"
    "/usr/local/bin/trailcurrent-firstboot.sh:layer/files/trailcurrent-firstboot.sh"
    "/usr/local/bin/trailcurrent-first-login.sh:layer/files/trailcurrent-first-login.sh"
    "/usr/local/bin/trailcurrent-load-images.sh:layer/files/trailcurrent-load-images.sh"
)
for pair in "${FILE_PAIRS[@]}"; do
    baked="${pair%%:*}"
    src="${pair##*:}"
    t=$(ext_type "$baked")
    if [ "$t" = "missing" ]; then
        report_fail "baked file missing: $baked"
    elif [ "$t" != "regular" ]; then
        report_fail "$baked is a $t, expected regular file"
    elif ! ext_diff "$baked" "$SRC_DIR/$src"; then
        report_fail "baked $baked does not match source $src"
    else
        report_ok "$baked matches source"
    fi
done

# ---- 2. Packages must be installed --------------------------------------
# Setup AP needs hostapd + dnsmasq + rfkill + iw. Missing any of them
# means the packages list in the layer YAML wasn't picked up.
for pkg_tool in \
    "/usr/sbin/hostapd:hostapd" \
    "/usr/sbin/dnsmasq:dnsmasq" \
    "/usr/sbin/rfkill:rfkill" \
    "/usr/sbin/iw:iw"
do
    path="${pkg_tool%%:*}"
    name="${pkg_tool##*:}"
    t=$(ext_type "$path")
    if [ "$t" = "missing" ]; then
        report_fail "package missing (not installed): $name  (expected $path)"
    else
        report_ok "package present: $name"
    fi
done

# ---- 3. Systemd units must be present AND enabled ----------------------
declare -a UNITS=(
    trailcurrent-firstboot.service
    trailcurrent-load-images.service
    trailcurrent-compose-up.service
    trailcurrent-setup-ap.service
    os-settings.service
    cantomqtt.service
    discovery-mdns.service
    deployment-watcher.service
)
for u in "${UNITS[@]}"; do
    unit_type=$(ext_type "/etc/systemd/system/$u")
    if [ "$unit_type" = "missing" ]; then
        report_fail "systemd unit missing: /etc/systemd/system/$u"
        continue
    fi
    link_type=$(ext_type "/etc/systemd/system/multi-user.target.wants/$u")
    if [ "$link_type" = "symlink" ]; then
        report_ok "unit enabled: $u"
    else
        report_fail "unit installed but not enabled: $u"
    fi
done

# ---- 4. WiFi is NOT disabled at the overlay level ----------------------
# The setup AP needs the WiFi radio active. `dtoverlay=disable-wifi` in
# config.txt kills wlan0 before userspace ever sees it.
#
# config.txt lives on the BOOT partition (FAT, p1), not root. Fetch it
# via mtools since we can't `cat` from vfat with debugfs.
CFG_TXT=$(mktemp)
# mtools can hang indefinitely on some loop-device geometries (waiting on
# stdin for a config-check prompt). Bound it hard so a wedged mcopy can
# never block the whole build.
#   MTOOLS_SKIP_CHECK=1  -- accept the FAT filesystem without asking
#   timeout 15           -- last-resort backstop if mtools still stalls
if command -v mcopy >/dev/null 2>&1; then
    MTOOLS_SKIP_CHECK=1 timeout 15 mcopy -n -i "${LOOP}p1" ::config.txt "$CFG_TXT" 2>/dev/null || true
fi
if [ ! -s "$CFG_TXT" ]; then
    report_fail "could not read config.txt from boot partition (install mtools?)"
elif grep -qE '^\s*dtoverlay=disable-wifi\s*$' "$CFG_TXT"; then
    report_fail "config.txt has 'dtoverlay=disable-wifi' -- setup AP cannot run"
else
    report_ok "config.txt does not disable WiFi"
fi
rm -f "$CFG_TXT"

# ---- 5. Default hostapd + dnsmasq services are masked ------------------
# Otherwise Debian's stock units race our custom one.
for masked_unit in hostapd.service dnsmasq.service; do
    p="/etc/systemd/system/$masked_unit"
    t=$(ext_type "$p")
    if [ "$t" != "symlink" ]; then
        report_fail "default $masked_unit is NOT masked (should be symlink to /dev/null; got $t)"
        continue
    fi
    target=$(ext_readlink "$p")
    if [ "$target" = "/dev/null" ]; then
        report_ok "default $masked_unit is masked"
    else
        report_fail "default $masked_unit symlinked to '$target', expected /dev/null"
    fi
done

echo

if [ "$failures" -gt 0 ]; then
    echo "================================================"
    echo "  IMAGE VERIFICATION FAILED ($failures problems)"
    echo "================================================"
    echo
    echo "  The built image will NOT boot into a working setup-AP state."
    echo "  DO NOT flash it -- fix the layer YAML / setup script and rebuild."
    echo
    echo "  Common causes:"
    echo "    * Stale chroot cached from a prior build"
    echo "      Fix: sudo rm -rf $SRC_DIR/../rpi-image-gen/work/chroot-v*"
    echo "    * Layer YAML missing 'install' hooks for new files"
    echo "      Fix: add a matching 'install -m 755 ...' line to the layer"
    echo "    * Package not added to layer YAML packages list"
    echo "      Fix: add the missing package name to 'mmdebstrap.packages'"
    echo "    * Unit not added to 'enable-units' line at the bottom"
    echo "      Fix: append the unit name to the enable-units invocation"
    exit 1
fi

echo "================================================"
echo "  IMAGE VERIFIED"
echo "================================================"
echo "  All critical files match source, packages installed, units enabled."
echo "  Safe to flash."
