const DEFAULT_CHANNEL_NAMES = [
    'Living Room', 'Kitchen', 'Bedroom', 'Bathroom',
    'Exterior', 'Awning', 'Porch', 'Storage'
];

function getDefaultChannels() {
    return DEFAULT_CHANNEL_NAMES.map((name, i) => ({
        channel: i + 1,
        name,
        icon: 'lightbulb',
        type: 'light'
    }));
}

/**
 * Sync PDM channel configs from system_config.mcu_modules to the lights collection.
 * Called when modules are updated and on backend startup.
 */
async function syncPdmChannelsToLights(db, mqttService) {
    const systemConfig = await db.collection('system_config').findOne({ _id: 'main' });
    const modules = systemConfig?.mcu_modules || [];

    // Filter enabled PDMs, sorted deterministically by hostname
    const pdms = modules
        .filter(m => m.type === 'power_distribution_module' && m.enabled)
        .sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''));

    // If no PDMs configured, leave the existing lights collection as-is
    if (pdms.length === 0) return;

    const lightsCollection = db.collection('lights');
    const allChannels = [];
    const validIds = new Set();

    for (let pdmIndex = 0; pdmIndex < pdms.length; pdmIndex++) {
        const pdm = pdms[pdmIndex];
        const channels = pdm.config?.channels || getDefaultChannels();

        for (const ch of channels) {
            const lightId = (pdmIndex * 8) + ch.channel;
            validIds.add(lightId);
            allChannels.push({
                id: lightId,
                name: ch.name,
                icon: ch.icon || 'lightbulb',
                type: ch.type || 'light'
            });

            await lightsCollection.updateOne(
                { _id: lightId },
                {
                    $set: {
                        name: ch.name,
                        icon: ch.icon || 'lightbulb',
                        type: ch.type || 'light',
                        updated_at: new Date()
                    }
                },
                { upsert: true }
            );
        }
    }

    // Remove orphaned PDM lights no longer covered by any PDM channel
    // Only delete entries without a source field (PDM lights) — leave switchback entries alone
    await lightsCollection.deleteMany({
        _id: { $nin: [...validIds] },
        source: { $exists: false }
    });

    // Publish config to MQTT for cloud sync
    if (mqttService) {
        mqttService.publishPdmChannelConfig(allChannels);
    }

    console.log(`[PDM Sync] Synced ${allChannels.length} channels from ${pdms.length} PDM(s)`);
}

module.exports = { syncPdmChannelsToLights, getDefaultChannels };
