// Trails — user-uploaded GPX tracks with a display color.
//
// CRUD surface for a small collection of GPX files the user wants to keep
// around. Each trail has a name + color + the raw GPX bytes on disk. The
// map page loads a chosen trail's GPX via GET /:id/gpx and renders the
// track as a polyline in the trail's color.
//
// Storage layout under /app/trails (host: ./data/trails):
//   active/<uuid>.gpx   — trails visible to the user
//   trash/<uuid>.gpx    — soft-deleted trails, restorable until the trash
//                          is emptied
//
// Mongo collection `trails` mirrors that split via `deletedAt`:
//   { id, name, color, filename, originalName, size, bounds,
//     createdAt, deletedAt }

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Busboy = require('busboy');
const { MAX_UPLOAD_BYTES } = require('../utils/upload-limits');

const TRAILS_ROOT = process.env.TRAILS_STORAGE_PATH || '/app/trails';
const ACTIVE_DIR = path.join(TRAILS_ROOT, 'active');
const TRASH_DIR = path.join(TRAILS_ROOT, 'trash');

const NAME_MAX = 60;
// Hex color like #a1b2c3. Rejecting anything else keeps whatever we hand
// to MapLibre's `line-color` paint property directly usable.
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function ensureDirs() {
    try { fs.mkdirSync(ACTIVE_DIR, { recursive: true }); } catch (_) {}
    try { fs.mkdirSync(TRASH_DIR, { recursive: true }); } catch (_) {}
}

// Parse GPX text into a GeoJSON FeatureCollection + bbox metadata.
// Regex-driven because the server has no DOMParser dependency and GPX
// track/route points always carry lat/lon as attributes on <trkpt> or
// <rtept>. Track segments (<trkseg>) are collapsed into a single
// LineString — one polyline per trail is enough for what the map
// renders today. Returns null when no points can be extracted.
function gpxToGeoJSON(text) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;
    const coords = [];
    // Match trkpt/rtept with lat+lon in either attribute order.
    const re = /<(?:trkpt|rtept)\b([^>]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const attrs = m[1];
        const latM = /\blat="([-\d.]+)"/.exec(attrs);
        const lonM = /\blon="([-\d.]+)"/.exec(attrs);
        if (!latM || !lonM) continue;
        const lat = parseFloat(latM[1]);
        const lng = parseFloat(lonM[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        // GeoJSON is [lng, lat] per RFC 7946 — inverse of GPX's attribute order.
        coords.push([lng, lat]);
    }
    if (coords.length === 0) return null;
    const bounds = { minLat, maxLat, minLng, maxLng, pointCount: coords.length };
    const geojson = {
        type: 'FeatureCollection',
        bbox: [minLng, minLat, maxLng, maxLat],
        features: [{
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: { pointCount: coords.length }
        }]
    };
    return { bounds, geojson };
}

// Both files share a base UUID: <id>.gpx (original upload, untouched)
// and <id>.geojson (server-parsed, what the map reads). Every file
// operation moves them as a pair.
function pairPaths(dir, id) {
    return {
        gpx:     path.join(dir, `${id}.gpx`),
        geojson: path.join(dir, `${id}.geojson`)
    };
}
function movePair(srcDir, dstDir, id) {
    const src = pairPaths(srcDir, id);
    const dst = pairPaths(dstDir, id);
    for (const key of ['gpx', 'geojson']) {
        try { fs.renameSync(src[key], dst[key]); }
        catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn(`[trails] rename ${src[key]} → ${dst[key]} failed:`, err.message);
            }
        }
    }
}
function unlinkPair(dir, id) {
    const p = pairPaths(dir, id);
    for (const key of ['gpx', 'geojson']) {
        try { fs.unlinkSync(p[key]); }
        catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn(`[trails] unlink ${p[key]} failed:`, err.message);
            }
        }
    }
}

function docToPublic(d) {
    return {
        id: d.id,
        name: d.name,
        color: d.color,
        originalName: d.originalName,
        size: d.size,
        bounds: d.bounds || null,
        createdAt: d.createdAt,
        deletedAt: d.deletedAt || null
    };
}

module.exports = (db) => {
    ensureDirs();
    const trails = db.collection('trails');

    const router = express.Router();

    // GET /api/trails — active trails, newest first.
    router.get('/', async (req, res) => {
        try {
            const list = await trails.find({ deletedAt: null })
                .sort({ createdAt: -1 })
                .toArray();
            res.json(list.map(docToPublic));
        } catch (err) {
            console.error('[trails] list failed:', err);
            res.status(500).json({ error: 'Failed to list trails' });
        }
    });

    // GET /api/trails/trash — soft-deleted trails, most-recently-deleted first.
    router.get('/trash', async (req, res) => {
        try {
            const list = await trails.find({ deletedAt: { $ne: null } })
                .sort({ deletedAt: -1 })
                .toArray();
            res.json(list.map(docToPublic));
        } catch (err) {
            console.error('[trails] list trash failed:', err);
            res.status(500).json({ error: 'Failed to list trash' });
        }
    });

    // POST /api/trails — multipart create. Fields: name, color. File: gpx.
    router.post('/', (req, res) => {
        let bb;
        try {
            bb = Busboy({
                headers: req.headers,
                limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
            });
        } catch (err) {
            return res.status(400).json({ error: 'Invalid multipart request' });
        }

        const fields = {};
        let filePath = null;
        let originalName = null;
        let savedFilename = null;
        let size = 0;
        let truncated = false;
        let responded = false;

        const fail = (status, message) => {
            if (responded) return;
            responded = true;
            if (filePath) { try { fs.unlinkSync(filePath); } catch (_) {} }
            res.status(status).json({ error: message });
        };

        bb.on('field', (name, val) => {
            fields[name] = val;
        });

        bb.on('file', (fieldname, file, info) => {
            originalName = (info.filename || 'trail.gpx').slice(0, 200);
            const id = randomUUID();
            savedFilename = `${id}.gpx`;
            filePath = path.join(ACTIVE_DIR, savedFilename);
            const ws = fs.createWriteStream(filePath);
            file.on('data', (chunk) => { size += chunk.length; });
            file.on('limit', () => { truncated = true; });
            file.on('error', (err) => {
                console.error('[trails] file stream error:', err);
                try { ws.destroy(); } catch (_) {}
                fail(500, 'Upload failed');
            });
            ws.on('error', (err) => {
                console.error('[trails] write error:', err);
                fail(500, 'Failed to write GPX');
            });
            file.pipe(ws);
        });

        bb.on('error', (err) => {
            console.error('[trails] busboy error:', err);
            fail(400, 'Upload parse error');
        });

        bb.on('finish', async () => {
            if (responded) return;

            if (truncated) return fail(413, `GPX file exceeds ${MAX_UPLOAD_BYTES} bytes`);
            if (!filePath) return fail(400, 'GPX file is required');

            const name = String(fields.name || '').trim().slice(0, NAME_MAX);
            if (!name) return fail(400, 'name is required');
            const color = String(fields.color || '').trim();
            if (!COLOR_RE.test(color)) return fail(400, 'color must be #RRGGBB');

            // Wait for the write stream to actually flush to disk. Busboy's
            // 'finish' fires when the parser is done reading the request,
            // not when our own write stream has drained. Read it back so
            // we can parse to GeoJSON and pull bounds out.
            fs.readFile(filePath, 'utf8', async (err, text) => {
                if (err) return fail(500, 'Failed to read uploaded GPX');

                const parsed = gpxToGeoJSON(text);
                if (!parsed) {
                    return fail(400, 'GPX contained no track or route points');
                }
                const { bounds, geojson } = parsed;

                const id = path.parse(savedFilename).name;
                const geojsonPath = path.join(ACTIVE_DIR, `${id}.geojson`);
                try {
                    fs.writeFileSync(geojsonPath, JSON.stringify(geojson));
                } catch (writeErr) {
                    console.error('[trails] failed to write geojson:', writeErr);
                    return fail(500, 'Failed to generate GeoJSON');
                }

                const now = new Date();
                const doc = {
                    id,
                    name,
                    color: color.toLowerCase(),
                    filename: savedFilename,
                    originalName,
                    size,
                    bounds,
                    createdAt: now,
                    deletedAt: null
                };
                try {
                    await trails.insertOne(doc);
                    responded = true;
                    res.status(201).json(docToPublic(doc));
                } catch (dbErr) {
                    console.error('[trails] insert failed:', dbErr);
                    // Clean up both files so we don't leak orphaned copies.
                    try { fs.unlinkSync(geojsonPath); } catch (_) {}
                    fail(500, 'Failed to save trail');
                }
            });
        });

        req.pipe(bb);
    });

    // PUT /api/trails/:id — rename or recolor.
    router.put('/:id', express.json(), async (req, res) => {
        const { id } = req.params;
        const body = req.body || {};
        const update = { updatedAt: new Date() };
        if (typeof body.name === 'string') {
            const name = body.name.trim().slice(0, NAME_MAX);
            if (!name) return res.status(400).json({ error: 'name may not be empty' });
            update.name = name;
        }
        if (typeof body.color === 'string') {
            if (!COLOR_RE.test(body.color)) return res.status(400).json({ error: 'color must be #RRGGBB' });
            update.color = body.color.toLowerCase();
        }
        try {
            const result = await trails.findOneAndUpdate(
                { id },
                { $set: update },
                { returnDocument: 'after' }
            );
            const doc = result && (result.value || result);
            if (!doc || !doc.id) return res.status(404).json({ error: 'Trail not found' });
            res.json(docToPublic(doc));
        } catch (err) {
            console.error('[trails] update failed:', err);
            res.status(500).json({ error: 'Failed to update trail' });
        }
    });

    // DELETE /api/trails/:id — soft delete. Move both files into trash/ so
    // restore is a rename, not a re-upload or re-parse.
    router.delete('/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const doc = await trails.findOne({ id });
            if (!doc) return res.status(404).json({ error: 'Trail not found' });
            if (doc.deletedAt) return res.json(docToPublic(doc));
            movePair(ACTIVE_DIR, TRASH_DIR, id);
            const now = new Date();
            await trails.updateOne({ id }, { $set: { deletedAt: now } });
            res.json({ ...docToPublic(doc), deletedAt: now });
        } catch (err) {
            console.error('[trails] soft delete failed:', err);
            res.status(500).json({ error: 'Failed to delete trail' });
        }
    });

    // POST /api/trails/:id/restore — move both files back to active.
    router.post('/:id/restore', async (req, res) => {
        const { id } = req.params;
        try {
            const doc = await trails.findOne({ id });
            if (!doc) return res.status(404).json({ error: 'Trail not found' });
            if (!doc.deletedAt) return res.json(docToPublic(doc));
            movePair(TRASH_DIR, ACTIVE_DIR, id);
            await trails.updateOne({ id }, { $set: { deletedAt: null } });
            res.json({ ...docToPublic(doc), deletedAt: null });
        } catch (err) {
            console.error('[trails] restore failed:', err);
            res.status(500).json({ error: 'Failed to restore trail' });
        }
    });

    // DELETE /api/trails/:id/permanent — remove trashed trail forever
    // (both files).
    router.delete('/:id/permanent', async (req, res) => {
        const { id } = req.params;
        try {
            const doc = await trails.findOne({ id });
            if (!doc) return res.status(404).json({ error: 'Trail not found' });
            unlinkPair(doc.deletedAt ? TRASH_DIR : ACTIVE_DIR, id);
            await trails.deleteOne({ id });
            res.json({ ok: true, id });
        } catch (err) {
            console.error('[trails] permanent delete failed:', err);
            res.status(500).json({ error: 'Failed to delete trail' });
        }
    });

    // POST /api/trails/trash/empty — permanently delete every trashed
    // trail (both files).
    router.post('/trash/empty', async (req, res) => {
        try {
            const list = await trails.find({ deletedAt: { $ne: null } }).toArray();
            for (const doc of list) unlinkPair(TRASH_DIR, doc.id);
            const result = await trails.deleteMany({ deletedAt: { $ne: null } });
            res.json({ ok: true, removed: result.deletedCount || 0 });
        } catch (err) {
            console.error('[trails] empty trash failed:', err);
            res.status(500).json({ error: 'Failed to empty trash' });
        }
    });

    // GET /api/trails/:id/gpx — original GPX bytes (kept for export /
    // sharing). The map page uses /geojson instead.
    router.get('/:id/gpx', async (req, res) => {
        const { id } = req.params;
        try {
            const doc = await trails.findOne({ id, deletedAt: null });
            if (!doc) return res.status(404).json({ error: 'Trail not found' });
            const p = path.join(ACTIVE_DIR, doc.filename);
            fs.readFile(p, 'utf8', (err, text) => {
                if (err) {
                    console.error('[trails] gpx read failed:', err.message);
                    return res.status(500).json({ error: 'Failed to read GPX' });
                }
                res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
                res.send(text);
            });
        } catch (err) {
            console.error('[trails] get gpx failed:', err);
            res.status(500).json({ error: 'Failed to read trail' });
        }
    });

    // GET /api/trails/:id/geojson — server-parsed GeoJSON FeatureCollection
    // that the map page hands directly to a MapLibre source. Generated at
    // upload time so the client never has to touch XML. If the sibling
    // .geojson doesn't exist yet (trail predates this feature), we parse
    // the original .gpx on demand and persist the result for next time.
    router.get('/:id/geojson', async (req, res) => {
        const { id } = req.params;
        try {
            const doc = await trails.findOne({ id, deletedAt: null });
            if (!doc) return res.status(404).json({ error: 'Trail not found' });
            const geojsonPath = path.join(ACTIVE_DIR, `${id}.geojson`);
            if (fs.existsSync(geojsonPath)) {
                fs.readFile(geojsonPath, 'utf8', (err, text) => {
                    if (err) return res.status(500).json({ error: 'Failed to read GeoJSON' });
                    res.setHeader('Content-Type', 'application/geo+json');
                    res.send(text);
                });
                return;
            }
            const gpxPath = path.join(ACTIVE_DIR, doc.filename);
            const text = await fs.promises.readFile(gpxPath, 'utf8');
            const parsed = gpxToGeoJSON(text);
            if (!parsed) return res.status(500).json({ error: 'GPX contained no points' });
            try { fs.writeFileSync(geojsonPath, JSON.stringify(parsed.geojson)); }
            catch (writeErr) { console.warn('[trails] geojson backfill write failed:', writeErr.message); }
            // Backfill bounds too if the DB entry predates parsing.
            if (!doc.bounds) {
                await trails.updateOne({ id }, { $set: { bounds: parsed.bounds } });
            }
            res.setHeader('Content-Type', 'application/geo+json');
            res.json(parsed.geojson);
        } catch (err) {
            console.error('[trails] get geojson failed:', err);
            res.status(500).json({ error: 'Failed to read trail' });
        }
    });

    return router;
};
