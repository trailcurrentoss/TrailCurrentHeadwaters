// Settings > Maps
//
// Offline map bundle: installed version, upload from PWA, load from a
// plugged-in USB/SD, recent-uploads list, rollback. Formerly the
// standalone Maps page — moved here on consolidation. Logic, DOM IDs,
// event handlers, and API calls are byte-identical to the pre-
// consolidation implementation.

import { API, AuthStore, wsClient } from '../../../api.js';
import { gnssSimulator } from '../../../services/gnss-simulator.js';

let uploadsList = [];
let currentBundle = null;
let versionsList = [];

function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
    });
}

function formatStatus(status) {
    if (!status) return '';
    const labels = {
        uploaded:    'Uploaded',
        verifying:   'Verifying',
        extracting:  'Extracting',
        applied:     'Applied',
        failed:      'Failed',
        'rolled-back': 'Rolled back',
        'awaiting-confirmation': 'Waiting for confirmation'
    };
    return labels[status] || status;
}

function statusClass(status) {
    if (!status) return '';
    if (status === 'applied' || status === 'rolled-back') return 'status-success';
    if (status === 'failed') return 'status-danger';
    if (status === 'awaiting-confirmation') return 'status-warning';
    return 'status-active';
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export const mapsGroup = {
    meta: {
        id: 'maps',
        title: 'Maps & Location',
        icon: 'map-outline',
        sub: 'Offline map bundles',
    },
    searchIndex: [
        { label: 'Simulate Location',     kw: 'simulate location fake gps demo screen recording privacy',   anchor: 'simulate-location-card' },
        { label: 'Installed Map Bundle',  kw: 'map bundle north america osm extract rollback installed', anchor: 'current-bundle-details' },
        { label: 'Upload Map Bundle',     kw: 'map upload bundle zip build california north america',    anchor: 'map-upload-form' },
        { label: 'External Storage Maps', kw: 'external usb sd card import scan',                        anchor: 'external-storage-card' },
        { label: 'Recent Uploads',        kw: 'map upload history versions applied',                     anchor: 'maps-uploads-list' },
    ],
    render() {
        return `
            <section class="page-maps">
                <h1 class="section-title">Maps</h1>
                <div class="settings-container" id="maps-container">

                    <!-- Simulate Location — pins the map + driving dashboard to
                         a fixed lat/lon so screen recordings don't reveal the
                         real vehicle position. When active, incoming Bearing
                         GNSS is dropped and a synthetic fix is published each
                         second; the map's location dot recolors to signal that
                         the position is no longer live. -->
                    <div class="card settings-item-vertical" id="simulate-location-card">
                        <div class="settings-item-header">
                            <span class="settings-label">Simulate Location</span>
                            <p class="settings-description">
                                Ignore live GNSS from Bearing and pin the map + driving dashboard to a fixed lat/lon.
                                Useful for screen recordings — the location dot changes color to make clear the position is simulated.
                            </p>
                        </div>
                        <div class="settings-units-container">
                            <div class="settings-units-row">
                                <span class="settings-units-label">Enabled</span>
                                <button type="button" class="toggle-switch" id="simulate-location-toggle"
                                        aria-pressed="false"></button>
                            </div>
                        </div>
                        <div id="simulate-location-coords" class="settings-units-container hidden">
                            <div class="settings-units-row">
                                <label class="settings-units-label" for="simulate-lat-input">Latitude</label>
                                <input type="number" step="0.0001" id="simulate-lat-input"
                                       class="password-input" style="max-width: 12rem;">
                            </div>
                            <div class="settings-units-row">
                                <label class="settings-units-label" for="simulate-lon-input">Longitude</label>
                                <input type="number" step="0.0001" id="simulate-lon-input"
                                       class="password-input" style="max-width: 12rem;">
                            </div>
                            <div class="settings-units-row" style="justify-content: flex-end; gap: 0.5rem;">
                                <button type="button" class="settings-units-btn" id="simulate-reset-btn">Reset to default</button>
                            </div>
                        </div>
                    </div>

                    <!-- Currently installed bundle -->
                    <div class="card settings-item-vertical">
                        <div class="settings-item-header">
                            <span class="settings-label">Installed Bundle</span>
                            <p class="settings-description" id="current-bundle-summary">Loading...</p>
                        </div>
                        <div id="current-bundle-details"></div>
                        <div id="rollback-container" class="hidden" style="margin-top: 0.75rem;">
                            <button type="button" class="password-submit-btn" id="rollback-btn" style="background: var(--warning, #b45309);">
                                Roll back to previous version
                            </button>
                            <div id="rollback-message" class="password-message hidden" style="margin-top: 0.5rem;"></div>
                        </div>
                    </div>

                    <!-- Load from external storage (Phase 8 sneakernet).
                         Hidden entirely when the poll finds nothing plugged in
                         — this card only ever appears when there's something
                         actionable, so the page stays clean by default. -->
                    <div class="card settings-item-vertical hidden" id="external-storage-card">
                        <div class="settings-item-header">
                            <span class="settings-label">Load from external storage</span>
                            <p class="settings-description">
                                Bundle detected on a connected USB drive or SD card.
                                Importing copies to the device at NVMe speed
                                (5–10 min for California, ~30 min for North America)
                                — much faster than uploading over Wi-Fi.
                            </p>
                        </div>
                        <div id="external-bundles-list"></div>
                        <div id="external-import-progress" class="hidden" style="margin-top: 0.75rem;">
                            <div class="upload-progress-bar">
                                <div class="upload-progress-fill" id="external-import-progress-fill"></div>
                            </div>
                            <span id="external-import-progress-text" class="settings-description">Preparing…</span>
                        </div>
                        <div id="external-import-message" class="password-message hidden" style="margin-top: 0.5rem;"></div>
                    </div>

                    <!-- Upload form -->
                    <div class="card settings-item-vertical">
                        <div class="settings-item-header">
                            <span class="settings-label">Upload Map Bundle</span>
                            <p class="settings-description">
                                Upload a .zip bundle produced by <code>build/maps/build.sh</code>.
                                Bundles can be large (California ≈ 91 GB, North America ≈ 129 GB) — plan for a wired or fast Wi-Fi connection.
                            </p>
                        </div>
                        <form id="map-upload-form" class="password-form">
                            <div class="password-form-group">
                                <label for="map-file" class="password-label">Bundle File (.zip)</label>
                                <input type="file" id="map-file" accept=".zip" required class="password-input">
                            </div>
                            <div id="map-upload-progress-container" class="hidden">
                                <div class="upload-progress-bar">
                                    <div class="upload-progress-fill" id="map-upload-progress-fill"></div>
                                </div>
                                <span id="map-upload-progress-text" class="settings-description">0%</span>
                            </div>
                            <div id="map-upload-message" class="password-message hidden"></div>
                            <button type="submit" class="password-submit-btn" id="map-upload-submit-btn">
                                Upload Bundle
                            </button>
                        </form>
                    </div>

                    <!-- Recent uploads / status -->
                    <div class="card settings-item-vertical">
                        <div class="settings-item-header">
                            <span class="settings-label">Recent Uploads</span>
                        </div>
                        <div id="maps-uploads-list">Loading...</div>
                    </div>

                </div>
            </section>
        `;
    },

    async init() {
        await Promise.all([
            this.loadCurrent(),
            this.loadVersions(),
            this.loadUploads()
        ]);
        this.renderCurrent();
        this.setupUploadForm();
        this.setupRollbackButton();
        this.setupSimulateLocation();

        // Real-time status updates from map-watcher via WebSocket
        this._wsHandler = (data) => this.handleStatusUpdate(data);
        wsClient.on('map_status', this._wsHandler);

        // Phase 8 — poll for external-storage bundles every 10 s while the
        // page is open. First scan runs immediately; the card only shows up
        // when at least one bundle is found.
        this.scanExternalNow();
        this._externalPoll = setInterval(() => this.scanExternalNow(), 10_000);
    },

    handleStatusUpdate(data) {
        const { id, status, timestamp, reason } = data;

        // Update cached list
        const upload = uploadsList.find(u => u.id === id);
        if (upload) {
            upload.status = status;
            upload.statusReason = reason || null;
            upload.statusUpdatedAt = timestamp;
        }

        // On 'applied' or 'rolled-back', current bundle changed — refresh.
        if (status === 'applied' || status === 'rolled-back') {
            (async () => {
                await Promise.all([this.loadCurrent(), this.loadVersions()]);
                this.renderCurrent();
            })();
        }

        this.renderUploads();
    },

    async loadCurrent() {
        try {
            currentBundle = await API.getMapCurrent();
        } catch (err) {
            console.error('Failed to load current bundle:', err);
            currentBundle = { status: 'error' };
        }
    },

    async loadVersions() {
        try {
            versionsList = await API.getMapVersions();
        } catch (err) {
            console.error('Failed to load versions:', err);
            versionsList = [];
        }
    },

    async loadUploads() {
        try {
            uploadsList = await API.getMapUploads();
        } catch (err) {
            console.error('Failed to load uploads:', err);
            uploadsList = [];
        }
        this.renderUploads();
    },

    renderCurrent() {
        const summaryEl = document.getElementById('current-bundle-summary');
        const detailsEl = document.getElementById('current-bundle-details');
        const rollbackContainer = document.getElementById('rollback-container');
        if (!summaryEl || !detailsEl) return;

        if (!currentBundle || currentBundle.status === 'no-bundle') {
            summaryEl.textContent = 'No map data installed. Upload a bundle below to enable the map, search, and routing.';
            detailsEl.innerHTML = '';
        } else if (currentBundle.status === 'error') {
            summaryEl.textContent = 'Could not read installed-bundle metadata.';
            detailsEl.innerHTML = '';
        } else {
            const m = currentBundle.manifest || {};
            const region = m.region_display_name || m.display_name || m.region || 'unknown';
            const built = m.build_date || currentBundle.version || 'unknown';
            summaryEl.textContent = `${region} · built ${built}`;
            detailsEl.innerHTML = `
                <span class="deployment-meta">Version dir: ${currentBundle.version || '—'}</span>
                ${m.pbf_date ? `<span class="deployment-meta">OSM extract: ${m.pbf_date}</span>` : ''}
                ${m.description ? `<span class="deployment-meta">${m.description}</span>` : ''}
            `;
        }

        // Show rollback only if there are at least 2 installed versions AND
        // a current symlink exists (a virgin device or single-version device
        // has nothing to roll back to).
        if (rollbackContainer) {
            const canRollback = (versionsList || []).length >= 2 && currentBundle && currentBundle.status === 'installed';
            rollbackContainer.classList.toggle('hidden', !canRollback);
        }
    },

    renderUploads() {
        const listEl = document.getElementById('maps-uploads-list');
        if (!listEl) return;

        if (!uploadsList || uploadsList.length === 0) {
            listEl.innerHTML = '<p class="settings-description">No uploads yet.</p>';
            return;
        }

        listEl.innerHTML = uploadsList.map(u => {
            // Cross-region confirmation prompt (Phase 5). map-watcher stalls
            // apply when the incoming bundle's region differs from what's
            // installed; user picks Confirm to proceed or Cancel to drop.
            const awaitingConf = u.status === 'awaiting-confirmation';
            const confirmBar = awaitingConf ? `
                <div class="map-upload-confirm-bar">
                    <div class="map-upload-confirm-message">
                        ${escapeHtml(u.statusReason || 'This upload declares a different region than what is installed.')}
                    </div>
                    <div class="map-upload-confirm-actions">
                        <button type="button" class="password-submit-btn map-upload-cancel-btn" data-id="${escapeHtml(u.id)}">Cancel</button>
                        <button type="button" class="password-submit-btn map-upload-confirm-btn" data-id="${escapeHtml(u.id)}">Confirm &amp; apply</button>
                    </div>
                </div>
            ` : '';
            return `
                <div class="deployment-list-item${awaitingConf ? ' deployment-list-item--attention' : ''}">
                    <div class="deployment-info">
                        <div class="deployment-header-row">
                            <span class="deployment-version">${u.filename || u.id}</span>
                            ${u.status ? `<span class="deployment-status ${statusClass(u.status)}">${formatStatus(u.status)}</span>` : ''}
                        </div>
                        <span class="deployment-meta">${formatFileSize(u.size)} &middot; ${(u.sha256 || '').substring(0, 12)}${u.sha256 ? '...' : ''}</span>
                        <span class="deployment-meta">
                            ${formatDate(u.uploadedAt)}
                            ${u.statusUpdatedAt ? ` &middot; ${formatStatus(u.status)}: ${formatDate(u.statusUpdatedAt)}` : ''}
                            ${u.statusReason && !awaitingConf ? ` &middot; ${u.statusReason}` : ''}
                        </span>
                        ${confirmBar}
                    </div>
                </div>
            `;
        }).join('');

        // Wire confirm / cancel buttons on any awaiting-confirmation rows.
        listEl.querySelectorAll('.map-upload-confirm-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                btn.disabled = true;
                try {
                    await API.confirmMapUpload(id);
                } catch (err) {
                    console.error('[maps] confirm failed:', err);
                    btn.disabled = false;
                }
            });
        });
        listEl.querySelectorAll('.map-upload-cancel-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                btn.disabled = true;
                try {
                    await API.cancelMapUpload(id);
                } catch (err) {
                    console.error('[maps] cancel failed:', err);
                    btn.disabled = false;
                }
            });
        });
    },

    setupUploadForm() {
        const form = document.getElementById('map-upload-form');
        if (!form) return;

        form.addEventListener('submit', (e) => {
            e.preventDefault();

            if (this._uploadInFlight) {
                const messageEl = document.getElementById('map-upload-message');
                messageEl.textContent = 'An upload is already in progress. Wait for it to finish before starting another.';
                messageEl.classList.remove('hidden', 'success');
                messageEl.classList.add('error');
                return;
            }
            this._uploadInFlight = true;

            const fileInput = document.getElementById('map-file');
            const file = fileInput.files[0];
            if (!file) {
                this._uploadInFlight = false;
                return;
            }

            const formData = new FormData();
            formData.append('file', file);

            const progressContainer = document.getElementById('map-upload-progress-container');
            const progressFill = document.getElementById('map-upload-progress-fill');
            const progressText = document.getElementById('map-upload-progress-text');
            const messageEl = document.getElementById('map-upload-message');
            const submitBtn = document.getElementById('map-upload-submit-btn');

            if (this._currentXhr) {
                try { this._currentXhr.abort(); } catch (_) { /* ignore */ }
                this._currentXhr = null;
            }

            progressContainer.classList.remove('hidden');
            messageEl.classList.add('hidden');
            messageEl.classList.remove('success', 'error');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Uploading...';
            progressFill.style.width = '0%';
            progressText.textContent = '0%';
            let maxPct = 0;

            const xhr = new XMLHttpRequest();
            this._currentXhr = xhr;
            xhr.open('POST', '/api/maps/upload');
            xhr.setRequestHeader('Authorization', `Bearer ${AuthStore.getToken()}`);

            xhr.upload.onprogress = (e) => {
                if (this._currentXhr !== xhr) return;
                if (!e.lengthComputable) return;
                const pct = Math.round((e.loaded / e.total) * 100);
                if (pct > maxPct) maxPct = pct;
                progressFill.style.width = maxPct + '%';
                progressText.textContent = `${maxPct}% (${formatFileSize(e.loaded)} / ${formatFileSize(e.total)})`;
            };

            const finish = () => {
                if (this._currentXhr === xhr) this._currentXhr = null;
                this._uploadInFlight = false;
                submitBtn.disabled = false;
                submitBtn.textContent = 'Upload Bundle';
            };

            xhr.onload = () => {
                finish();

                if (xhr.status >= 200 && xhr.status < 300) {
                    messageEl.textContent = 'Upload complete. The device is now verifying and extracting the bundle — status will update below.';
                    messageEl.classList.remove('hidden', 'error');
                    messageEl.classList.add('success');
                    fileInput.value = '';
                    progressFill.style.width = '100%';
                    this.loadUploads();
                } else {
                    let errorMsg = `Upload failed (HTTP ${xhr.status})`;
                    try {
                        const resp = JSON.parse(xhr.responseText);
                        if (resp.error) errorMsg = `${resp.error} (HTTP ${xhr.status})`;
                    } catch (_) { /* ignore parse error */ }
                    console.error('[maps] upload failed:', xhr.status, xhr.responseText);
                    messageEl.textContent = errorMsg;
                    messageEl.classList.remove('hidden', 'success');
                    messageEl.classList.add('error');
                }
            };

            xhr.onerror = () => {
                finish();
                console.error('[maps] upload network error, status=', xhr.status);
                messageEl.textContent = 'Upload failed — network error';
                messageEl.classList.remove('hidden', 'success');
                messageEl.classList.add('error');
            };

            xhr.onabort = () => {
                if (this._currentXhr === xhr) finish();
                else {
                    this._uploadInFlight = false;
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Upload Bundle';
                }
            };

            xhr.send(formData);
        });
    },

    setupRollbackButton() {
        const btn = document.getElementById('rollback-btn');
        const messageEl = document.getElementById('rollback-message');
        if (!btn) return;

        btn.addEventListener('click', async () => {
            if (!confirm('Roll back to the previous map bundle? Photon and Valhalla will restart.')) return;
            btn.disabled = true;
            messageEl.classList.add('hidden');
            messageEl.classList.remove('success', 'error');
            try {
                const resp = await API.rollbackMap();
                messageEl.textContent = `Rollback requested (target: ${resp.targetVersion}). Status will update below.`;
                messageEl.classList.remove('hidden', 'error');
                messageEl.classList.add('success');
            } catch (err) {
                messageEl.textContent = `Rollback failed: ${err.message || err}`;
                messageEl.classList.remove('hidden', 'success');
                messageEl.classList.add('error');
            } finally {
                btn.disabled = false;
            }
        });
    },

    setupSimulateLocation() {
        const toggle = document.getElementById('simulate-location-toggle');
        const coordsBox = document.getElementById('simulate-location-coords');
        const latInput = document.getElementById('simulate-lat-input');
        const lonInput = document.getElementById('simulate-lon-input');
        const resetBtn = document.getElementById('simulate-reset-btn');
        if (!toggle || !coordsBox || !latInput || !lonInput || !resetBtn) return;

        const applyState = () => {
            const active = gnssSimulator.isActive();
            const { latitude, longitude } = gnssSimulator.getCoords();
            toggle.classList.toggle('active', active);
            toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
            // `.settings-units-container` sets `display: flex`, which beats
            // the HTML `hidden` attribute, so we toggle a `.hidden` utility
            // class (declared with `!important`) for visibility instead.
            coordsBox.classList.toggle('hidden', !active);
            // Only overwrite the input if the user isn't editing — avoids
            // clobbering keystrokes when onChange fires from persist().
            if (document.activeElement !== latInput) latInput.value = latitude.toFixed(4);
            if (document.activeElement !== lonInput) lonInput.value = longitude.toFixed(4);
        };

        applyState();
        this._simUnsub = gnssSimulator.onChange(applyState);

        toggle.addEventListener('click', () => {
            if (gnssSimulator.isActive()) gnssSimulator.disable();
            else gnssSimulator.enable();
        });

        const commitCoords = () => {
            const lat = parseFloat(latInput.value);
            const lon = parseFloat(lonInput.value);
            if (isFinite(lat) && isFinite(lon)) {
                gnssSimulator.setCoords(lat, lon);
            }
        };
        latInput.addEventListener('change', commitCoords);
        lonInput.addEventListener('change', commitCoords);

        resetBtn.addEventListener('click', () => {
            const { latitude, longitude } = gnssSimulator.getDefaultCoords();
            gnssSimulator.setCoords(latitude, longitude);
        });
    },

    // --- Phase 8: sneakernet (USB/SD) load path -----------------------------

    async scanExternalNow() {
        // Polled every 10s. Silent no-op on error; the card just doesn't
        // appear if the backend can't scan (e.g. host-root mount not
        // available in a dev-machine setup).
        let results = [];
        try {
            const resp = await API.scanExternalMaps();
            results = (resp && Array.isArray(resp.results)) ? resp.results : [];
        } catch (err) {
            console.warn('[maps] external scan failed:', err);
            return;
        }
        this.renderExternalBundles(results);
    },

    renderExternalBundles(results) {
        const card = document.getElementById('external-storage-card');
        const listEl = document.getElementById('external-bundles-list');
        if (!card || !listEl) return;

        if (!results || results.length === 0) {
            card.classList.add('hidden');
            listEl.innerHTML = '';
            return;
        }
        card.classList.remove('hidden');
        listEl.innerHTML = results.map((b, i) => `
            <div class="external-bundle-row">
                <div class="external-bundle-info">
                    <div class="external-bundle-name">${this.escapeText(b.name || '')}</div>
                    <div class="external-bundle-meta">
                        ${formatFileSize(b.size)} &middot; ${this.escapeText(b.mountpoint || '')}
                        ${b.mtime ? ' &middot; ' + formatDate(b.mtime) : ''}
                    </div>
                </div>
                <button type="button" class="password-submit-btn external-import-btn"
                        data-idx="${i}" style="width: auto; padding: 6px 14px;">
                    Import
                </button>
            </div>
        `).join('');
        listEl.querySelectorAll('.external-import-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx, 10);
                const b = results[idx];
                if (b) this.importExternalBundle(b);
            });
        });
    },

    async importExternalBundle(bundle) {
        const progressContainer = document.getElementById('external-import-progress');
        const progressFill = document.getElementById('external-import-progress-fill');
        const progressText = document.getElementById('external-import-progress-text');
        const messageEl = document.getElementById('external-import-message');
        const buttons = document.querySelectorAll('.external-import-btn');
        if (!progressContainer || !messageEl) return;

        buttons.forEach(b => b.disabled = true);
        messageEl.classList.add('hidden');
        messageEl.classList.remove('success', 'error');
        progressContainer.classList.remove('hidden');
        progressFill.style.width = '0%';
        progressText.textContent = `Copying ${bundle.name} to device…`;

        // The backend copies synchronously and returns when done. There's
        // no progress-during-copy signal today; we show an indeterminate
        // "in progress" state and let the map-watcher status stream take
        // over once the copy completes and MAPS_AVAILABLE fires.
        progressFill.style.width = '100%';
        progressFill.style.background = 'linear-gradient(90deg, var(--primary), var(--primary), transparent)';
        progressFill.style.backgroundSize = '200% 100%';
        progressFill.style.animation = 'external-shimmer 1.2s linear infinite';

        try {
            const resp = await API.importExternalMap(bundle.path);
            messageEl.textContent = `Copied to device. Verifying + extracting will follow — status shows below.`;
            messageEl.classList.remove('hidden', 'error');
            messageEl.classList.add('success');
            progressText.textContent = 'Copy complete';
            progressFill.style.animation = '';
            // Refresh the uploads list so the new external row appears.
            this.loadUploads();
        } catch (err) {
            console.error('[maps] external import failed:', err);
            messageEl.textContent = `Import failed: ${err.message || err}`;
            messageEl.classList.remove('hidden', 'success');
            messageEl.classList.add('error');
            progressContainer.classList.add('hidden');
            progressFill.style.animation = '';
        } finally {
            buttons.forEach(b => b.disabled = false);
        }
    },

    // Small XSS-safe text helper for external-bundle rendering. We can't
    // reuse the top-level escapeHtml because it lives at module scope and
    // some rows go through innerHTML.
    escapeText(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    },

    cleanup() {
        if (this._simUnsub) {
            this._simUnsub();
            this._simUnsub = null;
        }
        if (this._wsHandler) {
            wsClient.off('map_status', this._wsHandler);
            this._wsHandler = null;
        }
        if (this._currentXhr) {
            try { this._currentXhr.abort(); } catch (_) { /* ignore */ }
            this._currentXhr = null;
        }
        if (this._externalPoll) {
            clearInterval(this._externalPoll);
            this._externalPoll = null;
        }
        this._uploadInFlight = false;
        uploadsList = [];
        currentBundle = null;
        versionsList = [];
    }
};
