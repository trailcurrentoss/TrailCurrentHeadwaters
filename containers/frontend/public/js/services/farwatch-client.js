// Browser-direct Farwatch API client. Used ONLY by Storage mode. All other
// data paths go through the local Overlook backend (WS + REST).
//
// Why direct: the whole point of Storage mode is that the user's rig is
// parked somewhere far from them and unreachable on their LAN. The PWA
// bundle is already cached on the phone by the service worker, and cloud
// credentials are cached in localStorage — so the PWA can pull remote
// telemetry from Farwatch without needing to reach Overlook at all.
//
// Credentials come from Overlook's system-config the first time Storage
// mode is opened (or Settings is saved). We cache them to localStorage
// so remote sessions work with a cold PWA.
//
// Auth: Farwatch accepts a raw API-key header — no "Bearer" prefix.
//   Authorization: rv_<hex>

import { API } from '../api.js';

const LS_KEY = 'overlook.farwatch.creds';
const POLL_MS_DEFAULT = 30000;

// Endpoints polled while Storage mode is visible. Each entry is
//   [key, path]  → result stored on this.data[key]
const POLL_ENDPOINTS = [
    ['energy',     '/api/energy'],
    ['water',      '/api/water'],
    ['airquality', '/api/airquality'],
    ['thermostat', '/api/thermostat'],
    ['level',      '/api/trailer/level'],
    ['settings',   '/api/settings'],       // last-sync timestamp lives here
    ['proximity',  '/api/proximity/status']
];

function readCredsFromStorage() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.url && parsed.apiKey) return parsed;
    } catch (_) {}
    return null;
}

function writeCredsToStorage(creds) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(creds));
    } catch (_) {}
}

/**
 * Refresh cloud credentials from Overlook's system-config and cache them.
 * Call this after Settings saves cloud config, or on Storage-mode init while
 * Overlook is still reachable. Fails silently if Overlook is offline — the
 * cached values from a previous session will still be used.
 */
export async function refreshCredsFromOverlook() {
    try {
        const cfg = await API.getSystemConfig();
        if (cfg && cfg.cloud_enabled && cfg.cloud_url && cfg.cloud_api_key) {
            writeCredsToStorage({
                url: cfg.cloud_url.replace(/\/+$/, ''),
                apiKey: cfg.cloud_api_key,
            });
            return true;
        }
    } catch (_) { /* Overlook offline — keep cached creds */ }
    return false;
}

export class FarwatchClient extends EventTarget {
    constructor({ pollMs = POLL_MS_DEFAULT } = {}) {
        super();
        this.pollMs = pollMs;
        this.creds = null;
        this.data = {};      // { energy: {...}, water: {...}, ... }
        this.status = 'idle'; // 'idle' | 'no-token' | 'polling' | 'online' | 'offline'
        this._pollTimer = null;
        this._inFlight = false;
    }

    async start() {
        // Try to top-up creds from Overlook (best-effort; ignored on failure).
        await refreshCredsFromOverlook();
        this.creds = readCredsFromStorage();
        if (!this.creds) {
            this._setStatus('no-token');
            return;
        }
        this._setStatus('polling');
        await this._pollOnce();
        this._pollTimer = setInterval(() => this._pollOnce(), this.pollMs);
    }

    stop() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    /**
     * Update Farwatch security config (arm/disarm). Returns true on success.
     */
    async setProximityConfig(patch) {
        if (!this.creds) return false;
        try {
            const res = await fetch(`${this.creds.url}/api/proximity/config`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.creds.apiKey,
                },
                body: JSON.stringify(patch),
            });
            if (!res.ok) return false;
            // Refresh proximity so the UI reflects the new state.
            const status = await this._fetchOne('/api/proximity/status');
            if (status !== undefined) this.data.proximity = status;
            this._emitChange();
            return true;
        } catch (_) {
            return false;
        }
    }

    _setStatus(s) {
        if (s === this.status) return;
        this.status = s;
        this.dispatchEvent(new CustomEvent('status', { detail: { status: s } }));
    }

    _emitChange() {
        this.dispatchEvent(new CustomEvent('change', {
            detail: { data: this.data, status: this.status }
        }));
    }

    async _fetchOne(path) {
        if (!this.creds) return undefined;
        try {
            const res = await fetch(`${this.creds.url}${path}`, {
                headers: { 'Authorization': this.creds.apiKey },
            });
            if (!res.ok) return undefined;
            return await res.json();
        } catch (_) {
            return undefined;
        }
    }

    async _pollOnce() {
        if (this._inFlight) return;
        this._inFlight = true;
        try {
            const results = await Promise.all(
                POLL_ENDPOINTS.map(([_key, path]) => this._fetchOne(path))
            );
            let anyOk = false;
            POLL_ENDPOINTS.forEach(([key], i) => {
                if (results[i] !== undefined) {
                    this.data[key] = results[i];
                    anyOk = true;
                }
            });
            this._setStatus(anyOk ? 'online' : 'offline');
            this._emitChange();
        } finally {
            this._inFlight = false;
        }
    }
}

// Shared singleton — used by the Storage page.
export const farwatchClient = new FarwatchClient();
