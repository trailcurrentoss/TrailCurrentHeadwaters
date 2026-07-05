const express = require('express');

const LABEL_MAX = 24;
const KEY_RE = /^(switchback|picket):([0-7]):([1-9]|1[0-2])$/;

function sanitizeSensors(input) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    for (const [k, raw] of Object.entries(input)) {
        if (!KEY_RE.test(k)) continue;
        const [, type, addrStr, sensorStr] = KEY_RE.exec(k);
        const sensor = parseInt(sensorStr, 10);
        if (type === 'switchback' && sensor > 8) continue;
        if (!raw || typeof raw !== 'object') continue;
        const entry = {};
        if (raw.armed === true) entry.armed = true;
        if (typeof raw.label === 'string') {
            const trimmed = raw.label.trim().slice(0, LABEL_MAX);
            if (trimmed.length > 0) entry.label = trimmed;
        }
        if (entry.armed || entry.label) out[k] = entry;
    }
    return out;
}

function sanitizeBattery(input) {
    if (!input || typeof input !== 'object') return { enabled: false, threshold: 20 };
    const enabled = input.enabled === true;
    let threshold = Number(input.threshold);
    if (!Number.isFinite(threshold)) threshold = 20;
    threshold = Math.round(threshold);
    if (threshold < 0) threshold = 0;
    if (threshold > 100) threshold = 100;
    return { enabled, threshold };
}

module.exports = (db) => {
    const router = express.Router();
    const alarmsService = require('../services/alarms-service');
    const systemConfig = db.collection('system_config');

    // GET /api/alarms/config — current arm + label state
    router.get('/config', async (req, res) => {
        try {
            const cfg = await systemConfig.findOne({ _id: 'main' });
            const sensors = (cfg && cfg.alarms && cfg.alarms.sensors) || {};
            const battery = sanitizeBattery(cfg && cfg.alarms && cfg.alarms.battery);
            res.json({ sensors, battery });
        } catch (err) {
            console.error('[Alarms route] GET /config failed:', err);
            res.status(500).json({ error: 'Failed to fetch alarms config' });
        }
    });

    // PUT /api/alarms/config — overwrite the sensors map (sparse) and battery
    router.put('/config', async (req, res) => {
        try {
            const body = req.body || {};
            const $set = { updated_at: new Date() };
            if (body.sensors !== undefined) {
                $set['alarms.sensors'] = sanitizeSensors(body.sensors);
            }
            if (body.battery !== undefined) {
                $set['alarms.battery'] = sanitizeBattery(body.battery);
            }
            await systemConfig.updateOne({ _id: 'main' }, { $set }, { upsert: true });
            await alarmsService.reloadConfig();
            const cfg = await systemConfig.findOne({ _id: 'main' });
            const sensors = (cfg && cfg.alarms && cfg.alarms.sensors) || {};
            const battery = sanitizeBattery(cfg && cfg.alarms && cfg.alarms.battery);
            res.json({ sensors, battery });
        } catch (err) {
            console.error('[Alarms route] PUT /config failed:', err);
            res.status(500).json({ error: 'Failed to save alarms config' });
        }
    });

    // GET /api/alarms/active — current active sensor snapshot (for first load
    // before a WS event fires).
    router.get('/active', (req, res) => {
        res.json(alarmsService.getActiveSnapshot());
    });

    return router;
};
