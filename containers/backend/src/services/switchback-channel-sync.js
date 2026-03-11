const DEFAULT_CHANNEL_NAMES = [
    'Relay 1', 'Relay 2', 'Relay 3', 'Relay 4', 'Relay 5', 'Relay 6'
];

// Base ID offset for Switchback relay entries in the lights collection.
// PDM lights use IDs 1-8 (per PDM), so 100+ avoids collisions.
const SWITCHBACK_ID_BASE = 100;
const CHANNELS_PER_MODULE = 6;

function getDefaultChannels() {
    return DEFAULT_CHANNEL_NAMES.map((name, i) => ({
        channel: i + 1,
        name,
        icon: 'power-outlet',
        type: 'other'
    }));
}

/**
 * Sync Switchback relay channel configs from system_config.mcu_modules to the lights collection.
 * Called when modules are updated and on backend startup.
 */
async function syncSwitchbackChannelsToLights(db, mqttService) {
    const systemConfig = await db.collection('system_config').findOne({ _id: 'main' });
    const modules = systemConfig?.mcu_modules || [];

    // Filter enabled Switchback modules, sorted deterministically by hostname
    const switchbacks = modules
        .filter(m => m.type === 'switchback_relay' && m.enabled)
        .sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''));

    const lightsCollection = db.collection('lights');
    const validIds = new Set();
    const allChannels = [];

    for (let sbIndex = 0; sbIndex < switchbacks.length; sbIndex++) {
        const sb = switchbacks[sbIndex];
        const channels = sb.config?.channels || getDefaultChannels();

        for (const ch of channels) {
            const lightId = SWITCHBACK_ID_BASE + (sbIndex * CHANNELS_PER_MODULE) + ch.channel;
            validIds.add(lightId);
            allChannels.push({
                id: lightId,
                name: ch.name,
                icon: ch.icon || 'power-outlet',
                type: ch.type || 'other',
                relay_channel: ch.channel  // 1-based MQTT channel (local/relays/N/command)
            });

            await lightsCollection.updateOne(
                { _id: lightId },
                {
                    $set: {
                        name: ch.name,
                        icon: ch.icon || 'power-outlet',
                        type: ch.type || 'other',
                        source: 'switchback',
                        relay_channel: ch.channel - 1, // CAN channel index is 0-based
                        updated_at: new Date()
                    }
                },
                { upsert: true }
            );
        }
    }

    // Remove orphaned switchback entries no longer covered by any enabled module
    if (validIds.size > 0) {
        await lightsCollection.deleteMany({
            source: 'switchback',
            _id: { $nin: [...validIds] }
        });
    } else {
        // No enabled switchbacks — remove all switchback entries
        await lightsCollection.deleteMany({ source: 'switchback' });
    }

    // Publish config to MQTT for local services (voice assistant, etc.)
    if (mqttService && allChannels.length > 0) {
        mqttService.publishRelayChannelConfig(allChannels);
    }

    console.log(`[Switchback Sync] Synced ${validIds.size} relay channels from ${switchbacks.length} module(s)`);
}

module.exports = { syncSwitchbackChannelsToLights, getDefaultChannels };
