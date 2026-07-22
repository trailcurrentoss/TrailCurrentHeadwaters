// Full-screen camera live-view modal.
//
// Same H.264-over-WebSocket + WebCodecs decoder as the monitoring
// tiles — see components/h264-stream.js. This modal just gives the
// same stream a full-screen canvas.

import { mountStreamToCanvas } from './h264-stream.js';

// Absolute ceiling for "modal opened but no frame ever arrived." If
// this fires the user sees an error with a Retry button instead of
// "Connecting…" forever.
const OVERALL_CONNECT_TIMEOUT_MS = 8000;

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export class CameraViewer {
    constructor() {
        this.overlay = null;
        this.canvas = null;
        this.stream = null;
        this.overallTimer = null;
        this.firstFrameSeen = false;
        this.onKeyDown = null;
        this.currentCamera = null;
    }

    open(camera) {
        if (this.overlay) this.close();
        this.currentCamera = camera;
        this.firstFrameSeen = false;

        const title = escapeHtml(camera.name || 'Camera');
        const sub = escapeHtml(camera.model || '');

        this.overlay = document.createElement('div');
        this.overlay.className = 'cam-viewer-overlay';
        this.overlay.innerHTML = `
            <div class="cam-viewer">
                <div class="cam-viewer-header">
                    <div class="cam-viewer-title">
                        <span class="cam-viewer-name">${title}</span>
                        ${sub ? `<span class="cam-viewer-sub">${sub}</span>` : ''}
                    </div>
                    <button class="cam-viewer-close" aria-label="Close">
                        <ion-icon name="close-outline" aria-hidden="true"></ion-icon>
                    </button>
                </div>
                <div class="cam-viewer-stage" id="cam-viewer-stage">
                    <canvas class="cam-viewer-image" id="cam-viewer-canvas"></canvas>
                    <div class="cam-viewer-status" id="cam-viewer-status">Connecting…</div>
                </div>
            </div>
        `;
        document.body.appendChild(this.overlay);

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay || e.target.closest('.cam-viewer-close')) {
                this.close();
            }
        });
        this.onKeyDown = (e) => { if (e.key === 'Escape') this.close(); };
        window.addEventListener('keydown', this.onKeyDown);

        this.canvas = this.overlay.querySelector('#cam-viewer-canvas');
        const status = this.overlay.querySelector('#cam-viewer-status');

        // Absolute ceiling on "still trying to connect" — surface an
        // error with a retry button instead of leaving the user on
        // "Connecting…" forever if the stream never delivers a frame.
        this.overallTimer = setTimeout(() => {
            if (!this.firstFrameSeen) this.showConnectFailure();
        }, OVERALL_CONNECT_TIMEOUT_MS);

        this.stream = mountStreamToCanvas(camera.id, this.canvas, {
            onFirstFrame: () => {
                this.firstFrameSeen = true;
                clearTimeout(this.overallTimer);
                this.overallTimer = null;
                if (status) status.remove();
            },
            onError: (err) => {
                console.error('[camera-viewer] stream error:', err);
                if (!this.firstFrameSeen) this.showConnectFailure(err.message);
            },
        });
    }

    showConnectFailure(detail) {
        if (!this.overlay) return;
        if (this.stream) { try { this.stream.close(); } catch { /* ignore */ } this.stream = null; }
        clearTimeout(this.overallTimer);
        this.overallTimer = null;

        const stage = this.overlay.querySelector('#cam-viewer-stage');
        if (!stage) return;
        stage.innerHTML = `
            <div class="cam-viewer-error">
                <div class="cam-viewer-error-title">Couldn't start the stream</div>
                <div class="cam-viewer-error-sub">${escapeHtml(detail || 'The camera may be offline, or another connection may be blocking new streams. Try again in a moment.')}</div>
                <button class="cam-viewer-retry-btn" type="button">Retry</button>
            </div>
        `;
        const retry = stage.querySelector('.cam-viewer-retry-btn');
        if (retry) {
            retry.addEventListener('click', () => {
                const cam = this.currentCamera;
                if (!cam) return;
                this.close();
                this.open(cam);
            });
        }
    }

    close() {
        clearTimeout(this.overallTimer);
        this.overallTimer = null;
        if (this.stream) {
            try { this.stream.close(); } catch { /* ignore */ }
            this.stream = null;
        }
        this.canvas = null;
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        if (this.onKeyDown) {
            window.removeEventListener('keydown', this.onKeyDown);
            this.onKeyDown = null;
        }
        this.firstFrameSeen = false;
        this.currentCamera = null;
    }
}
