// Settings > Voice Assistant
// Peregrine URL + CA upload, plus the local CA Certificate viewer used
// by third-party MQTT/HTTPS clients. Extracted verbatim from settings.js.

import { API } from '../../../api.js';

let peregrineConfig = null;

function escapeHtmlSettings(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export const voiceGroup = {
    meta: {
        id: 'voice',
        title: 'Voice Assistant',
        icon: 'mic-outline',
        sub: 'Peregrine, certificates',
    },
    searchIndex: [
        { label: 'Peregrine Connection', kw: 'peregrine voice assistant url lan chat board',                anchor: 'settings-peregrine-url' },
        { label: 'CA Certificate',       kw: 'certificate ca ssl trust mqtt https pem mosquitto home assistant', anchor: 'ca-cert-content' },
    ],

    render() {
        return `
            <!-- Peregrine -->
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">Peregrine</span>
                    <p class="settings-description">Connect to a Peregrine board on the LAN for on-device voice / chat assistance. The backend proxies chat requests, so the Peregrine CA only needs to be installed here — phones and browsers don't need to trust it themselves.</p>
                </div>
                <div class="cloud-config-container">
                    <div class="cloud-config-field">
                        <label class="password-label" for="settings-peregrine-url">Peregrine URL</label>
                        <input type="url" id="settings-peregrine-url" class="password-input"
                               placeholder="https://peregrine.local"
                               value="">
                    </div>
                    <div class="cloud-config-field">
                        <label class="password-label" for="settings-peregrine-ca-file">CA Certificate</label>
                        <p class="settings-description" style="margin-top: 0;">Upload the Peregrine CA (download from <code>http://peregrine.local/ca.pem</code>). Once installed, the backend container trusts the board's self-signed cert.</p>
                        <div id="peregrine-ca-status" class="peregrine-ca-status">Loading…</div>
                        <div class="peregrine-ca-actions">
                            <input type="file" id="settings-peregrine-ca-file"
                                   accept=".pem,.crt,.cer,application/x-pem-file,application/x-x509-ca-cert,text/plain"
                                   style="display: none;">
                            <button class="password-submit-btn" id="peregrine-upload-ca-btn" type="button">
                                Upload Certificate…
                            </button>
                            <button class="settings-action-btn settings-action-btn-danger"
                                    id="peregrine-remove-ca-btn" type="button" style="display: none;">
                                Remove
                            </button>
                        </div>
                    </div>
                    <div id="peregrine-config-message" class="password-message hidden"></div>
                    <button class="password-submit-btn" id="save-peregrine-config-btn">
                        Save Peregrine Settings
                    </button>
                </div>
            </div>

            <!-- CA Certificate -->
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">CA Certificate</span>
                    <p class="settings-description">Trust this CA on other MQTT/HTTPS clients (Home Assistant, mosquitto_sub, browsers) to talk to this system securely</p>
                </div>
                <div class="ca-cert-container">
                    <textarea id="ca-cert-content" class="password-input ca-cert-textarea"
                              readonly
                              placeholder="Loading certificate..."></textarea>
                    <div id="ca-cert-message" class="password-message hidden"></div>
                    <div class="ca-cert-actions">
                        <button class="password-submit-btn" id="copy-ca-cert-btn" disabled>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="vertical-align: middle; margin-right: 6px;">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                            Copy to Clipboard
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    async init() {
        try {
            peregrineConfig = await API.getPeregrineConfig().catch(err => {
                console.warn('Peregrine config load failed:', err);
                return null;
            });
        } catch (err) {
            peregrineConfig = null;
        }
        initPeregrineCard();
        wireListeners();
        loadCaCertificate();
    },

    cleanup() {
        peregrineConfig = null;
    },
};

function initPeregrineCard() {
    const urlInput = document.getElementById('settings-peregrine-url');
    if (urlInput && peregrineConfig) {
        urlInput.value = peregrineConfig.peregrine_url || 'https://peregrine.local';
    } else if (urlInput) {
        urlInput.value = 'https://peregrine.local';
    }
    renderPeregrineCaStatus();
}

function renderPeregrineCaStatus() {
    const statusEl = document.getElementById('peregrine-ca-status');
    const removeBtn = document.getElementById('peregrine-remove-ca-btn');
    if (!statusEl) return;
    const ca = peregrineConfig && peregrineConfig.ca_status;
    if (ca && ca.installed) {
        const subject = ca.subject || '(unknown subject)';
        const fp = ca.fingerprint ? ca.fingerprint.replace(/:/g, '').slice(0, 16) + '…' : '';
        const validTo = ca.valid_to ? new Date(ca.valid_to).toLocaleDateString() : '';
        statusEl.innerHTML = `
            <div class="peregrine-ca-installed">
                <span class="peregrine-ca-badge">Installed</span>
                <div class="peregrine-ca-detail"><strong>Subject:</strong> ${escapeHtmlSettings(subject)}</div>
                ${fp ? `<div class="peregrine-ca-detail"><strong>SHA-256:</strong> <code>${fp}</code></div>` : ''}
                ${validTo ? `<div class="peregrine-ca-detail"><strong>Expires:</strong> ${escapeHtmlSettings(validTo)}</div>` : ''}
            </div>
        `;
        if (removeBtn) removeBtn.style.display = '';
    } else {
        statusEl.innerHTML = `<div class="peregrine-ca-detail peregrine-ca-empty">No CA installed — Peregrine's self-signed cert won't be trusted by the backend.</div>`;
        if (removeBtn) removeBtn.style.display = 'none';
    }
}

function showPeregrineMsg(text, type) {
    const msg = document.getElementById('peregrine-config-message');
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'password-message ' + (type === 'error' ? 'error' : 'success');
    msg.classList.remove('hidden');
}

async function handleSavePeregrineConfig() {
    const urlInput = document.getElementById('settings-peregrine-url');
    const url = (urlInput?.value || '').trim();
    try {
        peregrineConfig = await API.setPeregrineConfig({ peregrine_url: url });
        showPeregrineMsg('Saved.', 'success');
        renderPeregrineCaStatus();
    } catch (err) {
        showPeregrineMsg(err.message || 'Save failed', 'error');
    }
}

async function handleUploadPeregrineCa(file) {
    try {
        const text = await file.text();
        const result = await API.installPeregrineCa(text);
        peregrineConfig = { ...(peregrineConfig || {}), ca_status: result.ca_status };
        renderPeregrineCaStatus();
        showPeregrineMsg('Certificate installed and trusted.', 'success');
    } catch (err) {
        showPeregrineMsg(err.message || 'Install failed', 'error');
    }
}

async function handleRemovePeregrineCa() {
    if (!confirm('Remove the Peregrine CA from the system trust store?')) return;
    try {
        const result = await API.removePeregrineCa();
        peregrineConfig = { ...(peregrineConfig || {}), ca_status: result.ca_status };
        renderPeregrineCaStatus();
        showPeregrineMsg('Certificate removed.', 'success');
    } catch (err) {
        showPeregrineMsg(err.message || 'Remove failed', 'error');
    }
}

function wireListeners() {
    const savePeregrineBtn = document.getElementById('save-peregrine-config-btn');
    if (savePeregrineBtn) savePeregrineBtn.addEventListener('click', handleSavePeregrineConfig);

    const peregrineUploadBtn = document.getElementById('peregrine-upload-ca-btn');
    const peregrineFileInput = document.getElementById('settings-peregrine-ca-file');
    if (peregrineUploadBtn && peregrineFileInput) {
        peregrineUploadBtn.addEventListener('click', () => peregrineFileInput.click());
        peregrineFileInput.addEventListener('change', async () => {
            const file = peregrineFileInput.files && peregrineFileInput.files[0];
            if (!file) return;
            await handleUploadPeregrineCa(file);
            peregrineFileInput.value = '';
        });
    }
    const peregrineRemoveBtn = document.getElementById('peregrine-remove-ca-btn');
    if (peregrineRemoveBtn) peregrineRemoveBtn.addEventListener('click', handleRemovePeregrineCa);

    const copyCaBtn = document.getElementById('copy-ca-cert-btn');
    if (copyCaBtn) copyCaBtn.addEventListener('click', handleCopyCaCertificate);
}

async function loadCaCertificate() {
    const textarea = document.getElementById('ca-cert-content');
    const copyBtn = document.getElementById('copy-ca-cert-btn');
    if (!textarea) return;

    try {
        const result = await API.getCaCertificate();
        textarea.value = result.certificate;
        if (copyBtn) copyBtn.disabled = false;
    } catch (error) {
        textarea.value = '';
        textarea.placeholder = 'Failed to load certificate';
        showCaCertMessage(error.message || 'Failed to load CA certificate', 'error');
    }
}

async function handleCopyCaCertificate() {
    const textarea = document.getElementById('ca-cert-content');
    const copyBtn = document.getElementById('copy-ca-cert-btn');
    if (!textarea || !textarea.value) return;

    try {
        await navigator.clipboard.writeText(textarea.value);
        showCaCertMessage('Certificate copied to clipboard', 'success');
    } catch (error) {
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy');
            showCaCertMessage('Certificate copied to clipboard', 'success');
        } catch {
            showCaCertMessage('Copy failed — select the text and copy manually', 'error');
        }
    }

    if (copyBtn) {
        const originalHTML = copyBtn.innerHTML;
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="vertical-align: middle; margin-right: 6px;">
                <path d="M20 6L9 17l-5-5"></path>
            </svg>
            Copied
        `;
        setTimeout(() => { copyBtn.innerHTML = originalHTML; }, 2000);
    }
}

function showCaCertMessage(message, type) {
    const messageEl = document.getElementById('ca-cert-message');
    if (messageEl) {
        messageEl.textContent = message;
        messageEl.classList.remove('hidden', 'success', 'error');
        messageEl.classList.add(type);
        if (type === 'success') {
            setTimeout(() => messageEl.classList.add('hidden'), 3000);
        }
    }
}
