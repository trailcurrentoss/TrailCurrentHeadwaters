const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const Busboy = require('busboy');
const mqttService = require('../mqtt');

// Bind-mount from host ./data/maps -> /app/maps. Matches the pattern used
// by ./data/deployments -> /app/deployments. On the host the directory is
// owned by the trailcurrent user (Phase 6 bake hook enforces this), so
// reading its uid/gid tells us who to hand ownership back to after the
// upload finishes streaming.
const MAPS_ROOT = process.env.MAPS_STORAGE_PATH || '/app/maps';
const STAGING_DIR = path.join(MAPS_ROOT, 'staging');
const VERSIONS_DIR = path.join(MAPS_ROOT, 'versions');
const CURRENT_LINK = path.join(MAPS_ROOT, 'current');

module.exports = (db) => {
    const mapsUploads = db.collection('map_uploads');

    // Read the target uid/gid off the bind-mount so we don't have to hardcode
    // trailcurrent's UID. If the directory doesn't exist yet (e.g. dev-machine
    // compose without the Phase 6 bake), skip the chown handoff — the file
    // stays root-owned and the fallback in the plan applies (map-watcher
    // treats staging zips as read-only inputs).
    let targetUid = null;
    let targetGid = null;
    try {
        const st = fs.statSync(MAPS_ROOT);
        targetUid = st.uid;
        targetGid = st.gid;
    } catch (err) {
        console.warn(`[maps] ${MAPS_ROOT} not found — upload path will not chown handoff.`);
    }

    // POST /api/maps/upload
    //
    // Streams a bundle zip to STAGING_DIR/<uuid>.zip, computes SHA256 as it
    // goes, records metadata in Mongo, chowns the file back to the owner of
    // MAPS_ROOT (trailcurrent), and publishes a local MQTT notification so
    // map-watcher.py can pick it up.
    router.post('/upload', (req, res) => {
        // ~130 GB North America bundle is the expected max — allow plenty of
        // headroom. Busboy's limit is a hard upper bound; nginx's
        // client_max_body_size 0 handles the transport side.
        const busboy = Busboy({
            headers: req.headers,
            limits: { fileSize: 200 * 1024 * 1024 * 1024 }
        });

        let fileProcessed = false;
        let savedFilename = null;
        let fileSize = 0;
        let filePath = null;
        let responseSent = false;

        busboy.on('file', (name, file, info) => {
            if (fileProcessed) { file.resume(); return; }
            fileProcessed = true;

            const originalName = info.filename || 'bundle.zip';
            const uuid = randomUUID();
            savedFilename = `${uuid}.zip`;
            filePath = path.join(STAGING_DIR, savedFilename);

            try { fs.mkdirSync(STAGING_DIR, { recursive: true }); } catch (_) {}

            const hash = crypto.createHash('sha256');
            const writeStream = fs.createWriteStream(filePath);

            file.on('data', (chunk) => {
                fileSize += chunk.length;
                hash.update(chunk);
            });

            file.on('error', (err) => {
                console.error('[maps] file stream error:', err);
                writeStream.destroy();
                fs.unlink(filePath, () => {});
                if (!responseSent) {
                    responseSent = true;
                    res.status(500).json({ error: 'Upload failed during file transfer' });
                }
            });

            file.pipe(writeStream);

            writeStream.on('finish', async () => {
                if (responseSent) return;

                try {
                    const sha256 = hash.digest('hex');

                    // Ownership handoff to trailcurrent so map-watcher (running
                    // as trailcurrent, non-root) can read and delete the zip.
                    // Silent skip if we didn't detect a target uid/gid.
                    if (targetUid !== null && targetGid !== null) {
                        try {
                            fs.chownSync(filePath, targetUid, targetGid);
                        } catch (err) {
                            console.warn(`[maps] chown handoff failed for ${filePath}: ${err.message}. map-watcher will treat as read-only input.`);
                        }
                    }

                    const doc = {
                        id: path.parse(savedFilename).name,
                        filename: savedFilename,
                        originalName,
                        size: fileSize,
                        sha256,
                        uploadedAt: new Date(),
                        status: 'uploaded'
                    };
                    const result = await mapsUploads.insertOne(doc);
                    doc._id = result.insertedId;

                    mqttService.publishLocalMapsAvailable({
                        id: doc.id,
                        filename: savedFilename,
                        originalName: doc.originalName,
                        size: doc.size,
                        sha256: doc.sha256,
                        timestamp: doc.uploadedAt.toISOString()
                    });

                    responseSent = true;
                    res.json({
                        id: doc.id,
                        filename: doc.originalName,
                        size: doc.size,
                        sha256: doc.sha256,
                        uploadedAt: doc.uploadedAt
                    });
                } catch (err) {
                    console.error('[maps] error saving map upload metadata:', err);
                    if (!responseSent) {
                        responseSent = true;
                        res.status(500).json({ error: 'Failed to save upload' });
                    }
                }
            });

            writeStream.on('error', (err) => {
                console.error('[maps] write stream error:', err);
                if (!responseSent) {
                    responseSent = true;
                    res.status(500).json({ error: 'Failed to write file' });
                }
            });
        });

        busboy.on('error', (err) => {
            console.error('[maps] busboy error:', err);
            if (!responseSent) {
                responseSent = true;
                res.status(500).json({ error: 'Upload failed' });
            }
        });

        req.pipe(busboy);
    });

    // GET /api/maps/current
    //
    // Returns the currently-active bundle's manifest. On a virgin device
    // (no `current` symlink yet) responds with 404 + a no-bundle envelope
    // so the frontend can render its placeholder state instead of erroring.
    router.get('/current', (req, res) => {
        try {
            const manifestPath = path.join(CURRENT_LINK, 'manifest.json');
            if (!fs.existsSync(manifestPath)) {
                return res.status(404).json({
                    status: 'no-bundle',
                    message: 'No map data installed'
                });
            }
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            let target = null;
            try { target = fs.readlinkSync(CURRENT_LINK); } catch (_) {}
            res.json({ status: 'installed', version: path.basename(target || ''), manifest });
        } catch (err) {
            console.error('[maps] error reading current manifest:', err);
            res.status(500).json({ error: 'Failed to read manifest' });
        }
    });

    // GET /api/maps/versions
    //
    // Lists installed versions (current + retained). Returns [] on virgin
    // devices — the UI relies on that to hide the rollback button.
    router.get('/versions', (req, res) => {
        try {
            if (!fs.existsSync(VERSIONS_DIR)) return res.json([]);
            const entries = fs.readdirSync(VERSIONS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.endsWith('-staging'))
                .map(d => d.name);

            let currentVersion = null;
            try {
                const t = fs.readlinkSync(CURRENT_LINK);
                currentVersion = path.basename(t);
            } catch (_) { /* no current yet */ }

            const versions = entries.map(name => {
                const manifestPath = path.join(VERSIONS_DIR, name, 'manifest.json');
                let manifest = null;
                try {
                    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                } catch (_) { /* directory without manifest — surface anyway */ }
                return {
                    version: name,
                    isCurrent: name === currentVersion,
                    region: manifest?.region || null,
                    displayName: manifest?.display_name || null,
                    buildDate: manifest?.build_date || null
                };
            });

            // Sort newest first — version dirs are dated YYYY.MM.DD[.N]
            versions.sort((a, b) => b.version.localeCompare(a.version));
            res.json(versions);
        } catch (err) {
            console.error('[maps] error listing versions:', err);
            res.status(500).json({ error: 'Failed to list versions' });
        }
    });

    // GET /api/maps/uploads
    //
    // Recent upload metadata (mirrors GET /api/deployments). Powers the
    // upload history + status badges on the Maps page.
    router.get('/uploads', async (req, res) => {
        try {
            const list = await mapsUploads.find()
                .sort({ uploadedAt: -1 })
                .limit(20)
                .toArray();
            res.json(list.map(d => ({
                id: d.id,
                filename: d.originalName,
                size: d.size,
                sha256: d.sha256,
                uploadedAt: d.uploadedAt,
                status: d.status,
                statusReason: d.statusReason || null,
                statusUpdatedAt: d.statusUpdatedAt || null
            })));
        } catch (err) {
            console.error('[maps] error listing uploads:', err);
            res.status(500).json({ error: 'Failed to list uploads' });
        }
    });

    // POST /api/maps/rollback
    //
    // Flips `current` back to the most-recent-non-current version. 409 if
    // there is nothing to roll back to (virgin device or single version).
    router.post('/rollback', async (req, res) => {
        try {
            if (!fs.existsSync(VERSIONS_DIR)) {
                return res.status(409).json({ error: 'No versions installed' });
            }
            const entries = fs.readdirSync(VERSIONS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.endsWith('-staging'))
                .map(d => d.name)
                .sort((a, b) => b.localeCompare(a));
            if (entries.length < 2) {
                return res.status(409).json({ error: 'Nothing to roll back to' });
            }

            let currentVersion = null;
            try {
                currentVersion = path.basename(fs.readlinkSync(CURRENT_LINK));
            } catch (_) { /* no current — cannot roll back */
                return res.status(409).json({ error: 'No current version' });
            }
            const previous = entries.find(name => name !== currentVersion);
            if (!previous) {
                return res.status(409).json({ error: 'Nothing to roll back to' });
            }

            mqttService.publishLocalMapsRollback({ targetVersion: previous });
            res.json({ status: 'rollback-requested', targetVersion: previous });
        } catch (err) {
            console.error('[maps] error requesting rollback:', err);
            res.status(500).json({ error: 'Failed to request rollback' });
        }
    });

    return router;
};
