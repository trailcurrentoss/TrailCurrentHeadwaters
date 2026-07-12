'use strict';

// Cloud MQTT Bridge — replaces Node-RED cloud-workflow.
// Manages a second MQTT client connecting to the cloud broker.
// Bridges local↔cloud messages with change detection, tiered intervals,
// and periodic heartbeat to minimize cellular data while keeping state
// synchronized.

const mqtt = require('mqtt');
const canBridge = require('./can-bridge');

let cloudClient = null;
let localClient = null;
let mqttServiceRef = null;
let heartbeatTimer = null;
const CONFIG_SYNC_RATE_MS = 5000;

// ── Change detection & heartbeat state ─────────────────────────────
// lastReceived: always stores the latest payload from CAN bus, even if
//   we didn't forward it. Used by heartbeat to republish fresh state.
// lastSentJson: stores the JSON string we last actually published to
//   the cloud. Used by change detection to avoid duplicate sends.
const lastReceived = {};  // cloudTopic -> { json: string, receivedAt: number }
const lastSentJson = {};  // cloudTopic -> string (JSON)

// Per-topic timestamp map for interval-based rate limiting
const lastSent = {};

const HEARTBEAT_MS = 20000;

// ── Bandwidth monitoring ───────────────────────────────────────────
let statsWindow = { bytes: 0, msgs: 0, windowStart: Date.now() };
const STATS_LOG_INTERVAL_MS = 60000;

// ── Tier configuration ─────────────────────────────────────────────
// interval:   minimum ms between sends (0 = no interval gate, send on change only)
// changeOnly: if true, skip publish when payload is identical to last sent
// thresholds: if set, bypass interval when values change significantly
const TIERS = {
    // Immediate — user-facing state, forward on change only
    'rv/lights':              { interval: 0,     changeOnly: true },
    'rv/relays':              { interval: 0,     changeOnly: true },
    'rv/thermostat/status':   { interval: 0,     changeOnly: true },
    // Standard — slow-changing, 5s interval with threshold bypass
    'rv/energy/status':       { interval: 5000,  changeOnly: true, thresholds: 'energy' },
    'rv/gps/latlon':          { interval: 5000,  changeOnly: true, thresholds: 'gps' },
    // Slow — rarely changes when parked, 15s interval
    'rv/gps/alt':             { interval: 15000, changeOnly: true },
    'rv/gps/details':         { interval: 15000, changeOnly: true },
    'rv/airquality/status':   { interval: 15000, changeOnly: true },
    'rv/airquality/temphumid':{ interval: 15000, changeOnly: true },
    'rv/airquality/safety':   { interval: 15000, changeOnly: true },
    'rv/water/status':        { interval: 15000, changeOnly: true },
    'rv/level/tilt':          { interval: 15000, changeOnly: true },
    'rv/level/status':        { interval: 15000, changeOnly: true },
    // Background — diagnostic only
    'rv/system/stats':        { interval: 30000, changeOnly: false },
    // Config — retain, low frequency
    'rv/config/pdm_channels': { interval: 5000,  changeOnly: true },
};

function getTier(cloudTopic) {
    // Direct match first
    if (TIERS[cloudTopic]) return TIERS[cloudTopic];
    // Wildcard match for rv/lights/N/status and rv/relays/N/status
    if (cloudTopic.startsWith('rv/lights/')) return TIERS['rv/lights'];
    if (cloudTopic.startsWith('rv/relays/')) return TIERS['rv/relays'];
    // Fallback: 5s interval with change detection
    return { interval: 5000, changeOnly: true };
}

// ── Interval gate (reuses lastSent map) ────────────────────────────

function shouldSend(topic, intervalMs) {
    if (intervalMs <= 0) return true;
    const now = Date.now();
    if (now - (lastSent[topic] || 0) < intervalMs) return false;
    lastSent[topic] = now;
    return true;
}

// ── Change detection ───────────────────────────────────────────────

function hasChanged(cloudTopic, jsonStr) {
    return lastSentJson[cloudTopic] !== jsonStr;
}

// ── Threshold-based bypass for Standard tier ───────────────────────

function exceedsThreshold(type, cloudTopic, newJsonStr) {
    const prevJson = lastSentJson[cloudTopic];
    if (!prevJson) return true;
    try {
        const oldVal = JSON.parse(prevJson);
        const newVal = JSON.parse(newJsonStr);
        if (type === 'energy') {
            if (oldVal.charge_type !== newVal.charge_type) return true;
            if (Math.abs((oldVal.battery_voltage || 0) - (newVal.battery_voltage || 0)) > 0.5) return true;
            if (Math.abs((oldVal.solar_watts || 0) - (newVal.solar_watts || 0)) > 50) return true;
            if (Math.abs((oldVal.battery_percent || 0) - (newVal.battery_percent || 0)) > 2) return true;
        } else if (type === 'gps') {
            if (Math.abs((oldVal.latitude || 0) - (newVal.latitude || 0)) > 0.0005) return true;
            if (Math.abs((oldVal.longitude || 0) - (newVal.longitude || 0)) > 0.0005) return true;
        }
    } catch (e) { return true; }
    return false;
}

// ── Local → Cloud status bridging (change-detected, tiered) ────────

const LOCAL_TO_CLOUD = [
    { local: 'local/lights/+/status',       cloudPrefix: 'rv/lights/',       cloudSuffix: '/status',    wildcard: true },
    { local: 'local/relays/+/status',        cloudPrefix: 'rv/relays/',       cloudSuffix: '/status',    wildcard: true },
    { local: 'local/airquality/status',      cloud: 'rv/airquality/status' },
    { local: 'local/airquality/temphumid',   cloud: 'rv/airquality/temphumid' },
    { local: 'local/airquality/safety',      cloud: 'rv/airquality/safety' },
    { local: 'local/gps/latlon',             cloud: 'rv/gps/latlon' },
    { local: 'local/gps/alt',               cloud: 'rv/gps/alt' },
    { local: 'local/gps/details',            cloud: 'rv/gps/details' },
    { local: 'local/energy/status',          cloud: 'rv/energy/status' },
    { local: 'local/thermostat/status',      cloud: 'rv/thermostat/status' },
    { local: 'local/water/status',            cloud: 'rv/water/status' },
    { local: 'local/level/tilt',             cloud: 'rv/level/tilt' },
    { local: 'local/level/status',           cloud: 'rv/level/status' },
    { local: 'local/config/pdm_channels',    cloud: 'rv/config/pdm_channels' },
    { local: 'local/system/stats',           cloud: 'rv/system/stats' }
];

// System config sync — retained, QoS 1, hardcoded 5s rate limit
const SYSTEM_SYNC = { local: 'local/config/system_sync', cloud: 'rv/config/system' };

// ── Publish helper (tracks bandwidth stats) ────────────────────────

function publishToCloud(cloudTopic, messageBuffer, opts, reason) {
    cloudClient.publish(cloudTopic, messageBuffer, opts);
    const size = typeof messageBuffer === 'string' ? messageBuffer.length : messageBuffer.length;
    statsWindow.bytes += size + cloudTopic.length + 30; // approximate MQTT overhead
    statsWindow.msgs += 1;
}

// ── Heartbeat — republish all last-known state periodically ────────
// Bounds maximum desync to HEARTBEAT_MS. In normal operation, state
// changes are forwarded immediately; the heartbeat is a safety net for
// connection-level failures where QoS 1 retry couldn't complete.

function publishHeartbeat() {
    if (!cloudClient || !cloudClient.connected) return;
    for (const [topic, entry] of Object.entries(lastReceived)) {
        publishToCloud(topic, entry.json, { qos: 1 }, 'heartbeat');
        lastSentJson[topic] = entry.json;
    }
}

function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(publishHeartbeat, HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// ── Bandwidth stats logging ────────────────────────────────────────

let statsTimer = null;

function logStats() {
    const elapsed = (Date.now() - statsWindow.windowStart) / 1000;
    if (statsWindow.msgs > 0) {
        const rate = (statsWindow.bytes / elapsed).toFixed(0);
        console.log(`[Cloud Bridge] Last ${elapsed.toFixed(0)}s: ${statsWindow.msgs} msgs, ${statsWindow.bytes} bytes (~${rate} B/s)`);
    }
    statsWindow = { bytes: 0, msgs: 0, windowStart: Date.now() };
}

// Local broker message handler — attached exactly once in connect().
// Must not be reattached on reconnect, or each message will be processed
// multiple times (fine for rate-limited status, fatal for toggles).
function handleLocalMessage(topic, message) {
    if (!cloudClient || !cloudClient.connected) return;

    // System config sync (retained, QoS 1, 5s rate limit)
    if (topic === SYSTEM_SYNC.local) {
        if (!shouldSend(SYSTEM_SYNC.cloud, CONFIG_SYNC_RATE_MS)) return;
        publishToCloud(SYSTEM_SYNC.cloud, message, { qos: 1, retain: true }, 'config');
        return;
    }

    // Match against local→cloud mappings
    for (const mapping of LOCAL_TO_CLOUD) {
        let cloudTopic = null;

        if (mapping.wildcard) {
            const regex = new RegExp('^' + mapping.local.replace('+', '([^/]+)') + '$');
            const match = topic.match(regex);
            if (match) {
                cloudTopic = mapping.cloudPrefix + match[1] + mapping.cloudSuffix;
            }
        } else if (topic === mapping.local) {
            cloudTopic = mapping.cloud;
        }

        if (!cloudTopic) continue;

        const jsonStr = message.toString();
        const tier = getTier(cloudTopic);

        // Always store latest value for heartbeat, even if we don't send now
        lastReceived[cloudTopic] = { json: jsonStr, receivedAt: Date.now() };

        // Change detection: skip if payload is identical to last sent
        if (tier.changeOnly && !hasChanged(cloudTopic, jsonStr)) return;

        // Interval gate: check if enough time has passed
        if (tier.interval > 0 && !shouldSend(cloudTopic, tier.interval)) {
            // Threshold bypass: send immediately if values changed significantly
            if (tier.thresholds && exceedsThreshold(tier.thresholds, cloudTopic, jsonStr)) {
                lastSent[cloudTopic] = Date.now(); // reset interval timer
            } else {
                return;
            }
        }

        publishToCloud(cloudTopic, message, { qos: 1 }, 'changed');
        lastSentJson[cloudTopic] = jsonStr;
        return;
    }
}

function subscribeLocalToCloud() {
    if (!localClient) return;

    // Subscribe to all local status topics (idempotent — safe to call on reconnect)
    for (const mapping of LOCAL_TO_CLOUD) {
        localClient.subscribe(mapping.local, { qos: 1 });
    }
    localClient.subscribe(SYSTEM_SYNC.local, { qos: 1 });
}

// ── Cloud → Local command routing ───────────────────────────────────

// Cloud broker message handler — attached exactly once per cloudClient.
// Critical: must NOT be reattached on reconnect, because individual
// light/relay commands are toggle-based. Duplicate listeners cause each
// toggle to be applied N times, so on an even count the light flickers
// back to its previous state — exactly the "sometimes works, sometimes
// doesn't" symptom. All On/Off and brightness are idempotent so they
// remain visually unaffected by listener leaks.
function handleCloudMessage(topic, message) {
    try {
        const payload = JSON.parse(message.toString());
        const parts = topic.split('/');

        if (parts[0] !== 'rv') return;

        if (parts[1] === 'lights') {
            if (parts[2] === 'all' && parts[3] === 'command') {
                // All lights on/off — broadcast to every Torrent instance
                // (0x018/0x019/0x01A). Modules that aren't present ignore
                // frames not addressed to their CAN ID.
                const state = payload.state ? 1 : 0;
                for (let instance = 0; instance < 3; instance++) {
                    mqttServiceRef.publishCanMessage(0x018 + instance, [0x08, state]);
                }
            } else if (parts[3] === 'command') {
                const lightId = parseInt(parts[2]);
                if (lightId >= 1 && lightId <= 24) {
                    const instance = Math.floor((lightId - 1) / 8);
                    const channel = (lightId - 1) % 8;
                    canBridge.sendLightToggle(mqttServiceRef, channel, instance);
                }
            } else if (parts[3] === 'brightness') {
                const lightId = parseInt(parts[2]);
                if (lightId >= 1 && lightId <= 24) {
                    const brightness = payload.brightness || 0;
                    const instance = Math.floor((lightId - 1) / 8);
                    const channel = (lightId - 1) % 8;
                    canBridge.sendLightBrightness(mqttServiceRef, channel, brightness, instance);
                }
            }
        } else if (parts[1] === 'relays') {
            if (parts[2] === 'all' && parts[3] === 'command') {
                canBridge.sendRelayAll(mqttServiceRef, payload.state);
            } else if (parts[3] === 'command') {
                const relayId = parseInt(parts[2]);
                if (relayId >= 1 && relayId <= 24) {
                    canBridge.sendRelayToggle(mqttServiceRef, relayId - 1);
                }
            }
        } else if (parts[1] === 'thermostat' && parts[2] === 'command') {
            // Pass through to local thermostat
            localClient.publish('local/thermostat/command', message, { qos: 1 });
        } else if (parts[1] === 'proximity') {
            // Pass through proximity events/status to local broker
            const localTopic = topic.replace('rv/', 'local/');
            localClient.publish(localTopic, message, { qos: 1 });
        }
    } catch (err) {
        console.error('[Cloud Bridge] Error handling cloud command:', err.message);
    }
}

function subscribeCloudToLocal() {
    if (!cloudClient) return;

    // Subscribe to cloud command topics (idempotent — safe to call on reconnect)
    cloudClient.subscribe('rv/lights/+/command', { qos: 1 });
    cloudClient.subscribe('rv/lights/+/brightness', { qos: 1 });
    cloudClient.subscribe('rv/lights/all/command', { qos: 1 });
    cloudClient.subscribe('rv/relays/+/command', { qos: 1 });
    cloudClient.subscribe('rv/relays/all/command', { qos: 1 });
    cloudClient.subscribe('rv/thermostat/command', { qos: 1 });
    cloudClient.subscribe('rv/proximity/event', { qos: 1 });
    cloudClient.subscribe('rv/proximity/status', { qos: 1 });
}

// ── Public API ──────────────────────────────────────────────────────

function connect(mqttService, domain, username, password) {
    mqttServiceRef = mqttService;
    localClient = mqttService.client;

    if (!localClient) {
        console.error('[Cloud Bridge] Local MQTT client not available');
        return;
    }

    // Disconnect existing cloud client if reconnecting with new creds
    if (cloudClient) {
        cloudClient.end(true);
        cloudClient = null;
    }

    const brokerUrl = `mqtts://${domain}:8883`;
    console.log(`[Cloud Bridge] Connecting to cloud broker at ${brokerUrl}`);

    cloudClient = mqtt.connect(brokerUrl, {
        clientId: `rv-cloud-bridge-${Date.now()}`,
        clean: true,
        reconnectPeriod: 5000,
        username,
        password,
        protocolVersion: 4,
        keepalive: 60,
        rejectUnauthorized: true   // Use system CA store (Let's Encrypt)
    });

    // Attach message listener exactly ONCE per client. mqtt.js fires 'connect'
    // on every reconnect, so attaching inside the connect handler would leak
    // a listener on each reconnect and cause duplicated toggle commands.
    cloudClient.on('message', handleCloudMessage);

    cloudClient.on('connect', () => {
        console.log('[Cloud Bridge] Connected to cloud broker');
        subscribeCloudToLocal();
        // Trigger config re-sync on cloud connect
        if (localClient && localClient.connected) {
            localClient.publish('local/config/system_sync_trigger',
                JSON.stringify({ reason: 'cloud_reconnect' }), { qos: 1 });
        }
        // Forced heartbeat: immediately publish all cached state to resync
        publishHeartbeat();
        startHeartbeat();
    });

    cloudClient.on('error', (err) => {
        console.error('[Cloud Bridge] Cloud MQTT error:', err.message);
    });

    cloudClient.on('close', () => {
        console.log('[Cloud Bridge] Cloud connection closed');
        stopHeartbeat();
    });

    // Set up local→cloud bridging. The message listener is attached to
    // localClient only once per connect() call — removeListener first to
    // keep this safe if connect() is re-invoked (e.g. credentials update).
    localClient.removeListener('message', handleLocalMessage);
    localClient.on('message', handleLocalMessage);
    subscribeLocalToCloud();

    // Start bandwidth stats logging
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(logStats, STATS_LOG_INTERVAL_MS);
}

function disconnect() {
    stopHeartbeat();
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    if (cloudClient) {
        console.log('[Cloud Bridge] Disconnecting from cloud broker');
        cloudClient.end(true);
        cloudClient = null;
    }
    // Clear rate limit and change detection state
    for (const key of Object.keys(lastSent)) delete lastSent[key];
    for (const key of Object.keys(lastReceived)) delete lastReceived[key];
    for (const key of Object.keys(lastSentJson)) delete lastSentJson[key];
}

function updateRateLimit(msgsPerSec) {
    // Legacy API — tiered intervals now control per-topic rates.
    // Kept for backward compatibility with system-config callers.
    console.log(`[Cloud Bridge] Rate limit setting ignored (using tiered intervals). Requested: ${msgsPerSec} msgs/sec`);
}

module.exports = { connect, disconnect, updateRateLimit };
