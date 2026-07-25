// Settings > General
// Dark Mode, Trailer, Units, Time Zone — extracted verbatim from the
// legacy settings.js. DOM IDs, class names, handlers, and API calls are
// preserved so pre-existing units/trailer/theme wiring works untouched.

import { API } from '../../../api.js';
import { units } from '../../../services/units.js';

let settings = null;
let currentTimezone = null;

export const generalGroup = {
    meta: {
        id: 'general',
        title: 'General',
        icon: 'options-outline',
        sub: 'Display, units, time zone',
    },
    searchIndex: [
        { label: 'Dark Mode',         kw: 'theme appearance dark light display',   anchor: 'theme-toggle' },
        { label: 'Speed Units',       kw: 'mph kph units speed',                   anchor: 'units-speed-choices' },
        { label: 'Temperature Units', kw: 'temperature celsius fahrenheit units',  anchor: 'units-temp-choices' },
        { label: 'Elevation Units',   kw: 'elevation feet meters altitude units',  anchor: 'units-length-choices' },
        { label: 'Time Zone',         kw: 'timezone iana timedatectl clock host',  anchor: 'settings-timezone-select' },
    ],

    render() {
        // Skeleton — real HTML fills in after init() fetches the data.
        return `<div id="settings-general-container"><p class="alarms-loading">Loading…</p></div>`;
    },

    async init() {
        try {
            const [data, tzResp] = await Promise.all([
                API.getSettings(),
                API.getTimezone().catch(err => {
                    console.warn('Timezone load failed:', err);
                    return null;
                }),
            ]);
            settings = data;
            currentTimezone = (tzResp && tzResp.tz) || null;
        } catch (err) {
            console.error('Failed to fetch general settings:', err);
            const c = document.getElementById('settings-general-container');
            if (c) c.innerHTML = '<p style="color: var(--danger);">Failed to load settings</p>';
            return;
        }
        const c = document.getElementById('settings-general-container');
        if (c) c.innerHTML = renderInner();
        wireListeners();
        initTimezoneCard();
    },

    cleanup() {
        settings = null;
        currentTimezone = null;
    },
};

function renderInner() {
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

        <!-- Units -->
        <div class="card settings-item-vertical">
            <div class="settings-item-header">
                <span class="settings-label">Units</span>
                <p class="settings-description">Choose how speeds and temperatures are displayed throughout the app. Sensor data is stored unconverted; only the display changes.</p>
            </div>
            <div class="settings-units-container">
                <div class="settings-units-row">
                    <span class="settings-units-label">Speed</span>
                    <div class="settings-units-choices" id="units-speed-choices">
                        <button class="settings-units-btn ${settings.units_speed === 'kph' ? '' : 'active'}" data-units-speed="mph">mph</button>
                        <button class="settings-units-btn ${settings.units_speed === 'kph' ? 'active' : ''}" data-units-speed="kph">kph</button>
                    </div>
                </div>
                <div class="settings-units-row">
                    <span class="settings-units-label">Temperature</span>
                    <div class="settings-units-choices" id="units-temp-choices">
                        <button class="settings-units-btn ${settings.units_temperature === 'C' ? '' : 'active'}" data-units-temperature="F">°F</button>
                        <button class="settings-units-btn ${settings.units_temperature === 'C' ? 'active' : ''}" data-units-temperature="C">°C</button>
                    </div>
                </div>
                <div class="settings-units-row">
                    <span class="settings-units-label">Elevation</span>
                    <div class="settings-units-choices" id="units-length-choices">
                        <button class="settings-units-btn ${settings.units_length === 'm' ? '' : 'active'}" data-units-length="ft">ft</button>
                        <button class="settings-units-btn ${settings.units_length === 'm' ? 'active' : ''}" data-units-length="m">m</button>
                    </div>
                </div>
            </div>
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
    `;
}

function wireListeners() {
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

    // Units — speed + temperature. Each container has two buttons; the
    // clicked one becomes active and the pref is persisted immediately.
    const KEY_TO_PREF = { units_speed: 'speed', units_temperature: 'temperature', units_length: 'length' };
    const setupUnitsGroup = (containerId, dataAttr, key) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.addEventListener('click', async (e) => {
            const btn = e.target.closest(`.settings-units-btn[${dataAttr}]`);
            if (!btn) return;
            const value = btn.getAttribute(dataAttr);
            if (!value) return;
            container.querySelectorAll('.settings-units-btn').forEach(b =>
                b.classList.toggle('active', b === btn));
            // Optimistically update the units service so labels flip
            // instantly — before the API round-trip lands.
            const prefKey = KEY_TO_PREF[key];
            if (prefKey) units.updatePrefs({ [prefKey]: value });
            try {
                settings = await API.setSettings({ [key]: value });
            } catch (error) {
                console.error(`Failed to save ${key}:`, error);
            }
        });
    };
    setupUnitsGroup('units-speed-choices',  'data-units-speed',       'units_speed');
    setupUnitsGroup('units-temp-choices',   'data-units-temperature', 'units_temperature');
    setupUnitsGroup('units-length-choices', 'data-units-length',      'units_length');

    // Time zone: apply
    const saveTzBtn = document.getElementById('save-timezone-btn');
    if (saveTzBtn) {
        saveTzBtn.addEventListener('click', handleSaveTimezone);
    }
}

function initTimezoneCard() {
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

    const browserTz = (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
        catch (_) { return null; }
    })();
    const selectedTz = currentTimezone || browserTz || 'UTC';

    select.innerHTML = zones.map(z =>
        `<option value="${z}" ${z === selectedTz ? 'selected' : ''}>${z}</option>`
    ).join('');

    const refreshSaveState = () => {
        if (!saveBtn) return;
        saveBtn.disabled = (select.value === currentTimezone);
    };
    refreshSaveState();
    select.addEventListener('change', refreshSaveState);
}

async function handleSaveTimezone() {
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
        if ([...select.options].some(o => o.value === currentTimezone)) {
            select.value = currentTimezone;
        }
        showTimezoneMsg(`Time zone set to ${currentTimezone}`, 'success');
    } catch (err) {
        showTimezoneMsg(err.message || 'Failed to set time zone', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.textContent = originalLabel || 'Apply Time Zone';
            saveBtn.disabled = (select.value === currentTimezone);
        }
    }
}

function showTimezoneMsg(text, type) {
    const msg = document.getElementById('timezone-message');
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'password-message ' + (type === 'error' ? 'error' : 'success');
    msg.classList.remove('hidden');
}
