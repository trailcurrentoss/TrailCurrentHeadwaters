/**
 * Build a sanitized system config snapshot for cloud sync.
 * Reads system_config and lights collections to produce a
 * complete picture of the vehicle's configuration.
 * Sensitive fields (passwords, API keys, IVs) are excluded.
 */

const SAFE_MODULE_CONFIG_KEYS = [
    'channels'
];

function sanitizeModuleConfig(config) {
    if (!config) return {};
    const safe = {};
    for (const key of SAFE_MODULE_CONFIG_KEYS) {
        if (config[key] !== undefined) {
            safe[key] = config[key];
        }
    }
    return safe;
}

async function buildConfigSnapshot(db) {
    const systemConfig = await db.collection('system_config').findOne({ _id: 'main' });
    if (!systemConfig) return null;

    const lights = await db.collection('lights').find().sort({ _id: 1 }).toArray();

    const modules = (systemConfig.mcu_modules || []).map(m => ({
        type: m.type,
        name: m.name,
        hostname: m.hostname,
        enabled: m.enabled !== false,
        config: sanitizeModuleConfig(m.config)
    }));

    const channels = lights.map(l => {
        const ch = {
            id: l._id,
            name: l.name,
            icon: l.icon,
            type: l.type,
            source: l.source || 'pdm'
        };
        if (l.relay_channel !== undefined) ch.relay_channel = l.relay_channel;
        return ch;
    });

    return {
        wizard_completed: systemConfig.wizard_completed || false,
        cloud_enabled: systemConfig.cloud_enabled || false,
        wifi_ssid: systemConfig.wifi_ssid || '',
        vehicle_mounting: systemConfig.vehicle_mounting,
        vehicle_length_cm: systemConfig.vehicle_length_cm,
        vehicle_width_cm: systemConfig.vehicle_width_cm,
        modules,
        channels,
        updated_at: systemConfig.updated_at || new Date().toISOString(),
        snapshot_at: new Date().toISOString()
    };
}

module.exports = { buildConfigSnapshot };
