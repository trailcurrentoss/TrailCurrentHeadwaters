const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

// MQTT Topic Path Constants
const MQTT_ROOT = 'local';
const MQTT_LIGHTS = 'lights';
const MQTT_THERMOSTAT = 'thermostat';
const MQTT_ENERGY = 'energy';
const MQTT_AIRQUALITY = 'airquality';
const MQTT_GPS = 'gps';
const MQTT_RELAYS = 'relays';

// MQTT Message Types
const MSG_COMMAND = 'command';
const MSG_BRIGHTNESS = 'brightness';
const MSG_STATUS = 'status';


// MQTT Topics
const TOPICS = {
    LIGHT_COMMAND: `${MQTT_ROOT}/${MQTT_LIGHTS}/+/${MSG_COMMAND}`,  // + is wildcard for light ID
    LIGHT_STATUS: `${MQTT_ROOT}/${MQTT_LIGHTS}/+/${MSG_STATUS}`,
    THERMOSTAT_COMMAND: `${MQTT_ROOT}/${MQTT_THERMOSTAT}/${MSG_COMMAND}`,
    THERMOSTAT_STATUS: `${MQTT_ROOT}/${MQTT_THERMOSTAT}/${MSG_STATUS}`,
    ENERGY_STATUS: `${MQTT_ROOT}/${MQTT_ENERGY}/${MSG_STATUS}`,
    AIRQUALITY_STATUS: `${MQTT_ROOT}/${MQTT_AIRQUALITY}/${MSG_STATUS}`,
    AIRQUALITY_TEMP_AND_HUMIDITY: `${MQTT_ROOT}/${MQTT_AIRQUALITY}/temphumid`,
    GPS_LAT_LON: `${MQTT_ROOT}/${MQTT_GPS}/latlon`,
    GPS_ALT: `${MQTT_ROOT}/${MQTT_GPS}/alt`,
    GPS_GNSS_DETAILS: `${MQTT_ROOT}/${MQTT_GPS}/details`,
    GPS_TIME: `${MQTT_ROOT}/${MQTT_GPS}/time`,
    RELAY_STATUS: `${MQTT_ROOT}/${MQTT_RELAYS}/+/${MSG_STATUS}`,
    CLOUD_CONFIG_CHANGED: 'local/config/cloud_updated'
};

class MqttService {
    constructor() {
        this.client = null;
        this.db = null;
        this.broadcast = null;
        this.connected = false;
        this.relayNameCache = {};  // lightId → name, refreshed on sync
    }

    connect(db, broadcast) {
        this.db = db;
        this.broadcast = broadcast;

        const brokerUrl = process.env.MQTT_BROKER_URL;
        const username = process.env.MQTT_USERNAME;
        const password = process.env.MQTT_PASSWORD;
        console.log(`Connecting to MQTT broker at ${brokerUrl}`);

        const options = {
            clientId: `rv-backend-${Date.now()}`,
            clean: true,
            reconnectPeriod: 5000,
            username: username,
            password: password,
        };

        // Load CA certificate for TLS connections
        const caPath = path.join('/app/certs', 'ca.pem');
        if (brokerUrl.startsWith('mqtts://') && fs.existsSync(caPath)) {
            options.ca = fs.readFileSync(caPath);
            // Verify cert against expected hostname since internal Docker hostname differs
            const expectedHost = process.env.TLS_CERT_HOSTNAME;
            if (expectedHost) {
                options.checkServerIdentity = (_host, cert) => {
                    return tls.checkServerIdentity(expectedHost, cert);
                };
            }
            console.log('Loaded CA certificate for TLS');
        }

        this.client = mqtt.connect(brokerUrl, options);

        this.client.on('connect', () => {
            console.log('Connected to MQTT broker');
            this.connected = true;
            this.subscribeToTopics();
        });

        this.client.on('error', (error) => {
            console.error('MQTT connection error:', error);
        });

        this.client.on('close', () => {
            console.log('MQTT connection closed');
            this.connected = false;
        });

        this.client.on('message', (topic, message) => {
            this.handleMessage(topic, message);
        });

        return this;
    }

    subscribeToTopics() {
        // Subscribe to light status topics (for real light controller integration)
        this.client.subscribe(TOPICS.LIGHT_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to light status:', err);
            } else {
                console.log('Subscribed to light status topics');
            }
        });

        // Subscribe to relay status topics (for Switchback relay module)
        this.client.subscribe(TOPICS.RELAY_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to relay status:', err);
            } else {
                console.log('Subscribed to relay status topics');
            }
        });

        // Subscribe to energy status topic
        this.client.subscribe(TOPICS.ENERGY_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to energy status:', err);
            } else {
                console.log('Subscribed to energy status topic');
            }
        });

        // Subscribe to air quality status topic
        this.client.subscribe(TOPICS.AIRQUALITY_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to air quality status:', err);
            } else {
                console.log('Subscribed to air quality status topic');
            }
        });

        // Subscribe to air quality temp and humidity topic
        this.client.subscribe(TOPICS.AIRQUALITY_TEMP_AND_HUMIDITY, (err) => {
            if (err) {
                console.error('Failed to subscribe to air quality temp and humidity:', err);
            } else {
                console.log('Subscribed to air quality temp and humidity topic');
            }
        })

        // Subscribe to GPS lat and lon topic
        this.client.subscribe(TOPICS.GPS_LAT_LON, (err) => {
            if (err) {
                console.error('Failed to subscribe to GPS lat/lon:', err);
            } else {
                console.log('Subscribed to GPS lat/lon topic');
            }
        });

        // Subscribe to GPS altitude topic
        this.client.subscribe(TOPICS.GPS_ALT, (err) => {
            if (err) {
                console.error('Failed to subscribe to GPS altitude:', err);
            } else {
                console.log('Subscribed to GPS altitude topic');
            }
        });

        // Subscribe to GPS details topic
        this.client.subscribe(TOPICS.GPS_GNSS_DETAILS, (err) => {
            if (err) {
                console.error('Failed to subscribe to GPS details:', err);
            } else {
                console.log('Subscribed to GPS details topic');
            }
        });

        // Subscribe to GPS time topic
        this.client.subscribe(TOPICS.GPS_TIME, (err) => {
            if (err) {
                console.error('Failed to subscribe to GPS time:', err);
            } else {
                console.log('Subscribed to GPS time topic');
            }
        });
    }

    handleMessage(topic, message) {
        try {
            const payload = JSON.parse(message.toString());

            // Parse topic to determine type
            const parts = topic.split('/');
            if (parts[0] !== MQTT_ROOT) return;

            if (parts[1] === MQTT_RELAYS) {
                const relayId = parseInt(parts[2]);
                const messageType = parts[3];

                if (messageType === MSG_STATUS) {
                    this.handleRelayStatus(relayId, payload);
                }
            } else if (parts[1] === MQTT_LIGHTS) {
                const lightId = parseInt(parts[2]);
                const messageType = parts[3];

                if (messageType === MSG_COMMAND) {
                    this.handleLightCommand(lightId, payload);
                } else if (messageType === MSG_STATUS) {
                    this.handleLightStatus(lightId, payload);
                }
            } else if (parts[1] === MQTT_ENERGY && parts[2] === MSG_STATUS) {
                this.handleEnergyStatus(payload);
            } else if (parts[1] === MQTT_AIRQUALITY && parts[2] === MSG_STATUS) {
                this.handleAirQualityStatus(payload);
            } else if (parts[1] === MQTT_AIRQUALITY && parts[2] === 'temphumid') {
                this.handleAirQualityTempAndHumdity(payload);
            } else if (parts[1] === MQTT_GPS && parts[2] === 'latlon') {
                this.handleGpsStatus(payload);
            } else if (parts[1] === MQTT_GPS && parts[2] === 'alt') {
                this.handleGpsAlt(payload);
            } else if (parts[1] === MQTT_GPS && parts[2] === 'details') {
                this.handleGpsDetails(payload);
            } else if (parts[1] === MQTT_GPS && parts[2] === 'time') {
                this.handleGpsTime(payload);
            } else if (parts[1] === MQTT_THERMOSTAT && parts[2] === MSG_STATUS) {
                this.handleThermostatStatus(payload);
            }
        } catch (error) {
            console.error('Error handling MQTT message:', error);
        }
    }

    // Handle light status update from light controller
    async handleLightStatus(lightId, payload) {
        console.log(`Received light status for light ${lightId}:`, payload);

        // Broadcast light status data via WebSocket, including name from DB
        if (this.broadcast) {
            const lightData = { "id": lightId, "_id": lightId, "state": payload.state, "brightness": payload.brightness };
            try {
                const light = await this.db.collection('lights').findOne({ _id: lightId });
                if (light && light.name) {
                    lightData.name = light.name;
                }
            } catch (err) {
                // Non-fatal — broadcast without name
            }
            this.broadcast('light', lightData);
        }
    }

    // Handle relay status update from Switchback module
    // Maps relay channel (1-6) to light ID (101-106) for unified WebSocket broadcast
    // Uses in-memory name cache to avoid DB queries on the 33ms hot path
    handleRelayStatus(relayId, payload) {
        const SWITCHBACK_ID_BASE = 100;
        const lightId = SWITCHBACK_ID_BASE + relayId;

        if (this.broadcast) {
            const relayData = { id: lightId, _id: lightId, state: payload.state };
            if (this.relayNameCache[lightId]) {
                relayData.name = this.relayNameCache[lightId];
            }
            this.broadcast('light', relayData);
        }
    }

    // Refresh relay name cache from DB — called after switchback channel sync
    async refreshRelayNameCache() {
        try {
            const relays = await this.db.collection('lights').find({ source: 'switchback' }).toArray();
            this.relayNameCache = {};
            for (const r of relays) {
                this.relayNameCache[r._id] = r.name;
            }
            console.log(`[MQTT] Cached ${relays.length} relay names`);
        } catch (err) {
            console.error('[MQTT] Failed to refresh relay name cache:', err.message);
        }
    }

    // Publish relay toggle command — routes to CAN ID 0x25 via Node-RED
    publishRelayToggle(channel) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish relay toggle');
            return false;
        }

        const topic = `${MQTT_ROOT}/${MQTT_RELAYS}/${channel + 1}/${MSG_COMMAND}`;
        const payload = { action: 'toggle' };
        console.log(`Publishing relay toggle to ${topic}:`, payload);
        this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
        return true;
    }

    // Publish relay all on/off command — routes to CAN ID 0x25 [6, state] via Node-RED
    publishRelayAllCommand(state) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish relay all command');
            return false;
        }

        const topic = `${MQTT_ROOT}/${MQTT_RELAYS}/all/${MSG_COMMAND}`;
        const payload = { state };
        console.log(`Publishing relay all command to ${topic}:`, payload);
        this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
        return true;
    }

    // Handle energy status update from battery monitor
    async handleEnergyStatus(payload) {
        console.log('Received energy status:', payload);

        if (this.db) {
            try {
                const updates = { updated_at: new Date() };

                if (payload.solar_watts !== undefined) {
                    updates.solar_watts = payload.solar_watts;
                }

                if (payload.battery_percent !== undefined) {
                    updates.battery_percent = payload.battery_percent;
                }

                if (payload.battery_voltage !== undefined) {
                    updates.battery_voltage = payload.battery_voltage;
                }

                if (payload.charge_type !== undefined) {
                    updates.charge_type = payload.charge_type;
                }

                if (payload.time_remaining_minutes !== undefined) {
                    updates.time_remaining_minutes = payload.time_remaining_minutes;
                }

                if (payload.consumption_watts !== undefined) {
                    updates.consumption_watts = payload.consumption_watts;
                }

                if (Object.keys(updates).length > 1) {
                    const energy = this.db.collection('energy');
                    await energy.updateOne(
                        { _id: 'main' },
                        { $set: updates }
                    );

                    // Get updated energy data and broadcast via WebSocket
                    const data = await energy.findOne({ _id: 'main' });
                    if (data && this.broadcast) {
                        this.broadcast('energy', data);
                    }
                }
            } catch (error) {
                console.error('Error updating energy in database:', error);
            }
        }
    }

    async handleAirQualityTempAndHumdity(payload) {
        console.log('Received air quality temp and humidity', payload);
        this.broadcast('temphumid', payload);
    }

    // Handle air quality status update from sensor (SGP30: TVOC + eCO2)
    async handleAirQualityStatus(payload) {
        console.log('Received air quality status:', payload);

        if (this.db) {
            try {
                const updates = { updated_at: new Date() };

                if (payload.tvoc_ppb !== undefined) {
                    updates.tvoc_ppb = payload.tvoc_ppb;
                }

                if (payload.eco2_ppm !== undefined) {
                    updates.eco2_ppm = payload.eco2_ppm;
                }

                if (Object.keys(updates).length > 1) {
                    const airquality = this.db.collection('airquality');
                    await airquality.updateOne(
                        { _id: 'main' },
                        { $set: updates },
                        { upsert: true }
                    );

                    // Get updated air quality data and broadcast via WebSocket
                    const data = await airquality.findOne({ _id: 'main' });
                    if (data && this.broadcast) {
                        this.broadcast('airquality', data);
                    }
                }
            } catch (error) {
                console.error('Error updating air quality in database:', error);
            }
        }
    }

    // Handle GPS lat/lon update from GPS module
    handleGpsStatus(payload) {
        console.log('Received GPS lat/lon:', payload);

        // Broadcast GPS data directly via WebSocket (no database storage needed)
        if (this.broadcast) {
            this.broadcast('latlon', {
                latitude: payload.latitude,
                longitude: payload.longitude
            });
        }
    }

    // Handle GPS altitude update from GPS module
    handleGpsAlt(payload) {
        console.log('Received GPS altitude:', payload);

        // Broadcast GPS data directly via WebSocket (no database storage needed)
        if (this.broadcast) {
            this.broadcast('alt', {
                altitudeInMeters: payload.altitudeInMeters,
                altitudeFeet: payload.altitudeFeet
            });
        }
    }

    // Handle GPS time update from GNSS module
    handleGpsTime(payload) {
        console.log('Received GPS time:', payload);

        if (this.broadcast) {
            this.broadcast('gps_time', {
                year: payload.year,
                month: payload.month,
                day: payload.day,
                hour: payload.hour,
                minute: payload.minute,
                second: payload.second
            });
        }
    }

    // Handle GPS details update from GPS module
    handleGpsDetails(payload) {
        console.log('Received GPS details:', payload);

        // Broadcast GPS data directly via WebSocket (no database storage needed)
        if (this.broadcast) {
            this.broadcast('gnss_details', {
                numberOfSatellites: payload.numberOfSatellites,
                speedOverGround: payload.speedOverGround,
                courseOverGround: payload.courseOverGround,
                gnssMode: payload.gnssMode
            });
        }
    }

    // Handle thermostat status update from HVAC controller
    handleThermostatStatus(payload) {
        console.log('Received thermostat status:', payload);

        // Broadcast thermostat data directly via WebSocket (no database storage)
        if (this.broadcast) {
            this.broadcast('thermostat', {
                target_temp: payload.target_temp,
                mode: payload.mode
            });
        }
    }

    // Publish thermostat command
    publishThermostatCommand(target_temp, mode) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish thermostat command');
            return false;
        }

        const topic = TOPICS.THERMOSTAT_COMMAND;
        const payload = {};
        if (target_temp !== undefined) {
            payload.target_temp = target_temp;
        }
        if (mode !== undefined) {
            payload.mode = mode;
        }

        console.log(`Publishing thermostat command to ${topic}:`, payload);
        this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
        return true;
    }    


    // Publish light command — routes to separate MQTT topics for toggle vs brightness
    // so Node-RED can send them to different CAN bus messages
    publishLightCommand(lightId, state, brightness = null) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish light command');
            return false;
        }

        if (brightness !== null) {
            // Brightness set: separate topic → CAN ID 0x015
            const topic = `${MQTT_ROOT}/${MQTT_LIGHTS}/${lightId}/${MSG_BRIGHTNESS}`;
            const payload = { brightness };
            console.log(`Publishing light brightness to ${topic}:`, payload);
            this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
        } else {
            // Toggle: existing topic → CAN ID 0x018
            const topic = `${MQTT_ROOT}/${MQTT_LIGHTS}/${lightId}/${MSG_COMMAND}`;
            const payload = { state };
            console.log(`Publishing light command to ${topic}:`, payload);
            this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
        }
        return true;
    }

    // Publish light status (used by simulated light controller)
    publishLightStatus(lightId, payload) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish light status');
            return false;
        }

        const topic = `${MQTT_ROOT}/${MQTT_LIGHTS}/${lightId}/${MSG_STATUS}`;
        console.log(`Publishing light status to ${topic}:`, payload);
        this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
        return true;
    }

    // Publish CAN message (e.g., OTA trigger)
    publishCanMessage(canId, dataBytes) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish CAN message');
            return false;
        }

        // Convert byte array to bit arrays format
        // Each byte becomes an array of 8 bits (MSB first to LSB)
        const bitArrays = dataBytes.map(byte => {
            const bits = [];
            for (let i = 7; i >= 0; i--) {
                bits.push((byte >> i) & 1);
            }
            return bits;
        });

        // Pad with zeros to 8 bytes if needed
        while (bitArrays.length < 8) {
            bitArrays.push([0, 0, 0, 0, 0, 0, 0, 0]);
        }

        const topic = 'can/outbound';
        const payload = {
            identifier: `0x${canId.toString(16)}`,
            data_length_code: Math.min(dataBytes.length, 8),
            data: bitArrays.slice(0, 8),
            extd: 0,
            rtr: 0,
            ss: 0,
            self: 0
        };

        console.log(`Publishing CAN message to ${topic}:`, payload);
        this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
        return true;
    }

    /**
     * Publish WiFi credentials to all MCUs via CAN bus
     * Sends multi-message sequence: Start, SSID chunks, Password chunks, End
     * @param {string} ssid - WiFi SSID (max 32 chars)
     * @param {string} password - WiFi password (max 63 chars)
     * @returns {boolean} Success status
     */
    publishWifiCredentials(ssid, password) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish WiFi credentials');
            return false;
        }

        // Validate inputs
        if (!ssid || ssid.length > 32) {
            console.error('Invalid SSID length (max 32 chars)');
            return false;
        }
        if (!password || password.length > 63) {
            console.error('Invalid password length (max 63 chars)');
            return false;
        }

        console.log(`[WiFi Config] Broadcasting credentials to MCUs (SSID: ${ssid})`);

        const ssidBytes = Buffer.from(ssid, 'utf8');
        const passwordBytes = Buffer.from(password, 'utf8');
        const ssidChunks = Math.ceil(ssidBytes.length / 6);
        const passwordChunks = Math.ceil(passwordBytes.length / 6);

        // Helper to send with delay
        const sendWithDelay = (messages, index = 0) => {
            if (index >= messages.length) {
                console.log('[WiFi Config] All messages sent');
                return;
            }

            this.publishCanMessage(0x01, messages[index]);
            setTimeout(() => sendWithDelay(messages, index + 1), 50);
        };

        // Build message sequence
        const messages = [];

        // 1. Start message
        messages.push([0x01, ssidBytes.length, passwordBytes.length, ssidChunks, passwordChunks, 0x00, 0x00, 0x00]);

        // 2. SSID chunks
        for (let i = 0; i < ssidChunks; i++) {
            const chunk = [0x02, i];
            const start = i * 6;
            const end = Math.min(start + 6, ssidBytes.length);
            for (let j = start; j < end; j++) {
                chunk.push(ssidBytes[j]);
            }
            while (chunk.length < 8) chunk.push(0x00);
            messages.push(chunk);
        }

        // 3. Password chunks
        for (let i = 0; i < passwordChunks; i++) {
            const chunk = [0x03, i];
            const start = i * 6;
            const end = Math.min(start + 6, passwordBytes.length);
            for (let j = start; j < end; j++) {
                chunk.push(passwordBytes[j]);
            }
            while (chunk.length < 8) chunk.push(0x00);
            messages.push(chunk);
        }

        // 4. End message with simple checksum
        let checksum = 0;
        for (let i = 0; i < ssidBytes.length; i++) checksum ^= ssidBytes[i];
        for (let i = 0; i < passwordBytes.length; i++) checksum ^= passwordBytes[i];
        messages.push([0x04, checksum, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

        // Send sequence with delays
        sendWithDelay(messages);
        return true;
    }

    /**
     * Publish Plateau leveling configuration via CAN bus (CAN ID 0x20)
     * Sends a single-frame message with subcommand 0x01 (set config)
     * Only the Plateau module firmware listens on CAN ID 0x20
     * @param {number} mounting - Mounting surface (0=floor, 1=left_wall, 2=right_wall)
     * @param {number} vehicleLengthCm - Vehicle length in centimeters (uint16)
     * @param {number} vehicleWidthCm - Vehicle width in centimeters (uint16)
     * @returns {boolean} Success status
     */
    publishPlateauConfig(mounting, vehicleLengthCm, vehicleWidthCm) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish Plateau config');
            return false;
        }

        console.log(`[Plateau Config] Sending config: mounting=${mounting}, length=${vehicleLengthCm}cm, width=${vehicleWidthCm}cm`);

        const dataBytes = [
            0x01,                                    // Subcommand: set leveling config
            mounting & 0xFF,                         // Mounting surface
            (vehicleLengthCm >> 8) & 0xFF,           // Vehicle length high byte
            vehicleLengthCm & 0xFF,                  // Vehicle length low byte
            (vehicleWidthCm >> 8) & 0xFF,            // Vehicle width high byte
            vehicleWidthCm & 0xFF,                   // Vehicle width low byte
            0x01                                     // Persist to NVS
        ];

        return this.publishCanMessage(0x20, dataBytes);
    }

    // Publish PDM channel configuration for cloud sync
    publishPdmChannelConfig(channels) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish PDM channel config');
            return false;
        }

        const topic = `${MQTT_ROOT}/config/pdm_channels`;
        const payload = { channels };
        console.log(`Publishing PDM channel config to ${topic} (${channels.length} channels)`);
        this.client.publish(topic, JSON.stringify(payload), { qos: 1, retain: true });
        return true;
    }

    // Publish Switchback relay channel configuration for local services
    publishRelayChannelConfig(channels) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish relay channel config');
            return false;
        }

        const topic = `${MQTT_ROOT}/config/relay_channels`;
        const payload = { channels };
        console.log(`Publishing relay channel config to ${topic} (${channels.length} channels)`);
        this.client.publish(topic, JSON.stringify(payload), { qos: 1, retain: true });
        return true;
    }

    // Notify local services that cloud configuration has changed
    publishCloudConfigChanged() {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish cloud config notification');
            return false;
        }

        const topic = TOPICS.CLOUD_CONFIG_CHANGED;
        const payload = { timestamp: new Date().toISOString() };
        console.log(`Publishing cloud config changed to ${topic}`);
        this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
        return true;
    }

    disconnect() {
        if (this.client) {
            this.client.end();
            this.connected = false;
        }
    }
}

// Singleton instance
const mqttService = new MqttService();

module.exports = mqttService;
