// Settings > Cameras & Monitoring
//
// First-pass scope: detection + persistence + per-camera enable toggle
// only. No live view yet — enabling a camera is a stored preference
// that a future streaming service will react to. Live view will need
// /dev/video* exposed to the backend via a compose `devices:` block.
//
// Detection reads /host/sys/class/video4linux/ on the backend (see
// backend/src/services/camera-detect.js). No compose changes required
// for this stage.

import { API } from '../../../api.js';
import { CameraViewer } from '../../../components/camera-viewer.js';

const viewer = new CameraViewer();

let cameras = [];        // configured cameras (from GET /api/cameras)
let available = null;    // detected-but-not-added, populated on picker open
let conflicts = [];      // hwId collisions reported alongside `available`
let pickerOpen = false;
let containerClickListener = null;
let containerInputListener = null;

const NAME_MAX = 32;

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function subtitleFor(cam) {
    // Show whatever hardware detail we have, joined with " · ". Falls back
    // gracefully when a stored camera is currently unplugged and its
    // detection metadata is stale.
    const bits = [];
    if (cam.vendor && cam.model && !cam.model.toLowerCase().includes((cam.vendor || '').toLowerCase())) {
        bits.push(`${cam.vendor} ${cam.model}`);
    } else if (cam.model) {
        bits.push(cam.model);
    } else if (cam.vendor) {
        bits.push(cam.vendor);
    }
    if (cam.devPath) bits.push(cam.devPath);
    return bits.join(' · ');
}

function renderCameraRow(cam) {
    const enabled = !!cam.enabled;
    const connected = cam.connected !== false;   // undefined (from POST/PATCH echo) = assume connected
    const statusDot = connected
        ? `<span class="cam-status cam-status-connected" title="Connected"></span>`
        : `<span class="cam-status cam-status-disconnected" title="Not currently connected"></span>`;
    // A camera of this model is plugged in, but it no longer matches this
    // saved entry — so the entry is orphaned and the hardware is sitting in
    // the Add Camera list instead. This one the operator can fix directly.
    const staleNotice = (!connected && cam.staleIdentity)
        ? `
            <div class="cam-row-notice">
                <ion-icon name="alert-circle-outline" aria-hidden="true"></ion-icon>
                <span>This camera is plugged in but no longer matches its saved
                entry — it may have been moved to a different USB port. Remove
                this entry with the bin icon, then add the camera again from
                “Add Camera” below. Its name and settings will need re-entering.</span>
            </div>
        `
        : '';
    return `
        <div class="cam-row ${connected ? '' : 'is-disconnected'}" data-id="${escapeAttr(cam.id)}">
            <div class="cam-row-main">
                ${statusDot}
                <div class="cam-row-text">
                    <div class="cam-row-name-line">
                        <input type="text" class="cam-name-input"
                               data-action="rename" data-id="${escapeAttr(cam.id)}"
                               value="${escapeAttr(cam.name)}" maxlength="${NAME_MAX}"
                               aria-label="Camera name">
                    </div>
                    <div class="cam-row-sub">${escapeHtml(subtitleFor(cam))}</div>
                    ${staleNotice}
                </div>
            </div>
            <div class="cam-row-actions">
                ${enabled && connected ? `
                    <button class="cam-view-btn" data-action="view" data-id="${escapeAttr(cam.id)}"
                            title="View live" aria-label="View live">
                        <ion-icon name="videocam-outline" aria-hidden="true"></ion-icon>
                    </button>
                ` : ''}
                <div class="toggle-switch ${enabled ? 'active' : ''}"
                     data-action="toggle-enable" data-id="${escapeAttr(cam.id)}"
                     role="switch" aria-checked="${enabled}" tabindex="0"
                     title="${enabled ? 'Disable' : 'Enable'}"></div>
                <button class="cam-remove-btn" data-action="remove" data-id="${escapeAttr(cam.id)}"
                        title="Remove camera" aria-label="Remove camera">
                    <ion-icon name="trash-outline" aria-hidden="true"></ion-icon>
                </button>
            </div>
        </div>
    `;
}

function renderCameraList() {
    if (!cameras.length) {
        return `
            <div class="cam-empty">
                <ion-icon name="videocam-off-outline" aria-hidden="true"></ion-icon>
                <div class="cam-empty-title">No cameras added yet</div>
                <div class="cam-empty-sub">Tap “Add Camera” below to detect a connected camera.</div>
            </div>
        `;
    }
    return cameras.map(renderCameraRow).join('');
}

// Explains an hwId collision: two or more units of one model report an
// identical serial, so Headwaters cannot tell them apart and only one can
// be added. Deliberately does NOT suggest removing and re-adding cameras —
// the duplicate IDs come from the hardware, so that would achieve nothing.
// The actionable paths are a firmware/model swap or reporting it.
function renderConflictNotice() {
    if (!conflicts.length) return '';
    const blocks = conflicts.map(c => {
        const model = c.model || 'USB camera';
        const count = c.devPaths.length;
        const idPair = [c.vendorId, c.productId].filter(Boolean).join(':');
        return `
            <div class="cam-conflict-item">
                <div class="cam-conflict-head">
                    ${escapeHtml(String(count))} × ${escapeHtml(model)}
                    ${idPair ? `<span class="cam-conflict-ids">(${escapeHtml(idPair)})</span>` : ''}
                </div>
                <div class="cam-conflict-body">
                    These report the same serial number, so Headwaters cannot tell
                    them apart — only one can be added. Removing and re-adding
                    cameras will not help; the duplicate identity comes from the
                    cameras themselves. Use one camera of this model, or report
                    this so support for it can be added.
                </div>
                <div class="cam-conflict-detail">
                    Affected devices: ${escapeHtml(c.devPaths.join(', '))}
                </div>
            </div>
        `;
    }).join('');
    return `
        <div class="cam-conflict">
            <div class="cam-conflict-title">
                <ion-icon name="warning-outline" aria-hidden="true"></ion-icon>
                Some cameras cannot be told apart
            </div>
            ${blocks}
        </div>
    `;
}

function renderPicker() {
    if (!pickerOpen) return '';
    if (available === null) {
        return `
            <div class="cam-picker" id="cam-picker">
                <div class="cam-picker-status">Scanning for cameras…</div>
            </div>
        `;
    }
    if (!available.length) {
        return `
            <div class="cam-picker" id="cam-picker">
                ${renderConflictNotice()}
                <div class="cam-picker-status">
                    No new cameras detected. Plug a USB camera into Headwaters and tap “Rescan”.
                </div>
                <div class="cam-picker-actions">
                    <button class="cam-btn-secondary" data-action="picker-rescan">Rescan</button>
                    <button class="cam-btn-secondary" data-action="picker-cancel">Cancel</button>
                </div>
            </div>
        `;
    }
    const rows = available.map(c => `
        <button class="cam-avail-row" data-action="pick" data-hwid="${escapeAttr(c.hwId)}">
            <ion-icon name="videocam-outline" class="cam-avail-icon" aria-hidden="true"></ion-icon>
            <span class="cam-avail-text">
                <span class="cam-avail-name">${escapeHtml(c.name || c.model || 'USB Camera')}</span>
                <span class="cam-avail-sub">${escapeHtml(subtitleFor(c))}</span>
            </span>
            <ion-icon name="add-circle-outline" class="cam-avail-add" aria-hidden="true"></ion-icon>
        </button>
    `).join('');
    return `
        <div class="cam-picker" id="cam-picker">
            ${renderConflictNotice()}
            <div class="cam-picker-title">Select a camera to add</div>
            <div class="cam-picker-list">${rows}</div>
            <div class="cam-picker-actions">
                <button class="cam-btn-secondary" data-action="picker-rescan">Rescan</button>
                <button class="cam-btn-secondary" data-action="picker-cancel">Cancel</button>
            </div>
        </div>
    `;
}

function renderInner() {
    return `
        <div class="card settings-item-vertical" id="cameras-list-card">
            <div class="settings-item-header">
                <span class="settings-label">Cameras</span>
                <p class="settings-description">Add USB cameras connected to Headwaters. Enable a camera to make it available to the vehicle.</p>
            </div>
            <div class="cam-list" id="cam-list">${renderCameraList()}</div>
            <div id="cameras-message" class="password-message hidden"></div>
        </div>

        <div class="card settings-item-vertical" id="cameras-add-card">
            <div class="settings-item-header">
                <span class="settings-label">Add Camera</span>
                <p class="settings-description">Detects USB cameras currently plugged into Headwaters that haven’t been added yet.</p>
            </div>
            <div class="cam-add-wrap">
                <button class="password-submit-btn" id="cam-add-btn" data-action="open-picker" ${pickerOpen ? 'disabled' : ''}>
                    <ion-icon name="add-outline" aria-hidden="true" style="vertical-align:middle;margin-right:6px;"></ion-icon>
                    Add Camera
                </button>
                ${renderPicker()}
            </div>
        </div>
    `;
}

function paint() {
    const c = document.getElementById('settings-cameras-container');
    if (c) c.innerHTML = renderInner();
}

function showMessage(text, type) {
    const el = document.getElementById('cameras-message');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden', 'success', 'error');
    el.classList.add(type);
    if (type === 'success') {
        setTimeout(() => { el.classList.add('hidden'); }, 2500);
    }
}

async function loadCameras() {
    try {
        const data = await API.getCameras();
        cameras = Array.isArray(data.cameras) ? data.cameras : [];
    } catch (err) {
        console.error('[Cameras] load failed:', err);
        cameras = [];
        showMessage('Failed to load cameras.', 'error');
    }
    paint();
}

async function openPicker() {
    pickerOpen = true;
    available = null;
    paint();
    await refreshAvailable();
}

async function refreshAvailable() {
    try {
        const data = await API.getAvailableCameras();
        available = Array.isArray(data.cameras) ? data.cameras : [];
        conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    } catch (err) {
        console.error('[Cameras] enumerate failed:', err);
        available = [];
        conflicts = [];
        showMessage('Failed to scan for cameras.', 'error');
    }
    paint();
}

function closePicker() {
    pickerOpen = false;
    available = null;
    paint();
}

async function addCamera(hwId) {
    try {
        const created = await API.addCamera(hwId, undefined);
        // Optimistic — insert immediately, then re-sync from server so the
        // `connected` flag is authoritative.
        cameras = [...cameras, { ...created, connected: true }];
        pickerOpen = false;
        available = null;
        paint();
        showMessage('Camera added.', 'success');
        loadCameras();
    } catch (err) {
        console.error('[Cameras] add failed:', err);
        showMessage(err.message || 'Failed to add camera.', 'error');
    }
}

async function toggleEnable(id) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;
    const next = !cam.enabled;
    // Optimistic UI flip
    cam.enabled = next;
    paint();
    try {
        const updated = await API.updateCamera(id, { enabled: next });
        Object.assign(cam, updated);
        paint();
    } catch (err) {
        console.error('[Cameras] toggle failed:', err);
        cam.enabled = !next;
        paint();
        showMessage(err.message || 'Failed to update camera.', 'error');
    }
}

async function renameCamera(id, newName) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;
    const clean = String(newName || '').trim().slice(0, NAME_MAX);
    if (!clean || clean === cam.name) return;
    try {
        const updated = await API.updateCamera(id, { name: clean });
        Object.assign(cam, updated);
    } catch (err) {
        console.error('[Cameras] rename failed:', err);
        showMessage(err.message || 'Failed to rename camera.', 'error');
        // Repaint to restore the stored name in the input.
        paint();
    }
}

async function removeCamera(id) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;
    if (!confirm(`Remove “${cam.name}”? The camera won’t be deleted from the device — it’ll reappear in the available list.`)) {
        return;
    }
    try {
        await API.deleteCamera(id);
        cameras = cameras.filter(c => c.id !== id);
        paint();
        showMessage('Camera removed.', 'success');
    } catch (err) {
        console.error('[Cameras] delete failed:', err);
        showMessage(err.message || 'Failed to remove camera.', 'error');
    }
}

function wireListeners() {
    const container = document.getElementById('settings-cameras-container');
    if (!container) return;

    containerClickListener = (e) => {
        const el = e.target.closest('[data-action]');
        if (!el || !container.contains(el)) return;
        const action = el.dataset.action;
        const id = el.dataset.id;
        const hwId = el.dataset.hwid;
        if (action === 'open-picker') { openPicker(); return; }
        if (action === 'picker-cancel') { closePicker(); return; }
        if (action === 'picker-rescan') { available = null; paint(); refreshAvailable(); return; }
        if (action === 'pick' && hwId) { addCamera(hwId); return; }
        if (action === 'toggle-enable' && id) { toggleEnable(id); return; }
        if (action === 'remove' && id) { removeCamera(id); return; }
        if (action === 'view' && id) {
            const cam = cameras.find(c => c.id === id);
            if (cam) viewer.open(cam);
            return;
        }
    };
    container.addEventListener('click', containerClickListener);

    // Rename: commit on blur or Enter — using capture-phase input listener
    // so we don't re-render on every keystroke (which would blow away the
    // focus).
    containerInputListener = (e) => {
        const el = e.target;
        if (!(el instanceof HTMLInputElement)) return;
        if (el.dataset.action !== 'rename') return;
        if (e.type === 'blur') {
            renameCamera(el.dataset.id, el.value);
        } else if (e.type === 'keydown' && e.key === 'Enter') {
            e.preventDefault();
            el.blur();
        }
    };
    container.addEventListener('blur', containerInputListener, true);
    container.addEventListener('keydown', containerInputListener);
}

function unwireListeners() {
    const container = document.getElementById('settings-cameras-container');
    if (container && containerClickListener) {
        container.removeEventListener('click', containerClickListener);
    }
    if (container && containerInputListener) {
        container.removeEventListener('blur', containerInputListener, true);
        container.removeEventListener('keydown', containerInputListener);
    }
    containerClickListener = null;
    containerInputListener = null;
}

export const camerasGroup = {
    meta: {
        id: 'cameras',
        title: 'Cameras & Monitoring',
        icon: 'videocam-outline',
        sub: 'USB cameras, live view',
    },
    searchIndex: [
        { label: 'Cameras',   kw: 'camera video usb webcam uvc',        anchor: 'cameras-list-card' },
        { label: 'Add Camera', kw: 'add camera detect scan connect',    anchor: 'cameras-add-card' },
    ],

    render() {
        return `<div id="settings-cameras-container"><p class="alarms-loading">Loading…</p></div>`;
    },

    async init() {
        pickerOpen = false;
        available = null;
        await loadCameras();
        wireListeners();
    },

    cleanup() {
        unwireListeners();
        viewer.close();
        cameras = [];
        available = null;
        pickerOpen = false;
    },
};
