const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');
const mqttService = require('../mqtt');

const DEPLOYMENT_DIR = process.env.DEPLOYMENT_STORAGE_PATH || '/app/deployments';

module.exports = (db) => {
    const deployments = db.collection('deployments');
    const deploymentStatuses = db.collection('deployment_statuses');

    // Ensure storage directory exists on startup
    fs.mkdirSync(DEPLOYMENT_DIR, { recursive: true });

    // Ensure index for deployment status lookups
    deploymentStatuses.createIndex({ deploymentId: 1, timestamp: -1 }).catch(err => {
        console.error('Failed to create deployment_statuses index:', err);
    });

    // POST /api/deployments/upload
    router.post('/upload', (req, res) => {
        const busboy = Busboy({
            headers: req.headers,
            limits: { fileSize: 20 * 1024 * 1024 * 1024 } // 20GB limit — matches nginx client_max_body_size
        });

        let version = null;
        let fileProcessed = false;
        let savedFilename = null;
        let fileSize = 0;
        let filePath = null;
        let responseSent = false;

        busboy.on('field', (name, val) => {
            if (name === 'version') version = val;
        });

        busboy.on('file', (name, file, info) => {
            if (fileProcessed) {
                file.resume();
                return;
            }
            fileProcessed = true;

            const originalName = info.filename;
            const timestamp = Date.now();
            savedFilename = `deployment-${timestamp}-${originalName}`;
            filePath = path.join(DEPLOYMENT_DIR, savedFilename);

            const hash = crypto.createHash('sha256');
            const writeStream = fs.createWriteStream(filePath);

            file.on('data', (chunk) => {
                fileSize += chunk.length;
                hash.update(chunk);
            });

            file.on('error', (err) => {
                console.error('File stream error:', err);
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

                    const doc = {
                        version: version || 'unknown',
                        filename: savedFilename,
                        originalName: originalName,
                        size: fileSize,
                        sha256: sha256,
                        uploadedAt: new Date()
                    };

                    const result = await deployments.insertOne(doc);
                    doc._id = result.insertedId;

                    // Publish local MQTT notification — deployment-watcher reads
                    // the zip from the shared Docker volume (no HTTP download)
                    mqttService.publishLocalDeploymentAvailable({
                        id: doc._id.toString(),
                        version: doc.version,
                        filename: savedFilename,
                        originalName: doc.originalName,
                        size: doc.size,
                        sha256: doc.sha256,
                        timestamp: doc.uploadedAt.toISOString()
                    });

                    responseSent = true;
                    res.json({
                        id: doc._id,
                        version: doc.version,
                        filename: doc.originalName,
                        size: doc.size,
                        sha256: doc.sha256,
                        uploadedAt: doc.uploadedAt
                    });
                } catch (err) {
                    console.error('Error saving deployment metadata:', err);
                    if (!responseSent) {
                        responseSent = true;
                        res.status(500).json({ error: 'Failed to save deployment' });
                    }
                }
            });

            writeStream.on('error', (err) => {
                console.error('Write stream error:', err);
                if (!responseSent) {
                    responseSent = true;
                    res.status(500).json({ error: 'Failed to write file' });
                }
            });
        });

        busboy.on('error', (err) => {
            console.error('Busboy error:', err);
            if (!responseSent) {
                responseSent = true;
                res.status(500).json({ error: 'Upload failed' });
            }
        });

        req.pipe(busboy);
    });

    // GET /api/deployments
    router.get('/', async (req, res) => {
        try {
            const list = await deployments.find()
                .sort({ uploadedAt: -1 })
                .toArray();

            // Fetch latest status for each deployment
            const deploymentIds = list.map(d => d._id.toString());
            const latestStatuses = await deploymentStatuses.aggregate([
                { $match: { deploymentId: { $in: deploymentIds } } },
                { $sort: { timestamp: -1 } },
                { $group: {
                    _id: '$deploymentId',
                    status: { $first: '$status' },
                    timestamp: { $first: '$timestamp' }
                }}
            ]).toArray();

            const statusMap = {};
            for (const s of latestStatuses) {
                statusMap[s._id] = { status: s.status, timestamp: s.timestamp };
            }

            res.json(list.map(d => ({
                id: d._id,
                version: d.version,
                filename: d.originalName,
                size: d.size,
                sha256: d.sha256,
                uploadedAt: d.uploadedAt,
                latestStatus: statusMap[d._id.toString()]?.status || null,
                statusUpdatedAt: statusMap[d._id.toString()]?.timestamp || null
            })));
        } catch (error) {
            console.error('Error fetching deployments:', error);
            res.status(500).json({ error: 'Failed to fetch deployments' });
        }
    });

    // DELETE /api/deployments/:id
    router.delete('/:id', async (req, res) => {
        try {
            const { ObjectId } = require('mongodb');
            const id = new ObjectId(req.params.id);
            const doc = await deployments.findOne({ _id: id });
            if (!doc) {
                return res.status(404).json({ error: 'Deployment not found' });
            }

            // Delete file from disk
            const deleteFilePath = path.join(DEPLOYMENT_DIR, doc.filename);
            fs.unlink(deleteFilePath, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error('Error deleting deployment file:', err);
                }
            });

            await deployments.deleteOne({ _id: id });

            // Clean up status records for this deployment
            await deploymentStatuses.deleteMany({ deploymentId: req.params.id });

            res.json({ message: 'Deployment deleted' });
        } catch (error) {
            console.error('Error deleting deployment:', error);
            res.status(500).json({ error: 'Failed to delete deployment' });
        }
    });

    return router;
};
