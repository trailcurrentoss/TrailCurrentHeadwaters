// Settings page
import { API } from '../api.js';

let settings = null;
let systemConfig = null;

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

            <!-- Cloud Configuration -->
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">Cloud Configuration</span>
                    <p class="settings-description">Configure connection to your TrailCurrent cloud service for remote management and deployments</p>
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
                    <p class="settings-description">Generate API keys for programmatic access to your TrailCurrent system</p>
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
                <p class="settings-description">TrailCurrent System __GIT_SHA__</p>
                <p class="settings-description">A Progressive Web App for TrailCurrent</p>
            </div>
        `;
    },

    async init() {
        try {
            const [data, sysConfig] = await Promise.all([
                API.getSettings(),
                API.getSystemConfig()
            ]);
            settings = data;
            systemConfig = sysConfig;

            document.getElementById('settings-container').innerHTML = this.renderSettings();
            this.setupListeners();
        } catch (error) {
            console.error('Failed to fetch settings:', error);
            document.getElementById('settings-container').innerHTML = '<p style="color: var(--danger);">Failed to load settings</p>';
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

        // Save cloud config button
        const saveCloudBtn = document.getElementById('save-cloud-config-btn');
        if (saveCloudBtn) {
            saveCloudBtn.addEventListener('click', async () => {
                await this.handleSaveCloudConfig();
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
                    // Clear caches first
                    if ('caches' in window) {
                        const cacheNames = await caches.keys();
                        for (const cacheName of cacheNames) {
                            await caches.delete(cacheName);
                        }
                    }

                    // Unregister service workers and wait for new registration
                    if ('serviceWorker' in navigator) {
                        const registrations = await navigator.serviceWorker.getRegistrations();
                        for (const registration of registrations) {
                            await registration.unregister();
                        }
                    }

                    // Add a small delay to ensure unregistration is complete
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // Force reload with cache-busting query parameter
                    // Use location.href with timestamp to force fresh fetch from server
                    window.location.href = window.location.pathname + '?' + new Date().getTime();
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
                cloud_api_key: cloudApiKey
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
                    <p class="api-key-empty-sub">Create an API key to access your TrailCurrent system programmatically.</p>
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

    cleanup() {
        settings = null;
        systemConfig = null;
    }
};
