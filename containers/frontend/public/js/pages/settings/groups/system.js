// Settings > System & Storage
// Compute module health, Refresh App, Reset Configuration, Factory Reset
// (with typed-confirmation modal). Extracted verbatim from settings.js.

import { API, wsClient } from '../../../api.js';

let statsWsHandler = null;

// Human-friendly byte formatter — restricted to MB / GB / TB.
function formatBytes(bytes) {
    if (bytes == null || Number.isNaN(bytes)) return 'N/A';
    const units = ['MB', 'GB', 'TB'];
    let value = bytes / (1024 * 1024);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(decimals)} ${units[unit]}`;
}

export const systemGroup = {
    meta: {
        id: 'system',
        title: 'System & Storage',
        icon: 'hardware-chip-outline',
        sub: 'Health, refresh, reset',
    },
    searchIndex: [
        { label: 'Compute Module Health', kw: 'cpu temperature usage fan speed storage disk system',           anchor: 'system-stats-grid' },
        { label: 'Refresh App',           kw: 'refresh cache reload update version',                            anchor: 'refresh-app-btn' },
        { label: 'Reset Configuration',   kw: 'reset setup wizard reconfigure',                                 anchor: 'reset-config-btn' },
        { label: 'Factory Reset',         kw: 'factory reset erase reboot credentials headwaters',              anchor: 'factory-reset-btn' },
    ],

    render() {
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
                <div class="disk-usage" id="disk-usage">
                    <div class="disk-usage-header">
                        <span class="disk-usage-title">Storage</span>
                        <span class="disk-usage-summary">
                            <span id="stat-disk-used">--</span>
                            <span class="disk-usage-summary-of"> of </span>
                            <span id="stat-disk-total">--</span>
                            <span class="disk-usage-summary-suffix"> used</span>
                        </span>
                    </div>
                    <div class="disk-usage-bar" role="progressbar" aria-label="Disk usage">
                        <div class="disk-usage-fill" id="disk-usage-fill"></div>
                    </div>
                    <div class="disk-usage-footer">
                        <span id="stat-disk-free">--</span>
                        <span class="disk-usage-footer-suffix"> free</span>
                    </div>
                </div>
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

            <!-- Factory Reset -->
            <div class="card settings-item">
                <div>
                    <span class="settings-label">Factory Reset</span>
                    <p class="settings-description">Erase all device credentials and settings and reboot. The device restarts on the Headwaters-XXXX setup WiFi network — the same out-of-box setup process runs again from the beginning.</p>
                </div>
                <button class="settings-action-btn settings-action-btn-danger" id="factory-reset-btn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                        <line x1="12" y1="9" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                    Factory Reset
                </button>
            </div>
        `;
    },

    async init() {
        wireListeners();
        await setupSystemStats();
    },

    cleanup() {
        if (statsWsHandler) {
            wsClient.off('system_stats', statsWsHandler);
            statsWsHandler = null;
        }
        closeFactoryResetModal();
    },
};

function wireListeners() {
    const refreshBtn = document.getElementById('refresh-app-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', handleRefreshApp);

    const resetConfigBtn = document.getElementById('reset-config-btn');
    if (resetConfigBtn) resetConfigBtn.addEventListener('click', handleResetConfig);

    const factoryResetBtn = document.getElementById('factory-reset-btn');
    if (factoryResetBtn) factoryResetBtn.addEventListener('click', openFactoryResetModal);
}

async function handleRefreshApp() {
    const refreshBtn = document.getElementById('refresh-app-btn');
    if (!refreshBtn) return;
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
        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const reg of registrations) {
                try { await reg.update(); } catch (_) {}
                if (reg.waiting) {
                    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                }
            }
        }
        if ('caches' in window) {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map(name => caches.delete(name)));
        }
        try {
            const critical = new Set(['/manifest.json', '/service-worker.js']);
            for (const s of document.querySelectorAll('script[src]')) critical.add(s.src);
            for (const l of document.querySelectorAll('link[rel="stylesheet"]')) critical.add(l.href);
            await Promise.all([...critical].map(url =>
                fetch(url, { cache: 'reload' }).catch(() => {})
            ));
        } catch (_) {}
        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map(r => r.unregister()));
        }
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
}

async function handleResetConfig() {
    if (!confirm('Are you sure you want to reset the configuration? The setup wizard will appear again on next load.')) {
        return;
    }
    const resetConfigBtn = document.getElementById('reset-config-btn');
    if (!resetConfigBtn) return;
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
        alert('Configuration reset successfully. The page will reload.');
        window.location.reload();
    } catch (error) {
        console.error('Failed to reset configuration:', error);
        alert('Failed to reset configuration: ' + (error.message || 'Unknown error'));
        resetConfigBtn.disabled = false;
        resetConfigBtn.innerHTML = originalHTML;
    }
}

// --- Factory Reset modal (typed-confirmation) ---

function openFactoryResetModal() {
    const existing = document.getElementById('factory-reset-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'factory-reset-modal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-backdrop" data-factory-reset-close></div>
        <div class="modal-content">
            <div class="modal-header">
                <h2>Factory Reset</h2>
                <button class="modal-close" data-factory-reset-close aria-label="Cancel">&times;</button>
            </div>
            <div class="module-form">
                <div class="form-group">
                    <p style="margin: 0; color: var(--text-primary); line-height: 1.5;">
                        This will <strong>permanently erase</strong> the following on this device:
                    </p>
                    <ul style="margin: 8px 0 0 0; padding-left: 20px; color: var(--text-secondary); line-height: 1.7;">
                        <li>MQTT credentials, admin password, and encryption key</li>
                        <li>All Farwatch cloud pairing information</li>
                        <li>All discovered MCU modules and their custom names</li>
                        <li>WiFi credentials configured for the MCU network</li>
                        <li>All alarm rules and SMS notification settings</li>
                    </ul>
                    <p style="margin: 12px 0 0 0; color: var(--text-secondary); line-height: 1.5;">
                        The device reboots and comes back up broadcasting the <strong>Headwaters-XXXX</strong> setup WiFi network — the same out-of-box setup process runs again from the beginning. Map data and TLS certificates are preserved.
                    </p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="factory-reset-confirm-input">
                        Type <code style="background: var(--bg-primary); padding: 2px 6px; border-radius: 4px;">FACTORY RESET</code> to enable the button
                    </label>
                    <input type="text"
                           id="factory-reset-confirm-input"
                           class="form-input"
                           autocomplete="off"
                           autocapitalize="characters"
                           spellcheck="false"
                           placeholder="FACTORY RESET">
                </div>
                <div id="factory-reset-error" class="password-message hidden"></div>
                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button type="button"
                            class="settings-action-btn"
                            data-factory-reset-close>
                        Cancel
                    </button>
                    <button type="button"
                            class="settings-action-btn settings-action-btn-danger"
                            id="factory-reset-confirm-btn"
                            disabled>
                        Reset Device
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const input = modal.querySelector('#factory-reset-confirm-input');
    const confirmBtn = modal.querySelector('#factory-reset-confirm-btn');
    const errorEl = modal.querySelector('#factory-reset-error');

    input.addEventListener('input', () => {
        const match = input.value.trim().toUpperCase() === 'FACTORY RESET';
        confirmBtn.disabled = !match;
    });

    modal.querySelectorAll('[data-factory-reset-close]').forEach(el => {
        el.addEventListener('click', closeFactoryResetModal);
    });

    confirmBtn.addEventListener('click', () => performFactoryReset(confirmBtn, errorEl));

    setTimeout(() => input.focus(), 50);
}

function closeFactoryResetModal() {
    const modal = document.getElementById('factory-reset-modal');
    if (modal) modal.remove();
}

async function performFactoryReset(confirmBtn, errorEl) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Resetting…';
    errorEl.classList.add('hidden');

    try {
        await API.factoryReset();

        const modal = document.getElementById('factory-reset-modal');
        if (!modal) return;
        modal.querySelector('.modal-content').innerHTML = `
            <div class="modal-header">
                <h2>Device Rebooting</h2>
            </div>
            <div class="module-form">
                <p style="margin: 0; color: var(--text-primary); line-height: 1.5;">
                    The device is powering back down and will restart on the
                    <strong>Headwaters-XXXX</strong> setup WiFi network in about
                    one minute.
                </p>
                <p style="margin: 0; color: var(--text-secondary); line-height: 1.5;">
                    This browser will lose its connection now. When the setup
                    WiFi network appears in your phone's WiFi list, connect to
                    it and follow the setup portal.
                </p>
            </div>
        `;
    } catch (error) {
        console.error('Factory reset failed:', error);
        errorEl.textContent = 'Factory reset failed: ' + (error.message || 'Unknown error');
        errorEl.classList.remove('hidden');
        errorEl.classList.add('error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Reset Device';
    }
}

// --- System stats (WS-driven live update) ---

function updateSystemStatsDisplay(stats) {
    const tempEl = document.getElementById('stat-cpu-temp');
    const cpuEl = document.getElementById('stat-cpu-usage');
    const fanEl = document.getElementById('stat-fan-speed');
    if (tempEl) tempEl.textContent = stats.cpu_temp_c !== null ? `${stats.cpu_temp_c.toFixed(1)}°C` : 'N/A';
    if (cpuEl) cpuEl.textContent = stats.cpu_percent !== null ? `${stats.cpu_percent}%` : 'N/A';
    if (fanEl) fanEl.textContent = stats.fan_percent !== null ? `${stats.fan_percent}%` : 'N/A';

    const totalEl = document.getElementById('stat-disk-total');
    const usedEl  = document.getElementById('stat-disk-used');
    const freeEl  = document.getElementById('stat-disk-free');
    if (totalEl) totalEl.textContent = formatBytes(stats.disk_total_bytes);
    if (usedEl)  usedEl.textContent  = formatBytes(stats.disk_used_bytes);
    if (freeEl)  freeEl.textContent  = formatBytes(stats.disk_free_bytes);

    const fillEl = document.getElementById('disk-usage-fill');
    const barEl  = document.getElementById('disk-usage');
    if (fillEl && barEl && stats.disk_total_bytes) {
        const pct = (stats.disk_used_bytes / stats.disk_total_bytes) * 100;
        fillEl.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`;
        barEl.dataset.pressure = pct >= 90 ? 'danger'
                              : pct >= 75 ? 'warning'
                              : 'ok';
        barEl.setAttribute('aria-valuenow', pct.toFixed(0));
    }
}

async function setupSystemStats() {
    try {
        const stats = await API.getSystemStats();
        updateSystemStatsDisplay(stats);
    } catch {
        // Non-critical — WebSocket will provide updates
    }
    statsWsHandler = (stats) => updateSystemStatsDisplay(stats);
    wsClient.on('system_stats', statsWsHandler);
}
