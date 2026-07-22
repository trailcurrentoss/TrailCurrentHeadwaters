// Live Monitoring page.
//
// Grid of live-view tiles for every camera currently enabled AND
// physically connected. Tap a tile to open the full-screen viewer modal.
//
// Video is delivered over WebSocket as H.264 Annex-B access units and
// decoded natively via the WebCodecs VideoDecoder API into a <canvas>.
// See components/h264-stream.js for the transport + decode implementation.

import { API } from '../api.js';
import { router } from '../router.js';
import { CameraViewer } from '../components/camera-viewer.js';
import { mountStreamToCanvas } from '../components/h264-stream.js';

let cameras = [];
let loading = true;
let loadError = null;
let containerClickListener = null;
let visibilityListener = null;
let pageHideListener = null;
let viewer = null;

// Active stream handles keyed by camera id. Each entry is a stream we
// spawned for the current render; close() them all on re-render, on
// navigation-away, on visibility change, on pagehide.
const activeStreams = new Map();

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function renderTile(cam) {
    return `
        <button class="monitor-tile" data-action="expand" data-id="${escapeAttr(cam.id)}"
                aria-label="View ${escapeAttr(cam.name)} full screen">
            <div class="monitor-tile-frame">
                <canvas class="monitor-tile-canvas" data-tile-id="${escapeAttr(cam.id)}"></canvas>
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

// Spawn an H.264 stream for each tile canvas currently in the DOM,
// after any previously-active streams have been closed. Called after
// every paint that includes tiles.
function mountStreams() {
    tearDownStreams();
    document.querySelectorAll('canvas.monitor-tile-canvas').forEach(canvas => {
        const id = canvas.dataset.tileId;
        if (!id) return;
        const stream = mountStreamToCanvas(id, canvas, {
            onError: (err) => {
                console.warn(`[monitoring] stream error for ${id}:`, err.message);
            },
        });
        activeStreams.set(id, stream);
    });
}

// Close every active stream — releases the WebSocket immediately,
// which fires ws.on('close') on the backend so the streamer's
// on-demand lifecycle can shut ffmpeg down after the idle grace period.
function tearDownStreams() {
    for (const stream of activeStreams.values()) {
        try { stream.close(); } catch { /* ignore */ }
    }
    activeStreams.clear();
}

function paint() {
    const container = document.getElementById('monitoring-container');
    if (!container) return;
    container.innerHTML = renderInner();
    // Only spawn streams if we're painting tiles (not the status/empty state).
    if (!loading && !loadError && cameras.some(c => c.enabled && c.connected)) {
        mountStreams();
    }
}

// Hard cap on how long we'll wait for the camera list before giving up
// and surfacing an error. Under normal conditions the response arrives
// in ~50 ms on the LAN.
const CAMERAS_LIST_TIMEOUT_MS = 8000;

async function loadCameras() {
    loading = true;
    loadError = null;
    paint();
    try {
        const data = await Promise.race([
            API.getCameras(),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(`Timed out after ${CAMERAS_LIST_TIMEOUT_MS / 1000}s`)),
                CAMERAS_LIST_TIMEOUT_MS
            )),
        ]);
        cameras = Array.isArray(data.cameras) ? data.cameras : [];
    } catch (err) {
        console.error('[monitoring] load failed:', err);
        loadError = err.message || 'Network error';
        cameras = [];
    }
    loading = false;
    paint();
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

    // Belt-and-suspenders for edge cases where cleanup() might not fire:
    // - iOS Safari tab backgrounding (visibilitychange)
    // - Safari BFCache navigation, native browser back button (pagehide)
    // Both close streams if they fire; on visible=true we repaint to
    // spawn fresh streams. Router cleanup() handles the common SPA case.
    visibilityListener = () => {
        if (document.visibilityState === 'hidden') {
            tearDownStreams();
        } else if (document.visibilityState === 'visible' && !loading && !loadError) {
            paint();
        }
    };
    document.addEventListener('visibilitychange', visibilityListener);

    pageHideListener = () => tearDownStreams();
    window.addEventListener('pagehide', pageHideListener);
}

function unwireListeners() {
    const container = document.getElementById('monitoring-container');
    if (container && containerClickListener) {
        container.removeEventListener('click', containerClickListener);
    }
    containerClickListener = null;

    if (visibilityListener) {
        document.removeEventListener('visibilitychange', visibilityListener);
        visibilityListener = null;
    }
    if (pageHideListener) {
        window.removeEventListener('pagehide', pageHideListener);
        pageHideListener = null;
    }
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
