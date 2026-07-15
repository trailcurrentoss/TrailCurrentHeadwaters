// Settings > Cloud & API
// Cloud Configuration + API Keys — extracted verbatim from settings.js.

import { API } from '../../../api.js';

let systemConfig = null;

export const cloudGroup = {
    meta: {
        id: 'cloud',
        title: 'Cloud & API',
        icon: 'cloud-outline',
        sub: 'Remote access, API keys',
    },
    searchIndex: [
        { label: 'Cloud Configuration', kw: 'cloud remote management enable deployments mqtt', anchor: 'settings-cloud-url' },
        { label: 'API Keys',            kw: 'api key token programmatic access home assistant', anchor: 'api-keys-list' },
    ],

    render() {
        // Skeleton — real HTML fills in after init() fetches system config.
        return `<div id="settings-cloud-container"><p class="alarms-loading">Loading…</p></div>`;
    },

    async init() {
        try {
            systemConfig = await API.getSystemConfig();
        } catch (err) {
            console.error('Failed to load system config:', err);
            systemConfig = {};
        }
        const c = document.getElementById('settings-cloud-container');
        if (c) c.innerHTML = renderInner();
        wireListeners();
        loadApiKeys();
    },

    cleanup() {
        systemConfig = null;
    },
};

function renderInner() {
    return `
        <!-- Cloud Configuration -->
        <div class="card settings-item-vertical">
            <div class="settings-item-header">
                <span class="settings-label">Cloud Configuration</span>
                <p class="settings-description">Configure connection to your cloud service for remote management and deployments</p>
            </div>
            <div class="cloud-config-container">
                <div class="cloud-config-field">
                    <div class="settings-item" style="padding: 0; border: none;">
                        <div>
                            <label class="settings-label" style="font-size: 0.9rem;">Enable Cloud</label>
                        </div>
                        <button class="toggle-switch ${systemConfig?.cloud_enabled ? 'active' : ''}"
                                id="cloud-enabled-toggle"
                                aria-pressed="${systemConfig?.cloud_enabled || false}">
                        </button>
                    </div>
                </div>
                <div id="cloud-config-fields" class="${!systemConfig?.cloud_enabled ? 'hidden' : ''}">
                    <div class="cloud-config-field">
                        <label class="password-label" for="settings-cloud-url">Cloud Service URL</label>
                        <input type="url" id="settings-cloud-url" class="password-input"
                               placeholder="https://cloud.example.com"
                               value="${systemConfig?.cloud_url || ''}">
                    </div>
                    <div class="cloud-config-field">
                        <label class="password-label" for="settings-cloud-mqtt-username">MQTT Username</label>
                        <input type="text" id="settings-cloud-mqtt-username" class="password-input"
                               placeholder="MQTT username for cloud broker"
                               value="${systemConfig?.cloud_mqtt_username || ''}">
                    </div>
                    <div class="cloud-config-field">
                        <label class="password-label" for="settings-cloud-mqtt-password">MQTT Password</label>
                        <input type="password" id="settings-cloud-mqtt-password" class="password-input"
                               placeholder="MQTT password for cloud broker"
                               value="${systemConfig?.cloud_mqtt_password || ''}">
                    </div>
                    <div class="cloud-config-field">
                        <label class="password-label" for="settings-cloud-api-key">API Key</label>
                        <input type="password" id="settings-cloud-api-key" class="password-input"
                               placeholder="rv_... API key from cloud settings"
                               value="${systemConfig?.cloud_api_key || ''}">
                    </div>
                    <div class="cloud-config-field">
                        <label class="password-label" for="settings-cloud-rate-limit">Message Rate Limit (msgs/sec)</label>
                        <input type="number" id="settings-cloud-rate-limit" class="password-input"
                               min="1" max="100"
                               placeholder="30"
                               value="${systemConfig?.cloud_rate_limit || 30}">
                    </div>
                    <div id="cloud-config-message" class="password-message hidden"></div>
                    <button class="password-submit-btn" id="save-cloud-config-btn">
                        Save Cloud Settings
                    </button>
                </div>
            </div>
        </div>

        <!-- API Keys -->
        <div class="card settings-item-vertical">
            <div class="settings-item-header">
                <span class="settings-label">API Keys</span>
                <p class="settings-description">Generate API keys for programmatic access to your Overlook system</p>
            </div>
            <div class="api-keys-container">
                <div class="api-keys-actions">
                    <input type="text" id="api-key-name" class="api-key-input"
                           placeholder="Enter a name for this API key (e.g., 'Home Assistant')" maxlength="100">
                    <button class="api-key-btn" id="create-api-key-btn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <path d="M12 5v14M5 12h14"></path>
                        </svg>
                        Create API Key
                    </button>
                </div>
                <div id="api-key-message" class="api-key-message hidden"></div>
                <div id="api-keys-list" class="api-keys-list">
                    <!-- API keys will be rendered here -->
                </div>
            </div>
        </div>
    `;
}

function wireListeners() {
    // Cloud enabled toggle
    const cloudEnabledToggle = document.getElementById('cloud-enabled-toggle');
    if (cloudEnabledToggle) {
        cloudEnabledToggle.addEventListener('click', () => {
            const isEnabled = cloudEnabledToggle.classList.toggle('active');
            cloudEnabledToggle.setAttribute('aria-pressed', isEnabled);
            const cloudFields = document.getElementById('cloud-config-fields');
            if (cloudFields) {
                cloudFields.classList.toggle('hidden', !isEnabled);
            }
        });
    }

    // Save cloud config button
    const saveCloudBtn = document.getElementById('save-cloud-config-btn');
    if (saveCloudBtn) saveCloudBtn.addEventListener('click', handleSaveCloudConfig);

    // API Keys
    const createApiKeyBtn = document.getElementById('create-api-key-btn');
    const apiKeyNameInput = document.getElementById('api-key-name');
    if (createApiKeyBtn && apiKeyNameInput) {
        createApiKeyBtn.addEventListener('click', async () => {
            await handleCreateApiKey(apiKeyNameInput.value.trim());
        });
    }
}

async function handleSaveCloudConfig() {
    const messageEl = document.getElementById('cloud-config-message');
    const saveBtn = document.getElementById('save-cloud-config-btn');
    const cloudEnabledToggle = document.getElementById('cloud-enabled-toggle');

    messageEl.classList.add('hidden');
    messageEl.classList.remove('success', 'error');

    const cloudEnabled = cloudEnabledToggle.classList.contains('active');
    const cloudUrl = document.getElementById('settings-cloud-url').value.trim();
    const cloudMqttUsername = document.getElementById('settings-cloud-mqtt-username').value.trim();
    const cloudMqttPassword = document.getElementById('settings-cloud-mqtt-password').value;
    const cloudApiKey = document.getElementById('settings-cloud-api-key').value;
    const cloudRateLimit = parseInt(document.getElementById('settings-cloud-rate-limit').value) || 30;

    if (cloudEnabled && cloudUrl) {
        try {
            new URL(cloudUrl);
        } catch (e) {
            showCloudConfigMessage('Please enter a valid URL', 'error');
            return;
        }
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        systemConfig = await API.updateSystemConfig({
            cloud_enabled: cloudEnabled,
            cloud_url: cloudUrl,
            cloud_mqtt_username: cloudMqttUsername,
            cloud_mqtt_password: cloudMqttPassword,
            cloud_api_key: cloudApiKey,
            cloud_rate_limit: cloudRateLimit,
        });
        showCloudConfigMessage('Cloud settings saved successfully', 'success');
    } catch (error) {
        showCloudConfigMessage(error.message || 'Failed to save cloud settings', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Cloud Settings';
    }
}

function showCloudConfigMessage(message, type) {
    const messageEl = document.getElementById('cloud-config-message');
    if (messageEl) {
        messageEl.textContent = message;
        messageEl.classList.remove('hidden', 'success', 'error');
        messageEl.classList.add(type);
    }
}

async function loadApiKeys() {
    try {
        const data = await API.getApiKeys();
        renderApiKeys(data.keys);
    } catch (error) {
        console.error('Failed to load API keys:', error);
        showApiKeyMessage('Failed to load API keys', 'error');
    }
}

function renderApiKeys(keys) {
    const listEl = document.getElementById('api-keys-list');
    if (!listEl) return;

    if (!keys || keys.length === 0) {
        listEl.innerHTML = `
            <div class="api-key-empty">
                <p>No API keys created yet.</p>
                <p class="api-key-empty-sub">Create an API key to access your Overlook system programmatically.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = keys.map(key => `
        <div class="api-key-item">
            <div class="api-key-info">
                <div class="api-key-name">${key.name}</div>
                <div class="api-key-meta">
                    <span class="api-key-prefix">Key: ${key.key_prefix}...</span>
                    <span class="api-key-date">Created: ${new Date(key.created_at).toLocaleDateString()}</span>
                    ${key.last_used ? `<span class="api-key-date">Last used: ${new Date(key.last_used).toLocaleDateString()}` : '<span class="api-key-date">Never used</span>'}
                </div>
            </div>
            <div class="api-key-actions">
                <button class="api-key-delete-btn" data-key-id="${key.id}" title="Delete API key">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M3 6h18"></path>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');

    listEl.querySelectorAll('.api-key-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const keyId = e.target.closest('.api-key-delete-btn').dataset.keyId;
            await handleDeleteApiKey(keyId);
        });
    });
}

async function handleCreateApiKey(name) {
    const messageEl = document.getElementById('api-key-message');
    const nameInput = document.getElementById('api-key-name');
    const createBtn = document.getElementById('create-api-key-btn');

    messageEl.classList.add('hidden');
    messageEl.classList.remove('success', 'error');

    if (!name || name.trim().length === 0) {
        showApiKeyMessage('Please enter a name for the API key', 'error');
        return;
    }
    if (name.length > 100) {
        showApiKeyMessage('API key name must be less than 100 characters', 'error');
        return;
    }

    createBtn.disabled = true;
    createBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" class="spinning">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
        </svg>
        Creating...
    `;

    try {
        const result = await API.createApiKey(name);

        messageEl.innerHTML = `
            <div class="api-key-success">
                <strong>API Key Created Successfully!</strong><br>
                <span class="api-key-full">Full Key: <code>${result.full_key}</code></span><br>
                <span class="api-key-warning">Copy this key now - it will not be shown again!</span>
            </div>
        `;
        messageEl.classList.remove('hidden', 'error');
        messageEl.classList.add('success');

        nameInput.value = '';
        await loadApiKeys();

        setTimeout(() => {
            messageEl.classList.add('hidden');
        }, 10000);

    } catch (error) {
        showApiKeyMessage(error.message || 'Failed to create API key', 'error');
    } finally {
        createBtn.disabled = false;
        createBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <path d="M12 5v14M5 12h14"></path>
            </svg>
            Create API Key
        `;
    }
}

async function handleDeleteApiKey(keyId) {
    if (!confirm('Are you sure you want to delete this API key? This action cannot be undone.')) {
        return;
    }
    try {
        await API.deleteApiKey(keyId);
        showApiKeyMessage('API key deleted successfully', 'success');
        await loadApiKeys();
    } catch (error) {
        showApiKeyMessage(error.message || 'Failed to delete API key', 'error');
    }
}

function showApiKeyMessage(message, type) {
    const messageEl = document.getElementById('api-key-message');
    if (messageEl) {
        messageEl.textContent = message;
        messageEl.classList.remove('hidden', 'success', 'error');
        messageEl.classList.add(type);
    }
}
