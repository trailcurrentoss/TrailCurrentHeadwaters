// Camera live-view modal.
//
// Opens a full-viewport modal showing the MJPEG stream from
// /api/cameras/:id/stream. Tries the native <img src="..."> path first
// (works cleanly in Firefox and Safari, mostly cleanly in Chrome); if
// no frame arrives within a short window, or the <img> errors, we fall
// back to a canvas shim that fetches the multipart stream directly and
// paints each JPEG frame to <canvas>. Same wire format either way, so
// the backend doesn't care which path the browser chose.

import { AuthStore } from '../api.js';

const FIRST_FRAME_TIMEOUT_MS = 2500;
// Absolute ceiling for "modal opened but no frame ever arrived" —
// covers img mode (2.5s) + canvas mode + some slack. If this fires the
// user sees an error with a Retry button instead of "Connecting…"
// forever, which is what happens when either the connection pool is
// saturated or the backend has stopped emitting frames for this camera.
const OVERALL_CONNECT_TIMEOUT_MS = 8000;
const MULTIPART_BOUNDARY_RE = /boundary=([^;]+)/i;

// 1×1 transparent GIF used to reliably abort in-flight multipart/x-
// mixed-replace connections on <img>. `img.src = ''` has undefined
// browser behavior (some load the document URL); swapping to a valid
// tiny complete image forces the multipart XHR to close cleanly. This
// matters most on iOS Safari, which caps HTTP/1.1 at 4 per host —
// leaked stream connections saturate the pool and block ALL other
// requests to the same origin (including API polls) until they age out.
const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Build a stream URL with the session token as a query param. HTML
// <img src> and the canvas-shim fetch both need auth on the URL; the
// backend middleware accepts ?token=/?apiKey= on GET requests as an
// equivalent to the Authorization header.
function streamUrl(cameraId) {
    const token = AuthStore.getToken();
    const parts = [`t=${Date.now()}`];
    if (token) parts.push(`token=${encodeURIComponent(token)}`);
    return `/api/cameras/${encodeURIComponent(cameraId)}/stream?${parts.join('&')}`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export class CameraViewer {
    constructor() {
        this.overlay = null;
        this.canvas = null;
        this.canvasCtx = null;
        this.img = null;
        this.abortController = null;
        this.firstFrameTimer = null;
        this.overallTimer = null;
        this.firstFrameSeen = false;
        this.mode = null;           // 'img' | 'canvas'
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
                    <div class="cam-viewer-status" id="cam-viewer-status">Connecting…</div>
                </div>
            </div>
        `;
        document.body.appendChild(this.overlay);

        // Close-on-backdrop and close-on-Esc.
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay || e.target.closest('.cam-viewer-close')) {
                this.close();
            }
        });
        this.onKeyDown = (e) => { if (e.key === 'Escape') this.close(); };
        window.addEventListener('keydown', this.onKeyDown);

        // Absolute ceiling: if no frame arrives from any code path in
        // OVERALL_CONNECT_TIMEOUT_MS, give up and show an error with a
        // retry button instead of leaving the user on "Connecting…".
        this.overallTimer = setTimeout(() => {
            if (!this.firstFrameSeen) this.showConnectFailure();
        }, OVERALL_CONNECT_TIMEOUT_MS);

        this.startImgMode(camera);
    }

    showConnectFailure() {
        if (!this.overlay) return;
        // Kill anything still running so we don't keep a leaked stream open.
        if (this.img) {
            try { this.img.src = BLANK_GIF; } catch { /* ignore */ }
            this.img.remove();
            this.img = null;
        }
        if (this.canvas) { this.canvas.remove(); this.canvas = null; this.canvasCtx = null; }
        if (this.abortController) {
            try { this.abortController.abort(); } catch { /* ignore */ }
            this.abortController = null;
        }
        clearTimeout(this.firstFrameTimer);
        clearTimeout(this.overallTimer);
        this.firstFrameTimer = null;
        this.overallTimer = null;
        this.mode = null;

        const stage = this.overlay.querySelector('#cam-viewer-stage');
        if (!stage) return;
        stage.innerHTML = `
            <div class="cam-viewer-error">
                <div class="cam-viewer-error-title">Couldn't start the stream</div>
                <div class="cam-viewer-error-sub">The camera may be offline, or another connection may be blocking new streams. Try again in a moment.</div>
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

    markFirstFrame() {
        this.firstFrameSeen = true;
        clearTimeout(this.firstFrameTimer);
        clearTimeout(this.overallTimer);
        this.firstFrameTimer = null;
        this.overallTimer = null;
    }

    startImgMode(camera) {
        this.mode = 'img';
        const stage = this.overlay.querySelector('#cam-viewer-stage');
        const status = this.overlay.querySelector('#cam-viewer-status');
        const img = document.createElement('img');
        img.className = 'cam-viewer-image';
        img.alt = camera.name || 'Camera';
        this.img = img;
        stage.appendChild(img);

        let firstFrame = false;

        // Success: <img> load fires when the FIRST frame renders (for
        // multipart/x-mixed-replace, subsequent frames don't retrigger it).
        img.addEventListener('load', () => {
            firstFrame = true;
            if (status) status.remove();
            clearTimeout(this.firstFrameTimer);
        });

        img.addEventListener('error', () => {
            if (!firstFrame) this.fallbackToCanvas('image error');
        });

        img.src = streamUrl(camera.id);

        this.firstFrameTimer = setTimeout(() => {
            if (!firstFrame) this.fallbackToCanvas('first-frame timeout');
        }, FIRST_FRAME_TIMEOUT_MS);
    }

    async fallbackToCanvas(reason) {
        if (this.mode === 'canvas' || !this.overlay) return;
        console.log(`[camera-viewer] falling back to canvas shim (${reason})`);
        this.mode = 'canvas';
        clearTimeout(this.firstFrameTimer);
        if (this.img) {
            // Same reliable multipart-connection abort we use in close():
            // just removing the element doesn't guarantee the browser
            // closes the socket. Swap src to a valid completed image
            // first so the multipart XHR is aborted immediately, then
            // remove the element.
            try { this.img.src = BLANK_GIF; } catch { /* ignore */ }
            this.img.remove();
            this.img = null;
        }

        const stage = this.overlay.querySelector('#cam-viewer-stage');
        const status = this.overlay.querySelector('#cam-viewer-status');
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'cam-viewer-image';
        this.canvasCtx = this.canvas.getContext('2d');
        stage.appendChild(this.canvas);

        this.abortController = new AbortController();
        try {
            const camera = this.currentCamera;
            const resp = await fetch(
                streamUrl(camera.id),
                { signal: this.abortController.signal }
            );
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const ct = resp.headers.get('content-type') || '';
            const m = ct.match(MULTIPART_BOUNDARY_RE);
            if (!m) throw new Error(`missing multipart boundary in ${ct}`);
            const boundary = m[1].replace(/^"|"$/g, '');
            await this.pumpMultipart(resp.body.getReader(), boundary, status);
        } catch (err) {
            if (err.name === 'AbortError') return;
            console.error('[camera-viewer] canvas shim error:', err);
            if (status) status.textContent = `Stream error: ${err.message}`;
        }
    }

    async pumpMultipart(reader, boundary, statusEl) {
        const delim = new TextEncoder().encode(`--${boundary}`);
        let buf = new Uint8Array(0);
        let statusRemoved = false;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf = concat(buf, value);

            // Extract as many complete parts as we can.
            // Structure of each part:
            //   --boundary\r\n
            //   Content-Type: image/jpeg\r\n
            //   Content-Length: N\r\n
            //   \r\n
            //   <N bytes of JPEG>
            //   \r\n
            // We split on the delimiter and take each middle part as one frame.
            while (true) {
                const start = indexOf(buf, delim);
                if (start < 0) break;
                const next = indexOf(buf, delim, start + delim.length);
                if (next < 0) break;   // wait for more bytes
                const part = buf.subarray(start + delim.length, next);
                const jpeg = extractJpegFromPart(part);
                if (jpeg && jpeg.length > 0) {
                    await this.paintFrame(jpeg);
                    if (!statusRemoved && statusEl) {
                        statusEl.remove();
                        statusRemoved = true;
                    }
                }
                buf = buf.subarray(next);
            }
        }
    }

    async paintFrame(jpegBytes) {
        try {
            const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
            const bmp = await createImageBitmap(blob);
            if (!this.canvas || !this.canvasCtx) { bmp.close(); return; }
            if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
                this.canvas.width = bmp.width;
                this.canvas.height = bmp.height;
            }
            this.canvasCtx.drawImage(bmp, 0, 0);
            bmp.close();
        } catch (err) {
            // A single malformed JPEG shouldn't kill the whole stream.
            console.warn('[camera-viewer] frame decode failed:', err.message);
        }
    }

    close() {
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = null;
        if (this.abortController) {
            try { this.abortController.abort(); } catch { /* ignore */ }
            this.abortController = null;
        }
        if (this.img) {
            // Reliable multipart-connection abort (see BLANK_GIF note).
            try { this.img.src = BLANK_GIF; } catch { /* ignore */ }
            this.img.remove();
            this.img = null;
        }
        if (this.canvas) {
            this.canvas.remove();
            this.canvas = null;
            this.canvasCtx = null;
        }
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        if (this.onKeyDown) {
            window.removeEventListener('keydown', this.onKeyDown);
            this.onKeyDown = null;
        }
        this.mode = null;
        this.currentCamera = null;
    }
}

// --- byte-buffer helpers ---

function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

function indexOf(haystack, needle, from = 0) {
    outer: for (let i = from; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

// Given the bytes of a single multipart part (after --boundary and
// before the next --boundary), locate the CRLFCRLF header/body split
// and return the JPEG body with any trailing CRLF stripped.
function extractJpegFromPart(part) {
    // Skip leading CRLF that follows the boundary line
    let i = 0;
    while (i < part.length && (part[i] === 0x0d || part[i] === 0x0a)) i++;
    // Find CRLFCRLF ending the headers
    const sep = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
    const headerEnd = indexOf(part, sep, i);
    if (headerEnd < 0) return null;
    const bodyStart = headerEnd + sep.length;
    let bodyEnd = part.length;
    // Trim the trailing CRLF that precedes the next boundary.
    if (bodyEnd >= 2 && part[bodyEnd - 2] === 0x0d && part[bodyEnd - 1] === 0x0a) {
        bodyEnd -= 2;
    }
    if (bodyEnd <= bodyStart) return null;
    return part.subarray(bodyStart, bodyEnd);
}
