// Maps page — offline bundle upload, status tracking, rollback.
import { API, AuthStore, wsClient } from '../api.js';

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
        'rolled-back': 'Rolled back'
    };
    return labels[status] || status;
}

function statusClass(status) {
    if (!status) return '';
    if (status === 'applied' || status === 'rolled-back') return 'status-success';
    if (status === 'failed') return 'status-danger';
    return 'status-active';
}

export const mapsPage = {
    render() {
        return `
            <section class="page-maps">
                <h1 class="section-title">Maps</h1>
                <div class="settings-container" id="maps-container">

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

        // Real-time status updates from map-watcher via WebSocket
        this._wsHandler = (data) => this.handleStatusUpdate(data);
        wsClient.on('map_status', this._wsHandler);
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

        listEl.innerHTML = uploadsList.map(u => `
            <div class="deployment-list-item">
                <div class="deployment-info">
                    <div class="deployment-header-row">
                        <span class="deployment-version">${u.filename || u.id}</span>
                        ${u.status ? `<span class="deployment-status ${statusClass(u.status)}">${formatStatus(u.status)}</span>` : ''}
                    </div>
                    <span class="deployment-meta">${formatFileSize(u.size)} &middot; ${(u.sha256 || '').substring(0, 12)}${u.sha256 ? '...' : ''}</span>
                    <span class="deployment-meta">
                        ${formatDate(u.uploadedAt)}
                        ${u.statusUpdatedAt ? ` &middot; ${formatStatus(u.status)}: ${formatDate(u.statusUpdatedAt)}` : ''}
                        ${u.statusReason ? ` &middot; ${u.statusReason}` : ''}
                    </span>
                </div>
            </div>
        `).join('');
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

    cleanup() {
        if (this._wsHandler) {
            wsClient.off('map_status', this._wsHandler);
            this._wsHandler = null;
        }
        if (this._currentXhr) {
            try { this._currentXhr.abort(); } catch (_) { /* ignore */ }
            this._currentXhr = null;
        }
        this._uploadInFlight = false;
        uploadsList = [];
        currentBundle = null;
        versionsList = [];
    }
};
