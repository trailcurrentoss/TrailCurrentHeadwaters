const express = require('express');
const router = express.Router();
const { encrypt, decrypt } = require('../utils/crypto.js');
const { injectWithRetry, removeWithRetry } = require('../services/nodered-cloud-workflow.js');
const { syncPdmChannelsToLights } = require('../services/pdm-channel-sync.js');
const { syncSwitchbackChannelsToLights } = require('../services/switchback-channel-sync.js');

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

            // Remove encrypted fields from response
            delete data.wifi_password_encrypted;
            delete data.wifi_password_iv;
            delete data.cloud_mqtt_password_encrypted;
            delete data.cloud_mqtt_password_iv;
            delete data.cloud_api_key_encrypted;
            delete data.cloud_api_key_iv;

            res.json(data);
        } catch (error) {
            console.error('Error fetching system config:', error);
            res.status(500).json({ error: 'Failed to fetch system config' });
        }
    });

    // PUT /api/system-config
    router.put('/', async (req, res) => {
        try {
            const { wizard_completed, cloud_enabled, cloud_url, cloud_mqtt_username, cloud_mqtt_password, cloud_api_key, mcu_modules, wifi_ssid, wifi_password } = req.body;

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

            if (mcu_modules !== undefined) {
                if (!Array.isArray(mcu_modules)) {
                    return res.status(400).json({ error: 'mcu_modules must be an array' });
                }
                // Validate each module
                for (const mod of mcu_modules) {
                    if (!mod.type || !mod.name || !mod.hostname) {
                        return res.status(400).json({ error: 'Each module must have type, name, and hostname' });
                    }
                    if (typeof mod.type !== 'string' || typeof mod.name !== 'string' || typeof mod.hostname !== 'string') {
                        return res.status(400).json({ error: 'Module fields must be strings' });
                    }
                }
                updates.mcu_modules = mcu_modules;
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

            // Trigger Plateau config broadcast via CAN if a vehicle_leveler module is present
            if (mcu_modules !== undefined) {
                const leveler = mcu_modules.find(m => m.type === 'vehicle_leveler' && m.enabled !== false);
                if (leveler && leveler.config) {
                    const mqttService = require('../mqtt');
                    try {
                        const mounting = leveler.config.mounting !== undefined ? leveler.config.mounting : 0;
                        const lengthCm = leveler.config.vehicle_length_cm !== undefined ? leveler.config.vehicle_length_cm : 500;
                        const widthCm = leveler.config.vehicle_width_cm !== undefined ? leveler.config.vehicle_width_cm : 200;

                        console.log('[System Config] Publishing Plateau config to CAN bus');
                        mqttService.publishPlateauConfig(mounting, lengthCm, widthCm);
                    } catch (error) {
                        console.error('[System Config] Error publishing Plateau config:', error);
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

                // Inject or remove the Node-RED cloud workflow (fire-and-forget)
                if (cloud_enabled === false) {
                    removeWithRetry().catch(err =>
                        console.error('[System Config] Cloud workflow removal failed:', err.message));
                } else {
                    // Re-read saved config to get the full set of cloud fields
                    const saved = await systemConfig.findOne({ _id: 'main' });
                    if (saved && saved.cloud_enabled) {
                        let mqttPass = '';
                        if (saved.cloud_mqtt_password_encrypted && saved.cloud_mqtt_password_iv) {
                            try { mqttPass = decrypt(saved.cloud_mqtt_password_encrypted, saved.cloud_mqtt_password_iv); } catch {}
                        }
                        injectWithRetry(saved.cloud_url, saved.cloud_mqtt_username, mqttPass).catch(err =>
                            console.error('[System Config] Cloud workflow injection failed:', err.message));
                    }
                }
            }

            // Sync PDM channel config to lights collection if modules changed
            if (mcu_modules !== undefined) {
                const mqttService = require('../mqtt');
                try {
                    await syncPdmChannelsToLights(db, mqttService);
                    await syncSwitchbackChannelsToLights(db, mqttService);
                    await mqttService.refreshRelayNameCache();
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

            // Remove encrypted fields from response
            delete data.wifi_password_encrypted;
            delete data.wifi_password_iv;
            delete data.cloud_mqtt_password_encrypted;
            delete data.cloud_mqtt_password_iv;
            delete data.cloud_api_key_encrypted;
            delete data.cloud_api_key_iv;

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

            // Remove cloud workflow from Node-RED on reset (fire-and-forget)
            removeWithRetry().catch(err =>
                console.error('[System Config] Cloud workflow removal on reset failed:', err.message));

            res.json({
                success: true,
                message: 'Configuration reset successfully',
                config: {
                    ...resetConfig,
                    wifi_password: '',
                    cloud_mqtt_password: '',
                    cloud_api_key: ''
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
