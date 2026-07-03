const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { readSystemStats } = require('./services/system-stats');

// MQTT Topic Path Constants
const MQTT_ROOT = 'local';
const MQTT_LIGHTS = 'lights';
const MQTT_THERMOSTAT = 'thermostat';
const MQTT_ENERGY = 'energy';
const MQTT_AIRQUALITY = 'airquality';
const MQTT_GPS = 'gps';
const MQTT_RELAYS = 'relays';
const MQTT_LEVEL = 'level';
const MQTT_WATER = 'water';
const MQTT_DEPLOYMENT = 'deployment';
// Playbill in-rig entertainment node — owns radio/livetv/transport state and
// publishes per-device retained status. Multiple Playbills can coexist on one
// rig; topics carry a <deviceId> segment so observers can address one or all.
//
// Topic shape (mirrored from controller/src/mqtt-bridge.js):
//   local/playbill/<deviceId>/<feature>/status   (retained)
//   local/playbill/<deviceId>/<feature>/command
//   local/playbill/all/<feature>/command         (broadcast to every Playbill)
//   local/playbill/<deviceId>/system/status      (presence + LWT, retained)
const MQTT_PLAYBILL = 'playbill';

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
    RELAY_ALL_COMMAND: `${MQTT_ROOT}/${MQTT_RELAYS}/all/${MSG_COMMAND}`,
    WATER_STATUS: `${MQTT_ROOT}/${MQTT_WATER}/${MSG_STATUS}`,
    LEVEL_TILT: `${MQTT_ROOT}/${MQTT_LEVEL}/tilt`,
    LEVEL_STATUS: `${MQTT_ROOT}/${MQTT_LEVEL}/${MSG_STATUS}`,
    CLOUD_CONFIG_CHANGED: 'local/config/cloud_updated',
    SYSTEM_CONFIG_SYNC: 'local/config/system_sync',
    SYSTEM_CONFIG_SYNC_TRIGGER: 'local/config/system_sync_trigger',
    DISCOVERY_BROWSE_START: 'discovery/browse/start',
    DISCOVERY_BROWSE_STOP: 'discovery/browse/stop',
    DISCOVERY_BROWSE_FOUND: 'discovery/browse/found',
    DISCOVERY_CONFIRM_REQUEST: 'discovery/confirm/request',
    DISCOVERY_CONFIRM_RESPONSE: 'discovery/confirm/response',
    // Playbill claim flow — the rig POSTs broker credentials to a freshly
    // discovered Playbill so it can connect to the MQTT broker. Distinct
    // from confirm/* (which is an MCU GET marker) because the payload shape
    // and the receiver semantics are different.
    DISCOVERY_CLAIM_REQUEST: 'discovery/claim/request',
    DISCOVERY_CLAIM_RESPONSE: 'discovery/claim/response',
    // OS-level settings proxy (os-settings.py host daemon). Sibling of
    // discovery/* — kept out of the local/ namespace because these
    // topics cross the container/host boundary rather than describing
    // in-rig runtime state.
    OS_TIMEZONE_REQUEST:  'os/timezone/request',
    OS_TIMEZONE_RESPONSE: 'os/timezone/response',
    OS_TIMEZONE_CURRENT:  'os/timezone/current',   // retained
    SYSTEM_STATS: `${MQTT_ROOT}/system/stats`,
    DEPLOYMENT_AVAILABLE: `${MQTT_ROOT}/${MQTT_DEPLOYMENT}/available`,
    DEPLOYMENT_STATUS: `${MQTT_ROOT}/${MQTT_DEPLOYMENT}/${MSG_STATUS}`,
    PROXIMITY_EVENT: `${MQTT_ROOT}/proximity/event`,
    PROXIMITY_STATUS: `${MQTT_ROOT}/proximity/status`,
    WIRELESS_DISCOVERY_TRIGGER: 'local/discovery/trigger',
    WIRELESS_OTA_TRIGGER: 'local/ota/trigger',
    CONFIG_REQUEST: 'local/config/request',
    // Match every Playbill device + feature status (e.g. radio, livetv,
    // transport, system). The handler unpacks deviceId and feature from the
    // topic segments — we don't need separate constants per feature, which
    // keeps the surface trivially extensible as more features land.
    PLAYBILL_STATUS_ALL: `${MQTT_ROOT}/${MQTT_PLAYBILL}/+/+/${MSG_STATUS}`,
};

// Gated logger for high-frequency per-CAN-frame handlers. These fire many
// times per second (8 lights × 1Hz, GPS 1Hz, etc.) and saturated the backend
// event loop on Headwaters. Set LOG_LEVEL=debug to re-enable them.
const DEBUG_LOG = process.env.LOG_LEVEL === 'debug';
const debugLog = DEBUG_LOG ? console.log.bind(console) : () => {};

class MqttService {
    constructor() {
        this.client = null;
        this.db = null;
        this.broadcast = null;
        this.connected = false;
        this.lightNameCache = {};  // lightId → name (PDM + Switchback). Refreshed on startup and on config edits — NEVER on a CAN-frame hot path.
        this.lightStateCache = {};  // lightId → last known state from CAN bus
        // Global SMS throttle — sliding window of recent send timestamps
        this.smsSentTimestamps = [];
        // Last observed IANA TZ from retained os/timezone/current. Null
        // until the host-side os-settings.py daemon has published.
        this.currentTimezone = null;
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
            this.startSystemStatsPublisher();
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
        // Subscribe to light command topics (for voice assistant / external control)
        this.client.subscribe(TOPICS.LIGHT_COMMAND, (err) => {
            if (err) {
                console.error('Failed to subscribe to light command:', err);
            } else {
                console.log('Subscribed to light command topics');
            }
        });

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

        // Subscribe to relay all-command topic (explicit set-all, not per-channel toggle)
        this.client.subscribe(TOPICS.RELAY_ALL_COMMAND, (err) => {
            if (err) {
                console.error('Failed to subscribe to relay all command:', err);
            } else {
                console.log('Subscribed to relay all command topic');
            }
        });

        // Subscribe to thermostat status topic
        this.client.subscribe(TOPICS.THERMOSTAT_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to thermostat status:', err);
            } else {
                console.log('Subscribed to thermostat status topic');
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

        // Subscribe to water tank status topic (Reservoir module)
        this.client.subscribe(TOPICS.WATER_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to water status:', err);
            } else {
                console.log('Subscribed to water status topic');
            }
        });

        // Subscribe to Plateau level tilt topic
        this.client.subscribe(TOPICS.LEVEL_TILT, (err) => {
            if (err) {
                console.error('Failed to subscribe to level tilt:', err);
            } else {
                console.log('Subscribed to level tilt topic');
            }
        });

        // Subscribe to Plateau level status topic (calibration + IMU state)
        this.client.subscribe(TOPICS.LEVEL_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to level status:', err);
            } else {
                console.log('Subscribed to level status topic');
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

        // Subscribe to config sync trigger (cloud reconnect re-publish)
        this.client.subscribe(TOPICS.SYSTEM_CONFIG_SYNC_TRIGGER, (err) => {
            if (err) {
                console.error('Failed to subscribe to config sync trigger:', err);
            } else {
                console.log('Subscribed to config sync trigger topic');
            }
        });

        // Subscribe to config request (voice assistant / local services requesting current config)
        this.client.subscribe(TOPICS.CONFIG_REQUEST, (err) => {
            if (err) {
                console.error('Failed to subscribe to config request:', err);
            } else {
                console.log('Subscribed to config request topic');
            }
        });

        // Subscribe to discovery browse results (from host-side mDNS browser)
        this.client.subscribe(TOPICS.DISCOVERY_BROWSE_FOUND, (err) => {
            if (err) {
                console.error('Failed to subscribe to discovery browse found:', err);
            } else {
                console.log('Subscribed to discovery browse found topic');
            }
        });

        // Subscribe to discovery confirm responses (from host-side proxy)
        this.client.subscribe(TOPICS.DISCOVERY_CONFIRM_RESPONSE, (err) => {
            if (err) {
                console.error('Failed to subscribe to discovery confirm response:', err);
            } else {
                console.log('Subscribed to discovery confirm response topic');
            }
        });

        // Subscribe to Playbill claim responses (from host-side proxy)
        this.client.subscribe(TOPICS.DISCOVERY_CLAIM_RESPONSE, (err) => {
            if (err) {
                console.error('Failed to subscribe to discovery claim response:', err);
            } else {
                console.log('Subscribed to discovery claim response topic');
            }
        });

        // Subscribe to OS-settings responses + retained current-timezone
        // cache from os-settings.py.
        this.client.subscribe(TOPICS.OS_TIMEZONE_RESPONSE, (err) => {
            if (err) {
                console.error('Failed to subscribe to OS timezone response:', err);
            } else {
                console.log('Subscribed to OS timezone response topic');
            }
        });
        this.client.subscribe(TOPICS.OS_TIMEZONE_CURRENT, (err) => {
            if (err) {
                console.error('Failed to subscribe to OS timezone current:', err);
            } else {
                console.log('Subscribed to OS timezone current topic');
            }
        });

        // Subscribe to proximity events/status (bridged from Farwatch cloud)
        this.client.subscribe(TOPICS.PROXIMITY_EVENT, (err) => {
            if (err) {
                console.error('Failed to subscribe to proximity event:', err);
            } else {
                console.log('Subscribed to proximity event topic');
            }
        });
        this.client.subscribe(TOPICS.PROXIMITY_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to proximity status:', err);
            } else {
                console.log('Subscribed to proximity status topic');
            }
        });

        // Subscribe to local deployment status topic (from deployment-watcher)
        this.client.subscribe(TOPICS.DEPLOYMENT_STATUS, (err) => {
            if (err) {
                console.error('Failed to subscribe to deployment status:', err);
            } else {
                console.log('Subscribed to deployment status topic');
            }
        });

        // Subscribe to every Playbill device's per-feature status. The
        // controller publishes retained payloads so a late-joining PWA gets
        // the current state on subscribe without polling.
        this.client.subscribe(TOPICS.PLAYBILL_STATUS_ALL, (err) => {
            if (err) {
                console.error('Failed to subscribe to playbill status:', err);
            } else {
                console.log('Subscribed to playbill status topic');
            }
        });

        // Track known Playbills so the WebSocket layer can emit a stable
        // "presence list" when a PWA first connects. Cleared on reconnect.
        if (!this.playbillDevices) this.playbillDevices = new Map();
    }

    handleMessage(topic, message) {
        try {
            const payload = JSON.parse(message.toString());

            // Handle discovery messages (not under local/ prefix)
            if (topic === TOPICS.DISCOVERY_BROWSE_FOUND) {
                this.handleDiscoveryFound(payload);
                return;
            }
            if (topic === TOPICS.DISCOVERY_CONFIRM_RESPONSE) {
                this.handleDiscoveryConfirmResponse(payload);
                return;
            }
            if (topic === TOPICS.DISCOVERY_CLAIM_RESPONSE) {
                this.handleDiscoveryClaimResponse(payload);
                return;
            }
            if (topic === TOPICS.OS_TIMEZONE_RESPONSE) {
                this.handleOsTimezoneResponse(payload);
                return;
            }
            if (topic === TOPICS.OS_TIMEZONE_CURRENT) {
                this.handleOsTimezoneCurrent(payload);
                return;
            }

            // Parse topic to determine type
            const parts = topic.split('/');
            if (parts[0] !== MQTT_ROOT) return;

            if (parts[1] === MQTT_RELAYS) {
                const messageType = parts[3];
                if (parts[2] === 'all' && messageType === MSG_COMMAND) {
                    this.handleAllRelaysCommand(payload);
                } else {
                    const relayId = parseInt(parts[2]);
                    if (messageType === MSG_STATUS) {
                        this.handleRelayStatus(relayId, payload);
                    }
                }
            } else if (parts[1] === MQTT_LIGHTS) {
                const messageType = parts[3];
                if (parts[2] === 'all' && messageType === MSG_COMMAND) {
                    this.handleAllLightsCommand(payload);
                } else {
                    const lightId = parseInt(parts[2]);
                    if (messageType === MSG_COMMAND) {
                        this.handleLightCommand(lightId, payload);
                    } else if (messageType === MSG_STATUS) {
                        this.handleLightStatus(lightId, payload);
                    }
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
            } else if (parts[1] === MQTT_WATER && parts[2] === MSG_STATUS) {
                this.handleWaterStatus(payload);
            } else if (parts[1] === MQTT_LEVEL && parts[2] === 'tilt') {
                this.handleLevelTilt(payload);
            } else if (parts[1] === MQTT_LEVEL && parts[2] === MSG_STATUS) {
                this.handleLevelStatus(payload);
            } else if (parts[1] === 'config' && parts[2] === 'system_sync_trigger') {
                this.handleConfigSyncTrigger();
            } else if (parts[1] === 'config' && parts[2] === 'request') {
                this.handleConfigRequest();
            } else if (parts[1] === MQTT_DEPLOYMENT && parts[2] === MSG_STATUS) {
                this.handleDeploymentStatus(payload);
            } else if (parts[1] === 'proximity' && parts[2] === 'event') {
                this.handleProximityEvent(payload);
            } else if (parts[1] === 'proximity' && parts[2] === 'status') {
                this.handleProximityStatus(payload);
            } else if (parts[1] === MQTT_PLAYBILL && parts.length === 5 && parts[4] === MSG_STATUS) {
                // local/playbill/<deviceId>/<feature>/status
                this.handlePlaybillStatus(parts[2], parts[3], payload);
            }
        } catch (error) {
            console.error('Error handling MQTT message:', error);
        }
    }

    // Handle light status update from light controller
    async handleLightStatus(lightId, payload) {
        debugLog(`Received light status for light ${lightId}:`, payload);

        // Broadcast light status data via WebSocket. Name is pulled from the
        // in-memory cache — populated at startup and refreshed when the user
        // edits the configuration screen — so we do zero Mongo I/O per frame.
        if (this.broadcast) {
            const lightData = { "id": lightId, "_id": lightId, "state": payload.state, "brightness": payload.brightness };
            const name = this.lightNameCache[lightId];
            if (name) lightData.name = name;
            this.broadcast('light', lightData);
        }

        // Check for state change and send alarm SMS if needed
        const prevState = this.lightStateCache[lightId];
        const newState = payload.state;
        this.lightStateCache[lightId] = newState;
        if (prevState === undefined) {
            console.log(`[Alarm] Light ${lightId} initial state cached: ${newState}`);
        } else if (prevState !== newState) {
            console.log(`[Alarm] Light ${lightId} state changed: ${prevState} -> ${newState}`);
            this.sendAlarmNotification('light');
        }
    }

    // Handle light command from external source (e.g. voice assistant via MQTT)
    async handleLightCommand(lightId, payload) {
        debugLog(`Received light command for light ${lightId}:`, payload);

        if (!this.db) {
            console.warn('DB not available, cannot route light command');
            return;
        }

        try {
            const light = await this.db.collection('lights').findOne({ _id: lightId });
            if (!light) {
                console.warn(`Light ${lightId} not found in DB, ignoring command`);
                return;
            }

            if (light.source === 'switchback') {
                // Switchback relays are toggle-only
                this.publishRelayToggle(light.relay_channel, light.relay_instance);
            } else {
                // PDM light — send explicit state/brightness
                const brightness = payload.brightness !== undefined ? payload.brightness : null;
                this.publishLightCommand(lightId, payload.state, brightness);
            }
        } catch (err) {
            console.error(`Error handling light command for light ${lightId}:`, err);
        }
    }

    // Handle all-lights command — sends explicit set-all CAN bytes to every PDM and
    // Switchback instance. Uses [8, state] which the firmware treats as SET ALL, not
    // a per-channel toggle. Mirrors the logic in PUT /api/lights/all.
    async handleAllLightsCommand(payload) {
        const state = payload.state ? 1 : 0;
        console.log(`[All Lights] Received all-lights command: state=${state}`);
        if (!this.db) {
            console.warn('[All Lights] DB not available, cannot send all-lights command');
            return;
        }
        try {
            // Send explicit set-all to each Torrent (PDM) instance: CAN 0x18+instance, [8, state]
            const pdmLights = await this.db.collection('lights').find({ source: { $exists: false } }).toArray();
            const pdmInstances = [...new Set(pdmLights.map(l => Math.floor((l._id - 1) / 8)))];
            for (const instance of pdmInstances) {
                this.publishCanMessage(0x18 + instance, [8, state]);
            }
            // Send explicit set-all to each Switchback instance
            const sbInstances = await this.db.collection('lights').distinct('relay_instance', { source: 'switchback' });
            for (const instance of sbInstances) {
                this.publishRelayAllCommand(state, instance);
            }
        } catch (err) {
            console.error('[All Lights] Error handling all-lights command:', err);
        }
    }

    // Handle all-relays command — sends explicit set-all to every Switchback instance.
    async handleAllRelaysCommand(payload) {
        const state = payload.state ? 1 : 0;
        console.log(`[All Relays] Received all-relays command: state=${state}`);
        if (!this.db) {
            console.warn('[All Relays] DB not available, cannot send all-relays command');
            return;
        }
        try {
            const sbInstances = await this.db.collection('lights').distinct('relay_instance', { source: 'switchback' });
            for (const instance of sbInstances) {
                this.publishRelayAllCommand(state, instance);
            }
        } catch (err) {
            console.error('[All Relays] Error handling all-relays command:', err);
        }
    }

    // Handle relay status update from Switchback module
    // Maps relay channel (1-8) to light ID (101-108) for unified WebSocket broadcast
    // Uses in-memory name cache to avoid DB queries on the 33ms hot path
    handleRelayStatus(relayId, payload) {
        const SWITCHBACK_ID_BASE = 100;
        const lightId = SWITCHBACK_ID_BASE + relayId;

        if (this.broadcast) {
            const relayData = { id: lightId, _id: lightId, state: payload.state };
            if (this.lightNameCache[lightId]) {
                relayData.name = this.lightNameCache[lightId];
            }
            this.broadcast('light', relayData);
        }

        // Check for state change and send alarm SMS if needed
        const prevState = this.lightStateCache[lightId];
        const newState = payload.state;
        this.lightStateCache[lightId] = newState;
        if (prevState === undefined) {
            console.log(`[Alarm] Relay ${lightId} initial state cached: ${newState}`);
        } else if (prevState !== newState) {
            console.log(`[Alarm] Relay ${lightId} state changed: ${prevState} -> ${newState}`);
            this.sendAlarmNotification('relay');
        }
    }

    // Send alarm SMS notification with global throttle.
    // Throttle uses a sliding window: max N messages in Y minutes,
    // configured via sms_max_messages and sms_throttle_window_minutes
    // in system_config (defaults: 3 messages per 60 minutes).
    async sendAlarmNotification(source) {
        try {
            const config = await this.db.collection('system_config').findOne({ _id: 'main' });
            if (!config || !config.alarm_enabled || !config.sms_enabled) {
                console.log(`[Alarm] ${source} skipped: alarm_enabled=${config?.alarm_enabled}, sms_enabled=${config?.sms_enabled}`);
                return;
            }

            if (!config.sms_phone_number || !config.sms_router_ip) {
                console.log(`[Alarm] ${source} skipped: missing sms_phone_number or sms_router_ip`);
                return;
            }
            if (!config.sms_ssh_key_encrypted || !config.sms_ssh_key_iv) {
                console.log(`[Alarm] ${source} skipped: missing SMS SSH key`);
                return;
            }

            // Global sliding-window throttle
            const maxMessages = config.sms_max_messages || 3;
            const windowMs = (config.sms_throttle_window_minutes || 60) * 60000;
            const now = Date.now();

            // Prune timestamps outside the window
            this.smsSentTimestamps = this.smsSentTimestamps.filter(t => now - t < windowMs);

            if (this.smsSentTimestamps.length >= maxMessages) {
                const oldest = this.smsSentTimestamps[0];
                const resumeIn = Math.round((windowMs - (now - oldest)) / 1000);
                console.log(`[Alarm] ${source} throttled: ${maxMessages} SMS already sent in window (${resumeIn}s until next slot)`);
                return;
            }

            const { decrypt } = require('./utils/crypto.js');
            const { executeRemoteSms } = require('./routes/sms');

            let sshKey;
            try {
                sshKey = decrypt(config.sms_ssh_key_encrypted, config.sms_ssh_key_iv);
            } catch {
                console.error('[Alarm] Failed to decrypt SMS SSH key');
                return;
            }

            let message;
            if (config.cloud_enabled && config.cloud_url) {
                message = `Unexpected event occurred, check Farwatch for details ${config.cloud_url}`;
            } else {
                message = 'Unexpected event occurred';
            }

            // Record send timestamp before dispatch
            this.smsSentTimestamps.push(now);

            console.log(`[Alarm] Sending SMS (${source}), ${this.smsSentTimestamps.length}/${maxMessages} in window`);
            executeRemoteSms(config.sms_router_ip, sshKey, config.sms_phone_number, message)
                .then(() => console.log(`[Alarm] SMS sent (${source})`))
                .catch(err => console.error(`[Alarm] SMS failed (${source}):`, err.message));
        } catch (err) {
            console.error(`[Alarm] Error sending alarm notification (${source}):`, err.message);
        }
    }

    // Refresh light name cache from DB. Called once at startup and after any
    // configuration edit that can rename or add/remove lights (system-config
    // save, discovery sync, MQTT config-request). NEVER called per CAN frame.
    async refreshLightNameCache() {
        try {
            const all = await this.db.collection('lights').find({}, { projection: { _id: 1, name: 1 } }).toArray();
            const next = {};
            for (const l of all) {
                if (l.name) next[l._id] = l.name;
            }
            this.lightNameCache = next;
            console.log(`[MQTT] Cached ${all.length} light names`);
        } catch (err) {
            console.error('[MQTT] Failed to refresh relay name cache:', err.message);
        }
    }

    // Publish relay toggle command — sends CAN ID 0x025+instance
    publishRelayToggle(channel, instance) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish relay toggle');
            return false;
        }

        const canBridge = require('./services/can-bridge');
        canBridge.sendRelayToggle(this, channel, instance);
        return true;
    }

    // Publish relay all on/off command — sends CAN ID 0x025+instance [0x08, state]
    publishRelayAllCommand(state, instance) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish relay all command');
            return false;
        }

        const canBridge = require('./services/can-bridge');
        canBridge.sendRelayAll(this, state, instance);
        return true;
    }

    // Handle energy status update from battery monitor — passthrough to WebSocket
    handleEnergyStatus(payload) {
        if (this.broadcast) {
            this.broadcast('energy', payload);
        }
    }

    async handleAirQualityTempAndHumdity(payload) {
        debugLog('Received air quality temp and humidity', payload);
        this.broadcast('temphumid', payload);
    }

    // Handle air quality status update from sensor (SGP30: TVOC + eCO2) — passthrough to WebSocket
    handleAirQualityStatus(payload) {
        if (this.broadcast) {
            this.broadcast('airquality', payload);
        }
    }

    // Handle GPS lat/lon update from GPS module
    handleGpsStatus(payload) {
        debugLog('Received GPS lat/lon:', payload);

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
        debugLog('Received GPS altitude:', payload);

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
        debugLog('Received GPS time:', payload);

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
        debugLog('Received GPS details:', payload);

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
        debugLog('Received thermostat status:', payload);

        // Broadcast thermostat data directly via WebSocket (no database storage)
        if (this.broadcast) {
            this.broadcast('thermostat', {
                target_temp: payload.target_temp,
                mode: payload.mode
            });
        }
    }

    // Handle Plateau tilt data (CAN ID 0x30 decoded by CAN bridge)
    // Payload: { front_back, side_to_side, front_back_diff_mm, left_right_diff_mm }
    // Handle water tank levels from Reservoir (CAN ID 0x3E decoded by CAN bridge)
    // Payload: { fresh, grey, black } — each 0-100 %
    handleWaterStatus(payload) {
        if (this.broadcast) {
            this.broadcast('water', payload);
        }
    }

    handleLevelTilt(payload) {
        if (this.broadcast) {
            this.broadcast('level', payload);
        }
    }

    // Handle Plateau status data (CAN ID 0x32 decoded by CAN bridge)
    // Payload: { imu_connected, fully_calibrated, cal_sys, cal_gyro, cal_accel, cal_mag, mounting }
    handleLevelStatus(payload) {
        if (this.broadcast) {
            this.broadcast('level_status', payload);
        }
    }

    // Handle proximity event from Farwatch cloud (bridged via cloud-bridge)
    handleProximityEvent(payload) {
        console.log('[Proximity] Event received:', payload);
        if (this.broadcast) {
            this.broadcast('proximity_event', payload);
        }
    }

    // Handle proximity status from Farwatch cloud
    handleProximityStatus(payload) {
        if (this.broadcast) {
            this.broadcast('proximity_status', payload);
        }
    }

    // Handle deployment status from deployment-watcher (via local MQTT)
    async handleDeploymentStatus(payload) {
        const { deploymentId, status, version, progress } = payload;
        if (!deploymentId || !status) return;

        const validStatuses = ['downloading', 'downloaded', 'extracting', 'deploying', 'completed', 'failed'];
        if (!validStatuses.includes(status)) return;

        const isProgressUpdate = status === 'downloading' && typeof progress === 'number';

        // Skip DB writes for intermediate progress updates to avoid flooding
        if (!isProgressUpdate && this.db) {
            try {
                await this.db.collection('deployment_statuses').insertOne({
                    deploymentId,
                    status,
                    version: version || 'unknown',
                    timestamp: new Date(payload.timestamp || Date.now()),
                    receivedAt: new Date()
                });
            } catch (err) {
                console.error('Error saving deployment status:', err.message);
            }
        }

        if (this.broadcast) {
            const wsPayload = {
                deploymentId,
                status,
                version: version || 'unknown',
                timestamp: payload.timestamp || new Date().toISOString()
            };
            if (typeof progress === 'number') {
                wsPayload.progress = progress;
            }
            this.broadcast('deployment_status', wsPayload);
        }
    }

    // Publish local deployment available notification
    publishLocalDeploymentAvailable(data) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish local deployment available');
            return false;
        }
        const topic = TOPICS.DEPLOYMENT_AVAILABLE;
        console.log(`[Deployment] Publishing to ${topic}: ${data.filename}`);
        this.client.publish(topic, JSON.stringify(data), { qos: 1 });
        return true;
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


    // Publish light command — sends CAN messages directly (toggle 0x018, brightness 0x015)
    publishLightCommand(lightId, state, brightness = null) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish light command');
            return false;
        }

        const canBridge = require('./services/can-bridge');
        if (brightness !== null) {
            canBridge.sendLightBrightness(this, lightId - 1, brightness);
        } else {
            canBridge.sendLightToggle(this, lightId - 1);
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
        debugLog(`Publishing light status to ${topic}:`, payload);
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

        debugLog(`Publishing CAN message to ${topic}:`, payload);
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

        // Helper to send with delay — returns a promise that resolves when all sent
        const sendWithDelay = (messages, index = 0) => {
            return new Promise((resolve) => {
                const sendNext = (i) => {
                    if (i >= messages.length) {
                        console.log('[WiFi Config] All messages sent');
                        resolve();
                        return;
                    }
                    this.publishCanMessage(0x01, messages[i]);
                    setTimeout(() => sendNext(i + 1), 50);
                };
                sendNext(index);
            });
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

        // Send sequence with delays — returns promise
        return sendWithDelay(messages);
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

    /**
     * Send calibration save command to Plateau via CAN bus (CAN ID 0x20, subcmd 0x03)
     * Plateau will save current BNO055 offsets to NVS, verify the write,
     * then switch to ACCONLY mode and respond with an updated status message.
     * @returns {boolean} Success status
     */
    publishPlateauCalibrationSave() {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish calibration save');
            return false;
        }

        console.log('[Plateau] Sending calibration save command');
        return this.publishCanMessage(0x20, [0x03]);
    }

    /**
     * Send temperature calibration offset to Borealis via CAN bus (CAN ID 0x21)
     * 2-byte signed big-endian value in tenths of °C.
     * e.g., -2.8°C → -28 → [0xFF, 0xE4]; 0°C → [0x00, 0x00]
     * Borealis stores this in NVS and applies it to the SHT31 reading.
     * @param {number} offsetTenths - Signed integer in tenths of °C (-1000 to 1000)
     * @returns {boolean} Success status
     */
    publishBorealisCalibration(offsetTenths) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish Borealis calibration');
            return false;
        }

        // Clamp to int16 range
        const clamped = Math.max(-32768, Math.min(32767, Math.round(offsetTenths)));
        // Convert to unsigned for byte extraction
        const unsigned = clamped < 0 ? clamped + 0x10000 : clamped;
        const highByte = (unsigned >> 8) & 0xFF;
        const lowByte = unsigned & 0xFF;

        console.log(`[Borealis] Sending calibration offset: ${clamped} tenths (${clamped / 10}°C) → [0x${highByte.toString(16).padStart(2, '0')}, 0x${lowByte.toString(16).padStart(2, '0')}]`);
        return this.publishCanMessage(0x21, [highByte, lowByte]);
    }

    // Handle cloud reconnect trigger — re-publish config snapshot
    async handleConfigSyncTrigger() {
        try {
            const { buildConfigSnapshot } = require('./services/config-snapshot');
            const systemConfig = await this.db.collection('system_config').findOne({ _id: 'main' });
            if (systemConfig && systemConfig.cloud_enabled) {
                const snapshot = await buildConfigSnapshot(this.db);
                if (snapshot) {
                    this.publishSystemConfigSnapshot(snapshot);
                    console.log('[Config Sync] Re-published config snapshot (cloud reconnect trigger)');
                }
            }
        } catch (err) {
            console.error('[Config Sync] Failed to re-publish config snapshot:', err.message);
        }
    }

    // Handle config request from local service (e.g. voice assistant startup)
    // Re-publishes current PDM and relay channel configs as retained messages
    async handleConfigRequest() {
        console.log('[Config Request] Re-publishing PDM and relay channel configs');
        try {
            const { syncPdmChannelsToLights } = require('./services/pdm-channel-sync');
            const { syncSwitchbackChannelsToLights } = require('./services/switchback-channel-sync');
            await syncPdmChannelsToLights(this.db, this);
            await syncSwitchbackChannelsToLights(this.db, this);
            await this.refreshLightNameCache();
        } catch (err) {
            console.error('[Config Request] Failed to re-publish config:', err.message);
        }
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

    // Publish full system config snapshot for cloud sync (retained)
    publishSystemConfigSnapshot(snapshot) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish system config snapshot');
            return false;
        }

        const topic = TOPICS.SYSTEM_CONFIG_SYNC;
        console.log(`Publishing system config snapshot to ${topic}`);
        this.client.publish(topic, JSON.stringify(snapshot), { qos: 1, retain: true });
        return true;
    }

    // Periodically read and publish compute-module system stats
    startSystemStatsPublisher() {
        const INTERVAL_MS = 10000;
        setInterval(() => {
            if (!this.connected) return;
            const stats = readSystemStats();
            this.client.publish(TOPICS.SYSTEM_STATS, JSON.stringify(stats), { qos: 0 });
            if (this.broadcast) {
                this.broadcast('system_stats', stats);
            }
        }, INTERVAL_MS);
    }

    // --- Discovery methods ---

    // Handle a module found by the host-side mDNS browser
    handleDiscoveryFound(payload) {
        console.log('[Discovery] Module found via mDNS:', payload);

        // Add to ephemeral discovered list
        const { addDiscoveredModule } = require('./routes/discovery');
        addDiscoveredModule(payload);

        // Broadcast to frontend via WebSocket
        if (this.broadcast) {
            this.broadcast('discovery_found', payload);
        }
    }

    // Send CAN 0x02 discovery trigger (broadcast, 0 data bytes)
    publishDiscoveryTrigger() {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish discovery trigger');
            return false;
        }
        console.log('[Discovery] Broadcasting CAN 0x02 discovery trigger');
        return this.publishCanMessage(0x02, []);
    }

    // Send CAN 0x03 discovery reset (targeted by MAC address)
    publishDiscoveryReset(hostname) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish discovery reset');
            return false;
        }

        const hostnameRegex = /^esp32-([0-9A-Fa-f]{6})$/;
        const match = hostname.match(hostnameRegex);
        if (!match) {
            console.error(`[Discovery] Invalid hostname format for reset: ${hostname}`);
            return false;
        }

        const macHex = match[1];
        const macBytes = [];
        for (let i = 0; i < 6; i += 2) {
            macBytes.push(parseInt(macHex.substring(i, i + 2), 16));
        }

        console.log(`[Discovery] Sending CAN 0x03 discovery reset to ${hostname}`);
        return this.publishCanMessage(0x03, macBytes);
    }

    // Tell the host-side mDNS browser to start browsing
    publishDiscoveryBrowseStart() {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot start discovery browse');
            return false;
        }
        console.log('[Discovery] Starting mDNS browse');
        this.client.publish(TOPICS.DISCOVERY_BROWSE_START, '{}', { qos: 1 });
        return true;
    }

    // Handle confirm response from host-side proxy
    handleDiscoveryConfirmResponse(payload) {
        console.log('[Discovery] Confirm response:', payload);
        const { handleConfirmResponse } = require('./routes/discovery');
        handleConfirmResponse(payload);
    }

    // Handle claim response from host-side proxy (Playbill credentials push)
    handleDiscoveryClaimResponse(payload) {
        console.log('[Discovery] Claim response:', payload);
        const { handleClaimResponse } = require('./routes/discovery');
        if (typeof handleClaimResponse === 'function') handleClaimResponse(payload);
    }

    // Ask the host-side proxy to POST broker credentials to a freshly
    // discovered Playbill. The proxy hits http://<hostname>.local/discovery/claim
    // with the JSON body inside `creds`. Don't log the creds object.
    publishDiscoveryClaimRequest(hostname, creds) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish claim request');
            return false;
        }
        if (!hostname || !creds || typeof creds !== 'object') {
            console.warn('[Discovery] publishDiscoveryClaimRequest: hostname + creds required');
            return false;
        }
        console.log(`[Discovery] Sending claim to ${hostname}`);
        this.client.publish(
            TOPICS.DISCOVERY_CLAIM_REQUEST,
            JSON.stringify({ hostname, creds }),
            { qos: 1 },
        );
        return true;
    }

    // Ask the host-side proxy to confirm a module
    publishDiscoveryConfirmRequest(hostname) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish confirm request');
            return false;
        }
        console.log(`[Discovery] Requesting host-side confirm for ${hostname}`);
        this.client.publish(TOPICS.DISCOVERY_CONFIRM_REQUEST, JSON.stringify({ hostname }), { qos: 1 });
        return true;
    }

    // Broadcast discovery trigger to all wireless MCUs (payload "*" = everyone responds)
    publishWirelessDiscoveryTrigger() {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish wireless discovery trigger');
            return false;
        }
        console.log('[Discovery] Broadcasting local/discovery/trigger to wireless devices');
        this.client.publish(TOPICS.WIRELESS_DISCOVERY_TRIGGER, '*', { qos: 0 });
        return true;
    }

    // Send targeted OTA trigger to a specific wireless MCU by hostname
    publishWirelessOtaTrigger(hostname) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish wireless OTA trigger');
            return false;
        }
        console.log(`[OTA] Publishing local/ota/trigger for wireless device ${hostname}`);
        this.client.publish(TOPICS.WIRELESS_OTA_TRIGGER, hostname, { qos: 0 });
        return true;
    }

    // ── OS-level settings (via os-settings.py host daemon) ─────────────
    //
    // The daemon owns the retained os/timezone/current topic and keeps
    // it in sync with the OS. We cache the last observed value so
    // /api/os/timezone GET doesn't need a round trip. `currentTimezone`
    // stays null until the daemon has published at least once — the
    // route handler treats null as "unknown" and can fall back if the
    // caller is willing to wait for a request/response.
    //
    // Set requests use a reqId → pending-promise map so a slow set
    // doesn't lose its response if another request lands in between.
    handleOsTimezoneCurrent(payload) {
        if (payload && typeof payload.tz === 'string') {
            this.currentTimezone = payload.tz;
        }
    }

    handleOsTimezoneResponse(payload) {
        const { handleTimezoneResponse } = require('./routes/os');
        if (typeof handleTimezoneResponse === 'function') {
            handleTimezoneResponse(payload);
        }
    }

    getCurrentTimezone() {
        return this.currentTimezone || null;
    }

    publishOsTimezoneRequest(reqId, tz) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish timezone request');
            return false;
        }
        console.log(`[OS] Requesting timezone set: ${tz} (reqId=${reqId})`);
        this.client.publish(
            TOPICS.OS_TIMEZONE_REQUEST,
            JSON.stringify({ reqId, tz }),
            { qos: 1 },
        );
        return true;
    }

    // Tell the host-side mDNS browser to stop browsing
    publishDiscoveryBrowseStop() {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot stop discovery browse');
            return false;
        }
        console.log('[Discovery] Stopping mDNS browse');
        this.client.publish(TOPICS.DISCOVERY_BROWSE_STOP, '{}', { qos: 1 });
        return true;
    }

    // ── Playbill (in-rig entertainment node) ────────────────────────────
    //
    // The Playbill controller publishes per-feature retained status on
    // `local/playbill/<deviceId>/<feature>/status`. We fan those out to the
    // PWA over the existing WebSocket using a single envelope event —
    // `playbill_status` with `{deviceId, feature, payload}` — so adding new
    // Playbill features (transport, livetv, sources, etc.) requires zero
    // backend changes here. The PWA decides which features it cares about.
    //
    // The `system` feature is also emitted as `playbill_presence` so the
    // PWA can keep a discovery list cheaply (and react to LWT-driven
    // offline transitions without having to look inside the payload).
    handlePlaybillStatus(deviceId, feature, payload) {
        if (!deviceId || !feature) return;

        // Cache every feature's most recent payload per device. The Playbill
        // controller publishes most feature topics edge-triggered (radio
        // only republishes when state.radio changes, not periodically), so
        // a PWA loading after the fact relies on us having the last value.
        // Without this, the PWA's `state.statusByDevice` map would only get
        // populated from new WS events — and if the Playbill's state hasn't
        // moved since the previous publish, no new event ever fires.
        if (!this.playbillStatusByDevice) this.playbillStatusByDevice = new Map();
        let perDevice = this.playbillStatusByDevice.get(deviceId);
        if (!perDevice) {
            perDevice = new Map();
            this.playbillStatusByDevice.set(deviceId, perDevice);
        }
        perDevice.set(feature, payload);

        // Update local presence cache. The retained `system` topic carries
        // {online, name, hostname, version, ...}; everything else is feature
        // state. Cached values are returned to fresh WebSocket connections
        // via the wsClient `playbill_snapshot` event (added below).
        if (feature === 'system') {
            if (payload && payload.online === false) {
                // LWT-driven offline transition. Keep the last known name/version
                // so the PWA can still render the device row as greyed-out.
                const prior = this.playbillDevices.get(deviceId) || {};
                this.playbillDevices.set(deviceId, { ...prior, ...payload, deviceId });
            } else {
                this.playbillDevices.set(deviceId, { ...payload, deviceId });
            }
            if (this.broadcast) {
                this.broadcast('playbill_presence', {
                    deviceId,
                    ...payload,
                });
            }
        }

        if (this.broadcast) {
            this.broadcast('playbill_status', {
                deviceId,
                feature,
                payload,
                ts: Date.now(),
            });
        }
    }

    // Returns the current presence snapshot — used by the REST route so a
    // freshly loaded PWA can list known Playbills without waiting for a
    // retained MQTT publish to arrive on its WebSocket. Each device entry
    // includes a `statusByFeature` map of the last seen payload for every
    // feature topic, so the PWA can hydrate widgets (volume slider, radio
    // tab, etc.) on first paint without depending on an immediate retained
    // republish from the broker.
    listPlaybillDevices() {
        if (!this.playbillDevices) return [];
        return Array.from(this.playbillDevices.values()).map((d) => {
            const perDevice = this.playbillStatusByDevice && this.playbillStatusByDevice.get(d.deviceId);
            return {
                ...d,
                statusByFeature: perDevice ? Object.fromEntries(perDevice) : {},
            };
        });
    }

    // Publish a command to a specific Playbill (or to all of them via the
    // reserved 'all' deviceId). Topic shape mirrors what the controller's
    // mqtt-bridge.js subscribes to. Payload must be a JSON-serializable
    // object with at minimum an `action` string; the controller dispatches
    // through the command bus same as IPC-arriving commands.
    publishPlaybillCommand(deviceId, feature, payload) {
        if (!this.connected) {
            console.warn('MQTT not connected, cannot publish Playbill command');
            return false;
        }
        if (!deviceId || !feature) {
            console.warn('publishPlaybillCommand: deviceId and feature required');
            return false;
        }
        if (!payload || typeof payload !== 'object' || typeof payload.action !== 'string') {
            console.warn('publishPlaybillCommand: payload must include a string action');
            return false;
        }
        const topic = `${MQTT_ROOT}/${MQTT_PLAYBILL}/${deviceId}/${feature}/${MSG_COMMAND}`;
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
