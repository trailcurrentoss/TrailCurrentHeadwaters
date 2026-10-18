// Peregrine, as handed out to devices that talk to it directly (Tiercel).
//
// Headwaters is the configuration broker here, not a proxy: a device gets
// exactly what this backend itself uses to reach Peregrine for Overlook's
// chat — the URL and Peregrine's CA certificate — and then talks to
// Peregrine on its own. Peregrine serves /api/chat and /api/voice on the
// same HTTPS listener with the same trust (on the LAN, trusts the CA), so
// nothing beyond what is already configured in Settings → Peregrine has to
// be generated or copied for a device to use voice.
//
// Payload size matters: the device drops an MQTT message over its 2048-byte
// MSG_DATA_MAX whole (tiercel_mqtt.c). A 2048-bit RSA CA is ~1.4 KB once
// JSON-escaped, which fits; a larger key may not, and is warned about below.

const DEFAULT_URL = 'https://peregrine.local';

// Matches MSG_DATA_MAX in TrailCurrentTiercel's tiercel_mqtt.c, less room
// for the topic-independent JSON wrapper the dial also has to fit.
const DEVICE_MSG_MAX = 2047;

let warnedOversize = false;

/**
 * The `peregrine` block of a device's services payload, or null when
 * Peregrine is disabled — in which case the block is omitted and the device
 * shows "Peregrine is not set up".
 *
 * `ca` is omitted for an http:// URL, and for https:// when no CA has been
 * uploaded (the device then cannot verify Peregrine and says so).
 */
function voiceServiceOf(doc) {
    if (doc && doc.peregrine_enabled === false) return null;
    const url = String((doc && doc.peregrine_url) || DEFAULT_URL).trim().replace(/\/+$/, '');
    if (!url) return null;

    const block = { url };
    const ca = doc && doc.peregrine_ca_pem;
    if (url.startsWith('https://') && ca) block.ca = ca;

    const size = JSON.stringify({ peregrine: block }).length;
    if (size > DEVICE_MSG_MAX && !warnedOversize) {
        warnedOversize = true;
        console.warn(`[peregrine-voice] Services payload is ${size} bytes, over the ` +
                     `${DEVICE_MSG_MAX}-byte device message limit; Tiercels will drop it. ` +
                     `Use a 2048-bit RSA or an EC CA for Peregrine.`);
    }
    return block;
}

module.exports = {
    DEFAULT_URL,
    voiceServiceOf,
};
