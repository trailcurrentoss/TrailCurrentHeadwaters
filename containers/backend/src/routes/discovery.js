const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const router = express.Router();
const { decrypt } = require('../utils/crypto.js');
const mqttService = require('../mqtt');
const { syncPdmChannelsToLights } = require('../services/pdm-channel-sync.js');
const { syncSwitchbackChannelsToLights } = require('../services/switchback-channel-sync.js');
const { syncCapstanConfig } = require('../services/capstan-config-sync.js');
const { MCU_MODULES, VALID_MODULE_IDS } = require('./modules');

const WIRELESS_MODULE_IDS = new Set(MCU_MODULES.filter(m => m.wireless).map(m => m.id));

const MODULE_DISPLAY_NAMES = Object.fromEntries(MCU_MODULES.map(m => [m.id, m.name]));

// Non-MCU device types we accept on the same mDNS browse. They follow a
// different onboarding flow (no mcu_modules entry, no CAN reset path) but
// share the same discovery transport.
const NON_MCU_TYPES = new Set(['playbill']);

// Ephemeral discovery session state
let discoveredModules = [];
let discoveryActive = false;
let discoveryTimeout = null;

// Pending confirm callbacks: hostname -> { resolve, reject, timer }
const pendingConfirms = new Map();
// Pending claim callbacks (Playbill onboarding) — same shape, separate map
// so a confirm and a claim for the same hostname can't collide.
const pendingClaims = new Map();

// Read the rig's broker credentials so we can hand them to a freshly
// discovered Playbill. The Headwaters backend already has these injected
// via env (mqtt.js connect() uses the same vars). If MQTT_BROKER_URL
// points at a Docker-internal hostname (e.g. `mqtts://mosquitto:8883`),
// the Playbill — which lives on the rig LAN, not the Docker bridge —
// cannot resolve it. In that case we translate to something reachable.
//
// Rewrite-target precedence (only used when the internal hostname doesn't
// already look LAN-reachable):
//   1. HEADWATERS_LAN_HOST env var — explicit operator override.
//   2. TLS_CERT_HOSTNAME env var — the rig's TLS cert SAN. By convention
//      this is the same as the rig's mDNS LAN name (e.g. `headwaters.local`).
//      Using it doubles as a free TLS verify match.
//   3. `${os.hostname()}.local` — last-ditch fallback. Inside a Docker
//      container this returns the container id, which won't resolve from
//      the LAN. We log loudly when this branch fires so operators know
//      they need to set one of the above.
//
// If the URL was rewritten, the cert SAN override priority is:
//   • TLS_CERT_HOSTNAME if set
//   • else the original (internal) hostname, in case the cert was issued
//     against it (e.g. SAN `mosquitto`).
function gatherPlaybillCreds() {
    const rawUrl   = process.env.MQTT_BROKER_URL;
    const username = process.env.MQTT_USERNAME;
    const password = process.env.MQTT_PASSWORD;
    if (!rawUrl || !username || !password) {
        throw new Error('Backend is missing MQTT_BROKER_URL/USERNAME/PASSWORD; cannot claim Playbills');
    }

    let brokerUrl = rawUrl;
    let internalHost = null;
    let rewrote = false;
    let rewriteSource = null;
    try {
        const url = new URL(rawUrl);
        internalHost = url.hostname;

        const explicitLan      = process.env.HEADWATERS_LAN_HOST;
        const certHostname     = process.env.TLS_CERT_HOSTNAME;
        const looksLanReachable =
            internalHost.endsWith('.local') ||
            /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(internalHost);

        let target = null;
        if (explicitLan) {
            target = explicitLan; rewriteSource = 'HEADWATERS_LAN_HOST';
        } else if (!looksLanReachable && certHostname) {
            // The TLS cert SAN doubles as the rig's LAN-reachable mDNS name
            // in our setup. Using it eliminates the need for a separate env
            // var and makes the TLS verify trivially match.
            target = certHostname; rewriteSource = 'TLS_CERT_HOSTNAME';
        } else if (!looksLanReachable) {
            target = `${os.hostname()}.local`; rewriteSource = 'os.hostname() (last-ditch)';
        }

        if (target && target !== internalHost) {
            url.hostname = target;
            brokerUrl = url.toString();
            rewrote = true;
        }
    } catch (e) {
        console.warn('[Discovery] Could not parse MQTT_BROKER_URL — passing through unchanged:', e.message);
    }

    const creds = { brokerUrl, username, password };

    // TLS cert SAN override. If we rewrote and TLS_CERT_HOSTNAME is set,
    // we already targeted that hostname above, so an explicit override is
    // redundant — but pass it through anyway in case the cert lives under
    // a different SAN. Fall back to the original internal hostname if we
    // rewrote without an explicit cert name.
    const explicitTls = process.env.TLS_CERT_HOSTNAME;
    if (explicitTls) {
        // Only emit a SAN override when it differs from the URL hostname;
        // otherwise it's noise. mqtt.js handles undefined cleanly.
        try {
            const finalHost = new URL(brokerUrl).hostname;
            if (explicitTls !== finalHost) creds.tlsCertHostname = explicitTls;
        } catch (_) { creds.tlsCertHostname = explicitTls; }
    } else if (rewrote && internalHost) {
        creds.tlsCertHostname = internalHost;
    }

    // CA cert — only meaningful for mqtts://.
    const caPath = path.join('/app/certs', 'ca.pem');
    if (brokerUrl.startsWith('mqtts://') && fs.existsSync(caPath)) {
        try { creds.caCertPem = fs.readFileSync(caPath, 'utf8'); }
        catch (e) { console.warn('[Discovery] CA cert unreadable:', e.message); }
    }

    if (rewriteSource === 'os.hostname() (last-ditch)') {
        console.warn(
            `[Discovery] Rewrote brokerUrl to ${brokerUrl} using the container hostname ` +
            `because neither HEADWATERS_LAN_HOST nor TLS_CERT_HOSTNAME is set. ` +
            `This URL is almost certainly not resolvable from the rig LAN — ` +
            `set HEADWATERS_LAN_HOST (or TLS_CERT_HOSTNAME) in docker-compose.yml.`
        );
    }
    console.log(`[Discovery] Playbill creds: ${brokerUrl}${creds.tlsCertHostname ? ` (TLS SAN: ${creds.tlsCertHostname})` : ''}${rewrote ? ` [rewrote from ${internalHost} via ${rewriteSource}]` : ''}`);
    return creds;
}

module.exports = (db) => {
    const systemConfig = db.collection('system_config');

    // POST /api/discovery/start — Broadcast WiFi creds + CAN 0x02, start mDNS browse
    router.post('/start', async (req, res) => {
        try {
            // Read WiFi credentials from system config
            const config = await systemConfig.findOne({ _id: 'main' });
            // Ignore if already scanning
            if (discoveryActive) {
                return res.json({ success: true, message: 'Discovery already active' });
            }

            // Check MQTT is connected before proceeding
            if (!mqttService.connected) {
                return res.status(503).json({ error: 'MQTT broker not connected' });
            }

            // Clear previous session
            discoveredModules = [];
            discoveryActive = true;

            // Auto-reset discoveryActive after timeout (safety net if frontend disconnects)
            if (discoveryTimeout) clearTimeout(discoveryTimeout);
            discoveryTimeout = setTimeout(() => {
                if (discoveryActive) {
                    console.log('[Discovery] Auto-stopping after timeout');
                    discoveryActive = false;
                    mqttService.publishDiscoveryBrowseStop();
                }
            }, 40000);

            // Broadcast WiFi credentials first, then trigger discovery after they finish
            if (config && config.wifi_ssid && config.wifi_password_encrypted && config.wifi_password_iv) {
                try {
                    const password = decrypt(config.wifi_password_encrypted, config.wifi_password_iv);
                    if (config.wifi_ssid && password) {
                        console.log('[Discovery] Broadcasting WiFi credentials via CAN 0x01');
                        await mqttService.publishWifiCredentials(config.wifi_ssid, password);
                    }
                } catch (err) {
                    console.error('[Discovery] Failed to decrypt WiFi password:', err.message);
                }
            }

            mqttService.publishDiscoveryTrigger();
            mqttService.publishWirelessDiscoveryTrigger();
            mqttService.publishDiscoveryBrowseStart();

            res.json({ success: true, message: 'Discovery started' });
        } catch (error) {
            console.error('Error starting discovery:', error);
            res.status(500).json({ error: 'Failed to start discovery' });
        }
    });

    // GET /api/discovery/found — Return modules found so far
    router.get('/found', (req, res) => {
        res.json({
            active: discoveryActive,
            modules: discoveredModules
        });
    });

    // POST /api/discovery/confirm — Confirm a discovered module and save it.
    //
    // Two branches based on the discovered device's type:
    //   - MCU (Fireside, Picket, etc.): GET /discovery/confirm marker, then
    //     persist into system_config.mcu_modules. (Original flow.)
    //   - Playbill (Linux endpoint): POST broker credentials to the device's
    //     /discovery/claim endpoint. No mcu_modules entry — the Playbill
    //     surfaces via its retained local/playbill/<id>/system/status
    //     presence once it connects to the broker. The PWA's Playbill page
    //     already discovers it from that presence cache.
    router.post('/confirm', async (req, res) => {
        try {
            const { hostname } = req.body;

            if (!hostname || typeof hostname !== 'string') {
                return res.status(400).json({ error: 'hostname is required' });
            }

            // Find the module in discovered list
            const found = discoveredModules.find(m => m.hostname === hostname);
            if (!found) {
                return res.status(404).json({ error: 'Module not found in discovered list' });
            }

            // Normalize the type once — TXT records have been observed with
            // stray whitespace and varying case. We compare against this
            // value everywhere below so an advertiser that ships `Playbill `
            // doesn't fall through to the MCU "unknown type" path.
            const normalizedType = String(found.type || '').trim().toLowerCase();

            // ── Playbill branch ──────────────────────────────────────────
            // Linux endpoint: push broker creds, then persist into
            // system_config.mcu_modules the same way an MCU does so it
            // appears in the unified Module Configuration list (and gets
            // edit/rename/enable/delete via the same UI). The runtime MQTT
            // presence cache tells us *online state*; the mcu_modules entry
            // records *we onboarded this one* with whatever name the user
            // wants to call it.
            if (normalizedType === 'playbill' || NON_MCU_TYPES.has(normalizedType)) {
                let creds;
                try { creds = gatherPlaybillCreds(); }
                catch (e) { return res.status(500).json({ error: e.message }); }

                try {
                    await claimPlaybillViaProxy(hostname, creds);
                } catch (claimErr) {
                    console.error(`[Discovery] Claim failed for ${hostname}:`, claimErr.message);
                    return res.status(502).json({ error: claimErr.message });
                }

                // Persist into mcu_modules. Same shape as an MCU record
                // minus addr/canid (Playbill uses canInstance instead, and
                // identifies on MQTT by hostname/deviceId).
                const config2 = await systemConfig.findOne({ _id: 'main' });
                const modules = (config2 && config2.mcu_modules) || [];
                if (!modules.some(m => m.hostname === hostname)) {
                    const newModule = {
                        type: 'playbill',
                        name: generateModuleName('playbill', 0, modules),
                        hostname,
                        fw: found.fw,
                        enabled: true,
                        wireless: true,
                        config: {},
                    };
                    if (found.canInstance !== undefined && found.canInstance !== null) {
                        newModule.canInstance = found.canInstance;
                    }
                    modules.push(newModule);
                    await systemConfig.updateOne(
                        { _id: 'main' },
                        { $set: { mcu_modules: modules, updated_at: new Date() } }
                    );
                }

                discoveredModules = discoveredModules.filter(m => m.hostname !== hostname);
                return res.json({
                    success: true,
                    module: modules.find(m => m.hostname === hostname),
                });
            }

            // ── MCU branch (unchanged) ───────────────────────────────────
            // Validate module type. Accept the canonical id or a normalized
            // variant so a slightly-malformed TXT record still onboards.
            if (!VALID_MODULE_IDS.includes(found.type) && !VALID_MODULE_IDS.includes(normalizedType)) {
                return res.status(400).json({ error: `Unknown module type: ${found.type}` });
            }

            // Confirm via host-side proxy (Docker can't resolve .local mDNS names)
            // Backend publishes request to MQTT, host-side script calls the module,
            // publishes result back
            try {
                await confirmViaProxy(hostname);
            } catch (confirmErr) {
                console.error(`[Discovery] Confirm failed for ${hostname}:`, confirmErr.message);
                return res.status(502).json({ error: confirmErr.message });
            }

            // Read current modules
            const config = await systemConfig.findOne({ _id: 'main' });
            const modules = (config && config.mcu_modules) || [];

            // Check for duplicate hostname
            if (modules.some(m => m.hostname === hostname)) {
                return res.status(409).json({ error: 'Module with this hostname already exists' });
            }

            // Generate auto-name
            const name = generateModuleName(found.type, found.addr, modules);

            // Build module record
            const newModule = {
                type: found.type,
                name: name,
                hostname: found.hostname,
                addr: found.addr,
                canid: found.canid,
                fw: found.fw,
                enabled: true,
                config: {}
            };
            if (found.target) newModule.target = found.target;
            if (WIRELESS_MODULE_IDS.has(found.type)) newModule.wireless = true;

            // Add to mcu_modules array
            modules.push(newModule);

            // Check if we need to rename the first module of this type
            // (when a second one is added, the first should get its addr suffix too)
            const sameType = modules.filter(m => m.type === found.type);
            if (sameType.length === 2) {
                const first = sameType[0];
                const displayName = MODULE_DISPLAY_NAMES[first.type] || first.type;
                const addr = first.addr !== undefined ? first.addr : 0;
                const paddedAddr = String(addr).padStart(2, '0');
                // Only rename if it doesn't already have the addr suffix
                if (first.name === displayName) {
                    first.name = `${displayName} ${paddedAddr}`;
                }
            }

            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: { mcu_modules: modules, updated_at: new Date() } }
            );

            // Trigger channel sync for relevant module types
            try {
                let syncedAny = false;
                if (found.type === 'torrent') {
                    await syncPdmChannelsToLights(db, mqttService);
                    syncedAny = true;
                }
                if (found.type === 'switchback' || found.type === 'switchback_relay') {
                    await syncSwitchbackChannelsToLights(db, mqttService);
                    syncedAny = true;
                }
                if (syncedAny) {
                    await mqttService.refreshLightNameCache();
                }
                // A new Torrent or Switchback shifts the light ids every
                // module after it in hostname order, so every Capstan's
                // resolved control list has to be recomputed. Confirming a
                // Capstan itself also lands here, with no controls yet, which
                // publishes the empty retained payload the display expects.
                if (syncedAny || found.type === 'capstan') {
                    await syncCapstanConfig(db, mqttService);
                }
            } catch (syncErr) {
                console.error('[Discovery] Channel sync error:', syncErr.message);
            }

            // Remove from discovered list
            discoveredModules = discoveredModules.filter(m => m.hostname !== hostname);

            res.json({ success: true, module: newModule });
        } catch (error) {
            console.error('Error confirming module:', error);
            res.status(500).json({ error: 'Failed to confirm module' });
        }
    });

    // POST /api/discovery/stop — Stop the mDNS browse session
    router.post('/stop', (req, res) => {
        discoveryActive = false;
        if (discoveryTimeout) { clearTimeout(discoveryTimeout); discoveryTimeout = null; }
        mqttService.publishDiscoveryBrowseStop();
        res.json({ success: true, message: 'Discovery stopped' });
    });

    // POST /api/discovery/reset — Reset a module's configured flag via CAN 0x03
    router.post('/reset', (req, res) => {
        try {
            const { hostname } = req.body;

            if (!hostname || typeof hostname !== 'string') {
                return res.status(400).json({ error: 'hostname is required' });
            }

            const success = mqttService.publishDiscoveryReset(hostname);
            if (!success) {
                return res.status(503).json({ error: 'Failed to send discovery reset' });
            }

            res.json({ success: true, message: `Discovery reset sent to ${hostname}` });
        } catch (error) {
            console.error('Error resetting module:', error);
            res.status(500).json({ error: 'Failed to reset module' });
        }
    });

    return router;
};

/**
 * Register a module found via MQTT (called from mqtt.js handler).
 * Adds to the ephemeral discovered list if discovery is active.
 */
module.exports.addDiscoveredModule = function(moduleData) {
    if (!discoveryActive) return;

    // Reject anything that isn't a recognized MCU or a known non-MCU type.
    // Without this filter a typo or rogue device on the LAN could clutter
    // the wizard's discovered list. Normalize defensively against TXT-record
    // casing/whitespace surprises before validating.
    const rawType = moduleData.type;
    const type = String(rawType || '').trim().toLowerCase();
    if (!VALID_MODULE_IDS.includes(type) && !NON_MCU_TYPES.has(type)) return;
    // Rewrite to the canonical lowercase form so downstream comparisons are
    // straightforward — but preserve the original error-trail value too.
    moduleData = { ...moduleData, type };

    // Avoid duplicates
    if (discoveredModules.some(m => m.hostname === moduleData.hostname)) return;

    const entry = {
        hostname: moduleData.hostname,
        type:     moduleData.type,
        fw:       moduleData.fw,
        discovered_at: new Date().toISOString(),
        onboard:  moduleData.onboard || (NON_MCU_TYPES.has(type) ? 'claim' : 'confirm'),
    };
    // MCU fields — only meaningful for the confirm flow.
    if (moduleData.addr !== undefined) entry.addr = moduleData.addr;
    if (moduleData.canid)              entry.canid = moduleData.canid;
    if (moduleData.target)             entry.target = moduleData.target;
    // Linux endpoint fields — Playbill carries these so the UI can render
    // a friendly name before the user has claimed the device.
    if (moduleData.name)        entry.name = moduleData.name;
    if (moduleData.deviceId)    entry.deviceId = moduleData.deviceId;
    if (moduleData.canInstance !== undefined) entry.canInstance = moduleData.canInstance;
    discoveredModules.push(entry);
};

/**
 * Generate a display name for a module.
 * Single instance: "Picket"
 * Multiple instances or addr > 1: "Picket 03"
 */
/**
 * Send confirm request to host-side proxy via MQTT and wait for response.
 * Returns a promise that resolves on success or rejects on failure/timeout.
 */
function confirmViaProxy(hostname) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingConfirms.delete(hostname);
            reject(new Error(`Confirm timed out for ${hostname}`));
        }, 40000);

        pendingConfirms.set(hostname, { resolve, reject, timer });

        mqttService.publishDiscoveryConfirmRequest(hostname);
    });
}

/**
 * Handle confirm response from host-side proxy (called from mqtt.js).
 */
module.exports.handleConfirmResponse = function(data) {
    const pending = pendingConfirms.get(data.hostname);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingConfirms.delete(data.hostname);

    if (data.success) {
        pending.resolve();
    } else {
        pending.reject(new Error(data.error || 'Module confirm failed'));
    }
};

/**
 * Hand broker credentials to a freshly discovered Playbill via the
 * host-side mDNS proxy (Docker can't resolve .local). The proxy POSTs to
 * http://<hostname>.local/discovery/claim and publishes the HTTP result
 * onto discovery/claim/response.
 */
function claimPlaybillViaProxy(hostname, creds) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingClaims.delete(hostname);
            reject(new Error(`Claim timed out for ${hostname}`));
        }, 40000);

        pendingClaims.set(hostname, { resolve, reject, timer });

        const ok = mqttService.publishDiscoveryClaimRequest(hostname, creds);
        if (!ok) {
            clearTimeout(timer);
            pendingClaims.delete(hostname);
            reject(new Error('Unable to publish claim request — MQTT not connected'));
        }
    });
}

/**
 * Handle claim response from host-side proxy (called from mqtt.js).
 */
module.exports.handleClaimResponse = function(data) {
    const pending = pendingClaims.get(data && data.hostname);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingClaims.delete(data.hostname);

    if (data.success) {
        pending.resolve();
    } else {
        pending.reject(new Error(data.error || 'Playbill claim failed'));
    }
};

function generateModuleName(type, addr, existingModules) {
    const displayName = MODULE_DISPLAY_NAMES[type] || type;
    const sameType = existingModules.filter(m => m.type === type);
    const addrNum = addr !== undefined ? addr : 0;

    // If there are already modules of this type, or addr > 1, use numbered name
    if (sameType.length > 0 || addrNum > 1) {
        const paddedAddr = String(addrNum).padStart(2, '0');
        return `${displayName} ${paddedAddr}`;
    }

    return displayName;
}
