// Deployments page — local deployment upload and status tracking
import { API, AuthStore, wsClient } from '../api.js';

let deploymentsList = [];

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
    });
}

function formatStatus(status, progress) {
    if (!status) return '';
    const labels = {
        downloading: 'Downloading',
        downloaded: 'Downloaded',
        extracting: 'Extracting',
        deploying: 'Deploying',
        completed: 'Deployed',
        failed: 'Failed'
    };
    const label = labels[status] || status;
    if (status === 'downloading' && typeof progress === 'number') {
        return `${label} ${progress}%`;
    }
    return label;
}

function statusClass(status) {
    if (!status) return '';
    if (status === 'completed') return 'status-success';
    if (status === 'failed') return 'status-danger';
    return 'status-active';
}

export const deploymentsPage = {
    render() {
        return `
            <section class="page-deployments">
                <h1 class="section-title">Deployments</h1>
                <div class="settings-container" id="deployments-container">
                    <!-- Upload form -->
                    <div class="card settings-item-vertical">
                        <div class="settings-item-header">
                            <span class="settings-label">Upload Deployment Package</span>
                            <p class="settings-description">Upload a .zip deployment package</p>
                        </div>
                        <form id="deployment-upload-form" class="password-form">
                            <div class="password-form-group">
                                <label for="deployment-version" class="password-label">Version</label>
                                <input type="text" id="deployment-version" class="password-input"
                                       placeholder="e.g. 1.2.3" required
                                       inputmode="decimal" autocomplete="off"
                                       pattern="^\\d+\\.\\d+\\.\\d+$">
                                <div id="deployment-version-error" class="password-message error hidden"></div>
                            </div>
                            <div class="password-form-group">
                                <label for="deployment-file" class="password-label">Package File (.zip)</label>
                                <input type="file" id="deployment-file" accept=".zip" required
                                       class="password-input">
                            </div>
                            <div id="upload-progress-container" class="hidden">
                                <div class="upload-progress-bar">
                                    <div class="upload-progress-fill" id="upload-progress-fill"></div>
                                </div>
                                <span id="upload-progress-text" class="settings-description">0%</span>
                            </div>
                            <div id="upload-message" class="password-message hidden"></div>
                            <button type="submit" class="password-submit-btn" id="upload-submit-btn">
                                Upload Package
                            </button>
                        </form>
                    </div>

                    <!-- Deployment list -->
                    <div class="card settings-item-vertical">
                        <div class="settings-item-header">
                            <span class="settings-label">Available Packages</span>
                        </div>
                        <div id="deployments-list">
                            Loading...
                        </div>
                    </div>
                </div>
            </section>
        `;
    },

    async init() {
        await this.loadDeployments();
        this.setupUploadForm();

        // Listen for real-time deployment status updates via WebSocket
        this._wsHandler = (data) => {
            this.handleStatusUpdate(data);
        };
        wsClient.on('deployment_status', this._wsHandler);
    },

    handleStatusUpdate(data) {
        const { deploymentId, status, timestamp, progress } = data;

        // Update the cached list
        const deployment = deploymentsList.find(d => d.id === deploymentId);
        if (deployment) {
            deployment.latestStatus = status;
            deployment.statusUpdatedAt = timestamp;
            deployment.downloadProgress = typeof progress === 'number' ? progress : undefined;
        }

        // Update the badge in the DOM without a full re-render
        const listEl = document.getElementById('deployments-list');
        if (!listEl) return;

        const items = listEl.querySelectorAll('.deployment-list-item');
        items.forEach((item, index) => {
            const d = deploymentsList[index];
            if (!d || d.id !== deploymentId) return;

            const headerRow = item.querySelector('.deployment-header-row');
            if (!headerRow) return;

            // Update or insert the status badge
            let badge = headerRow.querySelector('.deployment-status');
            if (status) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'deployment-status';
                    headerRow.appendChild(badge);
                }
                badge.className = `deployment-status ${statusClass(status)}`;
                badge.textContent = formatStatus(status, d.downloadProgress);
            } else if (badge) {
                badge.remove();
            }

            // Update the meta line with status timestamp
            const metaLines = item.querySelectorAll('.deployment-meta');
            if (metaLines.length >= 2 && d) {
                const baseMeta = `${formatDate(d.uploadedAt)} \u00b7 ${d.sha256.substring(0, 12)}...`;
                metaLines[1].innerHTML = d.statusUpdatedAt
                    ? `${baseMeta} &middot; ${formatStatus(d.latestStatus, d.downloadProgress)}: ${formatDate(d.statusUpdatedAt)}`
                    : baseMeta;
            }
        });
    },

    async loadDeployments() {
        const listEl = document.getElementById('deployments-list');
        try {
            deploymentsList = await API.getDeployments();
            if (deploymentsList.length === 0) {
                listEl.innerHTML = '<p class="settings-description">No deployment packages uploaded yet.</p>';
                return;
            }
            listEl.innerHTML = deploymentsList.map(d => `
                <div class="deployment-list-item">
                    <div class="deployment-info">
                        <div class="deployment-header-row">
                            <span class="deployment-version">v${d.version}</span>
                            ${d.latestStatus ? `<span class="deployment-status ${statusClass(d.latestStatus)}">${formatStatus(d.latestStatus)}</span>` : ''}
                        </div>
                        <span class="deployment-meta">${d.filename} &middot; ${formatFileSize(d.size)}</span>
                        <span class="deployment-meta">${formatDate(d.uploadedAt)} &middot; ${d.sha256.substring(0, 12)}...${d.statusUpdatedAt ? ' &middot; ' + formatStatus(d.latestStatus) + ': ' + formatDate(d.statusUpdatedAt) : ''}</span>
                    </div>
                    <button class="deployment-delete-btn" data-id="${d.id}" title="Delete package">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            `).join('');

            // Attach delete handlers
            listEl.querySelectorAll('.deployment-delete-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.id;
                    if (!confirm('Delete this deployment package?')) return;
                    btn.disabled = true;
                    try {
                        await API.deleteDeployment(id);
                        await this.loadDeployments();
                    } catch (error) {
                        console.error('Failed to delete deployment:', error);
                        btn.disabled = false;
                    }
                });
            });
        } catch (error) {
            console.error('Failed to fetch deployments:', error);
            listEl.innerHTML = '<p style="color: var(--danger);">Failed to load deployments</p>';
        }
    },

    setupUploadForm() {
        const form = document.getElementById('deployment-upload-form');
        const versionInput = document.getElementById('deployment-version');
        const versionError = document.getElementById('deployment-version-error');

        // Inline version validation — must be strict X.X.X (numeric only).
        // Common rejections: leading 'v' (e.g. "v1.2.3"), semver
        // pre-release suffixes ("1.2.3-rc1"), or single-segment / partial
        // values. Show a friendly, specific message per failure mode and
        // gate submit on validity.
        const validateVersion = (showWhenEmpty = false) => {
            const raw = versionInput.value;
            const trimmed = raw.trim();
            if (!trimmed) {
                if (showWhenEmpty) setVersionError('Version is required.');
                else clearVersionError();
                return false;
            }
            if (/^v/i.test(trimmed)) {
                setVersionError('Drop the “v” — version should be just numbers, e.g. 1.2.3');
                return false;
            }
            if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
                setVersionError('Use the format X.X.X (e.g. 1.2.3) — only numbers and two dots.');
                return false;
            }
            clearVersionError();
            return true;
        };
        const setVersionError = (msg) => {
            if (!versionError) return;
            versionError.textContent = msg;
            versionError.classList.remove('hidden');
            versionInput.setAttribute('aria-invalid', 'true');
        };
        const clearVersionError = () => {
            if (!versionError) return;
            versionError.textContent = '';
            versionError.classList.add('hidden');
            versionInput.removeAttribute('aria-invalid');
        };

        // Live feedback as the user types — clear errors the moment the
        // value looks valid; surface them on blur even if mid-edit.
        versionInput.addEventListener('input', () => validateVersion(false));
        versionInput.addEventListener('blur',  () => validateVersion(true));

        form.addEventListener('submit', (e) => {
            e.preventDefault();

            // Double-submit guard: `submitBtn.disabled = true` below can't
            // stop a second submit event that's already queued (double-click,
            // Enter+click), because both events run the handler before either
            // sees the disabled state. Without this check, two XHR uploads
            // race for the same file — both fire onprogress on the same DOM
            // elements (the counter appears to oscillate), the server sees
            // two concurrent multipart streams for the same version, and one
            // typically fails with "network error" when its connection is
            // reset.
            if (this._uploadInFlight) {
                const messageEl = document.getElementById('upload-message');
                messageEl.textContent = 'An upload is already in progress. Please wait for it to finish before starting another.';
                messageEl.classList.remove('hidden', 'success');
                messageEl.classList.add('error');
                return;
            }

            if (!validateVersion(true)) {
                versionInput.focus();
                return;
            }
            const version = versionInput.value.trim();
            const fileInput = document.getElementById('deployment-file');
            const file = fileInput.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('version', version);
            formData.append('file', file);

            const progressContainer = document.getElementById('upload-progress-container');
            const progressFill = document.getElementById('upload-progress-fill');
            const progressText = document.getElementById('upload-progress-text');
            const messageEl = document.getElementById('upload-message');
            const submitBtn = document.getElementById('upload-submit-btn');

            // Reset state
            this._uploadInFlight = true;
            progressContainer.classList.remove('hidden');
            messageEl.classList.add('hidden');
            messageEl.classList.remove('success', 'error');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Uploading...';
            progressFill.style.width = '0%';
            progressText.textContent = '0%';

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/deployments/upload');
            xhr.setRequestHeader('Authorization', `Bearer ${AuthStore.getToken()}`);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    progressFill.style.width = pct + '%';
                    progressText.textContent = pct + '% (' + formatFileSize(e.loaded) + ' / ' + formatFileSize(e.total) + ')';
                }
            };

            xhr.onload = () => {
                this._uploadInFlight = false;
                submitBtn.disabled = false;
                submitBtn.textContent = 'Upload Package';

                if (xhr.status >= 200 && xhr.status < 300) {
                    messageEl.textContent = 'Upload complete! Deployment notification sent.';
                    messageEl.classList.remove('hidden', 'error');
                    messageEl.classList.add('success');

                    // Reset form
                    document.getElementById('deployment-version').value = '';
                    fileInput.value = '';
                    progressFill.style.width = '100%';

                    // Refresh list
                    this.loadDeployments();
                } else {
                    let errorMsg = 'Upload failed';
                    try {
                        const resp = JSON.parse(xhr.responseText);
                        errorMsg = resp.error || errorMsg;
                    } catch (e) { /* ignore parse error */ }
                    messageEl.textContent = errorMsg;
                    messageEl.classList.remove('hidden', 'success');
                    messageEl.classList.add('error');
                }
            };

            xhr.onerror = () => {
                this._uploadInFlight = false;
                submitBtn.disabled = false;
                submitBtn.textContent = 'Upload Package';
                messageEl.textContent = 'Upload failed - network error';
                messageEl.classList.remove('hidden', 'success');
                messageEl.classList.add('error');
            };

            xhr.send(formData);
        });
    },

    cleanup() {
        if (this._wsHandler) {
            wsClient.off('deployment_status', this._wsHandler);
            this._wsHandler = null;
        }
        deploymentsList = [];
    }
};
