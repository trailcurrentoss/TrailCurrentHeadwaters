// Settings > Network & Modules
//
// Wi-Fi (MCU OTA) + CAN module discovery / add / edit / delete / OTA.
// Formerly the standalone Config page — moved here on consolidation so
// that all settings live under one screen. Logic, DOM IDs, event
// handlers, and API calls are byte-identical to the pre-consolidation
// implementation.

import { API, wsClient } from '../../../api.js';
import {
    FIRESIDE_ICONS,
    ICON_GROUPS,
    renderIconHtml,
    resolveIcon,
} from '../../../components/fireside-icons.js';

let systemConfig = null;
let modules = [];
let moduleTypes = [];
let editingModule = null;
let isToggleInProgress = false;
let configDiscoveryActive = false;
let configDiscoveryListener = null;
let configDiscoveryTimeout = null;
let otaProgressListener = null;
let configContainerClickListener = null;
let formSubmitListener = null;
let addBtnListener = null;
let closeBtnListener = null;
let cancelBtnListener = null;
let backdropListener = null;
let typeChangeListener = null;

function getModuleDisplayName(typeId) {
    const found = moduleTypes.find(m => m.id === typeId);
    return found ? found.name : typeId;
}

export const networkGroup = {
    meta: {
        id: 'network',
        title: 'Network & Modules',
        icon: 'wifi-outline',
        sub: 'Wi-Fi, CAN modules',
    },
    searchIndex: [
        { label: 'Wi-Fi Configuration', kw: 'wifi ssid password network access point ota mcu quigon', anchor: 'wifi-ssid' },
        { label: 'Module Configuration', kw: 'modules scan can bus discover devices firmware ota', anchor: 'config-container' },
    ],
    render() {
        return `
            <section class="page-config">
                <h1 class="section-title">Configuration</h1>

                <!-- Wireless Configuration Section -->
                <div class="card wireless-config-card">
                    <div class="wireless-config-section">
                        <h2 class="subsection-title">Wireless Configuration</h2>
                        <p class="wireless-config-description">Configure WiFi access point for MCU OTA updates</p>

                        <div class="wireless-form-group">
                            <label for="wifi-ssid" class="form-label">WiFi SSID (Network Name)</label>
                            <input type="text" id="wifi-ssid" class="form-input"
                                   placeholder="e.g., Overlook-OTA">
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

                        <div class="borealis-config" id="borealis-config" style="display: none;">
                            <label class="form-label">Calibration</label>
                            <p class="form-hint" style="margin-bottom: 12px;">Adjust the temperature sensor offset. This value is sent to Borealis via CAN bus and persists across reboots.</p>

                            <div class="leveler-field-group">
                                <label for="borealis-temp-offset" class="form-label">Temperature Offset (&deg;C)</label>
                                <input type="number" id="borealis-temp-offset" class="form-input"
                                       placeholder="0.0" min="-100" max="100" step="0.1" value="0">
                                <p class="form-hint">Offset applied to the SHT31 reading before conversion and transmission. Positive values increase the reported temperature. Send 0 to clear.</p>
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

            <!-- Icon picker modal -->
            <div class="modal icon-picker-modal" id="icon-picker-modal" style="display: none;">
                <div class="modal-content icon-picker-content">
                    <div class="modal-header">
                        <h2>Choose an Icon</h2>
                        <button class="modal-close" id="icon-picker-close-btn" aria-label="Close">×</button>
                    </div>
                    <div class="icon-picker-toolbar">
                        <input type="search" id="icon-picker-search" class="form-input"
                               placeholder="Search icons…" autocomplete="off">
                    </div>
                    <div class="icon-picker-body" id="icon-picker-body">
                        <!-- grid rendered dynamically -->
                    </div>
                </div>
            </div>
            <div class="modal-backdrop" id="icon-picker-backdrop" style="display: none;"></div>
        `;
    },

    renderModuleList(allModules) {
        if (!allModules || allModules.length === 0) {
            return `
                <div class="empty-state">
                    <p>No modules configured yet</p>
                    <p class="empty-state-hint">Click "Scan for Devices" to discover modules on the CAN bus</p>
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
                                <span class="module-type-badge">${escapeHtml(getModuleDisplayName(module.type))}</span>
                                ${module.fw ? `<span class="module-fw-badge">v${escapeHtml(module.fw)}</span>` : ''}
                            </div>
                            <p class="module-description">
                                ${module.hostname ? `<span class="module-hostname">${escapeHtml(module.hostname)}</span>` : ''}${module.canid ? ` &middot; CAN ${escapeHtml(module.canid)}` : ''} &middot; ${module.enabled ? 'Enabled' : 'Disabled'}
                            </p>
                            <div class="module-ota-status hidden" id="ota-status-${idx}"></div>
                        </div>
                        <div class="module-actions">
                            <button class="toggle-switch ${module.enabled ? 'active' : ''}"
                                    data-module-index="${idx}"
                                    data-action="toggle"
                                    title="${module.enabled ? 'Disable' : 'Enable'} module"
                                    aria-pressed="${module.enabled}">
                            </button>
                            ${module.hostname ? `
                            <button class="module-action-btn module-ota-btn"
                                    data-module-index="${idx}"
                                    data-action="ota"
                                    title="Update firmware">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="7 10 12 15 17 10"></polyline>
                                    <line x1="12" y1="15" x2="12" y2="3"></line>
                                </svg>
                            </button>
                            ` : ''}
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
                        Scan for Devices
                    </button>
                </div>
                <div id="config-discovery-status" class="discovery-status hidden">
                    <div class="discovery-spinner"></div>
                    <span class="discovery-status-text">Scanning for modules...</span>
                </div>
                <div id="config-discovered-modules" class="discovered-modules"></div>
                <div id="discovery-message" class="ota-message hidden"></div>
                ${this.renderModuleList(modules)}
            `;

            // Setup listeners
            this.setupListeners();
            this.setupWirelessListeners();
            this.loadWirelessConfig();
            this.setupOtaProgressListener();
        } catch (error) {
            console.error('Failed to load configuration:', error);
            const configEl = document.getElementById('config-container');
            if (configEl) {
                configEl.innerHTML = '<p style="color: var(--danger);">Failed to load configuration. Please try refreshing the page.</p>';
            }
        }
    },

    setupOtaProgressListener() {
        if (otaProgressListener) wsClient.off('ota_progress', otaProgressListener);
        otaProgressListener = (data) => {
            // Find module index by hostname
            const idx = modules.findIndex(m => m.hostname === data.hostname);
            if (idx === -1) return;
            const statusEl = document.getElementById(`ota-status-${idx}`);
            if (statusEl) {
                statusEl.textContent = data.message || data.status;
                statusEl.classList.remove('hidden');
                if (data.status === 'complete') {
                    statusEl.classList.add('ota-complete');
                    setTimeout(() => {
                        statusEl.classList.add('hidden');
                        this.reloadModules();
                    }, 3000);
                } else if (data.status === 'error') {
                    statusEl.classList.add('ota-error');
                }
            }
        };
        wsClient.on('ota_progress', otaProgressListener);
    },

    async handleModuleOta(module, moduleIndex) {
        const statusEl = document.getElementById(`ota-status-${moduleIndex}`);
        const showStatus = (msg, cls) => {
            if (!statusEl) return;
            statusEl.textContent = msg;
            statusEl.className = cls ? `module-ota-status ${cls}` : 'module-ota-status';
        };

        let files;
        try {
            files = await API.listFirmware();
        } catch (err) {
            showStatus('Failed to load firmware list', 'ota-error');
            return;
        }

        if (!files.length) {
            showStatus('No firmware available — upload via Deployments', 'ota-error');
            return;
        }

        // Find the right firmware for this module's type, target, and address
        const addr = module.addr !== undefined ? module.addr : 0;
        const target = module.target || '';
        const targetAddrName = target ? `${module.type}_${target}_addr${addr}.bin` : '';
        const addrName = `${module.type}_addr${addr}.bin`;
        const singleName = `${module.type}.bin`;

        let firmwareMatch = targetAddrName ? files.find(f => f.filename === targetAddrName) : null;
        if (!firmwareMatch) firmwareMatch = files.find(f => f.filename === addrName);
        if (!firmwareMatch) firmwareMatch = files.find(f => f.filename === singleName);
        if (!firmwareMatch) firmwareMatch = files[0]; // legacy fallback

        const firmwareFile = firmwareMatch.filename;

        if (!confirm(`Update ${module.name} (${module.hostname}) with ${firmwareFile}?`)) return;

        showStatus('Triggering OTA...');
        if (statusEl) statusEl.classList.remove('hidden');

        try {
            await API.triggerOta(module.hostname, firmwareFile, module.wireless === true);
            // Progress updates will come via WebSocket
        } catch (error) {
            showStatus('OTA trigger failed: ' + error.message, 'ota-error');
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

    showDiscoveryMessage(message, type) {
        const messageEl = document.getElementById('discovery-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.className = `ota-message ${type}`;
            messageEl.classList.remove('hidden');

            if (type === 'success') {
                setTimeout(() => {
                    messageEl.classList.add('hidden');
                }, 4000);
            }
        }
    },

    clearDiscoveryMessage() {
        const messageEl = document.getElementById('discovery-message');
        if (messageEl) {
            messageEl.classList.add('hidden');
        }
    },

    setupListeners() {
        // Add module button
        const addBtn = document.getElementById('add-module-btn');
        if (addBtn) {
            if (addBtnListener) addBtn.removeEventListener('click', addBtnListener);
            addBtnListener = () => this.showAddModuleModal();
            addBtn.addEventListener('click', addBtnListener);
        }

        // Module card actions - remove old listener before adding new one
        const configEl = document.getElementById('config-container');
        if (configEl) {
            if (configContainerClickListener) {
                configEl.removeEventListener('click', configContainerClickListener);
            }

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
                } else if (action === 'ota') {
                    const module = modules[moduleIndex];
                    if (module) {
                        this.handleModuleOta(module, moduleIndex);
                    }
                } else if (action === 'confirm-discovered') {
                    const hostname = btn.dataset.hostname;
                    if (hostname) {
                        this.confirmDiscoveredModule(hostname);
                    }
                }
            };

            configEl.addEventListener('click', configContainerClickListener);
        }

        // Module type change — toggle between JSON config and PDM channels UI
        const typeSelect = document.getElementById('module-type');
        if (typeSelect) {
            if (typeChangeListener) typeSelect.removeEventListener('change', typeChangeListener);
            typeChangeListener = () => this.togglePdmChannelsUI(typeSelect.value);
            typeSelect.addEventListener('change', typeChangeListener);
        }

        // Modal form
        const form = document.getElementById('module-form');
        if (form) {
            if (formSubmitListener) form.removeEventListener('submit', formSubmitListener);
            formSubmitListener = (e) => this.handleFormSubmit(e);
            form.addEventListener('submit', formSubmitListener);
        }

        // Modal close buttons
        const closeBtn = document.getElementById('modal-close-btn');
        if (closeBtn) {
            if (closeBtnListener) closeBtn.removeEventListener('click', closeBtnListener);
            closeBtnListener = () => this.closeModal();
            closeBtn.addEventListener('click', closeBtnListener);
        }

        const cancelBtn = document.getElementById('modal-cancel-btn');
        if (cancelBtn) {
            if (cancelBtnListener) cancelBtn.removeEventListener('click', cancelBtnListener);
            cancelBtnListener = () => this.closeModal();
            cancelBtn.addEventListener('click', cancelBtnListener);
        }

        // Modal backdrop click
        const backdrop = document.getElementById('modal-backdrop');
        if (backdrop) {
            if (backdropListener) backdrop.removeEventListener('click', backdropListener);
            backdropListener = () => this.closeModal();
            backdrop.addEventListener('click', backdropListener);
        }
    },

    showAddModuleModal() {
        // Instead of opening a modal, start discovery
        if (configDiscoveryActive) {
            this.stopConfigDiscovery();
        } else {
            this.startConfigDiscovery();
        }
    },

    async startConfigDiscovery() {
        const scanBtn = document.getElementById('add-module-btn');
        const statusEl = document.getElementById('config-discovery-status');

        // Clear previous session UI
        this.clearDiscoveryMessage();
        const prevCards = document.getElementById('config-discovered-modules');
        if (prevCards) prevCards.innerHTML = '';

        try {
            await API.startDiscovery();
            configDiscoveryActive = true;

            if (scanBtn) {
                scanBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    </svg>
                    Stop Scanning
                `;
            }
            if (statusEl) statusEl.classList.remove('hidden');

            configDiscoveryListener = (data) => this.onConfigModuleFound(data);
            wsClient.on('discovery_found', configDiscoveryListener);

            configDiscoveryTimeout = setTimeout(() => this.stopConfigDiscovery(), 35000);
        } catch (error) {
            console.error('Failed to start discovery:', error);
            configDiscoveryActive = false;
            this.showDiscoveryMessage('Failed to start discovery: ' + error.message, 'error');
            // Reset button back to scan state
            if (scanBtn) {
                scanBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M12 5v14M5 12h14"></path>
                    </svg>
                    Scan for Devices
                `;
            }
            if (statusEl) statusEl.classList.add('hidden');
        }
    },

    async stopConfigDiscovery() {
        try { await API.stopDiscovery(); } catch (err) { /* ignore */ }

        configDiscoveryActive = false;
        const scanBtn = document.getElementById('add-module-btn');
        const statusEl = document.getElementById('config-discovery-status');

        if (scanBtn) {
            scanBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                    <path d="M12 5v14M5 12h14"></path>
                </svg>
                Scan for Devices
            `;
        }
        if (statusEl) statusEl.classList.add('hidden');

        if (configDiscoveryListener) {
            wsClient.off('discovery_found', configDiscoveryListener);
            configDiscoveryListener = null;
        }
        if (configDiscoveryTimeout) {
            clearTimeout(configDiscoveryTimeout);
            configDiscoveryTimeout = null;
        }
    },

    onConfigModuleFound(data) {
        const container = document.getElementById('config-discovered-modules');
        if (!container) return;

        // Skip if already in modules list
        if (modules.some(m => m.hostname === data.hostname)) return;
        // Skip if already shown
        if (container.querySelector(`[data-hostname="${data.hostname}"]`)) return;

        const displayName = getModuleDisplayName(data.type);
        const card = document.createElement('div');
        card.className = 'discovered-module-card';
        card.dataset.hostname = data.hostname;
        card.innerHTML = `
            <div class="discovered-module-info">
                <span class="discovered-module-type">${escapeHtml(displayName)}</span>
                <span class="discovered-module-details">${escapeHtml(data.hostname)} &middot; addr ${data.addr} &middot; v${data.fw}</span>
            </div>
            <button class="module-action-btn module-edit-btn" data-hostname="${escapeHtml(data.hostname)}" data-action="confirm-discovered" title="Confirm module">
                Confirm
            </button>
        `;
        container.appendChild(card);
    },

    async confirmDiscoveredModule(hostname) {
        const card = document.querySelector(`.discovered-module-card[data-hostname="${hostname}"]`);
        const btn = card?.querySelector('[data-action="confirm-discovered"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Confirming...'; }
        this.clearDiscoveryMessage();

        try {
            this.showDiscoveryMessage('Contacting module (this may take a moment)...', 'success');
            await API.confirmModule(hostname);
            this.clearDiscoveryMessage();
            if (card) card.remove();
            await this.reloadModules();
        } catch (error) {
            console.error('Failed to confirm module:', error);
            if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
            this.showDiscoveryMessage('Failed to confirm: ' + error.message, 'error');
        }
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

        // Populate form with module data. Type + hostname are set by
        // discovery and can't be changed without re-onboarding, so they
        // stay read-only. Name is the user-facing label — editable here
        // is the whole point of the edit dialog.
        document.getElementById('module-type').value = module.type;
        document.getElementById('module-type').disabled = true;
        document.getElementById('module-name').value = module.name;
        document.getElementById('module-name').disabled = false;
        document.getElementById('module-hostname').value = module.hostname || '';
        document.getElementById('module-hostname').disabled = true;

        // Handle channel-based config (Torrent PDM, Switchback relay), borealis, or generic JSON.
        // Plateau's vehicle-geometry config lives in Settings > Vehicle, not here.
        const isSwitchback = module.type === 'switchback' || module.type === 'switchback_relay';
        if (module.type === 'torrent' || isSwitchback) {
            const defaults = isSwitchback ? this.getSwitchbackDefaultChannels() : this.getDefaultChannels();
            const channels = module.config?.channels || defaults;
            this.togglePdmChannelsUI(module.type);
            this.renderChannelRows(channels, module.type);
        } else if (module.type === 'borealis') {
            this.togglePdmChannelsUI('borealis');
            this.populateBorealisFields(module.config || {});
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
            // Re-enable fields that may have been disabled
            document.getElementById('module-type').disabled = false;
            document.getElementById('module-name').disabled = false;
            document.getElementById('module-hostname').disabled = false;
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
        if (type === 'torrent' || type === 'switchback' || type === 'switchback_relay') {
            config = { channels: this.collectChannelData() };
        } else if (type === 'borealis') {
            config = this.collectBorealisData();
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
            configEl.innerHTML = `
                <div class="config-actions">
                    <button class="add-module-btn" id="add-module-btn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <path d="M12 5v14M5 12h14"></path>
                        </svg>
                        Scan for Devices
                    </button>
                </div>
                <div id="config-discovery-status" class="discovery-status hidden">
                    <div class="discovery-spinner"></div>
                    <span class="discovery-status-text">Scanning for modules...</span>
                </div>
                <div id="config-discovered-modules" class="discovered-modules"></div>
                <div id="discovery-message" class="ota-message hidden"></div>
                ${this.renderModuleList(modules)}
            `;
            this.setupListeners();
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
            this.updateModuleListUI();
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
        const isSwitchback = moduleType === 'switchback' || moduleType === 'switchback_relay';
        const showChannels = moduleType === 'torrent' || isSwitchback;

        if (showChannels) {
            jsonGroup.style.display = 'none';
            channelsConfig.style.display = 'block';
            // Update label based on module type
            const label = channelsConfig.querySelector('.form-label');
            const hint = channelsConfig.querySelector('.form-hint');
            if (isSwitchback) {
                label.textContent = 'Relay Configuration';
                hint.textContent = 'Configure each relay channel';
            } else {
                label.textContent = 'Channel Configuration';
                hint.textContent = 'Configure each PDM output channel';
            }
            // Populate channel rows if empty
            const list = document.getElementById('pdm-channel-list');
            if (!list.children.length) {
                const defaults = isSwitchback ? this.getSwitchbackDefaultChannels() : this.getDefaultChannels();
                this.renderChannelRows(defaults, moduleType);
            }
        } else {
            jsonGroup.style.display = (moduleType === 'borealis') ? 'none' : 'block';
            channelsConfig.style.display = 'none';
        }

        // Borealis config
        document.getElementById('borealis-config').style.display =
            moduleType === 'borealis' ? 'block' : 'none';
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
        return Array.from({ length: 8 }, (_, i) => ({
            channel: i + 1,
            name: `Relay ${i + 1}`,
            icon: 'plug',
            type: 'other'
        }));
    },

    renderChannelRows(channels, moduleType) {
        const list = document.getElementById('pdm-channel-list');
        const isSwitchback = moduleType === 'switchback' || moduleType === 'switchback_relay';
        const defaultIcon = isSwitchback ? 'plug' : 'lightbulb';

        list.innerHTML = channels.map(ch => {
            const iconId = ch.icon || defaultIcon;
            const resolved = resolveIcon(iconId);
            const stableKey = resolved.key;
            return `
            <div class="pdm-channel-card" data-channel="${ch.channel}">
                <button type="button" class="pdm-channel-icon-btn"
                        data-icon="${escapeHtml(stableKey)}"
                        aria-label="Change icon for channel ${ch.channel}">
                    ${renderIconHtml(stableKey, 'pdm-channel-icon-glyph')}
                </button>
                <label class="pdm-channel-label">
                    <span class="pdm-channel-index">#${ch.channel}</span>
                    <input type="text" class="form-input pdm-channel-name"
                           value="${escapeHtml(ch.name)}"
                           placeholder="Channel name" maxlength="24">
                </label>
                <select class="form-input pdm-channel-type" aria-label="Channel ${ch.channel} type">
                    <option value="light"${ch.type === 'light' ? ' selected' : ''}>Light</option>
                    <option value="general"${ch.type === 'general' ? ' selected' : ''}>General</option>
                    <option value="other"${ch.type === 'other' ? ' selected' : ''}>Other</option>
                </select>
            </div>`;
        }).join('');

        // Wire up icon-picker buttons — open modal, remember which card
        // to write back to. Delegated so re-renders don't leak listeners.
        if (!list._iconClickBound) {
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('.pdm-channel-icon-btn');
                if (!btn) return;
                const card = btn.closest('.pdm-channel-card');
                if (card) this.openIconPicker(card);
            });
            list._iconClickBound = true;
        }
    },

    openIconPicker(targetCard) {
        this._iconPickerTarget = targetCard;
        const modal = document.getElementById('icon-picker-modal');
        const backdrop = document.getElementById('icon-picker-backdrop');
        if (!modal || !backdrop) return;

        this.renderIconPickerGrid('');
        modal.style.display = 'flex';
        backdrop.style.display = 'block';

        const searchEl = document.getElementById('icon-picker-search');
        if (searchEl) {
            searchEl.value = '';
            if (!searchEl._bound) {
                searchEl.addEventListener('input', () => {
                    this.renderIconPickerGrid(searchEl.value);
                });
                searchEl._bound = true;
            }
            // Delay focus so mobile keyboards don't cover the modal
            setTimeout(() => searchEl.focus(), 50);
        }

        const closeBtn = document.getElementById('icon-picker-close-btn');
        if (closeBtn && !closeBtn._bound) {
            closeBtn.addEventListener('click', () => this.closeIconPicker());
            closeBtn._bound = true;
        }
        if (!backdrop._bound) {
            backdrop.addEventListener('click', () => this.closeIconPicker());
            backdrop._bound = true;
        }
    },

    renderIconPickerGrid(query) {
        const body = document.getElementById('icon-picker-body');
        if (!body) return;

        const q = (query || '').trim().toLowerCase();
        const currentKey = this._iconPickerTarget?.querySelector('.pdm-channel-icon-btn')?.dataset.icon;

        const filtered = q
            ? FIRESIDE_ICONS.filter(ic =>
                ic.label.toLowerCase().includes(q) ||
                ic.key.toLowerCase().includes(q) ||
                ic.group.toLowerCase().includes(q))
            : FIRESIDE_ICONS;

        // Group by ic.group in the canonical group order
        const byGroup = new Map();
        for (const ic of filtered) {
            if (!byGroup.has(ic.group)) byGroup.set(ic.group, []);
            byGroup.get(ic.group).push(ic);
        }
        const orderedGroups = ICON_GROUPS.filter(g => byGroup.has(g))
            .concat([...byGroup.keys()].filter(g => !ICON_GROUPS.includes(g)));

        if (orderedGroups.length === 0) {
            body.innerHTML = `<p class="icon-picker-empty">No icons match "${escapeHtml(query)}"</p>`;
            return;
        }

        body.innerHTML = orderedGroups.map(group => `
            <section class="icon-picker-group">
                <h3 class="icon-picker-group-title">${escapeHtml(group)}</h3>
                <div class="icon-picker-grid">
                    ${byGroup.get(group).map(ic => `
                        <button type="button"
                                class="icon-picker-tile${ic.key === currentKey ? ' selected' : ''}"
                                data-icon="${escapeHtml(ic.key)}"
                                title="${escapeHtml(ic.label)}"
                                aria-label="${escapeHtml(ic.label)}">
                            ${renderIconHtml(ic.key)}
                            <span class="icon-picker-tile-label">${escapeHtml(ic.label)}</span>
                        </button>
                    `).join('')}
                </div>
            </section>
        `).join('');

        if (!body._bound) {
            body.addEventListener('click', (e) => {
                const tile = e.target.closest('.icon-picker-tile');
                if (!tile) return;
                this.selectIcon(tile.dataset.icon);
            });
            body._bound = true;
        }
    },

    selectIcon(iconKey) {
        const card = this._iconPickerTarget;
        if (!card) { this.closeIconPicker(); return; }
        const btn = card.querySelector('.pdm-channel-icon-btn');
        if (btn) {
            btn.dataset.icon = iconKey;
            btn.innerHTML = renderIconHtml(iconKey, 'pdm-channel-icon-glyph');
        }
        this.closeIconPicker();
    },

    closeIconPicker() {
        const modal = document.getElementById('icon-picker-modal');
        const backdrop = document.getElementById('icon-picker-backdrop');
        if (modal) modal.style.display = 'none';
        if (backdrop) backdrop.style.display = 'none';
        this._iconPickerTarget = null;
    },

    populateBorealisFields(config) {
        const offsetEl = document.getElementById('borealis-temp-offset');
        if (offsetEl) {
            offsetEl.value = config.temp_offset !== undefined ? config.temp_offset : 0;
        }
    },

    collectBorealisData() {
        const offsetVal = parseFloat(document.getElementById('borealis-temp-offset').value);

        if (isNaN(offsetVal) || offsetVal < -100 || offsetVal > 100) {
            this.showMessage('Temperature offset must be between -100 and 100 °C', 'error');
            return null;
        }

        // Round to one decimal place to match tenths-of-degree resolution
        return {
            temp_offset: Math.round(offsetVal * 10) / 10
        };
    },

    collectChannelData() {
        const cards = document.querySelectorAll('#pdm-channel-list .pdm-channel-card');
        return Array.from(cards).map(card => ({
            channel: parseInt(card.dataset.channel),
            name: card.querySelector('.pdm-channel-name').value.trim() || `Channel ${card.dataset.channel}`,
            icon: card.querySelector('.pdm-channel-icon-btn').dataset.icon,
            type: card.querySelector('.pdm-channel-type').value
        }));
    },

    cleanup() {
        if (configDiscoveryActive) this.stopConfigDiscovery();
        if (otaProgressListener) {
            wsClient.off('ota_progress', otaProgressListener);
            otaProgressListener = null;
        }
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
