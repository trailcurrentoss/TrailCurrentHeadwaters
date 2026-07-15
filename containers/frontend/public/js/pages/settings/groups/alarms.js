// Settings > Alarms & Notifications
//
// Composite group. Two independent pieces, both moved verbatim from
// their pre-consolidation homes:
//
//   1. Alarms — flat list of every digital input across configured
//      Picket + Switchback modules with per-sensor arm toggle, rename,
//      Solstice battery-level threshold, and the alarm-bell history
//      panel. (Formerly containers/frontend/public/js/pages/alarms.js.)
//
//   2. SMS Notifications — cellular router SMS relay config, extracted
//      from the legacy top-level settings.js.
//
// DOM IDs, class names, event handlers, and API calls are byte-identical
// to their pre-consolidation implementations to keep regression risk
// near zero.

import { API } from '../../../api.js';
import * as notifications from '../../../notifications.js';
import { alarmBell } from '../../../components/alarm-bell.js';

// --- SMS section state (independent of the alarms body below). ---
let smsSystemConfig = null;

// Local copy of settings.js escapeHtmlSettings — used only for SMS field
// values that echo back into the DOM.
function escapeHtmlSettings(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const LABEL_MAX = 24;
const SENSORS_PER = { switchback: 8, picket: 12 };

let sensors = {};        // "type:addr:sensor" → { armed, label }
let battery = { enabled: false, threshold: 20 };
let modules = [];        // configured picket/switchback modules
let saveTimer = null;
let batterySaveTimer = null;
let containerClickListener = null;
let containerInputListener = null;
let modalKeydownListener = null;
let historyChangeHandler = null;

function fmtHistTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function renderHistoryPanel() {
    const items = alarmBell.getHistory();
    if (items.length === 0) {
        return `
            <span class="alarm-history-label">Recent activity</span>
            <p class="alarm-history-empty">No alarm activity yet.</p>
        `;
    }
    const rows = items.map(it => `
        <div class="alarm-history-row">
            <span class="alarm-history-dot alarm-history-dot-${it.cleared ? 'cleared' : 'fired'}"></span>
            <span class="alarm-history-text">${escapeHtml(it.label || '(unnamed)')}</span>
            <span class="alarm-history-time">${escapeHtml(fmtHistTime(it.time))}</span>
            <span class="alarm-history-state">${it.cleared ? 'Cleared' : 'Fired'}</span>
        </div>
    `).join('');
    return `
        <span class="alarm-history-label">Recent activity</span>
        <div class="alarm-history-rows">${rows}</div>
    `;
}

function paintHistoryPanel() {
    const el = document.getElementById('alarms-history-panel');
    if (el) el.innerHTML = renderHistoryPanel();
}

function key(type, addr, sensor) { return `${type}:${addr}:${sensor}`; }

function defaultLabel(type, addr, sensor) {
    const prefix = type === 'switchback' ? 'SB' : 'PK';
    return `${prefix}${addr}-S${sensor}`;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Build a flat list of every sensor across configured modules.
function buildSensorList() {
    const rows = [];
    // Sort modules by type then addr for stable order.
    const sorted = [...modules].sort((a, b) =>
        a.type.localeCompare(b.type) || (a.addr ?? 0) - (b.addr ?? 0)
    );
    for (const m of sorted) {
        const type = m.type === 'switchback_relay' ? 'switchback' : m.type;
        if (type !== 'switchback' && type !== 'picket') continue;
        const addr = typeof m.addr === 'number' ? m.addr : 0;
        const count = SENSORS_PER[type];
        for (let sensor = 1; sensor <= count; sensor++) {
            rows.push({ type, addr, sensor });
        }
    }
    return rows;
}

function renderRow({ type, addr, sensor }) {
    const k = key(type, addr, sensor);
    const entry = sensors[k] || {};
    const armed = !!entry.armed;
    const label = entry.label || '';
    const ident = defaultLabel(type, addr, sensor);
    const display = label ? `${ident} <span class="alarm-row-custom">(${escapeHtml(label)})</span>` : ident;
    return `
        <li class="alarm-row" data-key="${k}">
            <div class="alarm-row-label">${display}</div>
            <div class="alarm-row-actions">
                <button class="alarm-rename-btn" data-action="rename" data-key="${k}" title="Rename">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 20h9"></path>
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                    </svg>
                </button>
                <div class="toggle-switch ${armed ? 'active' : ''}" data-action="toggle" data-key="${k}" role="switch" aria-checked="${armed}"></div>
            </div>
        </li>
    `;
}

function renderList() {
    const rows = buildSensorList();
    if (rows.length === 0) {
        return `
            <div class="alarms-empty">
                <p>No Picket or Switchback modules configured.</p>
                <p class="alarms-empty-hint">Add modules in Configuration to populate this list.</p>
            </div>
        `;
    }
    return `<ul class="alarms-list">${rows.map(renderRow).join('')}</ul>`;
}

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
            await API.updateAlarmsConfig(sensors);
        } catch (err) {
            console.error('[Alarms] Save failed:', err);
        }
    }, 300);
}

function scheduleBatterySave() {
    if (batterySaveTimer) clearTimeout(batterySaveTimer);
    batterySaveTimer = setTimeout(async () => {
        batterySaveTimer = null;
        try {
            await API.updateAlarmsBattery(battery);
        } catch (err) {
            console.error('[Alarms] Battery save failed:', err);
        }
    }, 300);
}

let pushCardStatus = '';

function renderPushCard() {
    const supported = notifications.isSupported();
    const perm = notifications.permissionState();
    const enabled = notifications.isEnabled();
    const disabled = !supported || perm === 'denied';

    let desc;
    if (!supported) {
        desc = 'This browser does not support notifications.';
    } else if (perm === 'denied') {
        desc = 'Notifications are blocked. Enable them in your device settings for this site.';
    } else if (enabled) {
        desc = 'Notifications are on. Keep this app open with the screen awake to receive alarms offline.';
    } else {
        desc = 'Show a device notification when a sensor fires an alarm. Works over the vehicle Wi-Fi with no internet needed — keep this app open on a dashboard tablet or phone on charge.';
    }

    const testBtn = (perm === 'granted')
        ? `<button class="btn-secondary alarm-push-test-btn" data-action="push-test">Send test notification</button>`
        : '';
    const status = pushCardStatus
        ? `<div class="alarm-push-status">${escapeHtml(pushCardStatus)}</div>`
        : '';

    return `
        <div class="alarm-push-card">
            <div class="alarm-push-header">
                <div class="alarm-push-label">
                    <div class="alarm-push-title">Alarm Notifications</div>
                    <div class="alarm-push-desc">${escapeHtml(desc)}</div>
                </div>
                <div class="toggle-switch ${enabled ? 'active' : ''} ${disabled ? 'is-disabled' : ''}"
                     data-action="push-toggle" role="switch"
                     aria-checked="${enabled}"
                     aria-disabled="${disabled}"></div>
            </div>
            ${testBtn ? `<div class="alarm-push-actions">${testBtn}</div>` : ''}
            ${status}
        </div>
    `;
}

function refreshPushCard() {
    const container = document.getElementById('alarms-push-container');
    if (container) container.innerHTML = renderPushCard();
}

function setPushStatus(msg) {
    pushCardStatus = msg || '';
    refreshPushCard();
    if (pushCardStatus) {
        setTimeout(() => {
            if (pushCardStatus === msg) {
                pushCardStatus = '';
                refreshPushCard();
            }
        }, 8000);
    }
}

async function handlePushToggle() {
    if (!notifications.isSupported()) {
        setPushStatus('This browser does not support notifications.');
        return;
    }
    if (notifications.permissionState() === 'denied') {
        setPushStatus('Permission was denied earlier — enable it in your device notification settings.');
        return;
    }

    if (notifications.isEnabled()) {
        notifications.setEnabled(false);
        await notifications.disableWakeLock();
        setPushStatus('Notifications turned off.');
        refreshPushCard();
        return;
    }

    const perm = await notifications.requestPermission();
    if (perm !== 'granted') {
        if (perm === 'denied') {
            setPushStatus('Permission denied. Change it in your device notification settings for this site.');
        } else {
            setPushStatus(`Permission prompt was dismissed — tap again to retry.`);
        }
        refreshPushCard();
        return;
    }

    notifications.setEnabled(true);
    notifications.startAlarmNotifier();
    const wl = await notifications.enableWakeLock();
    if (wl.ok) {
        setPushStatus('Enabled. Screen will stay awake so alarms fire even when the vehicle has no internet.');
    } else if (wl.reason === 'unsupported') {
        setPushStatus('Enabled. Note: this browser does not support keeping the screen awake — alarms may stop if the display sleeps.');
    } else {
        setPushStatus('Enabled, but could not keep the screen awake. Alarms may stop if the display sleeps.');
    }
    refreshPushCard();
}

async function handlePushTest() {
    const result = await notifications.fireTestNotification();
    if (result && result.ok) {
        setPushStatus('Test notification fired. If nothing appeared, check OS-level notification settings for this app.');
    } else {
        setPushStatus(`Test failed: ${result && result.error ? result.error : 'unknown error'}.`);
    }
}

function renderBatteryCard() {
    const enabled = !!battery.enabled;
    const threshold = Number.isFinite(battery.threshold) ? battery.threshold : 20;
    return `
        <div class="alarm-battery-card">
            <div class="alarm-battery-header">
                <div class="alarm-battery-label">
                    <div class="alarm-battery-title">Solstice Battery Level</div>
                    <div class="alarm-battery-desc">
                        Alarm when battery state of charge drops below the threshold.
                    </div>
                </div>
                <div class="toggle-switch ${enabled ? 'active' : ''}" data-action="battery-toggle"
                     role="switch" aria-checked="${enabled}"></div>
            </div>
            <div class="alarm-battery-slider-row ${enabled ? '' : 'is-disabled'}">
                <input type="range" min="0" max="100" step="1" value="${threshold}"
                       id="alarm-battery-slider" class="alarm-battery-slider"
                       aria-label="Battery threshold percent"
                       style="--pct: ${threshold}"
                       ${enabled ? '' : 'disabled'}>
                <span class="alarm-battery-pct" id="alarm-battery-pct">${threshold}%</span>
            </div>
        </div>
    `;
}

function setEntry(k, partial) {
    const cur = sensors[k] || {};
    const next = { ...cur, ...partial };
    if (typeof next.label === 'string' && next.label.trim() === '') delete next.label;
    if (next.armed === false) delete next.armed;
    if (next.armed || next.label) sensors[k] = next;
    else delete sensors[k];
}

function handleToggle(k) {
    const wasArmed = !!(sensors[k] && sensors[k].armed);
    setEntry(k, { armed: !wasArmed });
    const el = document.querySelector(`.toggle-switch[data-key="${k}"]`);
    if (el) {
        el.classList.toggle('active', !wasArmed);
        el.setAttribute('aria-checked', String(!wasArmed));
    }
    scheduleSave();
}

function handleBatteryToggle() {
    battery.enabled = !battery.enabled;
    const el = document.querySelector('[data-action="battery-toggle"]');
    if (el) {
        el.classList.toggle('active', battery.enabled);
        el.setAttribute('aria-checked', String(battery.enabled));
    }
    const sliderRow = document.querySelector('.alarm-battery-slider-row');
    const slider = document.getElementById('alarm-battery-slider');
    if (sliderRow) sliderRow.classList.toggle('is-disabled', !battery.enabled);
    if (slider) slider.disabled = !battery.enabled;
    scheduleBatterySave();
}

function handleBatterySliderInput(value) {
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    battery.threshold = v;
    const slider = document.getElementById('alarm-battery-slider');
    const pct = document.getElementById('alarm-battery-pct');
    if (slider) slider.style.setProperty('--pct', v);
    if (pct) pct.textContent = `${v}%`;
    scheduleBatterySave();
}

function openRenameModal(k) {
    const [type, addrStr, sensorStr] = k.split(':');
    const addr = parseInt(addrStr, 10);
    const sensor = parseInt(sensorStr, 10);
    const ident = defaultLabel(type, addr, sensor);
    const current = (sensors[k] && sensors[k].label) || '';

    const modal = document.createElement('div');
    modal.className = 'alarm-rename-modal';
    modal.innerHTML = `
        <div class="alarm-rename-modal-content">
            <h3>Rename Sensor</h3>
            <p class="alarm-rename-subtitle">${ident}</p>
            <input type="text" id="alarm-rename-input" class="form-input" maxlength="${LABEL_MAX}"
                value="${escapeHtml(current)}" placeholder="Custom name (optional)" autocomplete="off">
            <p class="form-hint">Leave blank to use the default identifier.</p>
            <div class="alarm-rename-actions">
                <button class="btn-secondary" data-action="rename-cancel">Cancel</button>
                <button class="btn-primary" data-action="rename-save" data-key="${k}">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Modal lives outside .page-alarms, so the page-scoped delegated click
    // handler never sees these. Bind directly on the modal.
    modal.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]');
        if (!action) return;
        const kind = action.dataset.action;
        if (kind === 'rename-cancel') closeRenameModal();
        else if (kind === 'rename-save') saveRename(action.dataset.key || k);
    });

    const input = modal.querySelector('#alarm-rename-input');
    input.focus();
    input.select();

    modalKeydownListener = (e) => {
        if (e.key === 'Escape') closeRenameModal();
        else if (e.key === 'Enter') saveRename(k);
    };
    document.addEventListener('keydown', modalKeydownListener);
}

function closeRenameModal() {
    const modal = document.querySelector('.alarm-rename-modal');
    if (modal) modal.remove();
    if (modalKeydownListener) {
        document.removeEventListener('keydown', modalKeydownListener);
        modalKeydownListener = null;
    }
}

function saveRename(k) {
    const input = document.getElementById('alarm-rename-input');
    if (!input) return;
    const label = input.value.trim().slice(0, LABEL_MAX);
    setEntry(k, { label });
    closeRenameModal();
    // Re-render the affected row in place.
    const row = document.querySelector(`.alarm-row[data-key="${k}"]`);
    if (row) {
        const [type, addrStr, sensorStr] = k.split(':');
        row.outerHTML = renderRow({
            type,
            addr: parseInt(addrStr, 10),
            sensor: parseInt(sensorStr, 10),
        });
    }
    scheduleSave();
}

function handleContainerClick(e) {
    const action = e.target.closest('[data-action]');
    if (!action) return;
    const kind = action.dataset.action;
    const k = action.dataset.key;
    if (kind === 'toggle' && k) {
        handleToggle(k);
    } else if (kind === 'rename' && k) {
        openRenameModal(k);
    } else if (kind === 'rename-cancel') {
        closeRenameModal();
    } else if (kind === 'rename-save' && k) {
        saveRename(k);
    } else if (kind === 'battery-toggle') {
        handleBatteryToggle();
    } else if (kind === 'push-toggle') {
        handlePushToggle();
    } else if (kind === 'push-test') {
        handlePushTest();
    }
}

function handleContainerInput(e) {
    if (e.target && e.target.id === 'alarm-battery-slider') {
        handleBatterySliderInput(e.target.value);
    }
}

export const alarmsGroup = {
    meta: {
        id: 'alarms',
        title: 'Alarms & Notifications',
        icon: 'notifications-outline',
        sub: 'Sensor alarms, SMS',
    },
    searchIndex: [
        { label: 'Alarm Notifications',    kw: 'alarm notification bell sensor door wifi push', anchor: 'alarms-push-container' },
        { label: 'Solstice Battery Level', kw: 'battery alarm threshold state of charge solstice', anchor: 'alarms-battery-container' },
        { label: 'Sensor Alarms',          kw: 'sensor alarm arm disarm picket switchback rename', anchor: 'alarms-list-container' },
        { label: 'SMS Notifications',      kw: 'sms text message cellular router sendsms ssh',    anchor: 'sms-config-fields' },
    ],

    render() {
        return `
            <section class="page-alarms">
                <h1 class="section-title">Alarms</h1>
                <div class="alarms-layout">
                    <div class="card">
                        <p class="alarms-intro">
                            Arm individual sensors to surface their state in the alarm bell.
                            A sensor that auto-clears (e.g. a door re-closing) clears its alarm.
                        </p>
                        <div id="alarms-push-container"></div>
                        <div id="alarms-battery-container">
                            <p class="alarms-loading">Loading…</p>
                        </div>
                        <div id="alarms-list-container">
                            <p class="alarms-loading">Loading…</p>
                        </div>
                    </div>
                    <aside id="alarms-history-panel" class="alarm-history-panel">
                        ${renderHistoryPanel()}
                    </aside>
                </div>
            </section>
            ${renderSmsSection()}
        `;
    },

    async init() {
        // 1) Alarms body init (verbatim from the pre-consolidation page).
        const listContainer = document.getElementById('alarms-list-container');
        const batteryContainer = document.getElementById('alarms-battery-container');
        if (listContainer && batteryContainer) {
            try {
                const [config, sysCfg] = await Promise.all([
                    API.getAlarmsConfig(),
                    API.getSystemConfig(),
                ]);
                sensors = (config && config.sensors) || {};
                const b = (config && config.battery) || {};
                battery = {
                    enabled: b.enabled === true,
                    threshold: Number.isFinite(Number(b.threshold)) ? Number(b.threshold) : 20,
                };
                modules = (sysCfg && sysCfg.mcu_modules) || [];
                batteryContainer.innerHTML = renderBatteryCard();
                listContainer.innerHTML = renderList();
                refreshPushCard();
            } catch (err) {
                console.error('[Alarms] Failed to load:', err);
                listContainer.innerHTML = '<p style="color: var(--danger);">Failed to load alarms configuration.</p>';
            }

            const page = document.querySelector('.page-alarms');
            if (page) {
                containerClickListener = handleContainerClick;
                containerInputListener = handleContainerInput;
                page.addEventListener('click', containerClickListener);
                page.addEventListener('input', containerInputListener);
            }

            // Live-repaint the history panel when alarms fire or clear.
            historyChangeHandler = () => paintHistoryPanel();
            alarmBell.addEventListener('change', historyChangeHandler);
        }

        // 2) SMS section init — load system config + populate form.
        try {
            smsSystemConfig = await API.getSystemConfig();
        } catch (err) {
            console.error('[Alarms/SMS] Failed to load system config:', err);
            smsSystemConfig = {};
        }
        populateSmsFields();
        wireSmsListeners();
    },

    cleanup() {
        // 1) Alarms body cleanup (verbatim from pre-consolidation).
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        if (batterySaveTimer) {
            clearTimeout(batterySaveTimer);
            batterySaveTimer = null;
        }
        const page = document.querySelector('.page-alarms');
        if (page) {
            if (containerClickListener) page.removeEventListener('click', containerClickListener);
            if (containerInputListener) page.removeEventListener('input', containerInputListener);
        }
        containerClickListener = null;
        containerInputListener = null;
        if (historyChangeHandler) {
            alarmBell.removeEventListener('change', historyChangeHandler);
            historyChangeHandler = null;
        }
        closeRenameModal();
        sensors = {};
        battery = { enabled: false, threshold: 20 };
        modules = [];

        // 2) SMS section cleanup. Listeners attach to elements that get
        // removed with the mount's innerHTML swap, so only state needs
        // clearing here.
        smsSystemConfig = null;
    }
};

// =====================================================================
// SMS Notifications section (moved verbatim from legacy settings.js)
// =====================================================================

function renderSmsSection() {
    return `
        <section class="settings-v2-sms-wrap">
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
                        <button class="toggle-switch"
                                id="sms-enabled-toggle"
                                aria-pressed="false">
                        </button>
                    </div>
                    <div id="sms-config-fields" class="sms-config-fields hidden">
                        <div class="password-form-group">
                            <label class="password-label" for="settings-sms-phone">Phone Number</label>
                            <input type="tel" id="settings-sms-phone" class="password-input"
                                   placeholder="+15551234567"
                                   value="">
                        </div>
                        <div class="password-form-group">
                            <label class="password-label" for="settings-sms-router-ip">Router IP Address</label>
                            <input type="text" id="settings-sms-router-ip" class="password-input"
                                   placeholder="192.168.1.1"
                                   value="">
                        </div>
                        <div class="password-form-group">
                            <label class="password-label" for="settings-sms-ssh-key">SSH Private Key</label>
                            <textarea id="settings-sms-ssh-key" class="password-input sms-ssh-key-textarea"
                                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                                      rows="6"></textarea>
                        </div>
                        <div class="sms-throttle-row">
                            <div class="password-form-group sms-throttle-field">
                                <label class="password-label" for="settings-sms-max-messages">Max messages</label>
                                <input type="number" id="settings-sms-max-messages" class="password-input"
                                       min="1" max="100" value="3">
                            </div>
                            <div class="sms-throttle-separator">per</div>
                            <div class="password-form-group sms-throttle-field">
                                <label class="password-label" for="settings-sms-throttle-window">Minutes</label>
                                <input type="number" id="settings-sms-throttle-window" class="password-input"
                                       min="1" max="1440" value="60">
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
        </section>
    `;
}

function populateSmsFields() {
    if (!smsSystemConfig) return;
    const toggle   = document.getElementById('sms-enabled-toggle');
    const fields   = document.getElementById('sms-config-fields');
    const phone    = document.getElementById('settings-sms-phone');
    const ip       = document.getElementById('settings-sms-router-ip');
    const ssh      = document.getElementById('settings-sms-ssh-key');
    const maxMsg   = document.getElementById('settings-sms-max-messages');
    const throttle = document.getElementById('settings-sms-throttle-window');

    const enabled = !!smsSystemConfig.sms_enabled;
    if (toggle) {
        toggle.classList.toggle('active', enabled);
        toggle.setAttribute('aria-pressed', String(enabled));
    }
    if (fields) fields.classList.toggle('hidden', !enabled);
    if (phone)    phone.value    = smsSystemConfig.sms_phone_number || '';
    if (ip)       ip.value       = smsSystemConfig.sms_router_ip || '';
    if (ssh)      ssh.value      = smsSystemConfig.sms_ssh_key || '';
    if (maxMsg)   maxMsg.value   = smsSystemConfig.sms_max_messages || 3;
    if (throttle) throttle.value = smsSystemConfig.sms_throttle_window_minutes || 60;
    void escapeHtmlSettings;   // kept for parity with settings.js; unused
}

function wireSmsListeners() {
    const smsEnabledToggle = document.getElementById('sms-enabled-toggle');
    if (smsEnabledToggle) {
        smsEnabledToggle.addEventListener('click', async () => {
            const isEnabled = smsEnabledToggle.classList.toggle('active');
            smsEnabledToggle.setAttribute('aria-pressed', isEnabled);
            const smsFields = document.getElementById('sms-config-fields');
            if (smsFields) {
                smsFields.classList.toggle('hidden', !isEnabled);
            }
            if (!isEnabled) {
                try {
                    smsSystemConfig = await API.updateSystemConfig({ sms_enabled: false });
                    showSmsConfigMessage('SMS disabled', 'success');
                } catch (error) {
                    smsEnabledToggle.classList.add('active');
                    smsEnabledToggle.setAttribute('aria-pressed', true);
                    if (smsFields) smsFields.classList.remove('hidden');
                    showSmsConfigMessage(error.message || 'Failed to disable SMS', 'error');
                }
            }
        });
    }
    const saveSmsBtn = document.getElementById('save-sms-config-btn');
    if (saveSmsBtn) saveSmsBtn.addEventListener('click', handleSaveSmsConfig);
    const testSmsBtn = document.getElementById('test-sms-btn');
    if (testSmsBtn) testSmsBtn.addEventListener('click', handleTestSms);
}

async function handleSaveSmsConfig() {
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
        showSmsConfigMessage('Please enter a phone number', 'error');
        return;
    }
    if (smsEnabled && !smsRouterIp) {
        showSmsConfigMessage('Please enter the router IP address', 'error');
        return;
    }
    if (smsEnabled && !smsSshKey) {
        showSmsConfigMessage('Please paste the SSH private key', 'error');
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        smsSystemConfig = await API.updateSystemConfig({
            sms_enabled: smsEnabled,
            sms_phone_number: smsPhoneNumber,
            sms_router_ip: smsRouterIp,
            sms_ssh_key: smsSshKey,
            sms_max_messages: smsMaxMessages,
            sms_throttle_window_minutes: smsThrottleWindow,
        });
        showSmsConfigMessage('SMS settings saved successfully', 'success');
    } catch (error) {
        showSmsConfigMessage(error.message || 'Failed to save SMS settings', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save SMS Settings';
    }
}

async function handleTestSms() {
    const messageEl = document.getElementById('sms-config-message');
    const testBtn = document.getElementById('test-sms-btn');

    messageEl.classList.add('hidden');
    messageEl.classList.remove('success', 'error');

    const phoneNumber = document.getElementById('settings-sms-phone').value.trim();
    const routerIp = document.getElementById('settings-sms-router-ip').value.trim();
    const sshKey = document.getElementById('settings-sms-ssh-key').value;

    if (!phoneNumber || !routerIp || !sshKey) {
        showSmsConfigMessage('Please fill in all SMS fields before testing', 'error');
        return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Sending...';

    try {
        const result = await API.testSms(phoneNumber, routerIp, sshKey);
        showSmsConfigMessage(result.output || 'Test SMS sent successfully', 'success');
    } catch (error) {
        showSmsConfigMessage(error.message || 'Failed to send test SMS', 'error');
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Send Test SMS';
    }
}

function showSmsConfigMessage(message, type) {
    const messageEl = document.getElementById('sms-config-message');
    if (messageEl) {
        messageEl.textContent = message;
        messageEl.classList.remove('hidden', 'success', 'error');
        messageEl.classList.add(type);
    }
}
