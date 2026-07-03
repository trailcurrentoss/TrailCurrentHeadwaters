'use strict';

// Alarms service — tracks which Picket / Switchback digital inputs are
// currently armed AND active, and pushes the live set to the PWA over
// WebSocket. Self-clearing: a sensor leaves the active set the moment its
// input bit drops, so no ack or snooze is required.
//
// Inputs:
//   local/spoor/<0-2>/inputs   — Switchback DIs (8 bits per board)
//   local/picket/<0-7>/inputs  — Picket reed switches (12 bits per board)
//
// Config (system_config.alarms.sensors, sparse map keyed "type:addr:sensor"):
//   "switchback:0:3": { armed: true, label: "Hatch" }
//   "picket:0:5":     { armed: true, label: "Front Door" }
//
// WS event: "alarms-update" with payload { active: [{ type, addr, sensor, label }] }

const SENSORS_PER = {
    switchback: 8,
    picket: 12,
};

let mqttService = null;
let db = null;
let armed = new Map();           // "type:addr:sensor" → true
let labels = new Map();          // "type:addr:sensor" → string
let lastInputs = new Map();      // "type:addr" → bitmask (raw, for diffing)
let active = new Map();          // "type:addr:sensor" → true (currently armed + high)

function key(type, addr, sensor) { return `${type}:${addr}:${sensor}`; }
function modKey(type, addr)      { return `${type}:${addr}`; }

function defaultLabel(type, addr, sensor) {
    const prefix = type === 'switchback' ? 'SB' : 'PK';
    return `${prefix}${addr}-S${sensor}`;
}

function displayLabel(type, addr, sensor) {
    const k = key(type, addr, sensor);
    return labels.get(k) || defaultLabel(type, addr, sensor);
}

function buildActiveList() {
    const out = [];
    for (const k of active.keys()) {
        const [type, addrStr, sensorStr] = k.split(':');
        const addr = parseInt(addrStr, 10);
        const sensor = parseInt(sensorStr, 10);
        out.push({ type, addr, sensor, label: displayLabel(type, addr, sensor) });
    }
    // Stable order: type, addr, sensor
    out.sort((a, b) =>
        a.type.localeCompare(b.type) ||
        a.addr - b.addr ||
        a.sensor - b.sensor
    );
    return out;
}

function broadcastUpdate() {
    if (!mqttService || !mqttService.broadcast) return;
    mqttService.broadcast('alarms_update', { active: buildActiveList() });
}

function getActiveSnapshot() {
    return { active: buildActiveList() };
}

// Recompute the active set from current armed + lastInputs. Called on
// config reload (the inputs haven't changed but arm flags have).
function recomputeActive() {
    const before = active.size;
    active = new Map();
    for (const [mk, bits] of lastInputs.entries()) {
        const [type, addrStr] = mk.split(':');
        const addr = parseInt(addrStr, 10);
        const count = SENSORS_PER[type] || 0;
        for (let bit = 0; bit < count; bit++) {
            if (!((bits >> bit) & 1)) continue;
            const sensor = bit + 1;
            const k = key(type, addr, sensor);
            if (armed.get(k)) active.set(k, true);
        }
    }
    if (active.size !== before) broadcastUpdate();
    else {
        // Size unchanged but membership may have shifted (e.g. one sensor
        // disarmed and another armed in the same call). Cheap to always push.
        broadcastUpdate();
    }
}

function handleInputs(type, addr, inputs) {
    const mk = modKey(type, addr);
    const prev = lastInputs.get(mk) || 0;
    if (prev === inputs) return;
    lastInputs.set(mk, inputs);

    const count = SENSORS_PER[type] || 0;
    let changed = false;
    for (let bit = 0; bit < count; bit++) {
        const high = (inputs >> bit) & 1;
        const wasHigh = (prev >> bit) & 1;
        if (high === wasHigh) continue;
        const sensor = bit + 1;
        const k = key(type, addr, sensor);
        if (high) {
            if (armed.get(k) && !active.has(k)) {
                active.set(k, true);
                changed = true;
            }
        } else {
            if (active.has(k)) {
                active.delete(k);
                changed = true;
            }
        }
    }
    if (changed) broadcastUpdate();
}

async function loadConfig() {
    if (!db) return;
    try {
        const cfg = await db.collection('system_config').findOne({ _id: 'main' });
        const sensors = (cfg && cfg.alarms && cfg.alarms.sensors) || {};
        armed = new Map();
        labels = new Map();
        for (const [k, entry] of Object.entries(sensors)) {
            if (entry && entry.armed) armed.set(k, true);
            if (entry && typeof entry.label === 'string' && entry.label.length > 0) {
                labels.set(k, entry.label);
            }
        }
        console.log(`[Alarms] Loaded config: ${armed.size} armed sensors, ${labels.size} custom labels`);
        recomputeActive();
    } catch (err) {
        console.error('[Alarms] Failed to load config:', err.message);
    }
}

// Called by /api/alarms routes after a successful PUT. Re-reads Mongo and
// re-evaluates the active set so the WS push reflects the new arm state
// immediately, even if no input has changed since the toggle.
async function reloadConfig() {
    await loadConfig();
}

function init(mqtt, mongo) {
    mqttService = mqtt;
    db = mongo;
    const client = mqttService.client;
    if (!client) {
        console.error('[Alarms] MQTT client not available');
        return;
    }

    const SPOOR_TOPIC = 'local/spoor/+/inputs';
    const PICKET_TOPIC = 'local/picket/+/inputs';

    client.subscribe(SPOOR_TOPIC, (err) => {
        if (err) console.error('[Alarms] Subscribe spoor failed:', err);
        else console.log('[Alarms] Subscribed to', SPOOR_TOPIC);
    });
    client.subscribe(PICKET_TOPIC, (err) => {
        if (err) console.error('[Alarms] Subscribe picket failed:', err);
        else console.log('[Alarms] Subscribed to', PICKET_TOPIC);
    });

    client.on('message', (topic, message) => {
        if (!topic.startsWith('local/spoor/') && !topic.startsWith('local/picket/')) return;
        if (!topic.endsWith('/inputs')) return;
        try {
            const payload = JSON.parse(message.toString());
            const addr = typeof payload.addr === 'number' ? payload.addr : NaN;
            const inputs = typeof payload.inputs === 'number' ? payload.inputs : NaN;
            if (Number.isNaN(addr) || Number.isNaN(inputs)) return;
            const type = topic.startsWith('local/spoor/') ? 'switchback' : 'picket';
            handleInputs(type, addr, inputs);
        } catch (err) {
            console.error('[Alarms] Failed to parse', topic, err.message);
        }
    });

    loadConfig();
    console.log('[Alarms] Service initialized');
}

module.exports = {
    init,
    reloadConfig,
    getActiveSnapshot,
};
