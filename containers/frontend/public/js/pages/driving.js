// Driving mode — Spotter-inspired glance dashboard.
//
// Layout: battery arc gauge (left), trailer diagram (center), solar arc
// gauge (right), trailer-light pill row underneath, GNSS stat chips, and
// a full-screen red alarm takeover when any alarm is active.
//
// Data sources:
//   * `energy` WS → battery %, voltage, solar watts, time remaining, charge
//   * `gnss_details` / `latlon` WS → speed, heading, elevation, satellites
//   * `aftline_tire` / `aftline_breakaway` / `aftline_blindspot` /
//     `aftline_lights` / `aftline_link` WS → trailer sensing (Aftline
//      hardware pending; UI renders "--" placeholders until data arrives)
//   * `alarmBell` shared store → full-screen red takeover

import { wsClient } from '../api.js';
import { alarmBell } from '../components/alarm-bell.js';
import { arcGauge } from '../components/arc-gauge.js';
import { trailerDiagram } from '../components/trailer-diagram.js';
import { units } from '../services/units.js';
import { trailerConfig } from '../services/trailer-config.js';

// ── Formatting helpers ──────────────────────────────────────
const fmt = (v, decimals = 0) => (v === null || v === undefined || Number.isNaN(v))
    ? '--' : Number(v).toFixed(decimals);

function pillState(on) {
    if (on === true) return 'on';
    if (on === false) return 'off';
    return 'unknown';
}

function pillWord(on) {
    if (on === true) return 'On';
    if (on === false) return 'Off';
    return '--';
}

const TRAILER_LIGHTS = [
    { key: 'running', label: 'Running', onColor: 'ok' },   // green when on
    { key: 'left',    label: 'Left',    onColor: 'amber' }, // amber when on
    { key: 'brake',   label: 'Brake',   onColor: 'danger'}, // red when on
    { key: 'right',   label: 'Right',   onColor: 'amber' },
    { key: 'reverse', label: 'Reverse', onColor: 'info' }   // blue when on
];

function renderLightPills(state) {
    return TRAILER_LIGHTS.map(l => {
        const on = state?.[l.key];
        const cls = on === true ? `drv-pill drv-pill-${l.onColor}` :
                    on === false ? 'drv-pill drv-pill-off' :
                    'drv-pill drv-pill-unknown';
        return `<div class="${cls}"><span class="drv-pill-dot"></span><span>${l.label}</span></div>`;
    }).join('');
}

function renderTakeover(activeAlarms) {
    if (!activeAlarms || activeAlarms.length === 0) return '';
    const rows = activeAlarms.map(a => `
        <div class="drv-takeover-row">
            <span class="drv-takeover-text">${escapeHtml(a.label || '(unnamed sensor)')}</span>
        </div>
    `).join('');
    return `
        <div class="drv-takeover" role="alertdialog" aria-label="Active alarms">
            <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" class="drv-takeover-icon">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
            </svg>
            <div class="drv-takeover-rows">${rows}</div>
            <button type="button" class="drv-takeover-ack" id="drv-takeover-ack">Acknowledge</button>
        </div>
    `;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── State + rendering ─────────────────────────────────────
const state = {
    energy: { battery_percent: null, battery_voltage: null, solar_watts: null,
              time_remaining_minutes: null, charge_type: null },
    gnss: { speed: null, heading: null, altitude: null, satellites: null },
    aftline: {
        link: null,          // 'linked' | 'unlinked' | null
        tires: {},           // { fl, fr, rl, rr } in psi
        breakawayArmed: null,
        blindSpotLeft: null, // 'clear' | 'vehicle' | null
        blindSpotRight: null,
        lights: {}           // { running, left, brake, right, reverse }
    },
    alarms: [],
    ackedAlarmIds: new Set() // acknowledged for THIS driving session
};

const listeners = { fns: [] };
function onWs(topic, fn) {
    wsClient.on(topic, fn);
    listeners.fns.push([topic, fn]);
}
function offAllWs() {
    for (const [t, fn] of listeners.fns) wsClient.off(t, fn);
    listeners.fns = [];
}

let alarmChangeHandler = null;
let unitsHandler = null;
let trailerConfigHandler = null;

// Format seconds → "Xh Ym" style
function fmtTimeRemaining(minutes) {
    if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '--';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (h >= 24) {
        const d = Math.floor(h / 24);
        return `${d}d ${h % 24}h`;
    }
    return `${h}h ${m}m`;
}

function renderPage() {
    const axleLabel = trailerConfig.axleLabel();
    const link = state.aftline.link === 'linked' ? `${axleLabel} · Linked`
        : state.aftline.link === 'unlinked' ? `${axleLabel} · Unlinked`
        : `${axleLabel} · --`;
    const linkColor = state.aftline.link === 'linked' ? 'var(--role-primary)'
        : state.aftline.link === 'unlinked' ? 'var(--danger)' : 'var(--text-muted)';
    const linkGlow = state.aftline.link === 'linked' ? 'box-shadow:var(--glow-primary);' : '';

    const batteryInner = `
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--role-primary)" stroke-width="2" stroke-linecap="round" class="drv-arc-icon">
            <rect x="1" y="6" width="18" height="12" rx="2"></rect>
            <line x1="23" y1="10" x2="23" y2="14"></line>
        </svg>
        <span class="drv-arc-value">${fmt(state.energy.battery_percent)}<span class="drv-arc-unit">%</span></span>
        <span class="drv-arc-sub">${fmt(state.energy.battery_voltage, 1)} V</span>
    `;
    const solarInner = `
        <svg viewBox="0 0 24 24" fill="none" stroke="#FFC107" stroke-width="2" stroke-linecap="round" class="drv-arc-icon">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>
        <span class="drv-arc-value">${fmt(state.energy.solar_watts)}<span class="drv-arc-unit">W</span></span>
        <span class="drv-arc-sub">watts in</span>
    `;

    const activeAlarms = state.alarms.filter(a => !state.ackedAlarmIds.has(a.id));

    return `
        <div class="drv-root">
            <div class="drv-header">
                <span class="drv-link" style="color:${linkColor}">
                    <span class="drv-link-dot" style="background:${linkColor};${linkGlow}"></span>
                    ${link}
                </span>
                <span class="drv-gnss-chips">
                    <span class="drv-chip"><span class="drv-chip-value">${units.formatSpeed(state.gnss.speed)}</span><span class="drv-chip-unit">${units.speedLabel()}</span></span>
                    <span class="drv-chip"><span class="drv-chip-value">${fmt(state.gnss.heading)}°</span></span>
                    <span class="drv-chip"><span class="drv-chip-value">${units.formatAltitude(state.gnss.altitude)}</span><span class="drv-chip-unit">${units.altitudeLabel()}</span></span>
                    <span class="drv-chip"><span class="drv-chip-value">${fmt(state.gnss.satellites)}</span><span class="drv-chip-unit">sats</span></span>
                </span>
            </div>

            <div class="drv-grid">
                <div class="drv-arc-tile">
                    ${arcGauge({ value: state.energy.battery_percent, max: 100, color: 'var(--role-primary)', inner: batteryInner })}
                    <span class="drv-arc-status">${fmtTimeRemaining(state.energy.time_remaining_minutes)} left</span>
                </div>

                <div class="drv-trailer-tile">
                    ${trailerDiagram({
                        axles: trailerConfig.axles,
                        breakawayArmed: state.aftline.breakawayArmed,
                        tires: state.aftline.tires,
                        blindSpotLeft: state.aftline.blindSpotLeft,
                        blindSpotRight: state.aftline.blindSpotRight
                    })}
                </div>

                <div class="drv-arc-tile">
                    ${arcGauge({ value: state.energy.solar_watts, max: 800, color: '#FFC107', inner: solarInner })}
                    <span class="drv-arc-status" style="color:${state.energy.solar_watts > 0 ? 'var(--role-primary)' : 'var(--text-muted)'}">
                        ${state.energy.solar_watts > 0 ? 'Charging' : (state.energy.solar_watts === 0 ? 'No sun' : 'No data')}
                    </span>
                </div>
            </div>

            <div class="drv-lights">${renderLightPills(state.aftline.lights)}</div>

            ${renderTakeover(activeAlarms)}
        </div>
    `;
}

function repaint() {
    const host = document.getElementById('main-content');
    if (host) host.innerHTML = renderPage();
    wireTakeover();
}

function wireTakeover() {
    const ackBtn = document.getElementById('drv-takeover-ack');
    if (ackBtn) {
        ackBtn.addEventListener('click', () => {
            for (const a of state.alarms) state.ackedAlarmIds.add(a.id);
            repaint();
        });
    }
}

// ── Page module ─────────────────────────────────────────────
export const drivingPage = {
    render() {
        return renderPage();
    },

    init() {
        // energy
        onWs('energy', (data) => {
            if (!data) return;
            Object.assign(state.energy, {
                battery_percent: data.battery_percent ?? state.energy.battery_percent,
                battery_voltage: data.battery_voltage ?? state.energy.battery_voltage,
                solar_watts: data.solar_watts ?? state.energy.solar_watts,
                time_remaining_minutes: data.time_remaining_minutes ?? state.energy.time_remaining_minutes,
                charge_type: data.charge_type ?? state.energy.charge_type
            });
            repaint();
        });

        // GNSS — three separate topics (see backend/src/mqtt.js).
        //   `alt`          → { altitudeFeet, altitudeInMeters }
        //   `gnss_details` → { speedOverGround (100ths of a knot!),
        //                       courseOverGround (°), numberOfSatellites,
        //                       gnssMode }
        //   `latlon`       → lat/lon (not shown here — Map page uses it).
        //
        // speedOverGround stays in its raw sensor unit here; the units
        // service converts to the user's preferred display unit (mph/kph).
        onWs('alt', (data) => {
            if (!data) return;
            if (data.altitudeFeet !== undefined) state.gnss.altitude = data.altitudeFeet;
            repaint();
        });
        onWs('gnss_details', (data) => {
            if (!data) return;
            if (data.speedOverGround !== undefined) state.gnss.speed = data.speedOverGround;
            if (data.courseOverGround !== undefined) state.gnss.heading = data.courseOverGround;
            if (data.numberOfSatellites !== undefined) state.gnss.satellites = data.numberOfSatellites;
            repaint();
        });

        // Re-render when the user flips speed/temp preferences from Settings.
        unitsHandler = () => repaint();
        units.addEventListener('change', unitsHandler);
        trailerConfigHandler = () => repaint();
        trailerConfig.addEventListener('change', trailerConfigHandler);

        // Aftline — hardware not yet built. These topics are subscribed
        // proactively so the UI populates the moment the module reports.
        onWs('aftline_link', (data) => {
            if (!data) return;
            state.aftline.link = data.linked === true ? 'linked' :
                                  data.linked === false ? 'unlinked' : state.aftline.link;
            repaint();
        });
        onWs('aftline_tire', (data) => {
            if (!data || !data.tires) return;
            state.aftline.tires = { ...state.aftline.tires, ...data.tires };
            repaint();
        });
        onWs('aftline_breakaway', (data) => {
            if (!data) return;
            if (data.armed !== undefined) state.aftline.breakawayArmed = data.armed;
            repaint();
        });
        onWs('aftline_blindspot', (data) => {
            if (!data) return;
            if (data.left !== undefined) state.aftline.blindSpotLeft = data.left;
            if (data.right !== undefined) state.aftline.blindSpotRight = data.right;
            repaint();
        });
        onWs('aftline_lights', (data) => {
            if (!data) return;
            state.aftline.lights = { ...state.aftline.lights, ...data };
            repaint();
        });

        // Alarm takeover
        alarmChangeHandler = () => {
            state.alarms = alarmBell.getActive();
            // If the previously acked set contains ids that are no longer
            // active, keep them (harmless) — active list is what drives display.
            repaint();
        };
        alarmBell.addEventListener('change', alarmChangeHandler);
        state.alarms = alarmBell.getActive();
        repaint();
    },

    cleanup() {
        offAllWs();
        if (alarmChangeHandler) {
            alarmBell.removeEventListener('change', alarmChangeHandler);
            alarmChangeHandler = null;
        }
        if (unitsHandler) {
            units.removeEventListener('change', unitsHandler);
            unitsHandler = null;
        }
        if (trailerConfigHandler) {
            trailerConfig.removeEventListener('change', trailerConfigHandler);
            trailerConfigHandler = null;
        }
        state.ackedAlarmIds.clear();
    }
};
