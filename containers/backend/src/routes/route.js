// Routing proxy routes — forward to the local Valhalla container. Reads
// pre-built routing tiles bind-mounted from data/maps/current/valhalla_tiles/.
// The browser never talks to Valhalla directly; nginx proxies /api/route*
// here, this router forwards to http://valhalla:8002/ on the internal
// compose bridge, and we return Valhalla's JSON responses largely as-is
// (Valhalla's schema is already a good client-facing shape).
//
// POST /api/route
//   Body: { locations: [{lat, lon, type?}, ...], costing: "auto"|"pedestrian"|... }
//   Returns: 200 Valhalla /route response (trip.summary, legs, maneuvers, ...)
//            400 { error: 'invalid request' }
//            503 { status: 'no-bundle', message: 'No map data installed' }
//            502 { error: 'valhalla unreachable' }
//
// POST /api/route/matrix
//   Body: { sources: [{lat,lon}], targets: [{lat,lon}], costing }
//   Returns: 200 Valhalla /sources_to_targets response
//            400/502/503 as above

const express = require('express');
const router = express.Router();
const http = require('http');
const fs = require('fs');
const path = require('path');

const VALHALLA_HOST = process.env.VALHALLA_HOST || 'valhalla';
const VALHALLA_PORT = parseInt(process.env.VALHALLA_PORT || '8002', 10);
const MAPS_ROOT = process.env.MAPS_STORAGE_PATH || '/app/maps';
const CURRENT_LINK = path.join(MAPS_ROOT, 'current');
const VALHALLA_TILES_DIR = path.join(CURRENT_LINK, 'valhalla_tiles');

function noBundleInstalled() {
    try {
        return !fs.existsSync(VALHALLA_TILES_DIR);
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

// POST JSON body to Valhalla and stream the response back.
function valhallaPost(pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        const req = http.request({
            host: VALHALLA_HOST,
            port: VALHALLA_PORT,
            path: pathname,
            method: 'POST',
            timeout: 20000,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
            }
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
                } catch (e) {
                    reject(new Error(
                        `valhalla returned non-JSON (status ${res.statusCode}): ${raw.slice(0, 200)}`
                    ));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('valhalla timeout')));
        req.write(payload);
        req.end();
    });
}

// Client sends the more forgiving shape {locations: [{lat, lon, ...}]}; Valhalla
// requires locations in the same shape (already {lat, lon}). This function
// exists to validate + narrow, not to translate.
function normalizeLocations(locations) {
    if (!Array.isArray(locations) || locations.length < 2) return null;
    const out = [];
    for (const l of locations) {
        if (!l || typeof l.lat !== 'number' || typeof l.lon !== 'number') return null;
        const rec = { lat: l.lat, lon: l.lon };
        if (l.type) rec.type = l.type;                // "break" | "through" | "via"
        if (l.name) rec.name = l.name;                // shows up in the maneuver text
        if (l.heading !== undefined) rec.heading = Number(l.heading);
        out.push(rec);
    }
    return out;
}

const ALLOWED_COSTINGS = new Set([
    'auto', 'bicycle', 'bus', 'motor_scooter', 'motorcycle',
    'pedestrian', 'truck', 'taxi'
]);

module.exports = () => {
    // POST /api/route
    router.post('/', async (req, res) => {
        const body = req.body || {};
        const locations = normalizeLocations(body.locations);
        if (!locations) {
            return res.status(400).json({
                error: 'invalid request',
                detail: 'locations must be an array of at least two {lat, lon} objects'
            });
        }
        const costing = ALLOWED_COSTINGS.has(body.costing) ? body.costing : 'auto';
        if (noBundleInstalled()) return noBundleResponse(res);

        const request = {
            locations,
            costing,
            // Return language-specific narrative and full maneuver detail so
            // the turn-list panel can render without a follow-up call.
            directions_options: { units: 'miles' },
            // Optional per-mode options can be layered in from the client:
            costing_options: body.costing_options || undefined,
            // Pass through the client's ID for correlation on the wire.
            id: body.id
        };

        try {
            const { status, body: resp } = await valhallaPost('/route', request);
            if (status !== 200 || !resp) {
                return res.status(status || 502).json({
                    error: 'valhalla error',
                    detail: resp
                });
            }
            return res.status(200).json(resp);
        } catch (err) {
            console.error('[route] valhalla proxy error:', err.message);
            return res.status(502).json({ error: 'valhalla unreachable' });
        }
    });

    // POST /api/route/matrix
    router.post('/matrix', async (req, res) => {
        const body = req.body || {};
        const sources = normalizeLocations(body.sources);
        const targets = normalizeLocations(body.targets);
        if (!sources || !targets) {
            return res.status(400).json({
                error: 'invalid request',
                detail: 'sources and targets must be arrays of {lat, lon}'
            });
        }
        const costing = ALLOWED_COSTINGS.has(body.costing) ? body.costing : 'auto';
        if (noBundleInstalled()) return noBundleResponse(res);

        try {
            const { status, body: resp } = await valhallaPost('/sources_to_targets', {
                sources, targets, costing,
                id: body.id
            });
            if (status !== 200 || !resp) {
                return res.status(status || 502).json({
                    error: 'valhalla error',
                    detail: resp
                });
            }
            return res.status(200).json(resp);
        } catch (err) {
            console.error('[route] valhalla matrix proxy error:', err.message);
            return res.status(502).json({ error: 'valhalla unreachable' });
        }
    });

    return router;
};
