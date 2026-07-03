// Settings page
import { API, wsClient } from '../api.js';

let settings = null;
let systemConfig = null;
let peregrineConfig = null;
let currentTimezone = null;

function escapeHtmlSettings(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export const settingsPage = {
    render() {
        return `
            <section class="page-settings">
                <h1 class="section-title">Settings</h1>
                <div class="settings-container" id="settings-container">
                    <!-- Settings will be rendered here -->
                </div>
            </section>
        `;
    },

    renderSettings() {
        if (!settings) return '';

        const user = API.getUser();

        return `
            <!-- System Stats -->
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">System</span>
                    <p class="settings-description">Compute module health</p>
                </div>
                <div class="system-stats-grid" id="system-stats-grid">
                    <div class="system-stat">
                        <span class="system-stat-label">CPU Temp</span>
                        <span class="system-stat-value" id="stat-cpu-temp">--</span>
                    </div>
                    <div class="system-stat">
                        <span class="system-stat-label">CPU Usage</span>
                        <span class="system-stat-value" id="stat-cpu-usage">--</span>
                    </div>
                    <div class="system-stat">
                        <span class="system-stat-label">Fan Speed</span>
                        <span class="system-stat-value" id="stat-fan-speed">--</span>
                    </div>
                </div>
            </div>

            <!-- Theme Toggle -->
            <div class="card settings-item">
                <div>
                    <span class="settings-label">Dark Mode</span>
                    <p class="settings-description">Toggle between dark and light themes</p>
                </div>
                <button class="toggle-switch ${settings.theme === 'dark' ? 'active' : ''}"
                        id="theme-toggle"
                        aria-pressed="${settings.theme === 'dark'}">
                </button>
            </div>

            <!-- Time Zone -->
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">Time Zone</span>
                    <p class="settings-description">Sets the operating system time zone. Applied via <code>timedatectl</code> on the host.</p>
                </div>
                <div class="cloud-config-container">
                    <div class="cloud-config-field">
                        <label class="password-label" for="settings-timezone-select">IANA Time Zone</label>
                        <select id="settings-timezone-select" class="password-input">
                            <option value="">Loading…</option>
                        </select>
                    </div>
                    <div id="timezone-message" class="password-message hidden"></div>
                    <button class="password-submit-btn" id="save-timezone-btn" disabled>
                        Apply Time Zone
                    </button>
                </div>
            </div>

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

            <!-- SMS Notifications -->
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">SMS Notifications</span>
                    <p class="settings-description">Send SMS notifications via your cellular router's sendsms command over SSH</p>
                </div>
                <div class="password-form">
                    <div class="settings-item" style="padding: 0; border: none;">
                        <div>
                            <label class="settings-label" style="font-size: 0.9rem;">Enable SMS</label>
                        </div>
                        <button class="toggle-switch ${systemConfig?.sms_enabled ? 'active' : ''}"
                                id="sms-enabled-toggle"
                                aria-pressed="${systemConfig?.sms_enabled || false}">
                        </button>
                    </div>
                    <div id="sms-config-fields" class="sms-config-fields ${!systemConfig?.sms_enabled ? 'hidden' : ''}">
                        <div class="password-form-group">
                            <label class="password-label" for="settings-sms-phone">Phone Number</label>
                            <input type="tel" id="settings-sms-phone" class="password-input"
                                   placeholder="+15551234567"
                                   value="${systemConfig?.sms_phone_number || ''}">
                        </div>
                        <div class="password-form-group">
                            <label class="password-label" for="settings-sms-router-ip">Router IP Address</label>
                            <input type="text" id="settings-sms-router-ip" class="password-input"
                                   placeholder="192.168.1.1"
                                   value="${systemConfig?.sms_router_ip || ''}">
                        </div>
                        <div class="password-form-group">
                            <label class="password-label" for="settings-sms-ssh-key">SSH Private Key</label>
                            <textarea id="settings-sms-ssh-key" class="password-input sms-ssh-key-textarea"
                                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                                      rows="6">${systemConfig?.sms_ssh_key || ''}</textarea>
                        </div>
                        <div class="sms-throttle-row">
                            <div class="password-form-group sms-throttle-field">
                                <label class="password-label" for="settings-sms-max-messages">Max messages</label>
                                <input type="number" id="settings-sms-max-messages" class="password-input"
                                       min="1" max="100" value="${systemConfig?.sms_max_messages || 3}">
                            </div>
                            <div class="sms-throttle-separator">per</div>
                            <div class="password-form-group sms-throttle-field">
                                <label class="password-label" for="settings-sms-throttle-window">Minutes</label>
                                <input type="number" id="settings-sms-throttle-window" class="password-input"
                                       min="1" max="1440" value="${systemConfig?.sms_throttle_window_minutes || 60}">
                            </div>
                        </div>
                        <div id="sms-config-message" class="password-message hidden"></div>
                        <div class="sms-buttons">
                            <button class="password-submit-btn" id="save-sms-config-btn">
                                Save SMS Settings
                            </button>
                            <button class="password-submit-btn sms-test-btn" id="test-sms-btn">
                                Send Test SMS
                            </button>
                        </div>
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

            <!-- Change Password -->
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">Change Password</span>
                    <p class="settings-description">Update your account password (${user?.username || 'user'})</p>
                </div>
                <form id="change-password-form" class="password-form">
                    <div class="password-form-group">
                        <label for="current-password" class="password-label">Current Password</label>
                        <input type="password" id="current-password" class="password-input"
                               placeholder="Enter current password" autocomplete="current-password" required>
                    </div>
                    <div class="password-form-group">
                        <label for="new-password" class="password-label">New Password</label>
                        <input type="password" id="new-password" class="password-input"
                               placeholder="Enter new password (min 6 chars)" autocomplete="new-password" required minlength="6">
                    </div>
                    <div class="password-form-group">
                        <label for="confirm-password" class="password-label">Confirm New Password</label>
                        <input type="password" id="confirm-password" class="password-input"
                               placeholder="Confirm new password" autocomplete="new-password" required>
                    </div>
                    <div id="password-message" class="password-message hidden"></div>
                    <button type="submit" class="password-submit-btn" id="password-submit-btn">
                        Change Password
                    </button>
                </form>
            </div>

            <!-- Refresh App -->
            <div class="card settings-item">
                <div>
                    <span class="settings-label">Refresh App</span>
                    <p class="settings-description">Clear cache and reload to get the latest version</p>
                </div>
                <button class="settings-action-btn" id="refresh-app-btn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                        <path d="M23 4v6h-6"></path>
                        <path d="M1 20v-6h6"></path>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                    Refresh
                </button>
            </div>

            <!-- Reset Configuration (Development) -->
            <div class="card settings-item">
                <div>
                    <span class="settings-label">Reset Configuration</span>
                    <p class="settings-description">Clear the setup wizard to reconfigure your system</p>
                </div>
                <button class="settings-action-btn settings-action-btn-danger" id="reset-config-btn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 5"></path>
                        <path d="M3 3v6h6"></path>
                    </svg>
                    Reset
                </button>
            </div>

            <!-- App Info -->
            <div class="card settings-item" style="flex-direction: column; align-items: flex-start; gap: 10px;">
                <span class="settings-label">About</span>
                <p class="settings-description">Overlook __GIT_SHA__</p>
                <p class="settings-description">A Progressive Web App by TrailCurrent</p>
            </div>
        `;
    },

    async init() {
        try {
            const [data, sysConfig, peregrineCfg, tzResp] = await Promise.all([
                API.getSettings(),
                API.getSystemConfig(),
                API.getPeregrineConfig().catch(err => {
                    console.warn('Peregrine config load failed:', err);
                    return null;
                }),
                API.getTimezone().catch(err => {
                    console.warn('Timezone load failed:', err);
                    return null;
                })
            ]);
            settings = data;
            systemConfig = sysConfig;
            peregrineConfig = peregrineCfg;
            currentTimezone = (tzResp && tzResp.tz) || null;

            document.getElementById('settings-container').innerHTML = this.renderSettings();
            this.setupListeners();
            this.setupSystemStats();
            this.initPeregrineCard();
            this.initTimezoneCard();
        } catch (error) {
            console.error('Failed to fetch settings:', error);
            document.getElementById('settings-container').innerHTML = '<p style="color: var(--danger);">Failed to load settings</p>';
        }
    },

    initTimezoneCard() {
        const select = document.getElementById('settings-timezone-select');
        const saveBtn = document.getElementById('save-timezone-btn');
        if (!select) return;

        // Prefer the browser's native list (IANA-canonical, up-to-date with
        // ICU tzdata) so we never render stale hardcoded names. Fall back
        // to a small curated set on very old runtimes.
        let zones = [];
        try {
            if (typeof Intl.supportedValuesOf === 'function') {
                zones = Intl.supportedValuesOf('timeZone');
            }
        } catch (_) { /* fall through */ }
        if (!zones.length) {
            zones = [
                'UTC',
                'America/Los_Angeles', 'America/Denver', 'America/Chicago',
                'America/New_York', 'America/Anchorage', 'America/Phoenix',
                'America/Halifax', 'America/Toronto',
                'Europe/London', 'Europe/Berlin', 'Europe/Paris',
                'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney',
            ];
        }
        zones = [...zones].sort();

        // If the host hasn't reported yet, fall back to whatever the browser
        // thinks the local zone is so the dropdown lands on something sane.
        const browserTz = (() => {
            try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
            catch (_) { return null; }
        })();
        const selectedTz = currentTimezone || browserTz || 'UTC';

        select.innerHTML = zones.map(z =>
            `<option value="${z}" ${z === selectedTz ? 'selected' : ''}>${z}</option>`
        ).join('');

        // Enable the save button once we've populated. Disable again if
        // the selection matches the current OS TZ — no point applying a
        // no-op.
        const refreshSaveState = () => {
            if (!saveBtn) return;
            saveBtn.disabled = (select.value === currentTimezone);
        };
        refreshSaveState();
        select.addEventListener('change', refreshSaveState);
    },

    showTimezoneMsg(text, type) {
        const msg = document.getElementById('timezone-message');
        if (!msg) return;
        msg.textContent = text;
        msg.className = 'password-message ' + (type === 'error' ? 'error' : 'success');
        msg.classList.remove('hidden');
    },

    async handleSaveTimezone() {
        const select = document.getElementById('settings-timezone-select');
        const saveBtn = document.getElementById('save-timezone-btn');
        if (!select) return;
        const tz = select.value;
        if (!tz) return;

        const originalLabel = saveBtn ? saveBtn.textContent : '';
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Applying…'; }

        try {
            const result = await API.setTimezone(tz);
            currentTimezone = (result && result.tz) || tz;
            // Re-select in case the OS normalized the name (e.g. an alias
            // like "US/Pacific" → "America/Los_Angeles").
            if ([...select.options].some(o => o.value === currentTimezone)) {
                select.value = currentTimezone;
            }
            this.showTimezoneMsg(`Time zone set to ${currentTimezone}`, 'success');
        } catch (err) {
            this.showTimezoneMsg(err.message || 'Failed to set time zone', 'error');
        } finally {
            if (saveBtn) {
                saveBtn.textContent = originalLabel || 'Apply Time Zone';
                saveBtn.disabled = (select.value === currentTimezone);
            }
        }
    },

    initPeregrineCard() {
        const urlInput = document.getElementById('settings-peregrine-url');
        if (urlInput && peregrineConfig) {
            urlInput.value = peregrineConfig.peregrine_url || 'https://peregrine.local';
        } else if (urlInput) {
            urlInput.value = 'https://peregrine.local';
        }
        this.renderPeregrineCaStatus();
    },

    renderPeregrineCaStatus() {
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
    },

    showPeregrineMsg(text, type) {
        const msg = document.getElementById('peregrine-config-message');
        if (!msg) return;
        msg.textContent = text;
        msg.className = 'password-message ' + (type === 'error' ? 'error' : 'success');
        msg.classList.remove('hidden');
    },

    async handleSavePeregrineConfig() {
        const urlInput = document.getElementById('settings-peregrine-url');
        const url = (urlInput?.value || '').trim();
        try {
            peregrineConfig = await API.setPeregrineConfig({ peregrine_url: url });
            this.showPeregrineMsg('Saved.', 'success');
            this.renderPeregrineCaStatus();
        } catch (err) {
            this.showPeregrineMsg(err.message || 'Save failed', 'error');
        }
    },

    async handleUploadPeregrineCa(file) {
        try {
            const text = await file.text();
            const result = await API.installPeregrineCa(text);
            peregrineConfig = { ...(peregrineConfig || {}), ca_status: result.ca_status };
            this.renderPeregrineCaStatus();
            this.showPeregrineMsg('Certificate installed and trusted.', 'success');
        } catch (err) {
            this.showPeregrineMsg(err.message || 'Install failed', 'error');
        }
    },

    async handleRemovePeregrineCa() {
        if (!confirm('Remove the Peregrine CA from the system trust store?')) return;
        try {
            const result = await API.removePeregrineCa();
            peregrineConfig = { ...(peregrineConfig || {}), ca_status: result.ca_status };
            this.renderPeregrineCaStatus();
            this.showPeregrineMsg('Certificate removed.', 'success');
        } catch (err) {
            this.showPeregrineMsg(err.message || 'Remove failed', 'error');
        }
    },

    setupListeners() {
        // Theme toggle
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', async () => {
                const newTheme = settings.theme === 'dark' ? 'light' : 'dark';
                try {
                    settings = await API.setSettings({ theme: newTheme });
                    themeToggle.classList.toggle('active', settings.theme === 'dark');
                    themeToggle.setAttribute('aria-pressed', settings.theme === 'dark');
                    document.documentElement.setAttribute('data-theme', settings.theme);
                } catch (error) {
                    console.error('Failed to update theme:', error);
                }
            });
        }

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

        // SMS enabled toggle
        const smsEnabledToggle = document.getElementById('sms-enabled-toggle');
        if (smsEnabledToggle) {
            smsEnabledToggle.addEventListener('click', async () => {
                const isEnabled = smsEnabledToggle.classList.toggle('active');
                smsEnabledToggle.setAttribute('aria-pressed', isEnabled);
                const smsFields = document.getElementById('sms-config-fields');
                if (smsFields) {
                    smsFields.classList.toggle('hidden', !isEnabled);
                }
                // Persist immediately when disabling — the Save button is hidden
                // with the config fields, so there's no other way to commit the change.
                if (!isEnabled) {
                    try {
                        systemConfig = await API.updateSystemConfig({ sms_enabled: false });
                        this.showSmsConfigMessage('SMS disabled', 'success');
                    } catch (error) {
                        smsEnabledToggle.classList.add('active');
                        smsEnabledToggle.setAttribute('aria-pressed', true);
                        if (smsFields) smsFields.classList.remove('hidden');
                        this.showSmsConfigMessage(error.message || 'Failed to disable SMS', 'error');
                    }
                }
            });
        }

        // Save SMS config button
        const saveSmsBtn = document.getElementById('save-sms-config-btn');
        if (saveSmsBtn) {
            saveSmsBtn.addEventListener('click', async () => {
                await this.handleSaveSmsConfig();
            });
        }

        // Test SMS button
        const testSmsBtn = document.getElementById('test-sms-btn');
        if (testSmsBtn) {
            testSmsBtn.addEventListener('click', async () => {
                await this.handleTestSms();
            });
        }

        // Save cloud config button
        const saveCloudBtn = document.getElementById('save-cloud-config-btn');
        if (saveCloudBtn) {
            saveCloudBtn.addEventListener('click', async () => {
                await this.handleSaveCloudConfig();
            });
        }

        // Time zone: apply
        const saveTzBtn = document.getElementById('save-timezone-btn');
        if (saveTzBtn) {
            saveTzBtn.addEventListener('click', async () => {
                await this.handleSaveTimezone();
            });
        }

        // Peregrine: save URL
        const savePeregrineBtn = document.getElementById('save-peregrine-config-btn');
        if (savePeregrineBtn) {
            savePeregrineBtn.addEventListener('click', async () => {
                await this.handleSavePeregrineConfig();
            });
        }

        // Peregrine: upload CA — file picker
        const peregrineUploadBtn = document.getElementById('peregrine-upload-ca-btn');
        const peregrineFileInput = document.getElementById('settings-peregrine-ca-file');
        if (peregrineUploadBtn && peregrineFileInput) {
            peregrineUploadBtn.addEventListener('click', () => peregrineFileInput.click());
            peregrineFileInput.addEventListener('change', async () => {
                const file = peregrineFileInput.files && peregrineFileInput.files[0];
                if (!file) return;
                await this.handleUploadPeregrineCa(file);
                peregrineFileInput.value = '';  // allow re-selecting the same file
            });
        }

        // Peregrine: remove CA
        const peregrineRemoveBtn = document.getElementById('peregrine-remove-ca-btn');
        if (peregrineRemoveBtn) {
            peregrineRemoveBtn.addEventListener('click', async () => {
                await this.handleRemovePeregrineCa();
            });
        }

        // Change password form
        const passwordForm = document.getElementById('change-password-form');
        if (passwordForm) {
            passwordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.handleChangePassword();
            });
        }

        // API Keys
        const createApiKeyBtn = document.getElementById('create-api-key-btn');
        const apiKeyNameInput = document.getElementById('api-key-name');
        if (createApiKeyBtn && apiKeyNameInput) {
            createApiKeyBtn.addEventListener('click', async () => {
                await this.handleCreateApiKey(apiKeyNameInput.value.trim());
            });
        }

        // Load existing API keys
        this.loadApiKeys();

        // Load CA certificate
        this.loadCaCertificate();

        // Copy CA certificate button
        const copyCaBtn = document.getElementById('copy-ca-cert-btn');
        if (copyCaBtn) {
            copyCaBtn.addEventListener('click', async () => {
                await this.handleCopyCaCertificate();
            });
        }

        // Refresh app button
        const refreshBtn = document.getElementById('refresh-app-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.disabled = true;
                refreshBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20" class="spinning">
                        <path d="M23 4v6h-6"></path>
                        <path d="M1 20v-6h6"></path>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                    Refreshing...
                `;

                try {
                    // Tell the waiting (new) SW to activate. controller is the
                    // currently-active old SW — messaging it is a no-op.
                    if ('serviceWorker' in navigator) {
                        const registrations = await navigator.serviceWorker.getRegistrations();
                        for (const reg of registrations) {
                            if (reg.waiting) {
                                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                            }
                        }
                    }

                    // Clear all caches
                    if ('caches' in window) {
                        const cacheNames = await caches.keys();
                        await Promise.all(cacheNames.map(name => caches.delete(name)));
                    }

                    // Unregister all service workers
                    if ('serviceWorker' in navigator) {
                        const registrations = await navigator.serviceWorker.getRegistrations();
                        await Promise.all(registrations.map(r => r.unregister()));
                    }

                    // Wait for unregistration to take effect, then hard reload.
                    // In iOS standalone, location.replace(same path) can be intercepted
                    // as an in-app navigation that keeps the old JS heap alive — a
                    // unique query string forces a fresh document load.
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    window.location.href = `${window.location.pathname}?_=${Date.now()}`;
                } catch (error) {
                    console.error('Failed to refresh app:', error);
                    refreshBtn.disabled = false;
                    refreshBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                            <path d="M23 4v6h-6"></path>
                            <path d="M1 20v-6h6"></path>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                        </svg>
                        Refresh
                    `;
                }
            });
        }

        // Reset configuration button
        const resetConfigBtn = document.getElementById('reset-config-btn');
        if (resetConfigBtn) {
            resetConfigBtn.addEventListener('click', async () => {
                if (!confirm('Are you sure you want to reset the configuration? The setup wizard will appear again on next load.')) {
                    return;
                }

                resetConfigBtn.disabled = true;
                const originalHTML = resetConfigBtn.innerHTML;
                resetConfigBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20" class="spinning">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 5"></path>
                        <path d="M3 3v6h6"></path>
                    </svg>
                    Resetting...
                `;

                try {
                    await API.resetConfiguration();
                    // Show success and reload
                    alert('Configuration reset successfully. The page will reload.');
                    window.location.reload();
                } catch (error) {
                    console.error('Failed to reset configuration:', error);
                    alert('Failed to reset configuration: ' + (error.message || 'Unknown error'));
                    resetConfigBtn.disabled = false;
                    resetConfigBtn.innerHTML = originalHTML;
                }
            });
        }

        // Deployment button
        const deploymentBtn = document.getElementById('deployment-btn');
        if (deploymentBtn) {
            deploymentBtn.addEventListener('click', () => {
                // Import router dynamically to avoid circular dependencies
                import('../router.js').then(({ router }) => {
                    router.navigate('deployment');
                });
            });
        }
    },

    async handleChangePassword() {
        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;
        const messageEl = document.getElementById('password-message');
        const submitBtn = document.getElementById('password-submit-btn');

        // Reset message
        messageEl.classList.add('hidden');
        messageEl.classList.remove('success', 'error');

        // Validate
        if (newPassword !== confirmPassword) {
            this.showPasswordMessage('New passwords do not match', 'error');
            return;
        }

        if (newPassword.length < 6) {
            this.showPasswordMessage('New password must be at least 6 characters', 'error');
            return;
        }

        // Disable button during request
        submitBtn.disabled = true;
        submitBtn.textContent = 'Changing...';

        try {
            await API.changePassword(currentPassword, newPassword);
            this.showPasswordMessage('Password changed successfully', 'success');

            // Clear form
            document.getElementById('current-password').value = '';
            document.getElementById('new-password').value = '';
            document.getElementById('confirm-password').value = '';
        } catch (error) {
            this.showPasswordMessage(error.message || 'Failed to change password', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Change Password';
        }
    },

    showPasswordMessage(message, type) {
        const messageEl = document.getElementById('password-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.classList.remove('hidden', 'success', 'error');
            messageEl.classList.add(type);
        }
    },

    async handleSaveCloudConfig() {
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

        // Validate URL if cloud is enabled
        if (cloudEnabled && cloudUrl) {
            try {
                new URL(cloudUrl);
            } catch (e) {
                this.showCloudConfigMessage('Please enter a valid URL', 'error');
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
                cloud_rate_limit: cloudRateLimit
            });
            this.showCloudConfigMessage('Cloud settings saved successfully', 'success');
        } catch (error) {
            this.showCloudConfigMessage(error.message || 'Failed to save cloud settings', 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Cloud Settings';
        }
    },

    showCloudConfigMessage(message, type) {
        const messageEl = document.getElementById('cloud-config-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.classList.remove('hidden', 'success', 'error');
            messageEl.classList.add(type);
        }
    },

    async handleSaveSmsConfig() {
        const messageEl = document.getElementById('sms-config-message');
        const saveBtn = document.getElementById('save-sms-config-btn');
        const smsEnabledToggle = document.getElementById('sms-enabled-toggle');

        messageEl.classList.add('hidden');
        messageEl.classList.remove('success', 'error');

        const smsEnabled = smsEnabledToggle.classList.contains('active');
        const smsPhoneNumber = document.getElementById('settings-sms-phone').value.trim();
        const smsRouterIp = document.getElementById('settings-sms-router-ip').value.trim();
        const smsSshKey = document.getElementById('settings-sms-ssh-key').value;
        const smsMaxMessages = parseInt(document.getElementById('settings-sms-max-messages').value) || 3;
        const smsThrottleWindow = parseInt(document.getElementById('settings-sms-throttle-window').value) || 60;

        if (smsEnabled && !smsPhoneNumber) {
            this.showSmsConfigMessage('Please enter a phone number', 'error');
            return;
        }

        if (smsEnabled && !smsRouterIp) {
            this.showSmsConfigMessage('Please enter the router IP address', 'error');
            return;
        }

        if (smsEnabled && !smsSshKey) {
            this.showSmsConfigMessage('Please paste the SSH private key', 'error');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
            systemConfig = await API.updateSystemConfig({
                sms_enabled: smsEnabled,
                sms_phone_number: smsPhoneNumber,
                sms_router_ip: smsRouterIp,
                sms_ssh_key: smsSshKey,
                sms_max_messages: smsMaxMessages,
                sms_throttle_window_minutes: smsThrottleWindow
            });
            this.showSmsConfigMessage('SMS settings saved successfully', 'success');
        } catch (error) {
            this.showSmsConfigMessage(error.message || 'Failed to save SMS settings', 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save SMS Settings';
        }
    },

    async handleTestSms() {
        const messageEl = document.getElementById('sms-config-message');
        const testBtn = document.getElementById('test-sms-btn');

        messageEl.classList.add('hidden');
        messageEl.classList.remove('success', 'error');

        const phoneNumber = document.getElementById('settings-sms-phone').value.trim();
        const routerIp = document.getElementById('settings-sms-router-ip').value.trim();
        const sshKey = document.getElementById('settings-sms-ssh-key').value;

        if (!phoneNumber || !routerIp || !sshKey) {
            this.showSmsConfigMessage('Please fill in all SMS fields before testing', 'error');
            return;
        }

        testBtn.disabled = true;
        testBtn.textContent = 'Sending...';

        try {
            const result = await API.testSms(phoneNumber, routerIp, sshKey);
            this.showSmsConfigMessage(result.output || 'Test SMS sent successfully', 'success');
        } catch (error) {
            this.showSmsConfigMessage(error.message || 'Failed to send test SMS', 'error');
        } finally {
            testBtn.disabled = false;
            testBtn.textContent = 'Send Test SMS';
        }
    },

    showSmsConfigMessage(message, type) {
        const messageEl = document.getElementById('sms-config-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.classList.remove('hidden', 'success', 'error');
            messageEl.classList.add(type);
        }
    },

    async loadApiKeys() {
        try {
            const data = await API.getApiKeys();
            this.renderApiKeys(data.keys);
        } catch (error) {
            console.error('Failed to load API keys:', error);
            this.showApiKeyMessage('Failed to load API keys', 'error');
        }
    },

    renderApiKeys(keys) {
        const listEl = document.getElementById('api-keys-list');
        const messageEl = document.getElementById('api-key-message');

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

        // Add delete event listeners
        listEl.querySelectorAll('.api-key-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const keyId = e.target.closest('.api-key-delete-btn').dataset.keyId;
                await this.handleDeleteApiKey(keyId);
            });
        });
    },

    async handleCreateApiKey(name) {
        const messageEl = document.getElementById('api-key-message');
        const nameInput = document.getElementById('api-key-name');
        const createBtn = document.getElementById('create-api-key-btn');

        // Reset message
        messageEl.classList.add('hidden');
        messageEl.classList.remove('success', 'error');

        // Validate
        if (!name || name.trim().length === 0) {
            this.showApiKeyMessage('Please enter a name for the API key', 'error');
            return;
        }

        if (name.length > 100) {
            this.showApiKeyMessage('API key name must be less than 100 characters', 'error');
            return;
        }

        // Disable button during request
        createBtn.disabled = true;
        createBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" class="spinning">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
            </svg>
            Creating...
        `;

        try {
            const result = await API.createApiKey(name);
            
            // Show success message with the full key
            messageEl.innerHTML = `
                <div class="api-key-success">
                    <strong>API Key Created Successfully!</strong><br>
                    <span class="api-key-full">Full Key: <code>${result.full_key}</code></span><br>
                    <span class="api-key-warning">Copy this key now - it will not be shown again!</span>
                </div>
            `;
            messageEl.classList.remove('hidden', 'error');
            messageEl.classList.add('success');

            // Clear input
            nameInput.value = '';

            // Reload the list
            await this.loadApiKeys();

            // Auto-hide success message after 10 seconds
            setTimeout(() => {
                messageEl.classList.add('hidden');
            }, 10000);

        } catch (error) {
            this.showApiKeyMessage(error.message || 'Failed to create API key', 'error');
        } finally {
            createBtn.disabled = false;
            createBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                    <path d="M12 5v14M5 12h14"></path>
                </svg>
                Create API Key
            `;
        }
    },

    async handleDeleteApiKey(keyId) {
        if (!confirm('Are you sure you want to delete this API key? This action cannot be undone.')) {
            return;
        }

        try {
            await API.deleteApiKey(keyId);
            this.showApiKeyMessage('API key deleted successfully', 'success');
            await this.loadApiKeys();
        } catch (error) {
            this.showApiKeyMessage(error.message || 'Failed to delete API key', 'error');
        }
    },

    showApiKeyMessage(message, type) {
        const messageEl = document.getElementById('api-key-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.classList.remove('hidden', 'success', 'error');
            messageEl.classList.add(type);
        }
    },

    async loadCaCertificate() {
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
            this.showCaCertMessage(error.message || 'Failed to load CA certificate', 'error');
        }
    },

    async handleCopyCaCertificate() {
        const textarea = document.getElementById('ca-cert-content');
        const copyBtn = document.getElementById('copy-ca-cert-btn');
        if (!textarea || !textarea.value) return;

        try {
            await navigator.clipboard.writeText(textarea.value);
            this.showCaCertMessage('Certificate copied to clipboard', 'success');
        } catch (error) {
            // Fallback: select the text so the user can copy manually
            textarea.focus();
            textarea.select();
            try {
                document.execCommand('copy');
                this.showCaCertMessage('Certificate copied to clipboard', 'success');
            } catch {
                this.showCaCertMessage('Copy failed — select the text and copy manually', 'error');
            }
        }

        // Brief visual feedback on the button
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
    },

    showCaCertMessage(message, type) {
        const messageEl = document.getElementById('ca-cert-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.classList.remove('hidden', 'success', 'error');
            messageEl.classList.add(type);
            if (type === 'success') {
                setTimeout(() => messageEl.classList.add('hidden'), 3000);
            }
        }
    },

    updateSystemStatsDisplay(stats) {
        const tempEl = document.getElementById('stat-cpu-temp');
        const cpuEl = document.getElementById('stat-cpu-usage');
        const fanEl = document.getElementById('stat-fan-speed');
        if (tempEl) tempEl.textContent = stats.cpu_temp_c !== null ? `${stats.cpu_temp_c.toFixed(1)}\u00B0C` : 'N/A';
        if (cpuEl) cpuEl.textContent = stats.cpu_percent !== null ? `${stats.cpu_percent}%` : 'N/A';
        if (fanEl) fanEl.textContent = stats.fan_percent !== null ? `${stats.fan_percent}%` : 'N/A';
    },

    async setupSystemStats() {
        // Fetch initial snapshot via REST
        try {
            const stats = await API.getSystemStats();
            this.updateSystemStatsDisplay(stats);
        } catch {
            // Non-critical — WebSocket will provide updates
        }

        // Listen for live updates via WebSocket
        this._statsWsHandler = (stats) => this.updateSystemStatsDisplay(stats);
        wsClient.on('system_stats', this._statsWsHandler);
    },

    cleanup() {
        settings = null;
        systemConfig = null;
        peregrineConfig = null;
        currentTimezone = null;
        if (this._statsWsHandler) {
            wsClient.off('system_stats', this._statsWsHandler);
            this._statsWsHandler = null;
        }
    }
};
