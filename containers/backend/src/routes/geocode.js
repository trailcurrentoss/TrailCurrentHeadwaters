// Geocode proxy routes — forward to the offline geocoder and nominatim
// containers. The browser never talks to either container directly; nginx
// proxies /api/geocode/* here, and this router proxies to the internal
// Docker bridge (http://geocoder:8000/ for reverse/nearby lookups,
// http://nominatim:8080/ for forward search). Keeps CORS simple, hides
// the internal service topology, and gives us a place to cache / rate-limit
// at the Overlook layer if we ever need to.
//
// Query: GET /api/geocode/reverse?lat=<f>&lon=<f>
// Returns: 200 { place, region, country, cc, distance_km }
//          404 { error: 'no match' }
//          502 { error: 'geocoder unreachable' }
//
// Query: GET /api/geocode/nearby?lat=<f>&lon=<f>&limit=<n>&radius_km=<f>
// Returns: 200 { results: [{ place, region, country, cc, distance_km }, ...] }
//          502 { error: 'geocoder unreachable' }
//
// Query: GET /api/geocode/search?q=<text>&limit=<n>&viewbox=<w,n,e,s>&bounded=<0|1>
// Returns: 200 { results: [{ display_name, lat, lon, type, class, importance, bbox }, ...] }
//          400 { error: 'q required' }
//          502 { error: 'nominatim unreachable' }

const express = require('express');
const router = express.Router();
const http = require('http');

const GEOCODER_HOST = process.env.GEOCODER_HOST || 'geocoder';
const GEOCODER_PORT = parseInt(process.env.GEOCODER_PORT || '8000', 10);
const NOMINATIM_HOST = process.env.NOMINATIM_HOST || 'nominatim';
const NOMINATIM_PORT = parseInt(process.env.NOMINATIM_PORT || '8080', 10);

function proxyGet(path) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: GEOCODER_HOST, port: GEOCODER_PORT, path, timeout: 3000 },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(body) });
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('geocoder timeout'));
        });
    });
}

function nominatimGet(path) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            {
                host: NOMINATIM_HOST,
                port: NOMINATIM_PORT,
                path,
                timeout: 5000,
                headers: { 'User-Agent': 'TrailCurrent-Headwaters/1.0' }
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(body) });
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('nominatim timeout'));
        });
    });
}

module.exports = () => {
    router.get('/reverse', async (req, res) => {
        const { lat, lon } = req.query;
        if (lat === undefined || lon === undefined) {
            return res.status(400).json({ error: 'lat and lon required' });
        }
        const latN = Number(lat);
        const lonN = Number(lon);
        if (Number.isNaN(latN) || Number.isNaN(lonN)) {
            return res.status(400).json({ error: 'lat and lon must be numbers' });
        }
        try {
            const { status, body } = await proxyGet(
                `/reverse?lat=${encodeURIComponent(latN)}&lon=${encodeURIComponent(lonN)}`
            );
            res.status(status).json(body);
        } catch (err) {
            console.error('[geocode] proxy error:', err.message);
            res.status(502).json({ error: 'geocoder unreachable' });
        }
    });

    // Forward-geocode / autocomplete-style search via Nominatim.
    // Query: GET /api/geocode/search?q=<text>&limit=<n>&viewbox=<w,s,e,n>&bounded=<0|1>
    // Returns: 200 { results: [{ display_name, lat, lon, type, class, importance, bbox }, ...] }
    //          400 { error: 'q required' }
    //          502 { error: 'nominatim unreachable' }
    router.get('/search', async (req, res) => {
        const { q, limit, viewbox, bounded } = req.query;
        if (!q || typeof q !== 'string' || q.trim().length === 0) {
            return res.status(400).json({ error: 'q required' });
        }
        const limitN = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 20);
        const qs = [
            `q=${encodeURIComponent(q.trim())}`,
            `format=jsonv2`,
            `limit=${limitN}`,
            `addressdetails=1`
        ];
        if (viewbox && typeof viewbox === 'string') {
            qs.push(`viewbox=${encodeURIComponent(viewbox)}`);
            if (bounded === '1' || bounded === 'true') qs.push(`bounded=1`);
        }
        try {
            const { status, body } = await nominatimGet(`/search?${qs.join('&')}`);
            if (status !== 200 || !Array.isArray(body)) {
                return res.status(status || 502).json({ error: 'nominatim error', body });
            }
            const results = body.map((r) => ({
                display_name: r.display_name,
                lat: Number(r.lat),
                lon: Number(r.lon),
                type: r.type,
                class: r.class,
                importance: r.importance,
                bbox: Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null
            }));
            res.status(200).json({ results });
        } catch (err) {
            console.error('[geocode] nominatim proxy error:', err.message);
            res.status(502).json({ error: 'nominatim unreachable' });
        }
    });

    router.get('/nearby', async (req, res) => {
        const { lat, lon, limit, radius_km } = req.query;
        if (lat === undefined || lon === undefined) {
            return res.status(400).json({ error: 'lat and lon required' });
        }
        const latN = Number(lat);
        const lonN = Number(lon);
        if (Number.isNaN(latN) || Number.isNaN(lonN)) {
            return res.status(400).json({ error: 'lat and lon must be numbers' });
        }
        const qs = [`lat=${encodeURIComponent(latN)}`, `lon=${encodeURIComponent(lonN)}`];
        if (limit !== undefined) qs.push(`limit=${encodeURIComponent(limit)}`);
        if (radius_km !== undefined) qs.push(`radius_km=${encodeURIComponent(radius_km)}`);
        try {
            const { status, body } = await proxyGet(`/nearby?${qs.join('&')}`);
            res.status(status).json(body);
        } catch (err) {
            console.error('[geocode] proxy error:', err.message);
            res.status(502).json({ error: 'geocoder unreachable' });
        }
    });

    return router;
};
