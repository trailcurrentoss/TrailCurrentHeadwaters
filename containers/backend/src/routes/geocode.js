// Reverse-geocode proxy — forwards to the offline geocoder container.
//
// The browser never talks to the geocoder container directly; nginx proxies
// /api/geocode/reverse here and this route proxies to http://geocoder:8000/
// on the Docker bridge network. This keeps CORS simple, hides the internal
// service topology, and lets us cache / rate-limit at the Overlook layer
// if we ever need to.
//
// Query: GET /api/geocode/reverse?lat=<f>&lon=<f>
// Returns: 200 { place, region, country, cc, distance_km }
//          404 { error: 'no match' }
//          502 { error: 'geocoder unreachable' }

const express = require('express');
const router = express.Router();
const http = require('http');

const GEOCODER_HOST = process.env.GEOCODER_HOST || 'geocoder';
const GEOCODER_PORT = parseInt(process.env.GEOCODER_PORT || '8000', 10);

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

    return router;
};
