// Backend surface for the os-settings.py host daemon.
//
// The daemon owns anything that needs to touch the host OS (currently
// just the system time zone). We publish requests on os/<setting>/request
// and wait for the matching os/<setting>/response, using the same
// promise-per-request pattern used by discovery.js.
//
// Reads short-circuit through the retained `os/timezone/current` cache
// that mqtt.js maintains, so the PWA can render current state without
// a round trip.

const express = require('express');
const router = express.Router();
const mqttService = require('../mqtt');

// IANA TZ regex — belt-and-braces guard before we hand the string to
// the daemon. The daemon revalidates against /usr/share/zoneinfo, but
// filtering obvious garbage here keeps the MQTT topic quiet.
const TZ_REGEX = /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+)*$/;

// reqId -> { resolve, reject, timer }
const pendingTimezone = new Map();

module.exports = () => {
    // GET /api/os/timezone — return the OS's current TZ.
    router.get('/timezone', (req, res) => {
        const tz = mqttService.getCurrentTimezone();
        // null means the host daemon hasn't published yet (fresh boot,
        // or backend restarted before the daemon's retained message
        // arrived). Report that honestly rather than guessing.
        res.json({ tz: tz || null });
    });

    // POST /api/os/timezone { tz: "America/Denver" } — set the OS TZ.
    router.post('/timezone', async (req, res) => {
        const tz = req.body && req.body.tz;
        if (!tz || typeof tz !== 'string' || !TZ_REGEX.test(tz)) {
            return res.status(400).json({ error: 'Invalid tz — expected an IANA time zone like "America/Denver"' });
        }

        if (!mqttService.connected) {
            return res.status(503).json({ error: 'MQTT broker not connected' });
        }

        const reqId = `tz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        try {
            const applied = await requestTimezone(reqId, tz);
            res.json({ ok: true, tz: applied });
        } catch (err) {
            const code = /timed out/i.test(err.message) ? 504 : 502;
            res.status(code).json({ error: err.message });
        }
    });

    return router;
};

function requestTimezone(reqId, tz) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingTimezone.delete(reqId);
            reject(new Error(`Timezone set timed out for ${tz}`));
        }, 8000);

        pendingTimezone.set(reqId, { resolve, reject, timer });

        const ok = mqttService.publishOsTimezoneRequest(reqId, tz);
        if (!ok) {
            clearTimeout(timer);
            pendingTimezone.delete(reqId);
            reject(new Error('Unable to publish timezone request — MQTT not connected'));
        }
    });
}

// Called from mqtt.js when os/timezone/response arrives.
module.exports.handleTimezoneResponse = function (payload) {
    const pending = pendingTimezone.get(payload && payload.reqId);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingTimezone.delete(payload.reqId);

    if (payload.ok) {
        pending.resolve(payload.tz);
    } else {
        pending.reject(new Error(payload.error || 'Timezone set failed'));
    }
};
