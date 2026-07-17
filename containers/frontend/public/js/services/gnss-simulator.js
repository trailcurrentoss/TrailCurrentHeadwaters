// GNSS simulator — used for screen recordings so the map, driving dashboard,
// and any other latlon/gnss_details/alt consumer show a pinned "somewhere out
// west" location instead of the real vehicle position streamed in from Bearing.
//
// Mechanism: wraps wsClient.emit so that while simulation is active, any
// upstream Bearing GPS delivery ('latlon', 'gnss_details', 'alt') is dropped
// before it reaches subscribed listeners. In parallel, a 1 Hz interval calls
// the ORIGINAL emit with synthetic values, so listeners get the fixed fix
// without needing to know the simulator exists.
//
// State is persisted in localStorage so a page reload keeps recording sessions
// intact. UI (settings > Maps) toggles active state and edits the coordinates.
// map-display subscribes to onChange() to recolor the location dot.
//
// Location dot color: consumers can call getMarkerColor() to pick a paint
// color that reflects live vs. simulated state at any moment.

import { wsClient } from '../api.js';

const STORAGE_ACTIVE_KEY = 'tc.simulateLocation';
const STORAGE_COORDS_KEY = 'tc.simulateLocationCoords';

// Default fixed fix: Grand Teton area, Wyoming. Clearly out-west, unambiguously
// not the user's home coordinates, and thematically fitting for an RV product.
const DEFAULT_COORDS = { latitude: 43.6799, longitude: -110.7663 };

// Colors: keep the live blue in sync with the CSS for the map dot. The
// simulated color is a saturated orange that reads as "not live data" at a
// glance against any map background.
export const LIVE_MARKER_COLOR = '#4a90d9';
export const SIMULATED_MARKER_COLOR = '#ff6b35';

let active = false;
let coords = { ...DEFAULT_COORDS };
let intervalId = null;
let origEmit = null;
const listeners = new Set();

function loadPersisted() {
    try {
        active = localStorage.getItem(STORAGE_ACTIVE_KEY) === '1';
    } catch (_) { active = false; }
    try {
        const raw = localStorage.getItem(STORAGE_COORDS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number'
                && isFinite(parsed.latitude) && isFinite(parsed.longitude)) {
                coords = { latitude: parsed.latitude, longitude: parsed.longitude };
            }
        }
    } catch (_) { /* keep defaults */ }
}

function persist() {
    try {
        localStorage.setItem(STORAGE_ACTIVE_KEY, active ? '1' : '0');
        localStorage.setItem(STORAGE_COORDS_KEY, JSON.stringify(coords));
    } catch (_) { /* ignore quota */ }
}

// Install the interceptor once. When active is false the wrapper just forwards
// through the original emit, so leaving it installed 24/7 is free.
function installEmitInterceptor() {
    if (origEmit) return;
    origEmit = wsClient.emit.bind(wsClient);
    wsClient.emit = function(type, data) {
        if (active && (type === 'latlon' || type === 'gnss_details' || type === 'alt')) {
            return; // drop real Bearing GPS while simulating
        }
        return origEmit(type, data);
    };
}

function emitFake() {
    if (!origEmit) return;
    origEmit('latlon', {
        latitude: coords.latitude,
        longitude: coords.longitude
    });
    origEmit('gnss_details', {
        numberOfSatellites: 12,
        speedOverGround: 0,
        courseOverGround: 0,
        gnssMode: 1
    });
}

function startTicking() {
    stopTicking();
    // Fire once immediately so consumers get a fix without waiting a second.
    emitFake();
    intervalId = setInterval(emitFake, 1000);
}

function stopTicking() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

function notify() {
    const snapshot = { active, coords: { ...coords } };
    for (const cb of Array.from(listeners)) {
        try { cb(snapshot); } catch (err) {
            console.error('[gnss-simulator] listener error:', err);
        }
    }
}

export const gnssSimulator = {
    // Call once from app.js at startup, before any consumer subscribes.
    init() {
        loadPersisted();
        installEmitInterceptor();
        if (active) startTicking();
    },

    isActive() { return active; },
    getCoords() { return { ...coords }; },
    getDefaultCoords() { return { ...DEFAULT_COORDS }; },

    // Live vs. simulated marker color. Consumers pass this to
    // MapLibre's setPaintProperty when simulation state changes.
    getMarkerColor() {
        return active ? SIMULATED_MARKER_COLOR : LIVE_MARKER_COLOR;
    },

    setCoords(latitude, longitude) {
        if (typeof latitude !== 'number' || typeof longitude !== 'number'
            || !isFinite(latitude) || !isFinite(longitude)) return;
        coords = { latitude, longitude };
        persist();
        if (active) emitFake();
        notify();
    },

    enable() {
        active = true;
        persist();
        installEmitInterceptor();
        startTicking();
        notify();
    },

    disable() {
        active = false;
        persist();
        stopTicking();
        notify();
    },

    // Subscribe to state changes. Returns an unsubscribe function.
    onChange(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }
};
