// Reusable browser-side H.264 stream consumer.
//
// Opens a WebSocket to /ws/cameras/<id>, receives H.264 Annex-B access
// units (one AU per binary message) and feeds them to WebCodecs'
// VideoDecoder. Decoded VideoFrames are drawn to a caller-supplied
// <canvas>. No JPEG-per-frame, no multipart parsing, no AbortController
// gymnastics — the whole pipeline is native, GPU-accelerated on every
// modern browser, and closes cleanly when we call ws.close().
//
// Consumed by:
//   - Monitoring page tiles (mount per-tile canvas)
//   - CameraViewer full-screen modal (mount modal canvas)
//
// Browser support (as of 2026):
//   - iOS Safari 16.4+
//   - Chrome / Edge 94+
//   - Firefox 130+
//   - Android Chrome (same as desktop Chrome)
// If VideoDecoder is missing we surface a clear error via opts.onError.

import { AuthStore } from '../api.js';

function streamUrlFor(cameraId) {
    const token = AuthStore.getToken();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const parts = [];
    if (token) parts.push(`token=${encodeURIComponent(token)}`);
    parts.push(`t=${Date.now()}`);
    return `${proto}//${window.location.host}/ws/cameras/${encodeURIComponent(cameraId)}?${parts.join('&')}`;
}

// Find the first Annex-B NAL start code in `bytes` and return the
// nal_unit_type of the NAL it opens. Used to decide whether an AU is a
// keyframe or a delta — WebCodecs requires this classification on every
// EncodedVideoChunk and errors out if the first chunk isn't a key.
function firstNalTypeOf(bytes) {
    const n = bytes.length;
    for (let i = 0; i + 3 < n; i++) {
        if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
        if (bytes[i + 2] === 1) return bytes[i + 3] & 0x1f;
        if (i + 4 < n && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
            return bytes[i + 4] & 0x1f;
        }
    }
    return 0;
}

// An AU is a keyframe if any of its NALs is SPS (7), PPS (8), or IDR (5).
// The backend groups SPS+PPS+IDR into a single AU for keyframes and
// leaves non-IDR slice NALs alone, so scanning just the first NAL is
// sufficient in practice — but we walk the whole AU to be safe against
// encoder variations.
function auIsKeyframe(bytes) {
    const n = bytes.length;
    let i = 0;
    while (i + 3 < n) {
        if (bytes[i] !== 0 || bytes[i + 1] !== 0) { i++; continue; }
        let prefixLen;
        if (bytes[i + 2] === 1) prefixLen = 3;
        else if (i + 4 < n && bytes[i + 2] === 0 && bytes[i + 3] === 1) prefixLen = 4;
        else { i++; continue; }
        const t = bytes[i + prefixLen] & 0x1f;
        if (t === 5 || t === 7 || t === 8) return true;
        i += prefixLen;
    }
    return false;
}

const CODEC_UNSUPPORTED_MSG =
    'This browser does not support hardware video decode (WebCodecs). ' +
    'Please update to iOS 16.4+, Chrome 94+, or Firefox 130+.';

/**
 * Mount a live H.264 stream from camera `cameraId` onto `canvas`.
 * Returns a handle with `.close()` — call it during page cleanup.
 *
 * @param {string} cameraId
 * @param {HTMLCanvasElement} canvas
 * @param {object} [opts]
 * @param {() => void} [opts.onFirstFrame]  Called once after first draw.
 * @param {(err: Error) => void} [opts.onError]  Fatal error handler.
 * @returns {{ close(): void, closed: boolean }}
 */
export function mountStreamToCanvas(cameraId, canvas, opts = {}) {
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
        // Deferred via microtask so callers can attach handlers before we fire.
        Promise.resolve().then(() => {
            opts.onError?.(new Error(CODEC_UNSUPPORTED_MSG));
        });
        return { close() {}, closed: true };
    }

    const ctx = canvas.getContext('2d');
    const handle = { closed: false, close: () => close() };

    let ws = null;
    let decoder = null;
    let seenKeyframe = false;      // gate deltas until first key arrives
    let firstFrameDelivered = false;
    let timestampUs = 0;

    // Decode → paint decoupling. The decoder's `output` callback fires
    // asynchronously and can arrive faster than the display refresh (or,
    // on Android Chrome, in ways the compositor doesn't reliably pick
    // up when we paint directly). We buffer the LATEST VideoFrame and
    // repaint once per rAF tick — anything older gets closed immediately
    // so memory stays bounded and observed lag stays under one display
    // frame no matter how bursty the decode queue is. Without this,
    // Android Chrome exhibits a compounding lag where decoded frames
    // accumulate and the canvas visibly only updates when the element
    // is reconstructed (e.g. after a full-screen toggle).
    let latestFrame = null;
    let rafId = 0;

    const paintLoop = () => {
        if (handle.closed) return;
        if (latestFrame) {
            const vf = latestFrame;
            latestFrame = null;
            try {
                const w = vf.displayWidth || vf.codedWidth;
                const h = vf.displayHeight || vf.codedHeight;
                if (canvas.width !== w || canvas.height !== h) {
                    canvas.width = w;
                    canvas.height = h;
                }
                ctx.drawImage(vf, 0, 0);
            } catch (err) {
                console.warn('[h264-stream] drawImage failed:', err.message);
            } finally {
                vf.close();
            }
            if (!firstFrameDelivered) {
                firstFrameDelivered = true;
                opts.onFirstFrame?.();
            }
        }
        rafId = requestAnimationFrame(paintLoop);
    };

    const close = () => {
        if (handle.closed) return;
        handle.closed = true;
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        if (latestFrame) { try { latestFrame.close(); } catch { /* ignore */ } latestFrame = null; }
        try { if (ws && ws.readyState <= 1) ws.close(); } catch { /* ignore */ }
        ws = null;
        try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch { /* ignore */ }
        decoder = null;
    };

    const raiseFatal = (err) => {
        if (handle.closed) return;
        close();
        opts.onError?.(err);
    };

    // VideoDecoder setup. Omitting `description` puts the decoder in
    // Annex-B mode: it consumes raw NAL units prefixed with 00 00 00 01
    // (or 00 00 01) start codes, exactly what the backend emits.
    decoder = new VideoDecoder({
        output: (videoFrame) => {
            if (handle.closed) { videoFrame.close(); return; }
            // Keep only the newest frame; older undrawn frames are
            // stale — the paint loop draws whatever's latest on each rAF.
            if (latestFrame) { try { latestFrame.close(); } catch { /* ignore */ } }
            latestFrame = videoFrame;
        },
        // WebCodecs surfaces bitstream / codec errors here. iOS Safari's
        // messages are often terse ("Decoder failure"); include the name
        // + message + any code so the user-visible failure banner and
        // console log both carry the maximum useful diagnostic.
        error: (err) => {
            const detail = [err.name, err.message].filter(Boolean).join(': ');
            raiseFatal(new Error(`Video decoder error — ${detail || 'unknown'}`));
        },
    });

    try {
        // avc1.42E01E = H.264 baseline profile, level 3.1 — matches the
        // ffmpeg args in camera-streamer.js. Baseline is universally
        // supported by every WebCodecs implementation.
        //
        // hardwareAcceleration: 'prefer-hardware' is a hint (per spec —
        // browsers still fall back to software if hardware isn't
        // available), but Android Chrome specifically has a large
        // hardware/software performance gap: MediaCodec-backed decode is
        // smooth even on mid-range phones, while the software fallback
        // lags noticeably. This field has been in the WebCodecs spec
        // from day one so it's safe on every browser that has
        // VideoDecoder at all (unlike `optimizeForLatency`, added
        // later, which some older iOS Safari builds reject).
        decoder.configure({
            codec: 'avc1.42E01E',
            hardwareAcceleration: 'prefer-hardware',
        });
    } catch (err) {
        raiseFatal(new Error(`Video decoder configure failed — ${err.message}`));
        return handle;
    }

    // Kick off the paint loop. rAF automatically pauses when the tab
    // is hidden and resumes on visibility change, so we don't need an
    // explicit visibility guard here.
    rafId = requestAnimationFrame(paintLoop);

    // WebSocket connect.
    try {
        ws = new WebSocket(streamUrlFor(cameraId));
    } catch (err) {
        raiseFatal(err);
        return handle;
    }
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        // No handshake — server pushes the cached SPS/PPS+keyframe AU
        // immediately on subscribe, then live AUs follow.
    };

    // Backpressure threshold. If the decoder falls behind (typically on
    // low-end Android when the browser lands on the software fallback,
    // or on any device when the CPU is temporarily busy), we skip delta
    // frames until it catches up. The next server-side keyframe (~1 s
    // cadence) always re-syncs the picture, so the recovery window is
    // bounded. Without this cap, deltas queue up in the decoder and
    // observed latency grows without bound.
    const DECODE_QUEUE_HIGH_WATER = 8;

    ws.onmessage = (event) => {
        if (handle.closed || !decoder || decoder.state !== 'configured') return;
        // Only binary frames are meaningful. Ignore any text (would be a
        // protocol error, but robust to future control-message additions).
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes.length === 0) return;

        const isKey = auIsKeyframe(bytes);
        if (!seenKeyframe && !isKey) {
            // WebCodecs errors if the first chunk isn't a key. Discard
            // deltas until we've seen at least one keyframe (which the
            // server pushes as the first AU on subscribe, so this only
            // matters if we reconnect mid-stream and land on a delta
            // before the next server-side keyframe cycle).
            return;
        }
        // Backpressure: if the decoder queue is deep, drop this delta.
        // Keyframes always pass — they re-anchor the picture and reset
        // the drift so the user sees the current moment rather than a
        // growing latency backlog.
        if (!isKey && decoder.decodeQueueSize > DECODE_QUEUE_HIGH_WATER) return;
        seenKeyframe = true;

        try {
            const chunk = new EncodedVideoChunk({
                type: isKey ? 'key' : 'delta',
                timestamp: timestampUs,
                data: bytes,
            });
            timestampUs += Math.floor(1_000_000 / 24);  // matches server fps
            decoder.decode(chunk);
        } catch (err) {
            raiseFatal(err);
        }
    };

    ws.onerror = () => {
        // Full error surfaces via onclose; suppress noisy console output.
    };

    ws.onclose = (ev) => {
        if (handle.closed) return;
        // Distinguish auth/policy failures (4xxx codes we set) from
        // benign network drops (1000, 1001, 1006). Only surface the
        // former via onError — network drops are handled by whoever
        // owns the page (they'll re-mount on visibility/reconnect).
        if (ev.code === 1008 || ev.code === 1011 || ev.code === 4401) {
            raiseFatal(new Error(ev.reason || `stream closed (${ev.code})`));
        } else {
            close();
        }
    };

    return handle;
}
