// Storage mode — remote monitoring from the Farwatch cloud.
//
// Unlike every other page in the app, Storage does NOT depend on the local
// Overlook backend or WebSocket. It polls Farwatch directly from the
// browser using cached cloud credentials. This lets the user see rig
// telemetry when they're at home / on the road and Overlook's LAN is
// unreachable.
//
// If cloud credentials haven't been configured (`Settings → Cloud`), the
// page renders a guided empty state instead of failing.

import { farwatchClient } from '../services/farwatch-client.js';
import { reverseGeocode, formatPlace } from '../services/reverse-geocode.js';
import { units } from '../services/units.js';

const state = {
    status: 'idle',
    data: {},
    place: null,     // reverse-geocoded location record
};

let statusHandler = null;
let changeHandler = null;
let unitsHandler = null;

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(v, decimals = 0, unit = '') {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return Number(v).toFixed(decimals) + (unit ? ` ${unit}` : '');
}

function formatLastSync(settings) {
    // Farwatch stores a last-checkin timestamp on the settings record.
    const ts = settings?.last_seen_at || settings?.updated_at || null;
    if (!ts) return 'Unknown';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return 'Unknown';
    const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}

function renderEmptyState() {
    return `
        <div class="storage-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" class="storage-empty-icon">
                <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
            </svg>
            <h2>Cloud not configured</h2>
            <p>Storage mode reads live telemetry from Farwatch when your rig
               is away from you. Configure the cloud connection under
               <strong>Settings → Cloud</strong> while you're on the vehicle
               Wi-Fi, and this page will start populating.</p>
        </div>
    `;
}

function renderTiles() {
    const energy = state.data.energy || {};
    const water = state.data.water || {};
    const air = state.data.airquality || {};

    const interior = air.temp_f ?? null;
    const humidity = air.humidity_percent ?? null;
    const battery = energy.battery_percent;
    const voltage = energy.battery_voltage;
    const solar = energy.solar_watts;

    const water_line = (
        [water.fresh, water.grey, water.black]
            .map(v => (v === null || v === undefined ? '—' : `${Math.round(v)}%`))
            .join(' · ')
    );

    return `
        <div class="storage-tiles">
            <div class="storage-tile">
                <span class="storage-tile-label">Battery</span>
                <span class="storage-tile-value">${fmt(battery, 0, '%')}</span>
                <span class="storage-tile-sub">${fmt(voltage, 1, 'V')} · Solar ${fmt(solar, 0, 'W')}</span>
            </div>
            <div class="storage-tile">
                <span class="storage-tile-label">Interior</span>
                <span class="storage-tile-value">${units.formatTemp(interior)}${units.tempLabel()}</span>
                <span class="storage-tile-sub">${humidity !== null ? `Humidity ${Math.round(humidity)}%` : 'Humidity —'}</span>
            </div>
            <div class="storage-tile">
                <span class="storage-tile-label">Water Tanks</span>
                <span class="storage-tile-value" style="font-size:22px">${esc(water_line)}</span>
                <span class="storage-tile-sub">Fresh · Grey · Black</span>
            </div>
            <div class="storage-tile">
                <span class="storage-tile-label">Location</span>
                <span class="storage-tile-value" style="font-size:20px">${esc(formatPlace(state.place) || '—')}</span>
                <span class="storage-tile-sub">Reverse-geocoded</span>
            </div>
        </div>
    `;
}

function renderStatusCards() {
    const linkColor = state.status === 'online' ? 'var(--role-primary)'
        : state.status === 'offline' ? 'var(--warning)'
        : 'var(--text-muted)';
    const linkGlow = state.status === 'online' ? 'box-shadow:var(--glow-primary);' : '';
    const linkWord = state.status === 'online' ? 'Connected'
        : state.status === 'offline' ? 'Farwatch unreachable'
        : state.status === 'polling' ? 'Connecting…'
        : 'Idle';

    // Proximity/security is remote-monitor only in Storage. The rig's
    // sensor arming is still controlled from Camping — remote arm/disarm
    // would need a cloud-side command channel we don't have yet.
    const prox = state.data.proximity || {};
    const proxEnabled = prox.enabled !== false;
    const proxWord = proxEnabled ? 'Monitoring' : 'Paused';
    const proxColor = proxEnabled ? 'var(--role-primary)' : 'var(--text-muted)';

    return `
        <div class="storage-status-grid">
            <div class="storage-card">
                <span class="storage-card-label">Remote Link</span>
                <div class="storage-card-status">
                    <span class="storage-card-dot" style="background:${linkColor};${linkGlow}"></span>
                    <span class="storage-card-title" style="color:${linkColor}">${linkWord}</span>
                </div>
                <div class="storage-card-rows">
                    <div class="storage-card-row">
                        <span>Last sync</span>
                        <span>${esc(formatLastSync(state.data.settings))}</span>
                    </div>
                    <div class="storage-card-row">
                        <span>Poll interval</span>
                        <span>30 s</span>
                    </div>
                </div>
            </div>
            <div class="storage-card">
                <span class="storage-card-label">Security</span>
                <div class="storage-card-status">
                    <span class="storage-card-dot" style="background:${proxColor}"></span>
                    <span class="storage-card-title" style="color:${proxColor}">${proxWord}</span>
                </div>
                <p class="storage-card-hint">
                    Arm and disarm sensors from the rig's local Wi-Fi (Camping mode).
                </p>
            </div>
        </div>
    `;
}

function renderPage() {
    if (state.status === 'no-token') {
        return `
            <section class="storage-root">
                ${renderEmptyState()}
            </section>
        `;
    }
    return `
        <section class="storage-root">
            <header class="storage-header">
                <h1 class="storage-title">Storage</h1>
                <span class="storage-subtitle">Remote monitoring via Farwatch</span>
            </header>
            ${renderStatusCards()}
            ${renderTiles()}
        </section>
    `;
}

function repaint() {
    const host = document.getElementById('main-content');
    if (host) host.innerHTML = renderPage();
}

async function maybeReverseGeocode() {
    const s = state.data.settings || {};
    const lat = s.last_lat ?? s.latitude ?? null;
    const lon = s.last_lon ?? s.longitude ?? null;
    if (typeof lat === 'number' && typeof lon === 'number') {
        const p = await reverseGeocode(lat, lon);
        if (p && (!state.place || p.place !== state.place.place || p.region !== state.place.region)) {
            state.place = p;
            repaint();
        }
    }
}

export const storagePage = {
    render() { return renderPage(); },

    async init() {
        statusHandler = (e) => {
            state.status = e.detail.status;
            repaint();
        };
        changeHandler = (e) => {
            state.data = e.detail.data || {};
            state.status = e.detail.status;
            repaint();
            maybeReverseGeocode();
        };
        farwatchClient.addEventListener('status', statusHandler);
        farwatchClient.addEventListener('change', changeHandler);
        unitsHandler = () => repaint();
        units.addEventListener('change', unitsHandler);
        state.status = farwatchClient.status;
        state.data = farwatchClient.data || {};
        await farwatchClient.start();
        repaint();
    },

    cleanup() {
        farwatchClient.stop();
        if (statusHandler) {
            farwatchClient.removeEventListener('status', statusHandler);
            statusHandler = null;
        }
        if (changeHandler) {
            farwatchClient.removeEventListener('change', changeHandler);
            changeHandler = null;
        }
        if (unitsHandler) {
            units.removeEventListener('change', unitsHandler);
            unitsHandler = null;
        }
    }
};
