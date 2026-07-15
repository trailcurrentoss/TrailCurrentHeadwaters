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

// Host filesystem is read-only mounted at /host/root by docker-compose
// (originally for system-stats disk usage; reused here). External USB/SD
// drives auto-mount under /media/tc-external/<label>/ via the udev rule
// baked into the CM5 image. Backend scans those paths for map bundles
// and reads bytes directly during import.
const HOST_ROOT = '/host/root';
const EXTERNAL_MOUNT_DIRS = [
    // Preferred location — matches the CM5 layer YAML's udev rule target
    'media/tc-external',
    // Fallbacks for dev-machine testing OR if a user manually mounts
    'media',
    'mnt',
    'run/media'
];

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

            // Chown the staging file to trailcurrent immediately — BEFORE
            // any data has been piped. If the upload is aborted mid-stream
            // (browser closed, network dropped, Node HTTP requestTimeout
            // fires — theoretically eliminated but defense-in-depth), the
            // leftover partial is already trailcurrent-owned and map-watcher
            // can delete it as part of its own housekeeping without needing
            // sudo. This is the second layer of defense; the first is the
            // deploy.sh bind-mount preflight that reclaims any straggler.
            if (targetUid !== null && targetGid !== null) {
                try {
                    fs.chownSync(filePath, targetUid, targetGid);
                } catch (err) {
                    console.warn(`[maps] initial chown on ${filePath} failed: ${err.message}`);
                }
            }

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
                    displayName: manifest?.region_display_name || manifest?.display_name || null,
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

    // POST /api/maps/confirm/:id
    //
    // User agreed to a pending cross-region apply. Publishes MAPS_CONFIRM
    // on the local bus; map-watcher resumes the paused apply. No 404 on
    // unknown id — the watcher owns the pending state and will simply
    // no-op if it doesn't recognize the id.
    router.post('/confirm/:id', async (req, res) => {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'id required' });
        mqttService.publishLocalMapsConfirm(id);
        res.json({ status: 'confirmed', id });
    });

    // POST /api/maps/cancel/:id
    //
    // User rejected a pending cross-region apply. Publishes MAPS_CANCEL;
    // map-watcher deletes the staged zip and drops the pending state.
    router.post('/cancel/:id', async (req, res) => {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'id required' });
        mqttService.publishLocalMapsCancel(id);
        res.json({ status: 'canceled', id });
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

    // --- Phase 8: sneakernet (USB / SD) load path ---------------------------
    //
    // Parallel inbound leg to PWA upload. Same downstream flow — bundle
    // lands in staging/<uuid>.zip, MAPS_AVAILABLE is published, map-watcher
    // does the rest. Only difference is where the source bytes come from.

    // GET /api/maps/scan-external
    //
    // Walks the mount points where udev auto-mounts external drives and
    // returns any file matching `maps-*.zip` in the root of each mount
    // (and one level down, to catch bundles the user dropped in a folder).
    // Returns [{path, name, size, mountpoint, mtime}].
    router.get('/scan-external', async (req, res) => {
        const results = [];
        const seen = new Set();       // dedupe if a bundle shows through
                                       // multiple listed roots (e.g. /media
                                       // and /media/tc-external overlap)
        for (const relRoot of EXTERNAL_MOUNT_DIRS) {
            const scanRoot = path.join(HOST_ROOT, relRoot);
            let mountEntries;
            try {
                mountEntries = fs.readdirSync(scanRoot, { withFileTypes: true });
            } catch (_) { continue; }  // dir doesn't exist — skip silently

            for (const mnt of mountEntries) {
                if (!mnt.isDirectory()) continue;
                const mountPath = path.join(scanRoot, mnt.name);
                // Scan the mount root + one level of subdirs. Deeper walks
                // are too slow on a big USB drive and would surprise users.
                for (const searchDepth of [mountPath, ...subdirs(mountPath, 1)]) {
                    let entries;
                    try {
                        entries = fs.readdirSync(searchDepth, { withFileTypes: true });
                    } catch (_) { continue; }
                    for (const f of entries) {
                        if (!f.isFile()) continue;
                        if (!/^maps-.*\.zip$/i.test(f.name)) continue;
                        const full = path.join(searchDepth, f.name);
                        if (seen.has(full)) continue;
                        seen.add(full);
                        try {
                            const st = fs.statSync(full);
                            results.push({
                                // Absolute host path (with the /host/root prefix
                                // stripped) — this is what /import-external
                                // will accept. Keeping the strip explicit means
                                // the client never sees /host/root in URLs.
                                path: full.slice(HOST_ROOT.length) || '/',
                                name: f.name,
                                size: st.size,
                                mountpoint: '/' + relRoot + '/' + mnt.name,
                                mtime: st.mtime.toISOString()
                            });
                        } catch (_) { /* stat failed — skip */ }
                    }
                }
            }
        }
        // Newest first — the user just plugged in the drive, they probably
        // want the freshest bundle.
        results.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
        res.json({ results });
    });

    // POST /api/maps/import-external
    // Body: { path: "/media/tc-external/<label>/maps-<date>.zip" }
    //
    // Streams the file from the read-only host mount into staging, hashing
    // as it goes. Same shape as the upload finish handler once the copy
    // completes: chown to trailcurrent, insert Mongo record, publish
    // MAPS_AVAILABLE. Map-watcher handles verify + extract + apply from
    // there — indistinguishable from a PWA upload.
    router.post('/import-external', express.json(), (req, res) => {
        const body = req.body || {};
        const clientPath = String(body.path || '');
        // Defence against path traversal — the source MUST live under one
        // of our expected external mount roots. Anything else (e.g.
        // /etc/passwd or /root/.ssh) is rejected without touching disk.
        if (!clientPath.startsWith('/')) {
            return res.status(400).json({ error: 'path must be absolute' });
        }
        if (clientPath.includes('/..')) {
            return res.status(400).json({ error: 'path may not contain ..' });
        }
        const inWhitelist = EXTERNAL_MOUNT_DIRS.some(
            (r) => clientPath.startsWith('/' + r + '/')
        );
        if (!inWhitelist) {
            return res.status(400).json({
                error: 'path is not under a recognized external mount root'
            });
        }
        const srcPath = path.join(HOST_ROOT, clientPath);
        let srcStat;
        try {
            srcStat = fs.statSync(srcPath);
        } catch (err) {
            return res.status(404).json({ error: 'source file not found' });
        }
        if (!srcStat.isFile()) {
            return res.status(400).json({ error: 'source is not a regular file' });
        }
        if (!/\.zip$/i.test(srcPath)) {
            return res.status(400).json({ error: 'source must be a .zip' });
        }

        try { fs.mkdirSync(STAGING_DIR, { recursive: true }); } catch (_) {}

        const originalName = path.basename(clientPath);
        const uuid = randomUUID();
        const savedFilename = `${uuid}.zip`;
        const destPath = path.join(STAGING_DIR, savedFilename);
        const hash = crypto.createHash('sha256');

        const rs = fs.createReadStream(srcPath, { highWaterMark: 4 * 1024 * 1024 });
        const ws = fs.createWriteStream(destPath);

        // Chown the destination immediately so a killed-mid-copy partial
        // still lands trailcurrent-owned — same defence-in-depth as the
        // upload path. See feedback_docker_volume_root_ownership + the
        // deploy.sh preflight for the wider story.
        if (targetUid !== null && targetGid !== null) {
            try { fs.chownSync(destPath, targetUid, targetGid); }
            catch (_) { /* non-fatal */ }
        }

        let bytesCopied = 0;
        let responded = false;

        rs.on('data', (chunk) => {
            hash.update(chunk);
            bytesCopied += chunk.length;
        });

        const cleanup = () => {
            try { rs.destroy(); } catch (_) {}
            try { ws.destroy(); } catch (_) {}
            try { fs.unlinkSync(destPath); } catch (_) {}
        };

        rs.on('error', (err) => {
            console.error('[maps] external-import read error:', err.message);
            cleanup();
            if (!responded) {
                responded = true;
                res.status(500).json({ error: 'read failed', detail: err.message });
            }
        });
        ws.on('error', (err) => {
            console.error('[maps] external-import write error:', err.message);
            cleanup();
            if (!responded) {
                responded = true;
                res.status(500).json({ error: 'write failed', detail: err.message });
            }
        });
        ws.on('finish', async () => {
            if (responded) return;
            try {
                const sha256 = hash.digest('hex');
                // Second-chance chown after the file has all bytes — belt
                // and suspenders against a race where the first chown ran
                // before the file was created.
                if (targetUid !== null && targetGid !== null) {
                    try { fs.chownSync(destPath, targetUid, targetGid); }
                    catch (_) {}
                }
                const doc = {
                    id: uuid,
                    filename: savedFilename,
                    originalName,
                    size: bytesCopied,
                    sha256,
                    uploadedAt: new Date(),
                    status: 'uploaded',
                    source: 'external'         // distinguishes this from PWA-upload
                                                // rows in the recent-uploads list
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

                responded = true;
                res.json({
                    id: doc.id,
                    filename: doc.originalName,
                    size: doc.size,
                    sha256: doc.sha256,
                    source: 'external'
                });
            } catch (err) {
                console.error('[maps] external-import metadata save failed:', err);
                cleanup();
                if (!responded) {
                    responded = true;
                    res.status(500).json({ error: 'Failed to save import' });
                }
            }
        });

        rs.pipe(ws);
    });

    return router;
};

// Return absolute-path subdirs of `dir` up to `maxDepth` deep. Used by
// /scan-external to look one level down inside each mount for a bundle
// the user might have stashed in a folder.
function subdirs(dir, maxDepth) {
    if (maxDepth <= 0) return [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return []; }
    const out = [];
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        out.push(path.join(dir, e.name));
    }
    return out;
}
