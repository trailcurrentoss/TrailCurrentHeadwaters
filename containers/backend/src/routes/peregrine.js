// Peregrine routes
//
// The browser talks to /api/peregrine/* here instead of hitting the
// Peregrine board directly. We hold the TLS client role, so the
// Peregrine self-signed CA only needs to be trusted in *this* container
// (via the peregrine-ca service), not on every phone/laptop opening the
// PWA. Trade-off: an extra hop and we have to forward SSE manually, but
// no CORS, no per-device cert install.

const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const peregrineCa = require('../services/peregrine-ca');
const mdns = require('../services/mdns-resolver');
const { DEFAULT_URL } = require('../services/peregrine-voice');
const { syncCapstanConfig } = require('../services/capstan-config-sync');

// Devices such as Tiercel talk to Peregrine directly, using the same URL and
// CA this backend uses (see services/peregrine-voice.js). Every change here
// is pushed to them straight away. Best-effort: the setting is already
// saved, and the next module-config save, config request or restart
// republishes it anyway.
async function pushToDevices(db) {
    try {
        await syncCapstanConfig(db, require('../mqtt'));
    } catch (err) {
        console.error('[peregrine] Device config push failed:', err.message);
    }
}

function getConfigDefaults() {
    return {
        peregrine_enabled:  true,
        peregrine_url:      DEFAULT_URL,
        peregrine_ca_pem:   '',
    };
}

function publicConfig(doc) {
    const url = (doc && doc.peregrine_url) || DEFAULT_URL;
    const enabled = doc && doc.peregrine_enabled !== false;
    return {
        peregrine_enabled: enabled,
        peregrine_url:     url,
        ca_status:         peregrineCa.getStatus(),
    };
}

function isValidUrl(s) {
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
}

module.exports = (db) => {
    const router = express.Router();
    const systemConfig = db.collection('system_config');

    async function getDoc() {
        const doc = await systemConfig.findOne({ _id: 'main' });
        return doc || { _id: 'main', ...getConfigDefaults() };
    }

    // GET /api/peregrine/config
    router.get('/config', async (req, res) => {
        try {
            res.json(publicConfig(await getDoc()));
        } catch (err) {
            console.error('[peregrine] config GET error:', err);
            res.status(500).json({ error: 'Failed to load configuration' });
        }
    });

    // PUT /api/peregrine/config
    //   body: { peregrine_url?, peregrine_enabled? }
    router.put('/config', async (req, res) => {
        try {
            const updates = {};
            if (req.body.peregrine_url !== undefined) {
                const u = String(req.body.peregrine_url || '').trim();
                if (u && !isValidUrl(u)) {
                    return res.status(400).json({ error: 'peregrine_url must be a http:// or https:// URL' });
                }
                updates.peregrine_url = u || DEFAULT_URL;
            }
            if (req.body.peregrine_enabled !== undefined) {
                if (typeof req.body.peregrine_enabled !== 'boolean') {
                    return res.status(400).json({ error: 'peregrine_enabled must be a boolean' });
                }
                updates.peregrine_enabled = req.body.peregrine_enabled;
            }
            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'No valid fields to update' });
            }
            updates.updated_at = new Date();
            await systemConfig.updateOne({ _id: 'main' }, { $set: updates }, { upsert: true });
            await pushToDevices(db);
            res.json(publicConfig(await getDoc()));
        } catch (err) {
            console.error('[peregrine] config PUT error:', err);
            res.status(500).json({ error: 'Failed to save configuration' });
        }
    });

    // POST /api/peregrine/ca
    //   body: { certificate: "<PEM>" }
    // Installs the cert into the system trust store, runs
    // update-ca-certificates, and persists the PEM to MongoDB so it
    // survives container recreation.
    router.post('/ca', express.json({ limit: '256kb' }), async (req, res) => {
        try {
            const pem = req.body && req.body.certificate;
            if (!pem) {
                return res.status(400).json({ error: 'certificate (PEM) is required' });
            }
            const info = await peregrineCa.install(pem);
            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: { peregrine_ca_pem: pem.replace(/\r\n/g, '\n').trim() + '\n', updated_at: new Date() } },
                { upsert: true }
            );
            await pushToDevices(db);
            res.json({ ok: true, ca_status: { installed: true, ...info } });
        } catch (err) {
            console.error('[peregrine] CA install error:', err);
            res.status(400).json({ error: err.message || 'Failed to install certificate' });
        }
    });

    // DELETE /api/peregrine/ca
    router.delete('/ca', async (req, res) => {
        try {
            await peregrineCa.uninstall();
            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: { peregrine_ca_pem: '', updated_at: new Date() } },
                { upsert: true }
            );
            await pushToDevices(db);
            res.json({ ok: true, ca_status: peregrineCa.getStatus() });
        } catch (err) {
            console.error('[peregrine] CA uninstall error:', err);
            res.status(500).json({ error: err.message || 'Failed to remove certificate' });
        }
    });

    // POST /api/peregrine/chat — SSE streaming proxy
    //   body: { messages: [{role, content}], system?: string }
    // Mirrors Peregrine's web_chat.py /api/chat protocol (newline-
    // delimited JSON in, SSE out). We pass the request through as-is and
    // forward the upstream SSE bytes verbatim.
    router.post('/chat', async (req, res) => {
        const doc = await getDoc().catch(() => null);
        if (doc && doc.peregrine_enabled === false) {
            return res.status(503).json({ error: 'Peregrine integration is disabled' });
        }
        const target = (doc && doc.peregrine_url) || DEFAULT_URL;
        let urlObj;
        try {
            urlObj = new URL('/api/chat', target);
        } catch (err) {
            return res.status(500).json({ error: 'Invalid Peregrine URL configured: ' + target });
        }

        const isHttps = urlObj.protocol === 'https:';
        const lib = isHttps ? https : http;
        const payload = Buffer.from(JSON.stringify({
            messages: Array.isArray(req.body?.messages) ? req.body.messages : [],
            system:   req.body?.system,
            stream:   true,
        }), 'utf8');

        // SSE response headers to the browser — sent up-front so the
        // mDNS / upstream-error paths below can emit `data: ...` frames
        // (the browser parser already understands an immediate error).
        res.status(200).set({
            'Content-Type':    'text/event-stream',
            'Cache-Control':   'no-store',
            'Connection':      'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const sendError = (msg) => {
            try {
                res.write('data: ' + JSON.stringify({ error: msg }) + '\n\n');
                res.write('data: [DONE]\n\n');
            } catch {}
            try { res.end(); } catch {}
        };

        // Resolve `*.local` via the host's avahi (Docker bridge doesn't do
        // mDNS). For non-.local hostnames Node's default DNS handles it.
        // We always pass `servername: hostname` for TLS so cert hostname
        // verification matches the original name even when we dial by IP.
        const hostname = urlObj.hostname;
        let dialHost = hostname;
        if (mdns.isMdnsHost(hostname)) {
            try {
                dialHost = await mdns.resolveMdns(hostname);
            } catch (err) {
                const detail = (err.stderr || err.message || '').toString().trim();
                return sendError(`Could not resolve ${hostname} via mDNS: ${detail || err.code || 'unknown error'}`);
            }
        }

        const reqOpts = {
            method:  'POST',
            host:    dialHost,
            port:    urlObj.port || (isHttps ? 443 : 80),
            path:    urlObj.pathname + (urlObj.search || ''),
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': payload.length,
                'Accept':         'text/event-stream',
                'Host':           urlObj.host,
            },
            timeout: 130_000,
        };
        if (isHttps) {
            reqOpts.agent = peregrineCa.getAgent();
            reqOpts.servername = hostname;   // TLS SNI + cert verification name
        }

        const upstream = lib.request(reqOpts, (upstreamRes) => {
            if (upstreamRes.statusCode !== 200) {
                let body = '';
                upstreamRes.setEncoding('utf8');
                upstreamRes.on('data', chunk => { body += chunk.slice(0, 2048); });
                upstreamRes.on('end', () => {
                    sendError(`Peregrine returned HTTP ${upstreamRes.statusCode}` +
                              (body ? ': ' + body.trim() : ''));
                });
                return;
            }

            // Peregrine's web_chat.py emits newline-delimited JSON inside an
            // SSE stream. Forward bytes through directly; the browser-side
            // parser already handles both shapes.
            upstreamRes.on('data', chunk => {
                if (!res.writableEnded) res.write(chunk);
            });
            upstreamRes.on('end', () => {
                if (!res.writableEnded) res.end();
            });
            upstreamRes.on('error', err => {
                console.error('[peregrine] upstream error:', err.message);
                sendError('Upstream stream error: ' + err.message);
            });
        });

        upstream.on('error', err => {
            console.error('[peregrine] connect error:', err.code, err.message);
            const hint = err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
                         err.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
                         err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
                ? ' (upload the Peregrine CA in Settings → Peregrine)'
                : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
                ? ' (check that the configured URL resolves on the LAN)'
                : '';
            sendError(`Cannot reach Peregrine at ${target}: ${err.message}${hint}`);
        });

        upstream.on('timeout', () => {
            upstream.destroy(new Error('Upstream timeout'));
        });

        req.on('close', () => {
            // Browser disconnected mid-stream — drop the upstream too.
            try { upstream.destroy(); } catch {}
        });

        upstream.write(payload);
        upstream.end();
    });

    return router;
};

module.exports.DEFAULT_URL = DEFAULT_URL;
