const express = require('express');
const router = express.Router();
const { encrypt, decrypt } = require('../utils/crypto.js');
const cloudBridge = require('../services/cloud-bridge');
const { syncPdmChannelsToLights } = require('../services/pdm-channel-sync.js');
const { syncSwitchbackChannelsToLights } = require('../services/switchback-channel-sync.js');
const { buildConfigSnapshot } = require('../services/config-snapshot.js');

module.exports = (db) => {
    const systemConfig = db.collection('system_config');

    // GET /api/system-config
    router.get('/', async (req, res) => {
        try {
            const data = await systemConfig.findOne({ _id: 'main' });

            if (!data) {
                return res.json({
                    _id: 'main',
                    wizard_completed: false,
                    cloud_enabled: false,
                    cloud_url: '',
                    cloud_mqtt_username: '',
                    cloud_mqtt_password: '',
                    cloud_api_key: '',
                    cloud_rate_limit: 30,
                    alarm_enabled: false,
                    sms_enabled: false,
                    sms_phone_number: '',
                    sms_router_ip: '',
                    sms_ssh_key: '',
                    sms_max_messages: 3,
                    sms_throttle_window_minutes: 60,
                    mcu_modules: [],
                    wifi_ssid: '',
                    wifi_password: '',
                    updated_at: new Date()
                });
            }

            // Decrypt WiFi password if it exists
            if (data.wifi_password_encrypted && data.wifi_password_iv) {
                try {
                    data.wifi_password = decrypt(data.wifi_password_encrypted, data.wifi_password_iv);
                } catch (error) {
                    console.error('Error decrypting WiFi password:', error);
                    data.wifi_password = '';
                }
            } else {
                data.wifi_password = '';
            }

            // Decrypt cloud MQTT password if it exists
            if (data.cloud_mqtt_password_encrypted && data.cloud_mqtt_password_iv) {
                try {
                    data.cloud_mqtt_password = decrypt(data.cloud_mqtt_password_encrypted, data.cloud_mqtt_password_iv);
                } catch (error) {
                    console.error('Error decrypting cloud MQTT password:', error);
                    data.cloud_mqtt_password = '';
                }
            } else {
                data.cloud_mqtt_password = '';
            }

            // Decrypt cloud API key if it exists
            if (data.cloud_api_key_encrypted && data.cloud_api_key_iv) {
                try {
                    data.cloud_api_key = decrypt(data.cloud_api_key_encrypted, data.cloud_api_key_iv);
                } catch (error) {
                    console.error('Error decrypting cloud API key:', error);
                    data.cloud_api_key = '';
                }
            } else {
                data.cloud_api_key = '';
            }

            // Decrypt SMS SSH key if it exists
            if (data.sms_ssh_key_encrypted && data.sms_ssh_key_iv) {
                try {
                    data.sms_ssh_key = decrypt(data.sms_ssh_key_encrypted, data.sms_ssh_key_iv);
                } catch (error) {
                    console.error('Error decrypting SMS SSH key:', error);
                    data.sms_ssh_key = '';
                }
            } else {
                data.sms_ssh_key = '';
            }

            // Remove encrypted fields from response
            delete data.wifi_password_encrypted;
            delete data.wifi_password_iv;
            delete data.cloud_mqtt_password_encrypted;
            delete data.cloud_mqtt_password_iv;
            delete data.cloud_api_key_encrypted;
            delete data.cloud_api_key_iv;
            delete data.sms_ssh_key_encrypted;
            delete data.sms_ssh_key_iv;
            // Peregrine CA PEM is managed by /api/peregrine and is large —
            // strip it from this generic blob.
            delete data.peregrine_ca_pem;

            // Migration: legacy installs stored vehicle geometry inside the
            // plateau (or previously-mislabelled aftline) module's .config.
            // Promote those to top-level system_config fields on first read
            // so the new Vehicle settings surface has a single source of truth.
            if (data.vehicle_mounting === undefined
                || data.vehicle_length_cm === undefined
                || data.vehicle_width_cm === undefined) {
                const legacy = (data.mcu_modules || []).find(m =>
                    (m.type === 'plateau' || m.type === 'aftline') && m.config
                    && (m.config.mounting !== undefined
                        || m.config.vehicle_length_cm !== undefined
                        || m.config.vehicle_width_cm !== undefined));
                if (legacy) {
                    const migration = {};
                    if (data.vehicle_mounting === undefined && legacy.config.mounting !== undefined) {
                        migration.vehicle_mounting = legacy.config.mounting;
                    }
                    if (data.vehicle_length_cm === undefined && legacy.config.vehicle_length_cm !== undefined) {
                        migration.vehicle_length_cm = legacy.config.vehicle_length_cm;
                    }
                    if (data.vehicle_width_cm === undefined && legacy.config.vehicle_width_cm !== undefined) {
                        migration.vehicle_width_cm = legacy.config.vehicle_width_cm;
                    }
                    if (Object.keys(migration).length) {
                        Object.assign(data, migration);
                        await systemConfig.updateOne({ _id: 'main' }, { $set: migration });
                    }
                }
            }

            res.json(data);
        } catch (error) {
            console.error('Error fetching system config:', error);
            res.status(500).json({ error: 'Failed to fetch system config' });
        }
    });

    // PUT /api/system-config
    router.put('/', async (req, res) => {
        try {
            const { wizard_completed, cloud_enabled, cloud_url, cloud_mqtt_username, cloud_mqtt_password, cloud_api_key, cloud_rate_limit, mcu_modules, wifi_ssid, wifi_password } = req.body;

            const updates = {};

            if (wizard_completed !== undefined) {
                if (typeof wizard_completed !== 'boolean') {
                    return res.status(400).json({ error: 'wizard_completed must be a boolean' });
                }
                updates.wizard_completed = wizard_completed;
            }

            if (cloud_enabled !== undefined) {
                if (typeof cloud_enabled !== 'boolean') {
                    return res.status(400).json({ error: 'cloud_enabled must be a boolean' });
                }
                updates.cloud_enabled = cloud_enabled;
            }

            if (cloud_url !== undefined) {
                if (typeof cloud_url !== 'string') {
                    return res.status(400).json({ error: 'cloud_url must be a string' });
                }
                // Basic URL validation if cloud is enabled
                if (cloud_enabled && cloud_url && !isValidUrl(cloud_url)) {
                    return res.status(400).json({ error: 'Invalid cloud URL format' });
                }
                updates.cloud_url = cloud_url;
            }

            if (cloud_mqtt_username !== undefined) {
                if (typeof cloud_mqtt_username !== 'string') {
                    return res.status(400).json({ error: 'cloud_mqtt_username must be a string' });
                }
                updates.cloud_mqtt_username = cloud_mqtt_username;
            }

            if (cloud_mqtt_password !== undefined) {
                if (typeof cloud_mqtt_password !== 'string') {
                    return res.status(400).json({ error: 'cloud_mqtt_password must be a string' });
                }
                if (cloud_mqtt_password) {
                    try {
                        const encrypted = encrypt(cloud_mqtt_password);
                        updates.cloud_mqtt_password_encrypted = encrypted.encrypted;
                        updates.cloud_mqtt_password_iv = encrypted.iv;
                    } catch (error) {
                        console.error('Error encrypting cloud MQTT password:', error);
                        return res.status(500).json({ error: 'Failed to encrypt cloud MQTT password' });
                    }
                } else {
                    updates.cloud_mqtt_password_encrypted = '';
                    updates.cloud_mqtt_password_iv = '';
                }
            }

            if (cloud_api_key !== undefined) {
                if (typeof cloud_api_key !== 'string') {
                    return res.status(400).json({ error: 'cloud_api_key must be a string' });
                }
                if (cloud_api_key) {
                    try {
                        const encrypted = encrypt(cloud_api_key);
                        updates.cloud_api_key_encrypted = encrypted.encrypted;
                        updates.cloud_api_key_iv = encrypted.iv;
                    } catch (error) {
                        console.error('Error encrypting cloud API key:', error);
                        return res.status(500).json({ error: 'Failed to encrypt cloud API key' });
                    }
                } else {
                    updates.cloud_api_key_encrypted = '';
                    updates.cloud_api_key_iv = '';
                }
            }

            if (cloud_rate_limit !== undefined) {
                const rate = parseInt(cloud_rate_limit);
                if (isNaN(rate) || rate < 1 || rate > 100) {
                    return res.status(400).json({ error: 'cloud_rate_limit must be an integer between 1 and 100' });
                }
                updates.cloud_rate_limit = rate;
                cloudBridge.updateRateLimit(rate);
            }

            if (req.body.alarm_enabled !== undefined) {
                if (typeof req.body.alarm_enabled !== 'boolean') {
                    return res.status(400).json({ error: 'alarm_enabled must be a boolean' });
                }
                updates.alarm_enabled = req.body.alarm_enabled;
            }

            if (req.body.sms_enabled !== undefined) {
                if (typeof req.body.sms_enabled !== 'boolean') {
                    return res.status(400).json({ error: 'sms_enabled must be a boolean' });
                }
                updates.sms_enabled = req.body.sms_enabled;
            }

            if (req.body.sms_phone_number !== undefined) {
                if (typeof req.body.sms_phone_number !== 'string') {
                    return res.status(400).json({ error: 'sms_phone_number must be a string' });
                }
                updates.sms_phone_number = req.body.sms_phone_number;
            }

            if (req.body.sms_router_ip !== undefined) {
                if (typeof req.body.sms_router_ip !== 'string') {
                    return res.status(400).json({ error: 'sms_router_ip must be a string' });
                }
                updates.sms_router_ip = req.body.sms_router_ip;
            }

            if (req.body.sms_ssh_key !== undefined) {
                if (typeof req.body.sms_ssh_key !== 'string') {
                    return res.status(400).json({ error: 'sms_ssh_key must be a string' });
                }
                if (req.body.sms_ssh_key) {
                    try {
                        const encrypted = encrypt(req.body.sms_ssh_key);
                        updates.sms_ssh_key_encrypted = encrypted.encrypted;
                        updates.sms_ssh_key_iv = encrypted.iv;
                    } catch (error) {
                        console.error('Error encrypting SMS SSH key:', error);
                        return res.status(500).json({ error: 'Failed to encrypt SMS SSH key' });
                    }
                } else {
                    updates.sms_ssh_key_encrypted = '';
                    updates.sms_ssh_key_iv = '';
                }
            }

            if (req.body.sms_max_messages !== undefined) {
                const val = parseInt(req.body.sms_max_messages);
                if (isNaN(val) || val < 1 || val > 100) {
                    return res.status(400).json({ error: 'sms_max_messages must be between 1 and 100' });
                }
                updates.sms_max_messages = val;
            }

            if (req.body.sms_throttle_window_minutes !== undefined) {
                const val = parseInt(req.body.sms_throttle_window_minutes);
                if (isNaN(val) || val < 1 || val > 1440) {
                    return res.status(400).json({ error: 'sms_throttle_window_minutes must be between 1 and 1440' });
                }
                updates.sms_throttle_window_minutes = val;
            }

            // Vehicle configuration — top-level fields consumed by Plateau
            // over CAN 0x36 subcmd 0x01. Independent of module registration:
            // may be set before a Plateau module is discovered.
            if (req.body.vehicle_mounting !== undefined) {
                const v = Number(req.body.vehicle_mounting);
                if (!Number.isInteger(v) || v < 0 || v > 2) {
                    return res.status(400).json({ error: 'vehicle_mounting must be 0 (floor), 1 (left wall), or 2 (right wall)' });
                }
                updates.vehicle_mounting = v;
            }

            if (req.body.vehicle_length_cm !== undefined) {
                const v = Number(req.body.vehicle_length_cm);
                if (!Number.isInteger(v) || v < 1 || v > 65535) {
                    return res.status(400).json({ error: 'vehicle_length_cm must be an integer between 1 and 65535' });
                }
                updates.vehicle_length_cm = v;
            }

            if (req.body.vehicle_width_cm !== undefined) {
                const v = Number(req.body.vehicle_width_cm);
                if (!Number.isInteger(v) || v < 1 || v > 65535) {
                    return res.status(400).json({ error: 'vehicle_width_cm must be an integer between 1 and 65535' });
                }
                updates.vehicle_width_cm = v;
            }

            if (mcu_modules !== undefined) {
                if (!Array.isArray(mcu_modules)) {
                    return res.status(400).json({ error: 'mcu_modules must be an array' });
                }
                // Validate user-editable fields only. addr/canid/fw/target/
                // canInstance/wireless are firmware-controlled (set at discovery
                // from the module's mDNS TXT record) and are NOT accepted from
                // the frontend — they're preserved server-side by merging from
                // the stored record below.
                for (const mod of mcu_modules) {
                    if (!mod.type || !mod.name || !mod.hostname) {
                        return res.status(400).json({ error: 'Each module must have type, name, and hostname' });
                    }
                    if (typeof mod.type !== 'string' || typeof mod.name !== 'string' || typeof mod.hostname !== 'string') {
                        return res.status(400).json({ error: 'Module type, name, and hostname must be strings' });
                    }
                }
                const existing = await systemConfig.findOne({ _id: 'main' });
                const stored = (existing && existing.mcu_modules) || [];
                const storedByHostname = new Map(stored.map(m => [m.hostname, m]));
                const IMMUTABLE_FIELDS = ['addr', 'canid', 'fw', 'target', 'canInstance', 'wireless'];
                updates.mcu_modules = mcu_modules.map(mod => {
                    const prior = storedByHostname.get(mod.hostname);
                    const merged = { ...mod };
                    for (const f of IMMUTABLE_FIELDS) {
                        delete merged[f];
                        if (prior && prior[f] !== undefined) merged[f] = prior[f];
                    }
                    return merged;
                });
            }

            // Handle WiFi configuration
            if (wifi_ssid !== undefined) {
                if (typeof wifi_ssid !== 'string') {
                    return res.status(400).json({ error: 'wifi_ssid must be a string' });
                }
                updates.wifi_ssid = wifi_ssid;
            }

            if (wifi_password !== undefined) {
                if (typeof wifi_password !== 'string') {
                    return res.status(400).json({ error: 'wifi_password must be a string' });
                }
                // Encrypt password if provided (non-empty)
                if (wifi_password) {
                    try {
                        const encrypted = encrypt(wifi_password);
                        updates.wifi_password_encrypted = encrypted.encrypted;
                        updates.wifi_password_iv = encrypted.iv;
                    } catch (error) {
                        console.error('Error encrypting WiFi password:', error);
                        return res.status(500).json({ error: 'Failed to encrypt WiFi password' });
                    }
                } else {
                    // Clear password if empty string provided
                    updates.wifi_password_encrypted = '';
                    updates.wifi_password_iv = '';
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'No valid fields to update' });
            }

            updates.updated_at = new Date();

            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: updates }
            );

            // Trigger WiFi credential broadcast to MCUs via CAN if WiFi settings changed
            if ((wifi_ssid !== undefined || wifi_password !== undefined) && wifi_ssid && wifi_password) {
                const mqttService = require('../mqtt');
                try {
                    const currentSsid = wifi_ssid !== undefined ? wifi_ssid :
                        (await systemConfig.findOne({ _id: 'main' })).wifi_ssid;
                    const currentPassword = wifi_password !== undefined ? wifi_password :
                        decrypt((await systemConfig.findOne({ _id: 'main' })).wifi_password_encrypted,
                                (await systemConfig.findOne({ _id: 'main' })).wifi_password_iv);

                    if (currentSsid && currentPassword) {
                        console.log('[System Config] Publishing WiFi credentials to MCUs');
                        mqttService.publishWifiCredentials(currentSsid, currentPassword);
                    }
                } catch (error) {
                    console.error('[System Config] Error publishing WiFi credentials:', error);
                    // Don't fail the request if MQTT publish fails
                }
            }

            // Trigger Plateau vehicle-config broadcast via CAN whenever any
            // of the top-level vehicle_* fields change. Independent of module
            // presence — Plateau firmware picks up the frame when listening;
            // if it isn't online yet, the field is still persisted for next boot.
            if (updates.vehicle_mounting !== undefined
                || updates.vehicle_length_cm !== undefined
                || updates.vehicle_width_cm !== undefined) {
                const mqttService = require('../mqtt');
                try {
                    const current = await systemConfig.findOne({ _id: 'main' });
                    const mounting = updates.vehicle_mounting !== undefined ? updates.vehicle_mounting
                        : (current && current.vehicle_mounting !== undefined ? current.vehicle_mounting : 0);
                    const lengthCm = updates.vehicle_length_cm !== undefined ? updates.vehicle_length_cm
                        : (current && current.vehicle_length_cm !== undefined ? current.vehicle_length_cm : 500);
                    const widthCm = updates.vehicle_width_cm !== undefined ? updates.vehicle_width_cm
                        : (current && current.vehicle_width_cm !== undefined ? current.vehicle_width_cm : 200);

                    console.log('[System Config] Publishing Plateau vehicle config to CAN bus');
                    mqttService.publishPlateauConfig(mounting, lengthCm, widthCm);
                } catch (error) {
                    console.error('[System Config] Error publishing Plateau vehicle config:', error);
                }
            }

            // Trigger Borealis calibration broadcast via CAN if a borealis module is present
            if (mcu_modules !== undefined) {
                const borealis = mcu_modules.find(m => m.type === 'borealis' && m.enabled !== false);
                if (borealis && borealis.config && borealis.config.temp_offset !== undefined) {
                    const mqttService = require('../mqtt');
                    try {
                        const offsetTenths = Math.round(borealis.config.temp_offset * 10);
                        console.log('[System Config] Publishing Borealis calibration to CAN bus');
                        mqttService.publishBorealisCalibration(offsetTenths);
                    } catch (error) {
                        console.error('[System Config] Error publishing Borealis calibration:', error);
                    }
                }
            }

            // Notify local services if cloud config changed
            if (cloud_enabled !== undefined || cloud_url !== undefined || cloud_mqtt_username !== undefined || cloud_mqtt_password !== undefined || cloud_api_key !== undefined) {
                const mqttService = require('../mqtt');
                try {
                    mqttService.publishCloudConfigChanged();
                } catch (error) {
                    console.error('[System Config] Error publishing cloud config notification:', error);
                }

                // Connect or disconnect the cloud bridge
                if (cloud_enabled === false) {
                    cloudBridge.disconnect();
                } else {
                    // Re-read saved config to get the full set of cloud fields
                    const saved = await systemConfig.findOne({ _id: 'main' });
                    if (saved && saved.cloud_enabled) {
                        let mqttPass = '';
                        if (saved.cloud_mqtt_password_encrypted && saved.cloud_mqtt_password_iv) {
                            try { mqttPass = decrypt(saved.cloud_mqtt_password_encrypted, saved.cloud_mqtt_password_iv); } catch {}
                        }
                        try {
                            const url = new URL(saved.cloud_url);
                            cloudBridge.connect(mqttService, url.hostname, saved.cloud_mqtt_username, mqttPass);
                            if (saved.cloud_rate_limit) {
                                cloudBridge.updateRateLimit(saved.cloud_rate_limit);
                            }
                        } catch (err) {
                            console.error('[System Config] Cloud bridge connection failed:', err.message);
                        }
                    }
                }
            }

            // Sync PDM channel config to lights collection if modules changed
            if (mcu_modules !== undefined) {
                const mqttService = require('../mqtt');
                try {
                    await syncPdmChannelsToLights(db, mqttService);
                    await syncSwitchbackChannelsToLights(db, mqttService);
                    await mqttService.refreshLightNameCache();
                    // Broadcast updated light names to all WebSocket clients immediately
                    const broadcast = req.app.get('broadcast');
                    if (broadcast) {
                        const allLights = await db.collection('lights').find().sort({ _id: 1 }).toArray();
                        broadcast('lights_config', allLights.map(l => ({ id: l._id, name: l.name })));
                    }
                } catch (error) {
                    console.error('[System Config] Error syncing device channels:', error);
                }
            }

            // Publish full config snapshot to cloud if enabled
            try {
                const currentConfig = await systemConfig.findOne({ _id: 'main' });
                if (currentConfig && currentConfig.cloud_enabled) {
                    const mqttService = require('../mqtt');
                    const snapshot = await buildConfigSnapshot(db);
                    if (snapshot) {
                        mqttService.publishSystemConfigSnapshot(snapshot);
                    }
                }
            } catch (error) {
                console.error('[System Config] Error publishing config snapshot:', error);
            }

            const data = await systemConfig.findOne({ _id: 'main' });

            // Decrypt WiFi password for response
            if (data.wifi_password_encrypted && data.wifi_password_iv) {
                try {
                    data.wifi_password = decrypt(data.wifi_password_encrypted, data.wifi_password_iv);
                } catch (error) {
                    console.error('Error decrypting WiFi password:', error);
                    data.wifi_password = '';
                }
            } else {
                data.wifi_password = '';
            }

            // Decrypt cloud MQTT password for response
            if (data.cloud_mqtt_password_encrypted && data.cloud_mqtt_password_iv) {
                try {
                    data.cloud_mqtt_password = decrypt(data.cloud_mqtt_password_encrypted, data.cloud_mqtt_password_iv);
                } catch (error) {
                    console.error('Error decrypting cloud MQTT password:', error);
                    data.cloud_mqtt_password = '';
                }
            } else {
                data.cloud_mqtt_password = '';
            }

            // Decrypt cloud API key for response
            if (data.cloud_api_key_encrypted && data.cloud_api_key_iv) {
                try {
                    data.cloud_api_key = decrypt(data.cloud_api_key_encrypted, data.cloud_api_key_iv);
                } catch (error) {
                    console.error('Error decrypting cloud API key:', error);
                    data.cloud_api_key = '';
                }
            } else {
                data.cloud_api_key = '';
            }

            // Decrypt SMS SSH key for response
            if (data.sms_ssh_key_encrypted && data.sms_ssh_key_iv) {
                try {
                    data.sms_ssh_key = decrypt(data.sms_ssh_key_encrypted, data.sms_ssh_key_iv);
                } catch (error) {
                    console.error('Error decrypting SMS SSH key:', error);
                    data.sms_ssh_key = '';
                }
            } else {
                data.sms_ssh_key = '';
            }

            // Remove encrypted fields from response
            delete data.wifi_password_encrypted;
            delete data.wifi_password_iv;
            delete data.cloud_mqtt_password_encrypted;
            delete data.cloud_mqtt_password_iv;
            delete data.cloud_api_key_encrypted;
            delete data.cloud_api_key_iv;
            delete data.sms_ssh_key_encrypted;
            delete data.sms_ssh_key_iv;
            // Peregrine CA PEM is managed by /api/peregrine and is large —
            // strip it from this generic blob.
            delete data.peregrine_ca_pem;

            res.json(data);
        } catch (error) {
            console.error('Error updating system config:', error);
            res.status(500).json({ error: 'Failed to update system config' });
        }
    });

    // POST /api/system-config/reset
    router.post('/reset', async (req, res) => {
        try {
            const resetConfig = {
                _id: 'main',
                wizard_completed: false,
                cloud_enabled: false,
                cloud_url: '',
                cloud_mqtt_username: '',
                cloud_mqtt_password_encrypted: '',
                cloud_mqtt_password_iv: '',
                cloud_api_key_encrypted: '',
                cloud_api_key_iv: '',
                cloud_rate_limit: 30,
                alarm_enabled: false,
                sms_enabled: false,
                sms_phone_number: '',
                sms_router_ip: '',
                sms_ssh_key_encrypted: '',
                sms_ssh_key_iv: '',
                sms_max_messages: 3,
                sms_throttle_window_minutes: 60,
                mcu_modules: [],
                wifi_ssid: '',
                wifi_password_encrypted: '',
                wifi_password_iv: '',
                updated_at: new Date()
            };

            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: resetConfig },
                { upsert: true }
            );

            // Disconnect cloud bridge on reset
            cloudBridge.disconnect();

            res.json({
                success: true,
                message: 'Configuration reset successfully',
                config: {
                    ...resetConfig,
                    wifi_password: '',
                    cloud_mqtt_password: '',
                    cloud_api_key: '',
                    sms_ssh_key: ''
                }
            });
        } catch (error) {
            console.error('Error resetting system config:', error);
            res.status(500).json({ error: 'Failed to reset system config' });
        }
    });

    return router;
};

// Helper function to validate URL
function isValidUrl(urlString) {
    try {
        new URL(urlString);
        return true;
    } catch (e) {
        return false;
    }
}
