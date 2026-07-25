// Settings > Vehicle
// Vehicle-level properties consumed by the rig's sensor modules:
//   - Plateau mounting/dimensions (broadcast via CAN 0x36 subcmd 0x01
//     by the system-config PUT handler)
//   - Trailer axles (drives the tire-slot layout in Driving mode)

import { API } from '../../../api.js';
import { trailerConfig } from '../../../services/trailer-config.js';

let systemConfig = null;
let settings = null;

const MOUNTING_LABEL = ['Floor', 'Left Wall', 'Right Wall'];

export const vehicleGroup = {
    meta: {
        id: 'vehicle',
        title: 'Vehicle',
        icon: 'car-outline',
        sub: 'Mounting, dimensions, axles',
    },
    searchIndex: [
        { label: 'Plateau Mounting Surface', kw: 'plateau mounting floor wall left right imu leveling orientation', anchor: 'vehicle-mounting' },
        { label: 'Vehicle Length',           kw: 'plateau vehicle length dimensions leveling',                       anchor: 'vehicle-length' },
        { label: 'Vehicle Width',            kw: 'plateau vehicle width dimensions leveling',                        anchor: 'vehicle-width' },
        { label: 'Trailer Axles',            kw: 'trailer axles tire pressure single tandem triple',                 anchor: 'vehicle-axles' },
    ],

    render() {
        return `<div id="settings-vehicle-container"><p class="alarms-loading">Loading…</p></div>`;
    },

    async init() {
        try {
            const [sc, s] = await Promise.all([
                API.getSystemConfig(),
                API.getSettings(),
            ]);
            systemConfig = sc || {};
            settings = s || {};
        } catch (err) {
            console.error('Failed to fetch vehicle settings:', err);
            const c = document.getElementById('settings-vehicle-container');
            if (c) c.innerHTML = '<p style="color: var(--danger);">Failed to load vehicle settings</p>';
            return;
        }
        const c = document.getElementById('settings-vehicle-container');
        if (c) c.innerHTML = renderInner();
        wireListeners();
    },

    cleanup() {
        systemConfig = null;
        settings = null;
    },
};

function renderInner() {
    const mounting = Number.isInteger(systemConfig.vehicle_mounting) ? systemConfig.vehicle_mounting : 0;
    const lengthCm = Number.isInteger(systemConfig.vehicle_length_cm) ? systemConfig.vehicle_length_cm : 500;
    const widthCm = Number.isInteger(systemConfig.vehicle_width_cm) ? systemConfig.vehicle_width_cm : 200;
    const axles = Number(settings.trailer_axles ?? 2);

    return `
        <!-- Plateau mounting -->
        <div class="card settings-item-vertical">
            <div class="settings-item-header">
                <span class="settings-label">Plateau Mounting Surface</span>
                <p class="settings-description">Where the Plateau IMU is physically mounted in the vehicle. Sent to Plateau via CAN and persisted on the module.</p>
            </div>
            <div class="settings-units-container">
                <div class="settings-units-row">
                    <span class="settings-units-label">Surface</span>
                    <div class="settings-units-choices" id="vehicle-mounting">
                        ${[0, 1, 2].map(v => `
                            <button class="settings-units-btn ${mounting === v ? 'active' : ''}" data-mounting="${v}">${MOUNTING_LABEL[v]}</button>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>

        <!-- Vehicle dimensions -->
        <div class="card settings-item-vertical">
            <div class="settings-item-header">
                <span class="settings-label">Vehicle Dimensions</span>
                <p class="settings-description">Total length and width of the vehicle, in centimeters. Used by Plateau to compute per-corner height adjustments.</p>
            </div>
            <div class="settings-units-container">
                <div class="settings-units-row">
                    <label for="vehicle-length" class="settings-units-label">Length (cm)</label>
                    <input type="number" id="vehicle-length" class="form-input"
                           min="1" max="65535" value="${lengthCm}">
                </div>
                <div class="settings-units-row">
                    <label for="vehicle-width" class="settings-units-label">Width (cm)</label>
                    <input type="number" id="vehicle-width" class="form-input"
                           min="1" max="65535" value="${widthCm}">
                </div>
                <div class="settings-units-row" style="justify-content: flex-end;">
                    <button class="password-submit-btn" id="vehicle-dims-save" disabled>Save Dimensions</button>
                </div>
                <div id="vehicle-dims-message" class="password-message hidden"></div>
            </div>
        </div>

        <!-- Trailer axles -->
        <div class="card settings-item-vertical">
            <div class="settings-item-header">
                <span class="settings-label">Trailer Axles</span>
                <p class="settings-description">Number of axles on your trailer. Determines the tire slots and pressure readouts in Driving mode.</p>
            </div>
            <div class="settings-units-container">
                <div class="settings-units-row">
                    <span class="settings-units-label">Axles</span>
                    <div class="settings-units-choices" id="vehicle-axles">
                        <button class="settings-units-btn ${axles === 1 ? 'active' : ''}" data-trailer-axles="1">Single</button>
                        <button class="settings-units-btn ${axles === 2 ? 'active' : ''}" data-trailer-axles="2">Tandem</button>
                        <button class="settings-units-btn ${axles === 3 ? 'active' : ''}" data-trailer-axles="3">Triple</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function wireListeners() {
    // Mounting: instant-save segmented control
    const mountingContainer = document.getElementById('vehicle-mounting');
    if (mountingContainer) {
        mountingContainer.addEventListener('click', async (e) => {
            const btn = e.target.closest('.settings-units-btn[data-mounting]');
            if (!btn) return;
            const value = Number(btn.getAttribute('data-mounting'));
            if (![0, 1, 2].includes(value)) return;
            const prev = systemConfig.vehicle_mounting;
            mountingContainer.querySelectorAll('.settings-units-btn').forEach(b =>
                b.classList.toggle('active', b === btn));
            try {
                systemConfig = await API.updateSystemConfig({ vehicle_mounting: value });
            } catch (err) {
                console.error('Failed to save vehicle_mounting:', err);
                // Revert visual state
                mountingContainer.querySelectorAll('.settings-units-btn').forEach(b =>
                    b.classList.toggle('active', Number(b.getAttribute('data-mounting')) === prev));
            }
        });
    }

    // Dimensions: explicit Save button (avoids CAN-flooding while user types)
    const lengthInput = document.getElementById('vehicle-length');
    const widthInput = document.getElementById('vehicle-width');
    const saveBtn = document.getElementById('vehicle-dims-save');
    const msgEl = document.getElementById('vehicle-dims-message');

    const baseline = { length: Number(lengthInput?.value), width: Number(widthInput?.value) };
    const refreshSaveState = () => {
        if (!saveBtn) return;
        const l = Number(lengthInput.value);
        const w = Number(widthInput.value);
        const validL = Number.isInteger(l) && l >= 1 && l <= 65535;
        const validW = Number.isInteger(w) && w >= 1 && w <= 65535;
        const changed = l !== baseline.length || w !== baseline.width;
        saveBtn.disabled = !(validL && validW && changed);
    };
    lengthInput?.addEventListener('input', refreshSaveState);
    widthInput?.addEventListener('input', refreshSaveState);

    saveBtn?.addEventListener('click', async () => {
        const l = parseInt(lengthInput.value, 10);
        const w = parseInt(widthInput.value, 10);
        if (!Number.isInteger(l) || l < 1 || l > 65535 || !Number.isInteger(w) || w < 1 || w > 65535) {
            showDimsMsg('Length and width must be integers between 1 and 65535 cm', 'error');
            return;
        }
        saveBtn.disabled = true;
        const label = saveBtn.textContent;
        saveBtn.textContent = 'Saving…';
        try {
            systemConfig = await API.updateSystemConfig({
                vehicle_length_cm: l,
                vehicle_width_cm: w,
            });
            baseline.length = l;
            baseline.width = w;
            showDimsMsg('Dimensions saved', 'success');
        } catch (err) {
            showDimsMsg(err.message || 'Failed to save dimensions', 'error');
        } finally {
            saveBtn.textContent = label;
            refreshSaveState();
        }
    });

    // Axles: instant-save (mirrors old General behavior)
    const axlesContainer = document.getElementById('vehicle-axles');
    if (axlesContainer) {
        axlesContainer.addEventListener('click', async (e) => {
            const btn = e.target.closest('.settings-units-btn[data-trailer-axles]');
            if (!btn) return;
            const value = Number(btn.getAttribute('data-trailer-axles'));
            if (![1, 2, 3].includes(value)) return;
            axlesContainer.querySelectorAll('.settings-units-btn').forEach(b =>
                b.classList.toggle('active', b === btn));
            try {
                settings = await API.setSettings({ trailer_axles: value });
                trailerConfig.primeFromSettings(settings);
            } catch (err) {
                console.error('Failed to save trailer_axles:', err);
            }
        });
    }
}

function showDimsMsg(text, type) {
    const msg = document.getElementById('vehicle-dims-message');
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'password-message ' + (type === 'error' ? 'error' : 'success');
    msg.classList.remove('hidden');
}
