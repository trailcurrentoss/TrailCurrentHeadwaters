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

// Stable hardware ID for a detected camera. Prefer serial (unique across
// identical models plugged into different ports), fall back to bus path
// (stable per physical port), fall back to devPath (least stable — moves
// on reconnect).
function hwIdFor(cam) {
    if (cam.serial && cam.vendorId && cam.productId) {
        return `usb:${cam.vendorId}:${cam.productId}:${cam.serial}`;
    }
    if (cam.busPath && cam.vendorId && cam.productId) {
        return `usb:${cam.vendorId}:${cam.productId}@${cam.busPath}`;
    }
    return `dev:${cam.devPath}`;
}

// Public entry point. Returns an array of { hwId, name, vendor, model,
// devPath, vendorId, productId, busPath } suitable for both the
// "available" list and for persisting as a configured camera.
function listConnectedCameras() {
    let entries;
    try { entries = fs.readdirSync(V4L_CLASS); }
    catch { return []; }

    const nodes = entries
        .filter(n => /^video\d+$/.test(n))
        .map(readOneVideoNode);

    return dedupePerUsbDevice(nodes)
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
}

module.exports = { listConnectedCameras };
