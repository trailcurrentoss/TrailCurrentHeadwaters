'use strict';

// CAN Bus Bridge — replaces Node-RED starter-flow CAN↔MQTT routing.
// Subscribes to can/inbound, parses CAN frames by identifier, publishes
// structured JSON to local/* MQTT topics. Also exports outbound helpers
// for sending CAN commands (lights, relays, brightness).

// ── Shared helpers ──────────────────────────────────────────────────

function decodeBitArrays(data) {
    return data.map(bitArray => parseInt(bitArray.join(''), 2));
}

function toBitArray(byte) {
    return [(byte >> 7) & 1, (byte >> 6) & 1, (byte >> 5) & 1, (byte >> 4) & 1,
            (byte >> 3) & 1, (byte >> 2) & 1, (byte >> 1) & 1, byte & 1];
}

// ── Energy merge accumulator (module-level, same as Node-RED flow.set) ─

let energyState = {};

// ── Database reference (set during init) ────────────────────────────

let systemConfig = null;

// ── CAN ID → parser table ───────────────────────────────────────────

const CHARGE_TYPES = { 0: 'off', 2: 'fault', 3: 'bulk', 4: 'absorption', 5: 'float', 7: 'equalize' };

// Switchback instance offsets: CAN 0x028 → instance 0 (relays 1-8),
// 0x029 → instance 1 (relays 9-16), 0x02a → instance 2 (relays 17-24).
const SWITCHBACK_RELAY_OFFSET = { '0x028': 0, '0x029': 8, '0x02a': 16 };

// Torrent (PDM) instance offsets: CAN 0x01b → instance 0 (lights 1-8),
// 0x01c → instance 1 (lights 9-16), 0x01d → instance 2 (lights 17-24).
const TORRENT_LIGHT_OFFSET = { '0x01b': 0, '0x01c': 8, '0x01d': 16 };

const parsers = {
    // ── Firmware version broadcast (0x004) ─────────────────────────
    '0x004': async (data) => {
        if (!systemConfig) return;
        const decoded = decodeBitArrays(data);
        const mac3 = decoded[0], mac4 = decoded[1], mac5 = decoded[2];
        const hostname = `esp32-${mac3.toString(16).toUpperCase().padStart(2, '0')}${mac4.toString(16).toUpperCase().padStart(2, '0')}${mac5.toString(16).toUpperCase().padStart(2, '0')}`;
        const fw = `${decoded[3]}.${decoded[4]}.${decoded[5]}`;

        try {
            const config = await systemConfig.findOne({ _id: 'main' });
            if (!config || !config.mcu_modules) return;
            const module = config.mcu_modules.find(m => m.hostname === hostname);
            if (!module || module.fw === fw) return;

            module.fw = fw;
            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: { mcu_modules: config.mcu_modules, updated_at: new Date() } }
            );
            console.log(`[CAN Bridge] Updated firmware version for ${hostname} to ${fw}`);
        } catch (err) {
            console.error(`[CAN Bridge] Failed to update fw for ${hostname}:`, err.message);
        }
    },

    // ── Lights (0x01b / 0x01c / 0x01d) — per-instance topics ───────
    '0x01b': (data, mqtt) => parseLightStatus(data, mqtt, '0x01b'),
    '0x01c': (data, mqtt) => parseLightStatus(data, mqtt, '0x01c'),
    '0x01d': (data, mqtt) => parseLightStatus(data, mqtt, '0x01d'),

    // ── Switchback digital-input broadcasts (0x012/0x013/0x014) ────
    // CAN payload: byte 0 = DIN1..DIN8 bitmask (Picket-format), byte 1 reserved.
    // Republished as local/spoor/<addr>/inputs for Spotter to consume.
    '0x012': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        mqtt.publish('local/spoor/0/inputs',
            JSON.stringify({ addr: 0, inputs: decoded[0] & 0xFF }));
    },
    '0x013': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        mqtt.publish('local/spoor/1/inputs',
            JSON.stringify({ addr: 1, inputs: decoded[0] & 0xFF }));
    },
    '0x014': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        mqtt.publish('local/spoor/2/inputs',
            JSON.stringify({ addr: 2, inputs: decoded[0] & 0xFF }));
    },

    // ── Picket reed-switch broadcasts (0x00A-0x011, addresses 0-7) ─
    // CAN payload: byte 0 = RSW1..RSW8 bitmask, byte 1 low nibble =
    // RSW9..RSW12 bitmask. Republished as local/picket/<addr>/inputs
    // with a 12-bit `inputs` value (1 = door open / sensor active).
    ...Object.fromEntries(
        Array.from({ length: 8 }, (_, addr) => {
            const canId = '0x' + (0x00A + addr).toString(16).padStart(3, '0');
            return [canId, (data, mqtt) => {
                const decoded = decodeBitArrays(data);
                const inputs = (decoded[0] & 0xFF) | ((decoded[1] & 0x0F) << 8);
                mqtt.publish(`local/picket/${addr}/inputs`,
                    JSON.stringify({ addr, inputs }));
            }];
        })
    ),

    // ── Air quality (0x01f) ────────────────────────────────────────
    '0x01f': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        const humidity = ((decoded[2] << 8) | decoded[3]) / 100;
        const tvoc = (decoded[4] << 8) | decoded[5];
        const eco2 = (decoded[6] << 8) | decoded[7];

        mqtt.publish('local/airquality/temphumid', JSON.stringify({
            tempInC: decoded[0], tempInF: decoded[1], humidity: parseFloat(humidity.toFixed(2))
        }));
        mqtt.publish('local/airquality/status', JSON.stringify({
            tvoc_ppb: tvoc, eco2_ppm: eco2
        }));
    },

    // ── GPS DateTime (0x006) ───────────────────────────────────────
    '0x006': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        mqtt.publish('local/gps/time', JSON.stringify({
            year: (decoded[0] << 8) | decoded[1],
            month: decoded[2], day: decoded[3],
            hour: decoded[4], minute: decoded[5], second: decoded[6]
        }));
    },

    // ── GNSS stats (0x007) ─────────────────────────────────────────
    '0x007': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        mqtt.publish('local/gps/details', JSON.stringify({
            numberOfSatellites: decoded[0],
            speedOverGround: (decoded[1] << 8) | decoded[2],
            courseOverGround: (decoded[3] << 8) | decoded[4],
            gnssMode: decoded[5]
        }));
    },

    // ── GNSS altitude (0x008) ──────────────────────────────────────
    '0x008': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        const scaled = ((decoded[0] << 24) | (decoded[1] << 16) | (decoded[2] << 8) | decoded[3]) >>> 0;
        const altitudeInMeters = scaled / 100.0;
        mqtt.publish('local/gps/alt', JSON.stringify({
            altitudeInMeters,
            altitudeFeet: Math.round(altitudeInMeters * 3.28084)
        }));
    },

    // ── GNSS LatLon (0x009) — sign-magnitude, ported verbatim ─────
    '0x009': (data, mqtt) => {
        // Use raw bit arrays for sign-magnitude decoding (not byte-level)
        const decoded = data.map(bitArray => {
            if (bitArray.length === 8) {
                return parseInt(bitArray.join(''), 2);
            } else if (bitArray.length === 16) {
                const signBit = bitArray[0];
                const bits = bitArray.slice(1).join('');
                return (parseInt(bits, 2) ^ 32768) * Math.pow(-1, signBit);
            } else if (bitArray.length === 32) {
                const signBit = bitArray[0];
                const bits = bitArray.slice(1).join('');
                return parseInt(bits, 2) * Math.pow(-1, signBit);
            }
            return parseInt(bitArray.join(''), 2);
        });

        const latBytes = decoded.slice(0, 4);
        const latSign = (latBytes[0] === 1) ? -1 : 1;
        const latitude = ((latBytes[1] << 16) | (latBytes[2] << 8) | latBytes[3]) / 10000.0 * latSign;

        const lonBytes = decoded.slice(4, 8);
        const lonSign = (lonBytes[0] === 1) ? -1 : 1;
        const longitude = ((lonBytes[1] << 16) | (lonBytes[2] << 8) | lonBytes[3]) / 10000.0 * lonSign;

        mqtt.publish('local/gps/latlon', JSON.stringify({ latitude, longitude }));
    },

    // ── Battery status (0x023) → energy merge ──────────────────────
    '0x023': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        Object.assign(energyState, {
            battery_voltage: decoded[0] + (decoded[1] / 100),
            battery_percent: decoded[5] + (decoded[6] / 100)
        });
        mqtt.publish('local/energy/status', JSON.stringify(energyState));
    },

    // ── Wattage / TTG (0x024) → energy merge ──────────────────────
    '0x024': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        const isNegative = decoded[0] === 0xFF;
        const wattage = (decoded[1] << 8) | decoded[2];
        const ttg = (decoded[3] << 8) | decoded[4];
        const fields = { consumption_watts: isNegative ? wattage : 0 };
        if (ttg > 0 && ttg < 0xFFFF) {
            fields.time_remaining_minutes = ttg;
        }
        Object.assign(energyState, fields);
        mqtt.publish('local/energy/status', JSON.stringify(energyState));
    },

    // ── Solar MPPT (0x02c) → energy merge ──────────────────────────
    '0x02c': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        const solarWatts = (decoded[2] << 8) | decoded[3];
        const csEnum = decoded[6];
        Object.assign(energyState, {
            solar_watts: solarWatts,
            charge_type: CHARGE_TYPES[csEnum] || 'unknown'
        });
        mqtt.publish('local/energy/status', JSON.stringify(energyState));
    },

    // ── Relay bitmask (0x028 / 0x029 / 0x02a) — per-instance topics
    '0x028': (data, mqtt) => parseRelayStatus(data, mqtt, '0x028'),
    '0x029': (data, mqtt) => parseRelayStatus(data, mqtt, '0x029'),
    '0x02a': (data, mqtt) => parseRelayStatus(data, mqtt, '0x02a'),

    // ── Plateau tilt (0x030) ───────────────────────────────────────
    '0x030': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        let pitch = (decoded[0] << 8) | decoded[1];
        if (pitch >= 0x8000) pitch -= 0x10000;
        let roll = (decoded[2] << 8) | decoded[3];
        if (roll >= 0x8000) roll -= 0x10000;
        let fbDiff = (decoded[4] << 8) | decoded[5];
        if (fbDiff >= 0x8000) fbDiff -= 0x10000;
        let lrDiff = (decoded[6] << 8) | decoded[7];
        if (lrDiff >= 0x8000) lrDiff -= 0x10000;

        mqtt.publish('local/level/tilt', JSON.stringify({
            front_back: pitch * 0.01,
            side_to_side: roll * 0.01,
            front_back_diff_mm: fbDiff,
            left_right_diff_mm: lrDiff
        }));
    },

    // ── Water tank levels (0x03e) — Reservoir module ─────────────────
    '0x03e': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        mqtt.publish('local/water/status', JSON.stringify({
            fresh: decoded[0],
            grey: decoded[1],
            black: decoded[2]
        }));
    },

    // ── Plateau status (0x032) ─────────────────────────────────────
    '0x032': (data, mqtt) => {
        const decoded = decodeBitArrays(data);
        const flags = decoded[0];
        const calPacked = decoded[1];
        const mounting = decoded[2];

        mqtt.publish('local/level/status', JSON.stringify({
            imu_connected: (flags & 0x01) !== 0,
            fully_calibrated: (flags & 0x02) !== 0,
            cal_sys: (calPacked >> 6) & 0x03,
            cal_gyro: (calPacked >> 4) & 0x03,
            cal_accel: (calPacked >> 2) & 0x03,
            cal_mag: calPacked & 0x03,
            mounting
        }));
    }
};

function parseRelayStatus(data, mqtt, canId) {
    const byte0 = parseInt(data[0].join(''), 2);
    const offset = SWITCHBACK_RELAY_OFFSET[canId];
    for (let i = 0; i < 8; i++) {
        mqtt.publish(`local/relays/${offset + i + 1}/status`,
            JSON.stringify({ state: (byte0 >> i) & 1 }));
    }
}

function parseLightStatus(data, mqtt, canId) {
    const decoded = decodeBitArrays(data);
    const offset = TORRENT_LIGHT_OFFSET[canId];
    for (let i = 0; i < 8; i++) {
        const payload = { state: decoded[i] > 0 ? 1 : 0, brightness: decoded[i] };
        mqtt.publish(`local/lights/${offset + i + 1}/status`, JSON.stringify(payload));
    }
}

// ── Inbound handler (called by MqttService.handleMessage) ───────────

function handleCanInbound(payload, mqttClient) {
    const parser = parsers[payload.identifier];
    if (parser && payload.data) {
        parser(payload.data, mqttClient);
    }
}

// ── Outbound command helpers ────────────────────────────────────────

function sendLightToggle(mqttService, deviceIndex, instance) {
    const canId = 0x018 + (instance || 0);
    mqttService.publishCanMessage(canId, [deviceIndex]);
}

function sendLightBrightness(mqttService, deviceIndex, brightness, instance) {
    const canId = 0x015 + (instance || 0);
    mqttService.publishCanMessage(canId, [deviceIndex, brightness]);
}

function sendRelayToggle(mqttService, channelIndex, instance) {
    const canId = 0x025 + (instance || 0);
    mqttService.publishCanMessage(canId, [channelIndex]);
}

function sendRelayAll(mqttService, state, instance) {
    const canId = 0x025 + (instance || 0);
    mqttService.publishCanMessage(canId, [0x08, state ? 1 : 0]);
}

// ── Init (subscribes to can/inbound on the local MQTT client) ───────

function init(mqttService, db) {
    if (db) {
        systemConfig = db.collection('system_config');
    }
    const client = mqttService.client;
    if (!client) {
        console.error('[CAN Bridge] MQTT client not available');
        return;
    }

    client.subscribe('can/inbound', { qos: 2 }, (err) => {
        if (err) {
            console.error('[CAN Bridge] Failed to subscribe to can/inbound:', err);
        } else {
            console.log('[CAN Bridge] Subscribed to can/inbound');
        }
    });

    // Intercept can/inbound messages on the shared client
    const originalHandler = client.listeners('message');
    client.on('message', (topic, message) => {
        if (topic === 'can/inbound') {
            try {
                const payload = JSON.parse(message.toString());
                handleCanInbound(payload, client);
            } catch (err) {
                console.error('[CAN Bridge] Error parsing can/inbound:', err.message);
            }
        }
    });

    console.log('[CAN Bridge] Initialized');
}

module.exports = {
    init,
    handleCanInbound,
    sendLightToggle,
    sendLightBrightness,
    sendRelayToggle,
    sendRelayAll
};
