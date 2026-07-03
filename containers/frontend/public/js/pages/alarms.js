// Alarms page — flat list of every digital input across configured
// Picket + Switchback modules with per-sensor arm toggle and rename.
import { API } from '../api.js';

const LABEL_MAX = 24;
const SENSORS_PER = { switchback: 8, picket: 12 };

let sensors = {};        // "type:addr:sensor" → { armed, label }
let modules = [];        // configured picket/switchback modules
let saveTimer = null;
let containerClickListener = null;
let modalKeydownListener = null;

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
    }
}

export const alarmsPage = {
    render() {
        return `
            <section class="page-alarms">
                <h1 class="section-title">Alarms</h1>
                <div class="card">
                    <p class="alarms-intro">
                        Arm individual sensors to surface their state in the alarm bell.
                        A sensor that auto-clears (e.g. a door re-closing) clears its alarm.
                    </p>
                    <div id="alarms-list-container">
                        <p class="alarms-loading">Loading…</p>
                    </div>
                </div>
            </section>
        `;
    },

    async init() {
        const container = document.getElementById('alarms-list-container');
        if (!container) return;

        try {
            const [config, sysCfg] = await Promise.all([
                API.getAlarmsConfig(),
                API.getSystemConfig(),
            ]);
            sensors = (config && config.sensors) || {};
            modules = (sysCfg && sysCfg.mcu_modules) || [];
            container.innerHTML = renderList();
        } catch (err) {
            console.error('[Alarms] Failed to load:', err);
            container.innerHTML = '<p style="color: var(--danger);">Failed to load alarms configuration.</p>';
            return;
        }

        containerClickListener = handleContainerClick;
        document.querySelector('.page-alarms').addEventListener('click', containerClickListener);
    },

    cleanup() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        const page = document.querySelector('.page-alarms');
        if (page && containerClickListener) {
            page.removeEventListener('click', containerClickListener);
        }
        containerClickListener = null;
        closeRenameModal();
        sensors = {};
        modules = [];
    }
};
