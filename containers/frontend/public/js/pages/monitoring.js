// Live Monitoring page.
//
// Grid of live-view tiles for every camera currently enabled AND
// physically connected. Tap a tile to open the full-screen viewer modal
// (native <img> path with canvas-shim fallback, same primitive used by
// the row-level "View" button in Settings > Cameras & Monitoring).
//
// The tiles themselves use plain <img src="…/stream"> — reliable in
// Firefox and Safari, works in recent Chrome, and if a tile misbehaves
// the user still has the modal's full fallback logic one tap away.

import { API, AuthStore } from '../api.js';
import { router } from '../router.js';
import { CameraViewer } from '../components/camera-viewer.js';

// Build a stream URL with the session token as a query param. HTML
// <img src> can't attach an Authorization header, so the backend
// middleware also accepts ?token=/?apiKey= on GET requests. Cache-bust
// with `t=` so a re-mount doesn't reuse a dead stream from image cache.
function streamUrl(cameraId) {
    const token = AuthStore.getToken();
    const parts = [`t=${Date.now()}`];
    if (token) parts.push(`token=${encodeURIComponent(token)}`);
    return `/api/cameras/${encodeURIComponent(cameraId)}/stream?${parts.join('&')}`;
}

let cameras = [];
let loading = true;
let loadError = null;
let containerClickListener = null;
let viewer = null;

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function renderTile(cam) {
    const src = streamUrl(cam.id);
    return `
        <button class="monitor-tile" data-action="expand" data-id="${escapeAttr(cam.id)}"
                aria-label="View ${escapeAttr(cam.name)} full screen">
            <div class="monitor-tile-frame">
                <img class="monitor-tile-img" src="${src}" alt="${escapeAttr(cam.name)}">
                <div class="monitor-tile-live-badge">
                    <span class="monitor-tile-live-dot"></span>LIVE
                </div>
            </div>
            <div class="monitor-tile-caption">
                <span class="monitor-tile-name">${escapeHtml(cam.name)}</span>
                ${cam.model ? `<span class="monitor-tile-sub">${escapeHtml(cam.model)}</span>` : ''}
            </div>
        </button>
    `;
}

function renderInner() {
    if (loading) {
        return `<div class="monitor-status">Loading cameras…</div>`;
    }
    if (loadError) {
        return `
            <div class="monitor-status monitor-status-error">
                <div>Couldn't load cameras.</div>
                <div class="monitor-status-sub">${escapeHtml(loadError)}</div>
                <button class="monitor-retry-btn" data-action="reload">Retry</button>
            </div>
        `;
    }
    const streamable = cameras.filter(c => c.enabled && c.connected);
    if (!streamable.length) {
        const anyEnabled = cameras.some(c => c.enabled);
        const anyAdded = cameras.length > 0;
        let title, sub;
        if (!anyAdded) {
            title = 'No cameras added yet';
            sub = 'Add a USB camera in Settings → Cameras &amp; Monitoring, then enable it.';
        } else if (!anyEnabled) {
            title = 'No cameras enabled';
            sub = 'Enable a camera in Settings → Cameras &amp; Monitoring to see its live feed here.';
        } else {
            title = 'Enabled cameras are offline';
            sub = 'The cameras you enabled are not currently connected. Check their USB connections.';
        }
        return `
            <div class="monitor-empty">
                <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor"
                     stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
                     class="monitor-empty-icon">
                    <polygon points="23 7 16 12 23 17 23 7"></polygon>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                </svg>
                <div class="monitor-empty-title">${title}</div>
                <div class="monitor-empty-sub">${sub}</div>
                <button class="monitor-empty-cta" data-action="open-settings">
                    Open Camera Settings
                </button>
            </div>
        `;
    }
    return `<div class="monitor-grid">${streamable.map(renderTile).join('')}</div>`;
}

function paint() {
    const container = document.getElementById('monitoring-container');
    if (container) container.innerHTML = renderInner();
}

async function loadCameras() {
    loading = true;
    loadError = null;
    paint();
    try {
        const data = await API.getCameras();
        cameras = Array.isArray(data.cameras) ? data.cameras : [];
    } catch (err) {
        console.error('[monitoring] load failed:', err);
        loadError = err.message || 'Network error';
        cameras = [];
    }
    loading = false;
    paint();
}

function tearDownStreams() {
    // Zero every <img src> so the browser closes each multipart HTTP
    // connection immediately. Without this the streams would keep
    // running in the image cache after we navigate away.
    document.querySelectorAll('.monitor-tile-img').forEach(img => {
        try { img.src = ''; } catch { /* ignore */ }
    });
}

function wireListeners() {
    const container = document.getElementById('monitoring-container');
    if (!container) return;
    containerClickListener = (e) => {
        const el = e.target.closest('[data-action]');
        if (!el || !container.contains(el)) return;
        const action = el.dataset.action;
        if (action === 'expand') {
            const id = el.dataset.id;
            const cam = cameras.find(c => c.id === id);
            if (cam && viewer) viewer.open(cam);
            return;
        }
        if (action === 'reload') { loadCameras(); return; }
        if (action === 'open-settings') {
            router.navigate('settings/cameras');
            return;
        }
    };
    container.addEventListener('click', containerClickListener);
}

function unwireListeners() {
    const container = document.getElementById('monitoring-container');
    if (container && containerClickListener) {
        container.removeEventListener('click', containerClickListener);
    }
    containerClickListener = null;
}

export const monitoringPage = {
    render() {
        return `
            <section class="page-monitoring">
                <h1 class="section-title">Live Monitoring</h1>
                <div id="monitoring-container" class="monitoring-container">
                    <div class="monitor-status">Loading cameras…</div>
                </div>
            </section>
        `;
    },

    async init() {
        viewer = new CameraViewer();
        await loadCameras();
        wireListeners();
    },

    cleanup() {
        tearDownStreams();
        unwireListeners();
        if (viewer) { viewer.close(); viewer = null; }
        cameras = [];
        loading = true;
        loadError = null;
    },
};
