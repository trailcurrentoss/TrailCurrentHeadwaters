// Geocode proxy routes — forward search and reverse to the local Photon
// container. Photon reads a pre-built index bind-mounted from the currently-
// applied map bundle (data/maps/current/photon_data/). The browser never
// talks to Photon directly; nginx proxies /api/geocode/* here, this router
// proxies to http://photon:2322/ on the internal Docker bridge, and we
// translate Photon's GeoJSON to the flat shape the frontend expects.
//
// Query: GET /api/geocode/reverse?lat=<f>&lon=<f>[&radius_km=<f>]
// Returns: 200 { place, region, country, cc, distance_km }
//          404 { error: 'no match' }
//          503 { status: 'no-bundle', message: 'No map data installed' }
//          502 { error: 'photon unreachable' }
//
// Query: GET /api/geocode/search?q=<text>[&limit=<n>][&viewbox=<w,n,e,s>][&bounded=<0|1>]
// Returns: 200 { results: [{ display_name, lat, lon, type, class, importance, bbox, ... }, ...] }
//          400 { error: 'q required' }
//          503 { status: 'no-bundle', message: 'No map data installed' }
//          502 { error: 'photon unreachable' }
//
// Location bias: when the vehicle has a recent GPS fix (Bearing publishes
// on local/gps/latlon), /search calls are decorated with lat=&lon= so
// nearby matches rank higher. Global matches are still returned — a search
// for "Berlin" from Colorado still finds Berlin, Germany.

const express = require('express');
const router = express.Router();
const http = require('http');
const fs = require('fs');
const path = require('path');
const mqttService = require('../mqtt');

const PHOTON_HOST = process.env.PHOTON_HOST || 'photon';
const PHOTON_PORT = parseInt(process.env.PHOTON_PORT || '2322', 10);
const MAPS_ROOT = process.env.MAPS_STORAGE_PATH || '/app/maps';
const CURRENT_LINK = path.join(MAPS_ROOT, 'current');
const PHOTON_DATA_DIR = path.join(CURRENT_LINK, 'photon_data');

function noBundleInstalled() {
    // Local FS probe rather than an HTTP round-trip to Photon — Photon's
    // container may still be starting after a fresh bundle apply, but the
    // presence of the extracted photon_data directory is the authoritative
    // signal that a bundle is installed.
    try {
        return !fs.existsSync(PHOTON_DATA_DIR);
    } catch (_) {
        return true;
    }
}

function noBundleResponse(res) {
    return res.status(503).json({
        status: 'no-bundle',
        message: 'No map data installed'
    });
}

function photonGet(path) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: PHOTON_HOST, port: PHOTON_PORT, path, timeout: 10000 },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
                    } catch (e) {
                        reject(new Error(
                            `photon returned non-JSON (status ${res.statusCode}): ${body.slice(0, 200)}`
                        ));
                    }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('photon timeout')));
    });
}

// Haversine distance in kilometers. Photon doesn't return distance to the
// reverse-geocode input point, so we compute it here to preserve the
// existing /reverse response contract.
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Compose a human-readable single-line display string from Photon's split
// address fields. Nominatim's `display_name` came pre-composed; Photon
// exposes structured fields, so the frontend gets an equivalent line.
//
// Deduping notes:
// - Photon sometimes sets `name` to the literal address ("10 Downing
//   Street"). In that case do NOT append the housenumber+street again —
//   just use the name once.
// - Sometimes `city` equals `name` (a settlement's own entry); skip.
// - Sometimes `state` equals `city` (city-state); skip.
function composeDisplayName(p) {
    const parts = [];
    const address = p.housenumber && p.street
        ? `${p.housenumber} ${p.street}`
        : (p.street || null);
    if (p.name) parts.push(p.name);
    if (address && address !== p.name) parts.push(address);
    if (p.city && p.city !== p.name && p.city !== address) parts.push(p.city);
    if (p.state && p.state !== p.city) parts.push(p.state);
    if (p.country && p.country !== p.state) parts.push(p.country);
    return parts.join(', ');
}

// Translate a Photon feature to the flat shape the frontend already
// understands. Preserves both /search-style fields (display_name, lat,
// lon, type, class, importance, bbox) and /reverse-style fields (place,
// region, country, cc) on the same object — callers pick what they need.
function flattenFeature(feature) {
    const p = feature.properties || {};
    const g = feature.geometry || {};
    const coords = g.coordinates || [null, null];
    // Photon's extent is [minLon, maxLat, maxLon, minLat] i.e. [west, north,
    // east, south]. The PWA's map-display component expects the Nominatim
    // convention [south, north, west, east] for bbox and then feeds it into
    // maplibregl.fitBounds as [[west, south], [east, north]]. Translating
    // here keeps the frontend contract stable — anywhere that consumed
    // Nominatim's boundingbox continues to work unchanged.
    let bbox = null;
    if (Array.isArray(p.extent) && p.extent.length === 4) {
        const [w, n, e, s] = p.extent;
        bbox = [s, n, w, e];
    }
    return {
        display_name: composeDisplayName(p),
        lat: coords[1],
        lon: coords[0],
        type: p.type,
        class: p.osm_key,
        importance: 1.0,          // Photon doesn't expose Nominatim's importance
        bbox,
        place: p.name || p.city || p.state || null,
        region: p.state || null,
        country: p.country || null,
        cc: p.countrycode || null,
        // Structured fields — kept alongside the flat display_name so the
        // frontend can render per-field UI (e.g. an "(approximate)" hint
        // when the query asked for a housenumber the OSM data doesn't have).
        housenumber: p.housenumber || null,
        street: p.street || null,
        city: p.city || null,
        osm_type: p.osm_type,
        osm_id: p.osm_id
    };
}

// If the user's query started with a numeric token, they were almost
// certainly looking for a specific house address. When Photon can only
// give us a street/POI/city (no housenumber in the result), the returned
// coordinate is a centroid — near but not at the address. Annotate the
// result so the frontend can surface that honestly.
function requestedHousenumber(q) {
    const m = /^\s*(\d+)\s+\S/.exec(q || '');
    return m ? m[1] : null;
}

module.exports = () => {
    // GET /api/geocode/reverse?lat=&lon=[&radius_km=]
    router.get('/reverse', async (req, res) => {
        const { lat, lon, radius_km } = req.query;
        if (lat === undefined || lon === undefined) {
            return res.status(400).json({ error: 'lat and lon required' });
        }
        const latN = Number(lat);
        const lonN = Number(lon);
        if (Number.isNaN(latN) || Number.isNaN(lonN)) {
            return res.status(400).json({ error: 'lat and lon must be numbers' });
        }
        if (noBundleInstalled()) return noBundleResponse(res);

        const qs = [
            `lat=${encodeURIComponent(latN)}`,
            `lon=${encodeURIComponent(lonN)}`,
            `limit=1`,
            `lang=en`
        ];
        if (radius_km !== undefined) {
            const r = Number(radius_km);
            if (!Number.isNaN(r) && r > 0) qs.push(`radius=${encodeURIComponent(r)}`);
        }
        try {
            const { status, body } = await photonGet(`/reverse?${qs.join('&')}`);
            if (status !== 200 || !body || !Array.isArray(body.features)) {
                return res.status(502).json({ error: 'photon error', status, body });
            }
            if (body.features.length === 0) {
                return res.status(404).json({ error: 'no match' });
            }
            const f = flattenFeature(body.features[0]);
            const distance_km = (f.lat !== null && f.lon !== null)
                ? haversineKm(latN, lonN, f.lat, f.lon)
                : null;
            return res.status(200).json({
                place: f.place,
                region: f.region,
                country: f.country,
                cc: f.cc,
                distance_km
            });
        } catch (err) {
            console.error('[geocode] photon reverse error:', err.message);
            return res.status(502).json({ error: 'photon unreachable' });
        }
    });

    // GET /api/geocode/search?q=&limit=&viewbox=&bounded=
    // Automatically adds &lat=&lon= from the vehicle's most-recent GPS fix
    // if available. Photon uses them for ranking bias only — distant matches
    // are still returned.
    router.get('/search', async (req, res) => {
        const { q, limit, viewbox, bounded } = req.query;
        if (!q || typeof q !== 'string' || q.trim().length === 0) {
            return res.status(400).json({ error: 'q required' });
        }
        if (noBundleInstalled()) return noBundleResponse(res);

        const limitN = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 20);
        const qs = [
            `q=${encodeURIComponent(q.trim())}`,
            `limit=${limitN}`,
            `lang=en`
        ];

        // Location bias precedence:
        //   1. Vehicle GPS from Bearing over MQTT (this.currentPosition on the
        //      client → mqttService.lastGpsLatLon on the backend). Best signal:
        //      "where the RV actually is right now."
        //   2. Center of the viewbox the frontend just sent. When a user has
        //      panned to New York on their laptop and searches "500 5th Ave",
        //      the viewbox is roughly Manhattan — biasing to that center
        //      surfaces the Manhattan match instead of "500 Fifth Avenue,
        //      Owego, NY" or "Fifth Ave, some other tiny town."
        //   3. Nothing — Photon's default global ranking.
        // Photon uses the coordinates for RANKING bias only; distant matches
        // are still returned. "Berlin" searched from Colorado still finds
        // Berlin, Germany — just after any Berlin nearby.
        let biasLat = null, biasLon = null;
        const gps = mqttService.lastGpsLatLon;
        if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
            biasLat = gps.latitude;
            biasLon = gps.longitude;
        } else if (viewbox && typeof viewbox === 'string') {
            const vparts = viewbox.split(',').map(Number);
            if (vparts.length === 4 && vparts.every(n => !Number.isNaN(n))) {
                const [w, n, e, s] = vparts;
                biasLat = (n + s) / 2;
                biasLon = (w + e) / 2;
            }
        }
        if (biasLat !== null && biasLon !== null) {
            qs.push(`lat=${encodeURIComponent(biasLat)}`);
            qs.push(`lon=${encodeURIComponent(biasLon)}`);
        }

        // Optional hard bbox restriction (kept as a Nominatim-compat surface).
        // Photon accepts `bbox=minLon,minLat,maxLon,maxLat`. Only kicks in
        // when the caller explicitly asks for bounded=1 — the location bias
        // above is a soft rank push, this is a hard filter.
        if (viewbox && typeof viewbox === 'string') {
            const parts = viewbox.split(',').map(Number);
            if (parts.length === 4 && parts.every(n => !Number.isNaN(n))) {
                const [w, n, e, s] = parts;
                if (bounded === '1' || bounded === 'true') {
                    qs.push(`bbox=${encodeURIComponent(`${w},${s},${e},${n}`)}`);
                }
            }
        }

        try {
            const { status, body } = await photonGet(`/api?${qs.join('&')}`);
            if (status !== 200 || !body || !Array.isArray(body.features)) {
                return res.status(status || 502).json({ error: 'photon error', body });
            }
            // If the user's query started with a housenumber, mark any result
            // that DIDN'T come back with a matching housenumber as approximate
            // so the frontend can render "(approximate — street center)"
            // instead of pretending the pin is exact. This is data-driven —
            // when OSM has the address, results include it; when it doesn't,
            // Photon degrades to the street/POI and we flag that honestly.
            const askedHn = requestedHousenumber(q);
            const results = body.features.map(flattenFeature).map((r) => {
                if (askedHn && !r.housenumber) {
                    return { ...r, approximate: true, requested_housenumber: askedHn };
                }
                return r;
            });
            return res.status(200).json({ results });
        } catch (err) {
            console.error('[geocode] photon search error:', err.message);
            return res.status(502).json({ error: 'photon unreachable' });
        }
    });

    return router;
};
