// Module Configuration page
import { API } from '../api.js';
import { ICON_LIST } from '../components/pdm-icons.js';

let systemConfig = null;
let modules = [];
let moduleTypes = [];
let editingModule = null;
let isToggleInProgress = false;
let configContainerClickListener = null;

export const configPage = {
    render() {
        return `
            <section class="page-config">
                <h1 class="section-title">Configuration</h1>

                <!-- OTA Testing Section -->
                <div class="card ota-testing-card">
                    <div class="ota-testing-section">
                        <h2 class="subsection-title">OTA Testing</h2>
                        <p class="ota-testing-description">Trigger OTA firmware update for a device</p>

                        <div class="ota-form-group">
                            <label for="ota-hostname" class="form-label">Device Hostname</label>
                            <input type="text" id="ota-hostname" class="form-input"
                                   placeholder="e.g., esp32-8A3B4C"
                                   pattern="^esp32-[0-9A-Fa-f]{6}$"
                                   title="Format: esp32-XXYYZZ (where XX, YY, ZZ are hex digits)">
                            <p class="form-hint">Enter device hostname in format: esp32-XXYYZZ</p>
                        </div>

                        <div class="ota-mac-display hidden" id="ota-mac-display">
                            <p class="ota-mac-label">MAC Address Bytes:</p>
                            <p class="ota-mac-bytes" id="ota-mac-bytes"></p>
                        </div>

                        <div class="ota-form-actions">
                            <button class="ota-trigger-btn" id="ota-trigger-btn" disabled>
                                Trigger OTA
                            </button>
                        </div>

                        <div id="ota-message" class="ota-message hidden"></div>
                    </div>
                </div>

                <!-- Wireless Configuration Section -->
                <div class="card wireless-config-card">
                    <div class="wireless-config-section">
                        <h2 class="subsection-title">Wireless Configuration</h2>
                        <p class="wireless-config-description">Configure WiFi access point for MCU OTA updates</p>

                        <div class="wireless-form-group">
                            <label for="wifi-ssid" class="form-label">WiFi SSID (Network Name)</label>
                            <input type="text" id="wifi-ssid" class="form-input"
                                   placeholder="e.g., TrailCurrent-OTA">
                            <p class="form-hint">Name of the WiFi network MCUs will connect to</p>
                        </div>

                        <div class="wireless-form-group">
                            <label for="wifi-password" class="form-label">WiFi Password</label>
                            <input type="password" id="wifi-password" class="form-input"
                                   placeholder="Enter WiFi password">
                            <p class="form-hint">Password for the WiFi network (stored encrypted)</p>
                        </div>

                        <div class="wireless-form-actions">
                            <button class="wireless-save-btn" id="wireless-save-btn">
                                Save WiFi Configuration
                            </button>
                        </div>

                        <div id="wireless-message" class="wireless-message hidden"></div>
                    </div>
                </div>

                <!-- Module Configuration Section -->
                <h2 class="subsection-title" style="margin-top: 2rem;">Module Configuration</h2>
                <div class="config-container" id="config-container">
                    <!-- Configuration will be rendered here -->
                </div>
            </section>

            <!-- Add/Edit Module Modal -->
            <div class="modal" id="module-modal" style="display: none;">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2 id="modal-title">Add Module</h2>
                        <button class="modal-close" id="modal-close-btn">×</button>
                    </div>
                    <form id="module-form" class="module-form">
                        <div class="form-group">
                            <label for="module-type" class="form-label">Module Type</label>
                            <select id="module-type" class="form-input" required>
                                <option value="">Select a type...</option>
                            </select>
                            <div id="type-error" class="form-error hidden"></div>
                        </div>

                        <div class="form-group">
                            <label for="module-name" class="form-label">Friendly Name</label>
                            <input type="text" id="module-name" class="form-input"
                                   placeholder="e.g., Cabin Air Quality" required>
                            <p class="form-hint">A descriptive name for this module instance</p>
                            <div id="name-error" class="form-error hidden"></div>
                        </div>

                        <div class="form-group">
                            <label for="module-hostname" class="form-label">Hostname</label>
                            <input type="text" id="module-hostname" class="form-input"
                                   placeholder="e.g., airquality-01" required>
                            <p class="form-hint">Device hostname containing chipid for CAN bus identification</p>
                            <div id="hostname-error" class="form-error hidden"></div>
                        </div>

                        <div class="form-group" id="json-config-group">
                            <label for="module-config" class="form-label">Configuration (JSON)</label>
                            <textarea id="module-config" class="form-input form-textarea"
                                      placeholder='{"key": "value"}'></textarea>
                            <p class="form-hint">Optional: Enter configuration as JSON</p>
                            <div id="config-error" class="form-error hidden"></div>
                        </div>

                        <div class="pdm-channels-config" id="pdm-channels-config" style="display: none;">
                            <label class="form-label">Channel Configuration</label>
                            <p class="form-hint" style="margin-bottom: 12px;">Configure each PDM output channel</p>
                            <div class="pdm-channel-list" id="pdm-channel-list">
                                <!-- Channel rows rendered dynamically -->
                            </div>
                        </div>

                        <div class="leveler-config" id="leveler-config" style="display: none;">
                            <label class="form-label">Leveling Configuration</label>
                            <p class="form-hint" style="margin-bottom: 12px;">Configure the IMU leveling sensor. Settings are sent to the module via CAN bus.</p>

                            <div class="leveler-field-group">
                                <label for="leveler-mounting" class="form-label">Mounting Surface</label>
                                <select id="leveler-mounting" class="form-input">
                                    <option value="0">Floor</option>
                                    <option value="1">Left Wall</option>
                                    <option value="2">Right Wall</option>
                                </select>
                                <p class="form-hint">Orientation of the IMU sensor in the vehicle</p>
                            </div>

                            <div class="leveler-field-group">
                                <label for="leveler-vehicle-length" class="form-label">Vehicle Length (cm)</label>
                                <input type="number" id="leveler-vehicle-length" class="form-input"
                                       placeholder="e.g., 500" min="1" max="65535" value="500">
                                <p class="form-hint">Total length of the vehicle in centimeters</p>
                            </div>

                            <div class="leveler-field-group">
                                <label for="leveler-vehicle-width" class="form-label">Vehicle Width (cm)</label>
                                <input type="number" id="leveler-vehicle-width" class="form-input"
                                       placeholder="e.g., 200" min="1" max="65535" value="200">
                                <p class="form-hint">Total width of the vehicle in centimeters</p>
                            </div>
                        </div>

                        <div id="form-message" class="form-message hidden"></div>

                        <div class="modal-actions">
                            <button type="button" class="modal-btn modal-btn-secondary" id="modal-cancel-btn">
                                Cancel
                            </button>
                            <button type="submit" class="modal-btn modal-btn-primary" id="modal-submit-btn">
                                Add Module
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            <!-- Modal backdrop -->
            <div class="modal-backdrop" id="modal-backdrop" style="display: none;"></div>
        `;
    },

    renderModuleList(allModules) {
        if (!allModules || allModules.length === 0) {
            return `
                <div class="empty-state">
                    <p>No modules configured yet</p>
                    <p class="empty-state-hint">Click "Add Module" to create your first module</p>
                </div>
            `;
        }

        return `
            <div class="modules-list">
                ${allModules.map((module, idx) => `
                    <div class="card module-card">
                        <div class="module-info">
                            <div class="module-header">
                                <h3 class="module-name">${escapeHtml(module.name)}</h3>
                                <span class="module-type-badge">${escapeHtml(module.type)}</span>
                            </div>
                            <p class="module-description">
                                ${module.hostname ? `<span class="module-hostname">Hostname: ${escapeHtml(module.hostname)}</span> • ` : ''}${module.enabled ? '✓ Enabled' : '○ Disabled'}
                            </p>
                        </div>
                        <div class="module-actions">
                            <button class="toggle-switch ${module.enabled ? 'active' : ''}"
                                    data-module-index="${idx}"
                                    data-action="toggle"
                                    title="${module.enabled ? 'Disable' : 'Enable'} module"
                                    aria-pressed="${module.enabled}">
                            </button>
                            <button class="module-action-btn module-edit-btn"
                                    data-module-index="${idx}"
                                    data-action="edit"
                                    title="Edit module">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                </svg>
                            </button>
                            <button class="module-action-btn module-delete-btn"
                                    data-module-index="${idx}"
                                    data-action="delete"
                                    title="Delete module">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                                    <path d="M3 6h18"></path>
                                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    },

    async init() {
        try {
            // Load system config (which contains mcu_modules) and module types
            const [configData, typesData] = await Promise.all([
                API.getSystemConfig(),
                API.getModuleTypes()
            ]);

            systemConfig = configData;
            modules = systemConfig.mcu_modules || [];
            moduleTypes = typesData;

            // Render module list
            const configEl = document.getElementById('config-container');
            configEl.innerHTML = `
                <div class="config-actions">
                    <button class="add-module-btn" id="add-module-btn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <path d="M12 5v14M5 12h14"></path>
                        </svg>
                        Add Module
                    </button>
                </div>
                ${this.renderModuleList(modules)}
            `;

            // Setup listeners
            this.setupListeners();
            this.setupOtaListeners();
            this.setupWirelessListeners();
            this.loadWirelessConfig();
        } catch (error) {
            console.error('Failed to load configuration:', error);
            const configEl = document.getElementById('config-container');
            if (configEl) {
                configEl.innerHTML = '<p style="color: var(--danger);">Failed to load configuration. Please try refreshing the page.</p>';
            }
        }
    },

    setupOtaListeners() {
        const hostnameInput = document.getElementById('ota-hostname');
        const triggerBtn = document.getElementById('ota-trigger-btn');

        if (hostnameInput) {
            hostnameInput.addEventListener('input', (e) => {
                this.handleHostnameInput(e);
            });
        }

        if (triggerBtn) {
            triggerBtn.addEventListener('click', () => {
                this.handleOtaTrigger();
            });
        }
    },

    loadWirelessConfig() {
        try {
            const wifiSsidInput = document.getElementById('wifi-ssid');
            const wifiPasswordInput = document.getElementById('wifi-password');

            if (systemConfig.wifi_ssid && wifiSsidInput) {
                wifiSsidInput.value = systemConfig.wifi_ssid;
            }

            if (systemConfig.wifi_password && wifiPasswordInput) {
                wifiPasswordInput.value = systemConfig.wifi_password;
            }
        } catch (error) {
            console.error('Failed to load wireless config:', error);
        }
    },

    setupWirelessListeners() {
        const saveBtn = document.getElementById('wireless-save-btn');

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.handleWirelessSave();
            });
        }
    },

    async handleWirelessSave() {
        const wifiSsidInput = document.getElementById('wifi-ssid');
        const wifiPasswordInput = document.getElementById('wifi-password');
        const saveBtn = document.getElementById('wireless-save-btn');

        if (!wifiSsidInput || !wifiPasswordInput) {
            return;
        }

        const wifiSsid = wifiSsidInput.value.trim();
        const wifiPassword = wifiPasswordInput.value;

        // Validation
        if (!wifiSsid) {
            this.showWirelessMessage('WiFi SSID is required', 'error');
            return;
        }

        saveBtn.disabled = true;
        this.clearWirelessMessage();

        try {
            // Update system config
            await API.updateSystemConfig({
                wizard_completed: systemConfig.wizard_completed,
                cloud_enabled: systemConfig.cloud_enabled,
                cloud_url: systemConfig.cloud_url,
                mcu_modules: systemConfig.mcu_modules || [],
                wifi_ssid: wifiSsid,
                wifi_password: wifiPassword
            });

            // Update local config
            systemConfig.wifi_ssid = wifiSsid;
            systemConfig.wifi_password = wifiPassword;

            this.showWirelessMessage('WiFi configuration saved successfully', 'success');
        } catch (error) {
            this.showWirelessMessage(error.message || 'Failed to save WiFi configuration', 'error');
        } finally {
            saveBtn.disabled = false;
        }
    },

    showWirelessMessage(message, type) {
        const messageEl = document.getElementById('wireless-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.className = `wireless-message ${type}`;
            messageEl.classList.remove('hidden');

            // Auto-hide success messages after 4 seconds
            if (type === 'success') {
                setTimeout(() => {
                    messageEl.classList.add('hidden');
                }, 4000);
            }
        }
    },

    clearWirelessMessage() {
        const messageEl = document.getElementById('wireless-message');
        if (messageEl) {
            messageEl.classList.add('hidden');
        }
    },

    handleHostnameInput(e) {
        const input = e.target.value.trim();
        const triggerBtn = document.getElementById('ota-trigger-btn');
        const macDisplay = document.getElementById('ota-mac-display');
        const macBytes = document.getElementById('ota-mac-bytes');

        // Clear message on new input
        this.clearOtaMessage();

        // Validate hostname format: esp32-XXXXXX where X are hex digits
        const hostnameRegex = /^esp32-([0-9A-Fa-f]{6})$/;
        const match = input.match(hostnameRegex);

        if (match) {
            // Valid hostname format
            triggerBtn.disabled = false;

            // Extract and display MAC bytes
            const macHex = match[1];
            const bytes = [];
            for (let i = 0; i < 6; i += 2) {
                const hexByte = macHex.substring(i, i + 2);
                bytes.push('0x' + hexByte.toUpperCase());
            }
            macBytes.textContent = bytes.join(' • ');
            macDisplay.classList.remove('hidden');
        } else if (input.length > 0) {
            // Invalid format
            triggerBtn.disabled = true;
            macDisplay.classList.add('hidden');
        } else {
            // Empty input
            triggerBtn.disabled = true;
            macDisplay.classList.add('hidden');
        }
    },

    async handleOtaTrigger() {
        const input = document.getElementById('ota-hostname');
        const triggerBtn = document.getElementById('ota-trigger-btn');
        const hostname = input.value.trim();

        triggerBtn.disabled = true;
        this.clearOtaMessage();

        try {
            const response = await API.triggerOta(hostname);
            this.showOtaMessage(`OTA trigger sent to ${hostname}`, 'success');
            input.value = '';
            document.getElementById('ota-mac-display').classList.add('hidden');
        } catch (error) {
            const errorMessage = error.message || 'Failed to send OTA trigger';
            this.showOtaMessage(errorMessage, 'error');
        } finally {
            triggerBtn.disabled = true;
        }
    },

    showOtaMessage(message, type) {
        const messageEl = document.getElementById('ota-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.className = `ota-message ${type}`;
            messageEl.classList.remove('hidden');

            // Auto-hide success messages after 4 seconds
            if (type === 'success') {
                setTimeout(() => {
                    messageEl.classList.add('hidden');
                }, 4000);
            }
        }
    },

    clearOtaMessage() {
        const messageEl = document.getElementById('ota-message');
        if (messageEl) {
            messageEl.classList.add('hidden');
        }
    },

    setupListeners() {
        // Add module button
        const addBtn = document.getElementById('add-module-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => this.showAddModuleModal());
        }

        // Module card actions - remove old listener before adding new one
        const configEl = document.getElementById('config-container');
        if (configEl) {
            // Remove old listener if it exists
            if (configContainerClickListener) {
                configEl.removeEventListener('click', configContainerClickListener);
            }

            // Create and store new listener
            configContainerClickListener = (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn) return;

                const moduleIndex = parseInt(btn.dataset.moduleIndex);
                const action = btn.dataset.action;

                if (action === 'toggle') {
                    if (isToggleInProgress) return;
                    const module = modules[moduleIndex];
                    if (module) {
                        this.handleToggleModule(module, !module.enabled);
                    }
                } else if (action === 'edit') {
                    const module = modules[moduleIndex];
                    if (module) {
                        this.showEditModuleModal(module);
                    }
                } else if (action === 'delete') {
                    this.handleDeleteModule(moduleIndex);
                }
            };

            configEl.addEventListener('click', configContainerClickListener);
        }

        // Module type change — toggle between JSON config and PDM channels UI
        const typeSelect = document.getElementById('module-type');
        if (typeSelect) {
            typeSelect.addEventListener('change', () => this.togglePdmChannelsUI(typeSelect.value));
        }

        // Modal form
        const form = document.getElementById('module-form');
        if (form) {
            form.addEventListener('submit', (e) => this.handleFormSubmit(e));
        }

        // Modal close buttons
        const closeBtn = document.getElementById('modal-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeModal());
        }

        const cancelBtn = document.getElementById('modal-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.closeModal());
        }

        // Modal backdrop click
        const backdrop = document.getElementById('modal-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', () => this.closeModal());
        }
    },

    showAddModuleModal() {
        editingModule = null;
        const modal = document.getElementById('module-modal');
        const backdrop = document.getElementById('modal-backdrop');
        const title = document.getElementById('modal-title');
        const submitBtn = document.getElementById('modal-submit-btn');

        title.textContent = 'Add Module';
        submitBtn.textContent = 'Add Module';

        // Reset form
        this.resetForm();

        // Populate module types
        this.populateModuleTypes();

        // Reset PDM channels UI
        this.togglePdmChannelsUI('');

        // Show modal
        modal.style.display = 'flex';
        backdrop.style.display = 'block';
    },

    showEditModuleModal(module) {
        editingModule = module;
        const modal = document.getElementById('module-modal');
        const backdrop = document.getElementById('modal-backdrop');
        const title = document.getElementById('modal-title');
        const submitBtn = document.getElementById('modal-submit-btn');

        title.textContent = 'Edit Module';
        submitBtn.textContent = 'Update Module';

        // Populate module types first so the select has the right options
        this.populateModuleTypes();

        // Populate form with module data
        document.getElementById('module-type').value = module.type;
        document.getElementById('module-type').disabled = true; // Can't change type
        document.getElementById('module-name').value = module.name;
        document.getElementById('module-hostname').value = module.hostname || '';

        // Handle channel-based config (PDM / Switchback), leveler, or generic JSON
        if (module.type === 'power_distribution_module') {
            const channels = module.config?.channels || this.getDefaultChannels();
            this.togglePdmChannelsUI('power_distribution_module');
            this.renderChannelRows(channels, 'power_distribution_module');
        } else if (module.type === 'switchback_relay') {
            const channels = module.config?.channels || this.getSwitchbackDefaultChannels();
            this.togglePdmChannelsUI('switchback_relay');
            this.renderChannelRows(channels, 'switchback_relay');
        } else if (module.type === 'vehicle_leveler') {
            this.togglePdmChannelsUI('vehicle_leveler');
            this.populateLevelerFields(module.config || {});
        } else {
            this.togglePdmChannelsUI(module.type);
            document.getElementById('module-config').value = JSON.stringify(module.config || {}, null, 2);
        }

        // Show modal
        modal.style.display = 'flex';
        backdrop.style.display = 'block';
    },

    populateModuleTypes() {
        const typeSelect = document.getElementById('module-type');
        const currentValue = typeSelect.value;

        // Keep existing options structure
        if (typeSelect.options.length <= 1) {
            moduleTypes.forEach(type => {
                const option = document.createElement('option');
                option.value = type.id;
                option.textContent = type.name;
                typeSelect.appendChild(option);
            });
        }

        // Restore value
        if (currentValue) {
            typeSelect.value = currentValue;
        }
    },

    closeModal() {
        const modal = document.getElementById('module-modal');
        const backdrop = document.getElementById('modal-backdrop');

        modal.style.display = 'none';
        backdrop.style.display = 'none';
        editingModule = null;
        this.resetForm();
    },

    resetForm() {
        const form = document.getElementById('module-form');
        if (form) {
            form.reset();
            // Re-enable type select
            document.getElementById('module-type').disabled = false;
            document.getElementById('module-hostname').value = '';
        }
        this.clearErrors();
    },

    clearErrors() {
        document.getElementById('name-error').classList.add('hidden');
        document.getElementById('type-error').classList.add('hidden');
        document.getElementById('hostname-error').classList.add('hidden');
        document.getElementById('config-error').classList.add('hidden');
        document.getElementById('form-message').classList.add('hidden');
    },

    async handleFormSubmit(e) {
        e.preventDefault();

        const type = document.getElementById('module-type').value;
        const name = document.getElementById('module-name').value.trim();
        const hostname = document.getElementById('module-hostname').value.trim();
        const configText = document.getElementById('module-config').value.trim();

        // Validate
        this.clearErrors();

        if (!type) {
            document.getElementById('type-error').textContent = 'Module type is required';
            document.getElementById('type-error').classList.remove('hidden');
            return;
        }

        if (!name) {
            document.getElementById('name-error').textContent = 'Friendly name is required';
            document.getElementById('name-error').classList.remove('hidden');
            return;
        }

        if (!hostname) {
            document.getElementById('hostname-error').textContent = 'Hostname is required';
            document.getElementById('hostname-error').classList.remove('hidden');
            return;
        }

        let config = {};
        if (type === 'power_distribution_module' || type === 'switchback_relay') {
            config = { channels: this.collectChannelData() };
        } else if (type === 'vehicle_leveler') {
            config = this.collectLevelerData();
            if (!config) return; // validation failed
        } else if (configText) {
            try {
                config = JSON.parse(configText);
                if (typeof config !== 'object') {
                    throw new Error('Config must be an object');
                }
            } catch (e) {
                document.getElementById('config-error').textContent = `Invalid JSON: ${e.message}`;
                document.getElementById('config-error').classList.remove('hidden');
                return;
            }
        }

        // Submit
        const submitBtn = document.getElementById('modal-submit-btn');
        submitBtn.disabled = true;

        try {
            if (editingModule) {
                // Update existing module in system config
                const index = modules.findIndex(m => m === editingModule);
                if (index !== -1) {
                    modules[index] = {
                        ...editingModule,
                        name: name,
                        hostname: hostname,
                        config: config
                    };
                }
                this.showMessage('Module updated successfully', 'success');
            } else {
                // Add new module to system config
                modules.push({
                    type: type,
                    name: name,
                    hostname: hostname,
                    enabled: true,
                    config: config
                });
                this.showMessage('Module created successfully', 'success');
            }

            // Save updated modules to system config
            systemConfig.mcu_modules = modules;
            await API.updateSystemConfig({
                wizard_completed: systemConfig.wizard_completed,
                cloud_enabled: systemConfig.cloud_enabled,
                cloud_url: systemConfig.cloud_url,
                mcu_modules: modules
            });

            // Reload modules
            await this.reloadModules();
            this.closeModal();
        } catch (error) {
            this.showMessage(error.message || 'Failed to save module', 'error');
        } finally {
            submitBtn.disabled = false;
        }
    },

    async handleToggleModule(moduleToToggle, enabled) {
        // Prevent rapid successive toggles
        if (isToggleInProgress) {
            return;
        }

        isToggleInProgress = true;
        const index = modules.findIndex(m => m === moduleToToggle);
        const originalEnabled = moduleToToggle.enabled;

        try {
            // Update UI immediately (optimistic)
            if (index !== -1) {
                modules[index] = {
                    ...moduleToToggle,
                    enabled: enabled
                };
            }

            systemConfig.mcu_modules = modules;

            // Re-render the UI immediately for instant feedback
            this.updateModuleListUI();

            // Save to API in background without waiting
            this.saveToggleAsync(enabled, originalEnabled, index);
        } finally {
            isToggleInProgress = false;
        }
    },

    updateModuleListUI() {
        const configEl = document.getElementById('config-container');
        if (configEl) {
            const listContainer = configEl.querySelector('.modules-list') || configEl.querySelector('.empty-state');
            if (listContainer) {
                listContainer.parentNode.innerHTML = `
                    <div class="config-actions">
                        <button class="add-module-btn" id="add-module-btn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                                <path d="M12 5v14M5 12h14"></path>
                            </svg>
                            Add Module
                        </button>
                    </div>
                    ${this.renderModuleList(modules)}
                `;
                this.setupListeners();
            }
        }
    },

    async saveToggleAsync(enabled, originalEnabled, index) {
        try {
            // Save to API with retry logic
            await this.retryRequest(
                () => API.updateSystemConfig({
                    wizard_completed: systemConfig.wizard_completed,
                    cloud_enabled: systemConfig.cloud_enabled,
                    cloud_url: systemConfig.cloud_url,
                    mcu_modules: modules
                }),
                3
            );

            this.showMessage(enabled ? 'Module enabled' : 'Module disabled', 'success');
        } catch (error) {
            // Revert UI on failure
            if (index !== -1) {
                modules[index] = {
                    ...modules[index],
                    enabled: originalEnabled
                };
            }
            this.showMessage(error.message || 'Failed to update module', 'error');
            // Update UI to show reverted state
            this.updateModuleListUI();
        }
    },

    async retryRequest(requestFn, maxRetries = 3) {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await requestFn();
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    // Exponential backoff: 500ms, 1000ms, 2000ms
                    const delay = 500 * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw lastError;
    },

    async handleDeleteModule(moduleIndex) {
        const module = modules[moduleIndex];
        if (!module) return;

        if (!confirm(`Are you sure you want to delete "${module.name}"? This action cannot be undone.`)) {
            return;
        }

        try {
            modules.splice(moduleIndex, 1);

            systemConfig.mcu_modules = modules;
            await API.updateSystemConfig({
                wizard_completed: systemConfig.wizard_completed,
                cloud_enabled: systemConfig.cloud_enabled,
                cloud_url: systemConfig.cloud_url,
                mcu_modules: modules
            });

            this.showMessage('Module deleted successfully', 'success');
            await this.reloadModules();
        } catch (error) {
            this.showMessage(error.message || 'Failed to delete module', 'error');
        }
    },

    async reloadModules() {
        try {
            systemConfig = await API.getSystemConfig();
            modules = systemConfig.mcu_modules || [];
            const configEl = document.getElementById('config-container');
            if (configEl) {
                // Update the modules list
                const listContainer = configEl.querySelector('.modules-list') || configEl.querySelector('.empty-state');
                if (listContainer) {
                    listContainer.parentNode.innerHTML = `
                        <div class="config-actions">
                            <button class="add-module-btn" id="add-module-btn">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                                    <path d="M12 5v14M5 12h14"></path>
                                </svg>
                                Add Module
                            </button>
                        </div>
                        ${this.renderModuleList(modules)}
                    `;
                    this.setupListeners();
                }
            }
        } catch (error) {
            console.error('Failed to reload modules:', error);
        }
    },

    showMessage(message, type) {
        const messageEl = document.getElementById('form-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.classList.remove('hidden', 'success', 'error');
            messageEl.classList.add(type);

            // Auto-hide success messages after 3 seconds
            if (type === 'success') {
                setTimeout(() => {
                    messageEl.classList.add('hidden');
                }, 3000);
            }
        }
    },

    togglePdmChannelsUI(moduleType) {
        const jsonGroup = document.getElementById('json-config-group');
        const channelsConfig = document.getElementById('pdm-channels-config');
        const showChannels = moduleType === 'power_distribution_module' || moduleType === 'switchback_relay';

        if (showChannels) {
            jsonGroup.style.display = 'none';
            channelsConfig.style.display = 'block';
            // Populate channel rows if empty
            const list = document.getElementById('pdm-channel-list');
            if (!list.children.length) {
                const defaults = moduleType === 'switchback_relay'
                    ? this.getSwitchbackDefaultChannels()
                    : this.getDefaultChannels();
                this.renderChannelRows(defaults, moduleType);
            }
        } else {
            jsonGroup.style.display = moduleType === 'vehicle_leveler' ? 'none' : 'block';
            channelsConfig.style.display = 'none';
        }

        // Leveler config is independent of PDM channels
        document.getElementById('leveler-config').style.display =
            moduleType === 'vehicle_leveler' ? 'block' : 'none';
    },

    getDefaultChannels() {
        const names = ['Living Room', 'Kitchen', 'Bedroom', 'Bathroom', 'Exterior', 'Awning', 'Porch', 'Storage'];
        return names.map((name, i) => ({
            channel: i + 1,
            name,
            icon: 'lightbulb',
            type: 'light'
        }));
    },

    getSwitchbackDefaultChannels() {
        return Array.from({ length: 6 }, (_, i) => ({
            channel: i + 1,
            name: `Relay ${i + 1}`,
            icon: 'power-outlet',
            type: 'other'
        }));
    },

    renderChannelRows(channels, moduleType) {
        const list = document.getElementById('pdm-channel-list');
        const iconOptions = ICON_LIST.map(ic =>
            `<option value="${ic.key}">${escapeHtml(ic.label)}</option>`
        ).join('');
        const isSwitchback = moduleType === 'switchback_relay';

        list.innerHTML = channels.map(ch => `
            <div class="pdm-channel-row" data-channel="${ch.channel}">
                <span class="pdm-channel-number">${ch.channel}</span>
                <input type="text" class="form-input pdm-channel-name" value="${escapeHtml(ch.name)}" placeholder="Channel name">
                <select class="form-input pdm-channel-icon">${iconOptions}</select>
                <select class="form-input pdm-channel-type">
                    <option value="light"${ch.type === 'light' ? ' selected' : ''}>Light</option>
                    <option value="general"${ch.type === 'general' ? ' selected' : ''}>General</option>
                    <option value="other"${ch.type === 'other' ? ' selected' : ''}>Other</option>
                </select>
            </div>
        `).join('');

        // Set icon select values after rendering (selected attribute in options)
        list.querySelectorAll('.pdm-channel-row').forEach((row, i) => {
            const iconSelect = row.querySelector('.pdm-channel-icon');
            if (iconSelect && channels[i]) {
                iconSelect.value = channels[i].icon || (isSwitchback ? 'power-outlet' : 'lightbulb');
            }
        });
    },

    populateLevelerFields(config) {
        const mounting = document.getElementById('leveler-mounting');
        const length = document.getElementById('leveler-vehicle-length');
        const width = document.getElementById('leveler-vehicle-width');

        if (mounting) mounting.value = config.mounting !== undefined ? config.mounting : 0;
        if (length) length.value = config.vehicle_length_cm !== undefined ? config.vehicle_length_cm : 500;
        if (width) width.value = config.vehicle_width_cm !== undefined ? config.vehicle_width_cm : 200;
    },

    collectLevelerData() {
        const mounting = parseInt(document.getElementById('leveler-mounting').value);
        const vehicleLength = parseInt(document.getElementById('leveler-vehicle-length').value);
        const vehicleWidth = parseInt(document.getElementById('leveler-vehicle-width').value);

        if (isNaN(vehicleLength) || vehicleLength < 1 || vehicleLength > 65535) {
            this.showMessage('Vehicle length must be between 1 and 65535 cm', 'error');
            return null;
        }
        if (isNaN(vehicleWidth) || vehicleWidth < 1 || vehicleWidth > 65535) {
            this.showMessage('Vehicle width must be between 1 and 65535 cm', 'error');
            return null;
        }

        return {
            mounting: mounting,
            vehicle_length_cm: vehicleLength,
            vehicle_width_cm: vehicleWidth
        };
    },

    collectChannelData() {
        const rows = document.querySelectorAll('#pdm-channel-list .pdm-channel-row');
        return Array.from(rows).map(row => ({
            channel: parseInt(row.dataset.channel),
            name: row.querySelector('.pdm-channel-name').value.trim() || `Channel ${row.dataset.channel}`,
            icon: row.querySelector('.pdm-channel-icon').value,
            type: row.querySelector('.pdm-channel-type').value
        }));
    },

    cleanup() {
        systemConfig = null;
        modules = [];
        moduleTypes = [];
        editingModule = null;
    }
};

// Helper function to escape HTML
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}
