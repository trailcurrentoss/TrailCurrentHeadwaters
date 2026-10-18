// Peregrine voice endpoint, as handed out to voice terminals (Tiercel).
//
// Peregrine serves two things on two listeners (TrailCurrentPeregrine
// src/web_chat.py):
//
//   https://<host>         the browser chat UI, behind its self-signed CA.
//                          This is what peregrine_url points at and what the
//                          peregrine-ca service makes this container trust.
//   http://<host>:8081     POST /api/voice, plain HTTP with a bearer token
//                          (PEREGRINE_VOICE_TOKEN). Deliberately not TLS:
//                          small LAN clients can't practically carry the CA.
//
// A voice terminal only ever talks to the second one, so it needs the host,
// the voice port and the token — never the CA. The host is taken from the
// configured peregrine_url so there is one place to say where Peregrine is.
//
// The token is stored encrypted in system_config, the same way the Wi-Fi
// password is, and is only ever decrypted to be published to a device.

const { decrypt } = require('../utils/crypto.js');

const DEFAULT_URL = 'https://peregrine.local';
// Peregrine's PEREGRINE_VOICE_PORT default.
const DEFAULT_VOICE_PORT = 8081;

function voicePortOf(doc) {
    const p = Number(doc && doc.peregrine_voice_port);
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_VOICE_PORT;
}

/** http://<host of peregrine_url>:<voice port>, no trailing slash, or '' if
 *  the configured URL can't be parsed. */
function voiceUrlOf(doc) {
    let host;
    try {
        host = new URL((doc && doc.peregrine_url) || DEFAULT_URL).hostname;
    } catch {
        return '';
    }
    if (!host) return '';
    // URL.hostname keeps the brackets on an IPv6 literal, which is what a
    // URL needs back, so it can be interpolated as-is.
    return `http://${host}:${voicePortOf(doc)}`;
}

function hasVoiceToken(doc) {
    return !!(doc && doc.peregrine_voice_token_encrypted && doc.peregrine_voice_token_iv);
}

function voiceTokenOf(doc) {
    if (!hasVoiceToken(doc)) return '';
    try {
        return decrypt(doc.peregrine_voice_token_encrypted, doc.peregrine_voice_token_iv);
    } catch (err) {
        console.error('[peregrine-voice] Could not decrypt voice token:', err.message);
        return '';
    }
}

/**
 * The `peregrine` block of a voice terminal's services payload, or null when
 * Peregrine is disabled or has no voice token — in which case the block is
 * omitted and the device shows "Peregrine is not set up".
 */
function voiceServiceOf(doc) {
    if (doc && doc.peregrine_enabled === false) return null;
    const url = voiceUrlOf(doc);
    const token = voiceTokenOf(doc);
    if (!url || !token) return null;
    return { url, token };
}

module.exports = {
    DEFAULT_URL,
    DEFAULT_VOICE_PORT,
    voicePortOf,
    voiceUrlOf,
    hasVoiceToken,
    voiceServiceOf,
};
