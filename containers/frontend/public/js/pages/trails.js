// Trails page — full CRUD for user-uploaded GPX tracks.
//
// Two tabs: Trails (active) and Trash (soft-deleted). Each active row
// shows name + color swatch + point count and offers Navigate (opens the
// map centered on the trail with its polyline drawn) and Delete
// (soft-delete → trash). Trash rows offer Restore and Delete Forever;
// the tab header carries an Empty Trash button.
//
// Color selection uses the platform's native color picker
// (<input type="color">) which opens a full color wheel / gradient chart
// on every modern browser and OS. A row of preset swatches is provided
// for one-tap choices — matches the design brief.

import { API } from '../api.js';
import { router } from '../router.js';

const PRESET_COLORS = [
    '#e53935', // red
    '#fb8c00', // orange
    '#fdd835', // yellow
    '#43a047', // green
    '#00acc1', // teal
    '#1e88e5', // blue
    '#8e24aa', // purple
    '#6d4c41', // brown
    '#546e7a', // slate
    '#212121', // black
];

const DEFAULT_COLOR = '#43a047';

let activeTab = 'active';   // 'active' | 'trash'
let activeList = [];
let trashList = [];
let selectedColor = DEFAULT_COLOR;
let uploading = false;

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDate(v) {
    if (!v) return '';
    const d = new Date(v);
    return d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

export const trailsPage = {
    render() {
        return `
            <section class="page-trails">
                <h1 class="section-title">Trails</h1>
                <div class="settings-container">

                    <div class="card settings-item-vertical" id="trails-create-card">
                        <div class="settings-item-header">
                            <span class="settings-label">Add Trail</span>
                            <p class="settings-description">
                                Upload a GPX file, give the trail a name, and pick a color to draw it in on the map.
                            </p>
                        </div>
                        <form id="trail-create-form" class="password-form">
                            <div class="password-form-group">
                                <label for="trail-name-input" class="password-label">Name</label>
                                <input type="text" id="trail-name-input" class="password-input"
                                       maxlength="60" required
                                       placeholder="e.g. West Rim Loop">
                            </div>
                            <div class="password-form-group">
                                <label class="password-label">Color</label>
                                <div class="trail-color-picker">
                                    <label class="trail-color-wheel" title="Pick any color">
                                        <input type="color" id="trail-color-input" value="${DEFAULT_COLOR}">
                                        <span class="trail-color-wheel-swatch"
                                              id="trail-color-preview"
                                              style="background:${DEFAULT_COLOR}"></span>
                                        <span class="trail-color-wheel-label">Wheel</span>
                                    </label>
                                    <div class="trail-color-presets" id="trail-color-presets">
                                        ${PRESET_COLORS.map(c => `
                                            <button type="button" class="trail-color-swatch${c === DEFAULT_COLOR ? ' selected' : ''}"
                                                    data-color="${c}"
                                                    style="background:${c}"
                                                    aria-label="Choose ${c}"></button>
                                        `).join('')}
                                    </div>
                                </div>
                            </div>
                            <div class="password-form-group">
                                <label for="trail-file-input" class="password-label">GPX File</label>
                                <input type="file" id="trail-file-input" accept=".gpx,application/gpx+xml"
                                       required class="password-input">
                            </div>
                            <div id="trail-create-message" class="password-message hidden"></div>
                            <button type="submit" id="trail-create-submit" class="password-submit-btn">
                                Save Trail
                            </button>
                        </form>
                    </div>

                    <div class="card settings-item-vertical" id="trails-list-card">
                        <div class="trails-tabs" role="tablist">
                            <button class="trails-tab active" data-tab="active" role="tab">
                                Trails <span class="trails-tab-count" id="trails-active-count"></span>
                            </button>
                            <button class="trails-tab" data-tab="trash" role="tab">
                                Trash <span class="trails-tab-count" id="trails-trash-count"></span>
                            </button>
                            <div class="trails-tabs-spacer"></div>
                            <button type="button" id="trails-empty-trash-btn"
                                    class="trails-empty-trash-btn hidden">
                                Empty Trash
                            </button>
                        </div>
                        <div id="trails-list">Loading…</div>
                    </div>

                </div>
            </section>
        `;
    },

    async init() {
        this._wireCreateForm();
        this._wireTabs();
        this._wireListDelegation();
        await this._reloadAll();
    },

    async _reloadAll() {
        try {
            const [a, t] = await Promise.all([
                API.getTrails(), API.getTrashedTrails()
            ]);
            activeList = Array.isArray(a) ? a : [];
            trashList  = Array.isArray(t) ? t : [];
        } catch (err) {
            console.error('[trails] failed to load lists:', err);
            activeList = [];
            trashList = [];
        }
        this._renderCounts();
        this._renderList();
    },

    _renderCounts() {
        const a = document.getElementById('trails-active-count');
        const t = document.getElementById('trails-trash-count');
        if (a) a.textContent = activeList.length ? `(${activeList.length})` : '';
        if (t) t.textContent = trashList.length ? `(${trashList.length})` : '';
        const emptyBtn = document.getElementById('trails-empty-trash-btn');
        if (emptyBtn) {
            const show = activeTab === 'trash' && trashList.length > 0;
            emptyBtn.classList.toggle('hidden', !show);
        }
    },

    _renderList() {
        const el = document.getElementById('trails-list');
        if (!el) return;
        const list = activeTab === 'active' ? activeList : trashList;

        if (!list.length) {
            const msg = activeTab === 'active'
                ? 'No trails yet. Add one above to get started.'
                : 'Trash is empty.';
            el.innerHTML = `<p class="settings-description">${msg}</p>`;
            return;
        }

        el.innerHTML = list.map(t => this._renderRow(t, activeTab)).join('');
    },

    _renderRow(t, tab) {
        const color = escapeHtml(t.color || '#888888');
        const name = escapeHtml(t.name || 'Untitled');
        const pointCount = t.bounds?.pointCount ?? 0;
        const meta = [
            pointCount ? `${pointCount.toLocaleString()} points` : null,
            t.size ? fmtSize(t.size) : null,
            tab === 'active'
                ? (t.createdAt ? `added ${fmtDate(t.createdAt)}` : null)
                : (t.deletedAt ? `deleted ${fmtDate(t.deletedAt)}` : null),
        ].filter(Boolean).join(' · ');

        const actions = tab === 'active' ? `
            <button type="button" class="trail-action-btn" data-action="navigate" data-id="${escapeHtml(t.id)}"
                    title="Show on map">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>
                <span>Navigate</span>
            </button>
            <button type="button" class="trail-action-btn trail-action-btn-danger" data-action="delete" data-id="${escapeHtml(t.id)}"
                    title="Move to trash">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>
                <span>Delete</span>
            </button>
        ` : `
            <button type="button" class="trail-action-btn" data-action="restore" data-id="${escapeHtml(t.id)}"
                    title="Restore from trash">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
                <span>Restore</span>
            </button>
            <button type="button" class="trail-action-btn trail-action-btn-danger" data-action="permanent" data-id="${escapeHtml(t.id)}"
                    title="Delete forever">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                <span>Delete Forever</span>
            </button>
        `;

        return `
            <div class="trail-row">
                <span class="trail-row-swatch" style="background:${color}" aria-hidden="true"></span>
                <div class="trail-row-info">
                    <div class="trail-row-name">${name}</div>
                    <div class="trail-row-meta">${escapeHtml(meta)}</div>
                </div>
                <div class="trail-row-actions">${actions}</div>
            </div>
        `;
    },

    _wireTabs() {
        const container = document.getElementById('trails-list-card');
        if (!container) return;
        container.querySelectorAll('.trails-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                if (!tab || tab === activeTab) return;
                activeTab = tab;
                container.querySelectorAll('.trails-tab').forEach(b => {
                    b.classList.toggle('active', b.dataset.tab === activeTab);
                });
                this._renderCounts();
                this._renderList();
            });
        });

        const emptyBtn = document.getElementById('trails-empty-trash-btn');
        if (emptyBtn) {
            emptyBtn.addEventListener('click', async () => {
                if (!confirm('Permanently delete every trail in the trash? This cannot be undone.')) return;
                emptyBtn.disabled = true;
                try {
                    await API.emptyTrailsTrash();
                    await this._reloadAll();
                } catch (err) {
                    console.error('[trails] empty trash failed:', err);
                    alert(`Failed to empty trash: ${err.message || err}`);
                } finally {
                    emptyBtn.disabled = false;
                }
            });
        }
    },

    _wireListDelegation() {
        const listEl = document.getElementById('trails-list');
        if (!listEl) return;
        listEl.addEventListener('click', async (e) => {
            const btn = e.target.closest('.trail-action-btn');
            if (!btn) return;
            const id = btn.dataset.id;
            const action = btn.dataset.action;
            if (!id || !action) return;

            if (action === 'navigate') {
                router.navigate(`map/trail/${encodeURIComponent(id)}`);
                return;
            }

            btn.disabled = true;
            try {
                if (action === 'delete') {
                    await API.deleteTrail(id);
                } else if (action === 'restore') {
                    await API.restoreTrail(id);
                } else if (action === 'permanent') {
                    if (!confirm('Permanently delete this trail? This cannot be undone.')) {
                        btn.disabled = false;
                        return;
                    }
                    await API.permanentDeleteTrail(id);
                }
                await this._reloadAll();
            } catch (err) {
                console.error(`[trails] ${action} failed:`, err);
                alert(`Failed: ${err.message || err}`);
                btn.disabled = false;
            }
        });
    },

    _wireCreateForm() {
        const form = document.getElementById('trail-create-form');
        if (!form) return;

        const colorInput = document.getElementById('trail-color-input');
        const preview = document.getElementById('trail-color-preview');
        const presets = document.getElementById('trail-color-presets');

        const applyColor = (color) => {
            selectedColor = color;
            if (preview) preview.style.background = color;
            if (colorInput) colorInput.value = color;
            if (presets) {
                presets.querySelectorAll('.trail-color-swatch').forEach(s => {
                    s.classList.toggle('selected', s.dataset.color?.toLowerCase() === color.toLowerCase());
                });
            }
        };

        if (colorInput) {
            colorInput.addEventListener('input', (e) => applyColor(e.target.value));
        }
        if (presets) {
            presets.addEventListener('click', (e) => {
                const s = e.target.closest('.trail-color-swatch');
                if (!s) return;
                applyColor(s.dataset.color);
            });
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (uploading) return;

            const nameInput = document.getElementById('trail-name-input');
            const fileInput = document.getElementById('trail-file-input');
            const submitBtn = document.getElementById('trail-create-submit');
            const msgEl = document.getElementById('trail-create-message');

            const name = (nameInput.value || '').trim();
            const file = fileInput.files && fileInput.files[0];

            const setMsg = (text, kind) => {
                if (!msgEl) return;
                msgEl.textContent = text;
                msgEl.classList.remove('hidden', 'success', 'error');
                if (kind) msgEl.classList.add(kind);
            };

            if (!name)  return setMsg('Name is required.', 'error');
            if (!file)  return setMsg('Choose a GPX file.', 'error');

            uploading = true;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Uploading…';
            setMsg('Uploading GPX…', '');

            try {
                await API.createTrail({ name, color: selectedColor, file });
                setMsg('Trail saved.', 'success');
                form.reset();
                applyColor(DEFAULT_COLOR);
                // Reset the file input; its `value = ''` above is enough,
                // but form.reset() may leave the underlying value cached in
                // some browsers — belt and suspenders.
                fileInput.value = '';
                await this._reloadAll();
            } catch (err) {
                console.error('[trails] create failed:', err);
                setMsg(err.message || 'Upload failed', 'error');
            } finally {
                uploading = false;
                submitBtn.disabled = false;
                submitBtn.textContent = 'Save Trail';
            }
        });
    },

    cleanup() {
        activeList = [];
        trashList = [];
        activeTab = 'active';
        selectedColor = DEFAULT_COLOR;
        uploading = false;
    }
};
