/*
 * Capstan per-device configuration: device controls and alarms.
 *
 * A Capstan is a rotary touchscreen with room for a handful of controls, not
 * every channel in the rig. The user picks which Torrent (PDM) and Switchback
 * (relay) channels that particular dial should drive, in Settings > Network &
 * Modules, and those picks live on the module record as
 *
 *     config.controls = [ { source, hostname, channel }, ... ]
 *
 * That form is a *reference*: source + which module + which channel on it. It
 * deliberately does not store the unified light id, the label or the icon,
 * because all three are derived — renaming a PDM channel or adding a second
 * Switchback would silently invalidate a stored copy.
 *
 * This service does the deriving and publishes the resolved list, retained,
 * on a per-device topic:
 *
 *     local/config/capstan/<hostname>/controls
 *     { "controls": [ { "id": 3, "name": "Kitchen", "icon": "lightbulb" } ] }
 *
 * `id` is the unified light id the display already commands with
 * local/lights/<id>/command — PDM channels are 1..N, Switchback relays start
 * at SWITCHBACK_ID_BASE (100). The device stores the resolved triplet in NVS
 * so its controls come up labelled before the broker is reachable.
 *
 * `source` is not in the payload on purpose: it is recoverable from the id —
 * anything at or above SWITCHBACK_ID_BASE is a relay, and therefore
 * toggle-only — and leaving it out keeps MAX_CONTROLS entries comfortably
 * inside the display's MQTT message buffer, which drops an oversized payload
 * whole rather than truncating it. See docs/mqtt.md in TrailCurrentCapstan.
 *
 * ALARMS work the same way, on a sibling topic, with two differences.
 *
 *     config.alarms = [ { source, hostname, sensor, icon, label, modes } ]
 *     local/config/panel/<hostname>/alarms
 *
 * FIRST: a control's label and icon are DERIVED, because the Torrent or
 * Switchback channel already carries both. An alarm has neither — nothing on
 * the bus is "an alarm". Picket publishes a bitmask, Torrent publishes channel
 * state; whether a given status event constitutes an alarm is an
 * interpretation a particular panel applies. So the label and icon belong to
 * the panel's entry and are carried in the payload.
 *
 * SECOND, and the reason this is not just a list of armed sensors: the
 * interpretation is PER MODE. The same input means opposite things depending
 * on what the rig is doing. A fridge sense line:
 *
 *     storage  — voltage present is the alarm. Something switched it on.
 *     driving  — voltage absent is the alarm. It lost power on the road.
 *     camping  — neither. It is supposed to cycle.
 *
 * So each alarm carries a verdict per mode: 'none' (this mode does not care),
 * 'high' (alarm while the input is asserted) or 'low' (alarm while it is
 * not). The panel evaluates against whichever mode the rig is in, which it
 * learns from the retained local/mode/current.
 *
 * WHY THE SOURCE IS ALWAYS A DIGITAL INPUT, never a relay or PDM channel's
 * reported state. A relay can report ON while a failed contact passes no
 * voltage — which is precisely the fault an alarm is for. A Picket DI wired
 * to the load's supply sees what the load sees, so it stays correct when the
 * relay lies. Do not "improve" this by adding local/lights/<id>/status as an
 * alarm source: that would alarm on commanded state rather than on reality.
 *
 * PER PANEL, NOT PER CAPSTAN. The alarms topic is keyed on `panel` rather
 * than `capstan` because Milepost and Fireside are the same kind of consumer
 * and should adopt this contract rather than growing their own. The controls
 * topic is still capstan-scoped and should migrate when Milepost does.
 */

const CHANNELS_PER_MODULE = 8;
const SWITCHBACK_ID_BASE = 100;

// Matches CAPSTAN_MAX_CONTROLS in the firmware and MAX_CAPSTAN_CONTROLS in
// the PWA. Bounded by the display's MQTT message buffer, not by screen real
// estate — raising it means checking MSG_DATA_MAX in capstan_mqtt.c too.
const MAX_CONTROLS = 8;

// SIX, not eight, and the difference is the per-mode verdicts.
//
// A worst-case alarm entry — the longest sensor key, a 24-character label, a
// 16-character icon key and all three modes spelled out — is 149 bytes, so
// six of them plus the wrapper is 907. Eight would be 1205, over the display's
// 1024-byte MSG_DATA_MAX, and an oversized payload is dropped whole rather
// than truncated: the dial would simply have no alarms and say so in one log
// line. If six turns out to be too few, the lever is MSG_QUEUE_DEPTH against
// MSG_DATA_MAX in capstan_mqtt.c, which are deliberately traded off against
// each other there — not a quiet bump here.
const MAX_ALARMS = 6;

// What an alarm means in a given mode. 'none' is not "disarmed" so much as
// "this mode does not care" — the same sensor is usually live in another.
const ALARM_VERDICTS = ['none', 'high', 'low'];

// Fixed set, mirroring VALID_MODES in routes/system-config.js, MODES in the
// PWA's mode-controller.js and capstan_mode_t in the firmware.
const RIG_MODES = ['camping', 'driving', 'storage'];

// Digital inputs per board, matching SENSORS_PER in alarms-service.js. Sensor
// numbers are 1-based here and on the wire, exactly as the PWA's alarm keys
// and system_config.alarms.sensors use them; the display subtracts one to get
// the bit index.
const SENSORS_PER_BOARD = { picket: 12, switchback: 8 };

// Hostnames we have published a retained payload for. A Capstan that is
// deleted or disabled has to have its retained topic cleared, or the display
// keeps loading a control list nobody can see in the PWA any more.
const publishedHostnames = new Set();

function isSwitchback(type) {
    return type === 'switchback' || type === 'switchback_relay';
}

/**
 * Index of a module within its own type, ordered exactly the way
 * pdm-channel-sync and switchback-channel-sync order them (enabled only,
 * sorted by hostname). That ordering is what assigns light ids, so it has to
 * be derived the same way here or the ids won't match.
 */
function moduleIndex(modules, mod) {
    const peers = modules
        .filter(m => (isSwitchback(mod.type) ? isSwitchback(m.type) : m.type === mod.type) && m.enabled)
        .sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''));
    return peers.findIndex(m => m.hostname === mod.hostname);
}

/**
 * Resolve one { source, hostname, channel } reference to the light id it
 * addresses, or null when the target module is gone, disabled, or the channel
 * is out of range. A dangling reference is dropped rather than published as a
 * dead control — a button that does nothing is worse than an absent one.
 */
function resolveControlId(modules, control) {
    const channel = Number(control.channel);
    if (!Number.isInteger(channel) || channel < 1 || channel > CHANNELS_PER_MODULE) return null;

    const mod = modules.find(m => m.hostname === control.hostname && m.enabled);
    if (!mod) return null;

    if (control.source === 'torrent' && mod.type === 'torrent') {
        const idx = moduleIndex(modules, mod);
        if (idx < 0) return null;
        return (idx * CHANNELS_PER_MODULE) + channel;
    }

    if (control.source === 'switchback' && isSwitchback(mod.type)) {
        const idx = moduleIndex(modules, mod);
        if (idx < 0) return null;
        return SWITCHBACK_ID_BASE + (idx * CHANNELS_PER_MODULE) + channel;
    }

    return null;
}

function defaultAlarmLabel(source, addr, sensor) {
    // Matches defaultLabel() in alarms-service.js and the PWA's alarms group,
    // so an unnamed sensor reads the same on the dial as it does everywhere
    // else in the rig.
    return `${source === 'switchback' ? 'SB' : 'PK'}${addr}-S${sensor}`;
}

/**
 * Resolve one alarm reference against the module list.
 *
 * Returns the wire form — { key, name, icon, modes } — or null when the
 * board is gone, disabled, or the sensor number is off the end of it. The key
 * is `<source>:<addr>:<sensor>`, byte-for-byte the identifier
 * system_config.alarms.sensors uses, so the same string names the same input
 * in Mongo, in the PWA and on the display.
 */
function resolveAlarm(modules, alarm, sensorLabels) {
    const source = alarm.source === 'switchback' ? 'switchback'
                 : alarm.source === 'picket' ? 'picket'
                 : null;
    if (!source) return null;

    const sensor = Number(alarm.sensor);
    if (!Number.isInteger(sensor) || sensor < 1 || sensor > SENSORS_PER_BOARD[source]) return null;

    const mod = modules.find(m => m.hostname === alarm.hostname && m.enabled);
    if (!mod) return null;

    const modSource = isSwitchback(mod.type) ? 'switchback' : mod.type;
    if (modSource !== source) return null;

    // The MQTT input topics are addressed by board address, not hostname:
    // local/picket/<addr>/inputs and local/spoor/<addr>/inputs. `addr` is
    // firmware-controlled and immutable in system-config, but the reference
    // stores the hostname anyway, so a board re-addressed on the bench
    // re-resolves instead of quietly pointing at its neighbour.
    const addr = Number.isInteger(mod.addr) ? mod.addr : 0;
    const key = `${source}:${addr}:${sensor}`;

    const label = (alarm.label && String(alarm.label).trim())
               || sensorLabels.get(key)
               || defaultAlarmLabel(source, addr, sensor);

    // Spelled out in full for every mode, including the 'none' ones. The
    // display should not have to infer a missing key's meaning, and a payload
    // whose size depends on how many modes happen to be configured is a
    // payload that fits in testing and overflows in the field.
    const modes = {};
    for (const m of RIG_MODES) {
        const v = alarm.modes?.[m];
        modes[m] = ALARM_VERDICTS.includes(v) ? v : 'none';
    }

    return {
        key,
        name: label.slice(0, 24),
        icon: alarm.icon || 'bell',
        modes
    };
}

/**
 * Publish each enabled Capstan's resolved configuration, retained: its
 * device controls on one topic, its alarms on a sibling.
 *
 * Call this after syncPdmChannelsToLights and syncSwitchbackChannelsToLights,
 * never before: control labels and icons are read back out of the lights
 * collection those two write, so running first publishes the previous names.
 */
async function syncCapstanConfig(db, mqttService) {
    const systemConfig = await db.collection('system_config').findOne({ _id: 'main' });
    const modules = systemConfig?.mcu_modules || [];
    const capstans = modules.filter(m => m.type === 'capstan');

    if (capstans.length === 0 && publishedHostnames.size === 0) return;

    const lights = await db.collection('lights').find().toArray();
    const lightsById = new Map(lights.map(l => [l._id, l]));

    // Rig-wide sensor labels, used only as a fallback: the PWA seeds the
    // Capstan entry's own label from these, and once seeded the entry owns it.
    const sensorLabels = new Map();
    for (const [k, entry] of Object.entries(systemConfig?.alarms?.sensors || {})) {
        if (entry && typeof entry.label === 'string' && entry.label.length > 0) {
            sensorLabels.set(k, entry.label);
        }
    }

    const seen = new Set();

    for (const capstan of capstans) {
        if (!capstan.hostname) continue;
        seen.add(capstan.hostname);

        // A disabled Capstan is sent empty lists rather than skipped — that is
        // how a dial is told to forget what it was showing.
        const enabled = capstan.enabled;

        const controlRefs = enabled ? (capstan.config?.controls || []) : [];
        const controls = [];
        for (const ref of controlRefs.slice(0, MAX_CONTROLS)) {
            const id = resolveControlId(modules, ref);
            if (id === null) continue;
            const light = lightsById.get(id);
            if (!light) continue;
            controls.push({
                id,
                name: light.name,
                icon: light.icon || (id >= SWITCHBACK_ID_BASE ? 'power-outlet' : 'lightbulb')
            });
        }

        const alarmRefs = enabled ? (capstan.config?.alarms || []) : [];
        const alarms = [];
        for (const ref of alarmRefs.slice(0, MAX_ALARMS)) {
            const resolved = resolveAlarm(modules, ref, sensorLabels);
            if (resolved) alarms.push(resolved);
        }

        if (mqttService) {
            mqttService.publishCapstanControlConfig(capstan.hostname, controls);
            mqttService.publishPanelAlarmConfig(capstan.hostname, alarms);
        }
        publishedHostnames.add(capstan.hostname);

        const droppedControls = Math.min(controlRefs.length, MAX_CONTROLS) - controls.length;
        const droppedAlarms = Math.min(alarmRefs.length, MAX_ALARMS) - alarms.length;
        const dropped = droppedControls + droppedAlarms;
        console.log(`[Capstan Sync] ${capstan.hostname}: ${controls.length} control(s), ` +
                    `${alarms.length} alarm(s)` +
                    (dropped > 0 ? `, ${dropped} unresolved reference(s) dropped` : ''));
    }

    // Clear both retained payloads for any Capstan we published for previously
    // and that is no longer in the module list at all.
    for (const hostname of [...publishedHostnames]) {
        if (seen.has(hostname)) continue;
        if (mqttService) {
            mqttService.publishCapstanControlConfig(hostname, []);
            mqttService.publishPanelAlarmConfig(hostname, []);
        }
        publishedHostnames.delete(hostname);
        console.log(`[Capstan Sync] ${hostname}: removed, cleared retained config`);
    }
}

module.exports = {
    syncCapstanConfig,
    resolveControlId,
    resolveAlarm,
    MAX_CONTROLS,
    MAX_ALARMS,
    ALARM_VERDICTS,
    RIG_MODES,
    SENSORS_PER_BOARD,
    SWITCHBACK_ID_BASE,
    CHANNELS_PER_MODULE
};
