'use strict';

// Enumerate USB / UVC video capture devices visible to the host by reading
// /host/sys/class/video4linux/. The backend container has /sys bind-mounted
// read-only (see docker-compose.yml → backend.volumes), so no privileged
// access is needed for detection. Live streaming later will require
// /dev/video* to be exposed via a `devices:` block in compose.

const fs = require('fs');
const path = require('path');

const V4L_CLASS = '/host/sys/class/video4linux';

function readTrim(p) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

// Walk up parent 'device' symlinks until we find one that exposes idVendor
// (i.e. the USB device node, not the interface node). Returns the resolved
// absolute host-side path or null.
function findUsbDeviceDir(startDir) {
    let cur = startDir;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(cur, 'idVendor'))) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        cur = parent;
    }
    return null;
}

// The USB device dir under /sys resolves to something like
// /host/sys/devices/platform/xhci-hcd.0.auto/usb1/1-1 — the trailing
// segment ("1-1", "3-2.4") is the physical bus path and is stable across
// reboots for the same physical port.
function busPathOf(usbDir) {
    if (!usbDir) return null;
    return path.basename(usbDir);
}

function readOneVideoNode(name) {
    const nodeDir = path.join(V4L_CLASS, name);
    const displayName = readTrim(path.join(nodeDir, 'name')) || name;
    // 'device' is a symlink to the USB interface. realpathSync resolves it
    // to the absolute /host/sys/devices/... path we can walk upward from.
    let ifaceDir;
    try { ifaceDir = fs.realpathSync(path.join(nodeDir, 'device')); }
    catch { ifaceDir = null; }
    const usbDir = ifaceDir ? findUsbDeviceDir(ifaceDir) : null;

    return {
        node: name,                             // e.g. "video0"
        devPath: `/dev/${name}`,                // path inside the container once /dev/video* is bind-mounted
        name: displayName,
        vendorId: usbDir ? readTrim(path.join(usbDir, 'idVendor')) : null,
        productId: usbDir ? readTrim(path.join(usbDir, 'idProduct')) : null,
        vendor: usbDir ? readTrim(path.join(usbDir, 'manufacturer')) : null,
        model: usbDir ? readTrim(path.join(usbDir, 'product')) : null,
        serial: usbDir ? readTrim(path.join(usbDir, 'serial')) : null,
        busPath: busPathOf(usbDir),
        usbDir,
    };
}

// A single UVC camera typically presents multiple /dev/videoN nodes
// (capture + metadata streams). Group by USB device dir and keep only the
// lowest-numbered node per camera — that's the primary capture interface.
//
// Non-USB video4linux nodes are dropped entirely. On Raspberry Pi the
// kernel exposes a large fleet of platform devices for the SoC's video
// pipeline — rpi-hevc-dec (hardware HEVC decoder), pispbe-* (PiSP
// back-end ISP: input, tdn_input, stitch_input, output0/1, tdn_output,
// stitch_output, config), etc. These are internal ISP/codec resources,
// not cameras a user would want to select. Requiring a USB device parent
// (i.e. an `idVendor` file up the sysfs chain) is the tightest simple
// filter that excludes them without also excluding future CSI cameras
// via /dev/media* — CSI is a separate concern and would go through a
// distinct detection path anyway.
function dedupePerUsbDevice(nodes) {
    const groups = new Map();
    for (const n of nodes) {
        if (!n.usbDir) continue;
        const list = groups.get(n.usbDir) || [];
        list.push(n);
        groups.set(n.usbDir, list);
    }
    const primary = [];
    for (const list of groups.values()) {
        list.sort((a, b) => {
            const na = parseInt(a.node.replace('video', ''), 10);
            const nb = parseInt(b.node.replace('video', ''), 10);
            return na - nb;
        });
        primary.push(list[0]);
    }
    return primary;
}

// Not every UVC module assigns a real per-unit serial. Some burn a single
// constant into every unit off the line — the Arducam B0590 reports
// "SN0001" on all of them. Trusting one of those produces an identical
// hwId for two physically distinct cameras, which silently collapses them
// into one entry: after adding the first, the second vanishes from the
// "available" list (it is filtered out by matching hwId) and a direct add
// is rejected 409 "Camera already added".
//
// So a serial is only honoured when it looks like a genuine per-unit
// identifier. That test runs on the serial value alone — deliberately NOT
// on whether a duplicate is currently visible — so a camera's hwId is a
// pure function of that camera. Identity must not shift based on what else
// happens to be plugged in at the time; otherwise unplugging one of a pair
// would re-identify the other and orphan its stored configuration.

// Placeholder values seen in the wild in place of a real serial.
const GENERIC_SERIALS = new Set([
    'NOSERIAL', 'NONE', 'NULL', 'DEFAULT', 'SERIAL', 'UNKNOWN',
]);

// Minimum length for the meaningful part of a serial. Genuine UVC serials
// are alphanumeric runs comfortably longer than this (the Logitech C920
// reports "3D486C6F"), so this errs toward distrust: a false negative here
// costs only port-bound identity, while a false positive re-opens the
// collision bug above.
const MIN_SERIAL_LEN = 6;

// Reduce a raw serial to the part that would actually distinguish two
// units: uppercased, punctuation stripped, a leading serial-number label
// ("SN", "S/N", "SERIAL") removed, and leading zeros dropped. This renders
// the Arducam's "SN0001" as "1", and the common firmware-version-shaped
// pseudo-serial "01.00.00" as "10000" — neither long enough to be real.
function meaningfulSerialPart(serial) {
    return String(serial)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .replace(/^(?:SN|SERIAL)/, '')
        .replace(/^0+/, '');
}

// True for strings that are a single repeated character ("AAAAAA") or a
// strictly ascending decimal run ("123456") — placeholder shapes rather
// than factory-assigned identifiers.
function isDegenerateRun(s) {
    if (/^(.)\1*$/.test(s)) return true;
    if (/^\d+$/.test(s)) {
        for (let i = 1; i < s.length; i++) {
            if (s.charCodeAt(i) !== s.charCodeAt(i - 1) + 1) return false;
        }
        return true;
    }
    return false;
}

function isTrustworthySerial(serial) {
    if (!serial) return false;
    const core = meaningfulSerialPart(serial);
    if (core.length < MIN_SERIAL_LEN) return false;
    if (GENERIC_SERIALS.has(core)) return false;
    return !isDegenerateRun(core);
}

// Stable hardware ID for a detected camera. Prefer a trustworthy serial
// (survives the camera being moved to a different port), fall back to bus
// path (stable per physical port across reboots, and necessarily unique
// between two simultaneously-connected cameras), fall back to devPath
// (least stable — moves on reconnect).
function hwIdFor(cam) {
    if (cam.vendorId && cam.productId && isTrustworthySerial(cam.serial)) {
        return `usb:${cam.vendorId}:${cam.productId}:${cam.serial}`;
    }
    if (cam.busPath && cam.vendorId && cam.productId) {
        return `usb:${cam.vendorId}:${cam.productId}@${cam.busPath}`;
    }
    return `dev:${cam.devPath}`;
}

// Two cameras can never share a bus path, so a surviving duplicate means
// two units reported the same serial and it passed isTrustworthySerial —
// i.e. a placeholder shape the rules above don't recognise yet. That still
// hides a camera, so report it loudly instead of failing silently the way
// the original collision did.
//
// Note this is NOT resolvable by the operator: the colliding hwIds are
// computed from each camera's own attributes, so removing and re-adding the
// configured cameras changes nothing. It needs the offending serial added
// to the rules above. The UI copy has to say that rather than send someone
// round a loop that cannot help.
const warnedCollisions = new Set();

// Returns one entry per colliding hwId: { hwId, model, vendorId, productId,
// devPaths, busPaths }. Empty array in the normal case.
function findDuplicateHwIds(cams) {
    const byId = new Map();
    for (const cam of cams) {
        const list = byId.get(cam.hwId) || [];
        list.push(cam);
        byId.set(cam.hwId, list);
    }

    const conflicts = [];
    for (const [hwId, list] of byId) {
        if (list.length < 2) continue;
        conflicts.push({
            hwId,
            model: list[0].model || list[0].name || null,
            vendorId: list[0].vendorId,
            productId: list[0].productId,
            devPaths: list.map(c => c.devPath),
            busPaths: list.map(c => c.busPath),
        });
        if (warnedCollisions.has(hwId)) continue;
        warnedCollisions.add(hwId);
        console.warn(
            `[camera-detect] duplicate hwId ${hwId} shared by ` +
            `${list.map(c => c.devPath).join(', ')} — only one is selectable. ` +
            `These units appear to report a shared placeholder serial; add it ` +
            `to the generic-serial rules in camera-detect.js so they fall back ` +
            `to bus-path identity.`
        );
    }
    return conflicts;
}

// Public entry point. Returns { cameras, conflicts }, where cameras is an
// array of { hwId, name, vendor, model, devPath, vendorId, productId,
// busPath } suitable for both the "available" list and for persisting as a
// configured camera, and conflicts describes any hwId collisions the rules
// above failed to separate (see findDuplicateHwIds).
function detectCameras() {
    let entries;
    try { entries = fs.readdirSync(V4L_CLASS); }
    catch { return { cameras: [], conflicts: [] }; }

    const nodes = entries
        .filter(n => /^video\d+$/.test(n))
        .map(readOneVideoNode);

    const cameras = dedupePerUsbDevice(nodes)
        .map(cam => ({
            hwId: hwIdFor(cam),
            name: cam.model || cam.name,
            vendor: cam.vendor,
            model: cam.model,
            devPath: cam.devPath,
            vendorId: cam.vendorId,
            productId: cam.productId,
            busPath: cam.busPath,
        }))
        .sort((a, b) => a.devPath.localeCompare(b.devPath));

    return { cameras, conflicts: findDuplicateHwIds(cameras) };
}

// Convenience wrapper for the many call sites that only need the list.
function listConnectedCameras() {
    return detectCameras().cameras;
}

module.exports = { listConnectedCameras, detectCameras };
