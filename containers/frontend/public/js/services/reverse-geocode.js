// Browser-side reverse-geocode client. Calls /api/geocode/reverse which is
// proxied by the Overlook backend to the offline geocoder container.
//
// Two layers of caching:
//   * In-memory LRU keyed by ~500m tiles (0.005 degrees) — the common case
//     while the rig is parked or moving slowly; same tile → cache hit.
//   * localStorage — survives page reloads (RV boots come and go without
//     internet, and we want the greeting to render instantly even offline).
//
// Both caches are keyed to a lat/lon *tile*, not exact coords. This means
// small GNSS jitter doesn't miss the cache, and city-level answers are the
// same across the tile anyway.

import { API } from '../api.js';

const TILE_DEGREES = 0.005;   // ~500 m at the equator
const MEMORY_MAX = 32;
const LS_KEY_PREFIX = 'overlook.geocode.';
const LS_MAX = 128;

const memoryCache = new Map();  // Map<tileKey, {place, region, country, cc, ts}>

function tileKey(lat, lon) {
    const tLat = Math.round(lat / TILE_DEGREES) * TILE_DEGREES;
    const tLon = Math.round(lon / TILE_DEGREES) * TILE_DEGREES;
    return `${tLat.toFixed(3)},${tLon.toFixed(3)}`;
}

function memGet(key) {
    if (!memoryCache.has(key)) return null;
    const value = memoryCache.get(key);
    // Touch for LRU
    memoryCache.delete(key);
    memoryCache.set(key, value);
    return value;
}

function memSet(key, value) {
    memoryCache.set(key, value);
    while (memoryCache.size > MEMORY_MAX) {
        const oldestKey = memoryCache.keys().next().value;
        memoryCache.delete(oldestKey);
    }
}

function lsGet(key) {
    try {
        const raw = localStorage.getItem(LS_KEY_PREFIX + key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function lsSet(key, value) {
    try {
        localStorage.setItem(LS_KEY_PREFIX + key, JSON.stringify(value));
        pruneLs();
    } catch (_) {
        // quota exceeded — prune aggressively and retry once
        pruneLs(true);
        try { localStorage.setItem(LS_KEY_PREFIX + key, JSON.stringify(value)); } catch (_) {}
    }
}

function pruneLs(aggressive = false) {
    let keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_KEY_PREFIX)) keys.push(k);
    }
    if (keys.length <= LS_MAX && !aggressive) return;
    // Drop oldest by insertion order (localStorage doesn't guarantee it, but
    // in practice most engines return in insertion order for our own prefix).
    const dropCount = aggressive ? Math.max(1, Math.floor(keys.length / 2))
                                 : keys.length - LS_MAX;
    for (let i = 0; i < dropCount; i++) {
        try { localStorage.removeItem(keys[i]); } catch (_) {}
    }
}

/**
 * Reverse-geocode a lat/lon to a { place, region, country, cc } record.
 * Returns null if the network call fails and no cached value exists.
 *
 * Callers should treat null as "no answer yet" and try again on the next
 * GNSS update rather than showing a permanent error.
 */
export async function reverseGeocode(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number'
        || Number.isNaN(lat) || Number.isNaN(lon)) return null;

    const key = tileKey(lat, lon);
    const mem = memGet(key);
    if (mem) return mem;

    const ls = lsGet(key);
    if (ls) {
        memSet(key, ls);
        return ls;
    }

    try {
        // Route through API.request so the Bearer token from AuthStore is
        // attached — bare fetch() would 401 because the backend guards
        // /api/geocode behind authMiddleware.
        const data = await API.request(
            `/geocode/reverse?lat=${lat}&lon=${lon}`
        );
        if (!data || !data.place) return null;
        const record = {
            place: data.place,
            region: data.region || '',
            country: data.country || '',
            cc: data.cc || '',
            ts: Date.now(),
        };
        memSet(key, record);
        lsSet(key, record);
        return record;
    } catch (_) {
        return null;
    }
}

/**
 * Format a geocoded record for display. Prefers "City, State" for US,
 * "City, Country" for elsewhere.
 */
export function formatPlace(record) {
    if (!record || !record.place) return '';
    if (record.cc === 'US' && record.region) {
        return `${record.place}, ${record.region}`;
    }
    if (record.country) {
        return `${record.place}, ${record.country}`;
    }
    return record.place;
}
