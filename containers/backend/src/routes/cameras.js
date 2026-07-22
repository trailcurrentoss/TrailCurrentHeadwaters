const express = require('express');
const { listConnectedCameras } = require('../services/camera-detect');
const streamer = require('../services/camera-streamer');

const NAME_MAX = 32;

function sanitizeName(raw, fallback) {
    if (typeof raw !== 'string') return fallback;
    const trimmed = raw.trim().slice(0, NAME_MAX);
    return trimmed.length > 0 ? trimmed : fallback;
}

// Snapshot fields we persist per configured camera. Kept separate from the
// live detection payload so we can round-trip renamed cameras even when
// they're unplugged.
function toStoredShape(detected, overrides = {}) {
    return {
        name: sanitizeName(overrides.name, detected.name || 'Camera'),
        model: detected.model || null,
        vendor: detected.vendor || null,
        vendorId: detected.vendorId || null,
        productId: detected.productId || null,
        busPath: detected.busPath || null,
        devPath: detected.devPath || null,
    };
}

function toApiShape(doc) {
    return {
        id: doc._id,
        hwId: doc._id,
        name: doc.name,
        model: doc.model,
        vendor: doc.vendor,
        vendorId: doc.vendorId,
        productId: doc.productId,
        busPath: doc.busPath,
        devPath: doc.devPath,
        enabled: !!doc.enabled,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

module.exports = (db) => {
    const router = express.Router();
    const cameras = db.collection('cameras');

    // GET /api/cameras — configured cameras + a `connected` flag telling
    // the frontend whether each one is currently physically present. Lets
    // the UI dim rows for cameras that were added but are now unplugged.
    router.get('/', async (req, res) => {
        try {
            const [configured, detected] = await Promise.all([
                cameras.find({}).sort({ createdAt: 1 }).toArray(),
                Promise.resolve(listConnectedCameras()),
            ]);
            const connectedIds = new Set(detected.map(c => c.hwId));
            const list = configured.map(doc => ({
                ...toApiShape(doc),
                connected: connectedIds.has(doc._id),
            }));
            res.json({ cameras: list });
        } catch (err) {
            console.error('[Cameras route] GET / failed:', err);
            res.status(500).json({ error: 'Failed to fetch cameras' });
        }
    });

    // GET /api/cameras/available — hardware-detected cameras that have NOT
    // already been added. This is what the "Add Camera" picker loads.
    router.get('/available', async (req, res) => {
        try {
            const detected = listConnectedCameras();
            const existingIds = new Set(
                (await cameras.find({}, { projection: { _id: 1 } }).toArray())
                    .map(d => d._id)
            );
            const available = detected.filter(c => !existingIds.has(c.hwId));
            res.json({ cameras: available });
        } catch (err) {
            console.error('[Cameras route] GET /available failed:', err);
            res.status(500).json({ error: 'Failed to enumerate cameras' });
        }
    });

    // POST /api/cameras — add a currently-connected camera by hwId. Body:
    // { hwId: string, name?: string }. The rest of the metadata is
    // captured from the live detection snapshot, not trusted from the
    // client.
    router.post('/', async (req, res) => {
        try {
            const { hwId, name } = req.body || {};
            if (typeof hwId !== 'string' || !hwId) {
                return res.status(400).json({ error: 'hwId is required' });
            }
            const detected = listConnectedCameras().find(c => c.hwId === hwId);
            if (!detected) {
                return res.status(404).json({ error: 'Camera not currently connected' });
            }
            const existing = await cameras.findOne({ _id: hwId });
            if (existing) {
                return res.status(409).json({ error: 'Camera already added' });
            }
            const now = new Date();
            const doc = {
                _id: hwId,
                ...toStoredShape(detected, { name }),
                enabled: false,
                createdAt: now,
                updatedAt: now,
            };
            await cameras.insertOne(doc);
            res.status(201).json(toApiShape(doc));
        } catch (err) {
            console.error('[Cameras route] POST / failed:', err);
            res.status(500).json({ error: 'Failed to add camera' });
        }
    });

    // PATCH /api/cameras/:id — update rename or enable/disable. Body may
    // contain any subset of { name, enabled }. Enabling merely marks the
    // camera as available for streaming; ffmpeg boots lazily on first
    // viewer connect. Disabling immediately stops any running stream.
    router.patch('/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const body = req.body || {};
            const $set = { updatedAt: new Date() };
            if (body.name !== undefined) {
                const clean = sanitizeName(body.name, null);
                if (!clean) return res.status(400).json({ error: 'name cannot be empty' });
                $set.name = clean;
            }
            if (body.enabled !== undefined) {
                $set.enabled = !!body.enabled;
            }
            const result = await cameras.findOneAndUpdate(
                { _id: id },
                { $set },
                { returnDocument: 'after' }
            );
            const doc = result && (result.value || result);
            if (!doc || !doc._id) {
                return res.status(404).json({ error: 'Camera not found' });
            }
            if (body.enabled === false) {
                streamer.stopStream(id);
            }
            res.json(toApiShape(doc));
        } catch (err) {
            console.error('[Cameras route] PATCH /:id failed:', err);
            res.status(500).json({ error: 'Failed to update camera' });
        }
    });

    // DELETE /api/cameras/:id — remove a configured camera. Physical
    // device is untouched; it just re-appears in the "available" list.
    router.delete('/:id', async (req, res) => {
        try {
            const { id } = req.params;
            streamer.stopStream(id);
            const result = await cameras.deleteOne({ _id: id });
            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'Camera not found' });
            }
            res.json({ ok: true });
        } catch (err) {
            console.error('[Cameras route] DELETE /:id failed:', err);
            res.status(500).json({ error: 'Failed to delete camera' });
        }
    });

    // GET /api/cameras/:id/status — lightweight streamer health poll.
    // Reports encoder uptime, access-unit count, keyframe cadence, and
    // last ffmpeg stderr line. The live video itself is delivered over
    // the WebSocket at /ws/cameras/:id — this endpoint is view-only.
    router.get('/:id/status', async (req, res) => {
        try {
            const doc = await cameras.findOne({ _id: req.params.id });
            if (!doc) return res.status(404).json({ error: 'Camera not found' });
            res.json({
                enabled: !!doc.enabled,
                ...streamer.getStatus(req.params.id),
            });
        } catch (err) {
            console.error('[Cameras route] GET /:id/status failed:', err);
            res.status(500).json({ error: 'Failed to fetch status' });
        }
    });

    return router;
};
