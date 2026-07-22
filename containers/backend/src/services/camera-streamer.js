'use strict';

// Camera live-stream service.
//
// One ffmpeg process per camera, spawned ON DEMAND when the first
// WebSocket subscriber connects and shut down after a grace period once
// the last one disconnects. Under idle the entire pipeline is zero-cost.
//
// ffmpeg captures the UVC camera's native MJPEG, transcodes to H.264
// baseline (ultrafast + zerolatency), and writes an Annex-B elementary
// stream to stdout. We split that stream into NAL units, group NALs into
// access units (one AU = one frame), cache the current parameter sets
// (SPS/PPS) and the most recent keyframe access unit, and fan every AU
// out to subscribers as a single binary WebSocket message.
//
// Public API (unchanged from the MJPEG version so route wiring is
// identical):
//   const sub = streamer.subscribe(cameraDoc, sendAuFn)
//   streamer.unsubscribe(cameraId, sub)
//   streamer.stopStream(cameraId)
//   streamer.getStatus(cameraId)
//   streamer.stopAll()
//
// sendAuFn is invoked as sendAuFn(auBuffer, { isKeyframe, timestampUs }).
// A new subscriber gets the cached parameter-set + keyframe AU pushed
// synchronously from subscribe(), so the client's WebCodecs decoder can
// start producing a first frame within one keyframe interval (≤ 1 s at
// -g 30).

const { spawn } = require('child_process');

// Capture and encode parameters.
//
// The CM5 (BCM2712) has no hardware H.264 encoder — Pi 5 dropped the
// VideoCore encoder that Pi 4 had. libx264 in software is our only
// option, and its CPU cost scales roughly with pixel-count × fps. At
// 1280x720@30 with two cameras we burn ~1.5 CPU cores; dropping to
// 960x540@24 halves the pixel budget and lands us near 0.7 cores total
// while still looking clean when downscaled into a 380 px monitor tile
// or upscaled for full-screen viewing. The C920 supports 960x540
// natively so no scaling happens at capture.
//
// If a future CM7 or similar gains a hardware encoder, switch this
// service to h264_v4l2m2m and these values can jump back to 1280x720@30.
const CAPTURE_WIDTH = 960;
const CAPTURE_HEIGHT = 540;
const CAPTURE_FPS = 24;
const KEYFRAME_INTERVAL = 24;    // 1 s at 24 fps — new joiners see picture fast
const TARGET_BITRATE = '1500k';

// Grace period before an idle stream shuts down ffmpeg. Keeps a stream
// alive across quick nav-away-nav-back so we don't restart-spam ffmpeg,
// but shuts things down quickly when the user is genuinely gone.
const IDLE_SHUTDOWN_MS = 10_000;

// Backoff schedule for ffmpeg auto-restart after unexpected exit. Only
// kicks in when there are still subscribers; if the last subscriber
// left, we let it die.
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

// Sanity guard: if the ingest buffer grows past this without producing
// a NAL, we've lost sync. Reset and re-anchor on the next start code.
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

// H.264 NAL unit types (nal_unit_type from RBSP byte, low 5 bits).
const NAL_TYPE_SLICE_NON_IDR = 1;
const NAL_TYPE_SLICE_IDR     = 5;
const NAL_TYPE_SEI           = 6;
const NAL_TYPE_SPS           = 7;
const NAL_TYPE_PPS           = 8;
const NAL_TYPE_AUD           = 9;

function isSliceNal(t) { return t === NAL_TYPE_SLICE_NON_IDR || t === NAL_TYPE_SLICE_IDR; }
function isParamNal(t) { return t === NAL_TYPE_SPS || t === NAL_TYPE_PPS || t === NAL_TYPE_SEI; }

// Search buf[from..] for the next Annex-B start code. Returns
// { pos, prefixLen } where pos is the index of the first 0x00 and
// prefixLen is 3 (for 00 00 01) or 4 (for 00 00 00 01), or null.
function findStartCode(buf, from) {
    const n = buf.length;
    for (let i = from; i + 3 <= n; i++) {
        if (buf[i] !== 0) continue;
        if (buf[i + 1] !== 0) continue;
        if (buf[i + 2] === 1) return { pos: i, prefixLen: 3 };
        if (i + 4 <= n && buf[i + 2] === 0 && buf[i + 3] === 1) return { pos: i, prefixLen: 4 };
    }
    return null;
}

// Given a NAL that starts with an Annex-B start code prefix, return the
// nal_unit_type from the byte immediately after the prefix.
function nalTypeOf(nal) {
    // Skip the start code prefix — either 3 or 4 bytes.
    const off = (nal[2] === 1) ? 3 : 4;
    if (off >= nal.length) return 0;
    return nal[off] & 0x1f;
}

// For a slice NAL (types 1, 5), return true iff `first_mb_in_slice == 0`
// — i.e., this slice is the first slice of a new picture, and therefore
// marks a new access-unit boundary.
//
// slice_header starts with `first_mb_in_slice` encoded as ue(v)
// (unsigned Exp-Golomb). Value 0 is encoded as the single bit `1`,
// so we just need to check the top bit of the byte immediately after
// the NAL header. This lets a multi-slice encoder (e.g. one that leaves
// x264's default sliced-threads on) still be parsed correctly without
// implementing a full Exp-Golomb decoder.
function sliceStartsNewPicture(nal) {
    const scLen = (nal[2] === 1) ? 3 : 4;
    const bodyByte = scLen + 1;   // first slice_header byte, after NAL header
    if (bodyByte >= nal.length) return false;
    return (nal[bodyByte] & 0x80) !== 0;
}

class StreamState {
    constructor(cameraDoc) {
        this.camera = cameraDoc;
        this.proc = null;
        this.stopping = false;
        this.restartAttempt = 0;

        this.buf = Buffer.alloc(0);
        this.currentAu = [];           // NAL Buffers being accumulated for the in-flight AU
        this.currentAuHasSlice = false;
        this.currentAuHasIdr = false;

        // Catch-up cache — pushed synchronously to every new subscriber.
        this.cachedSps = null;
        this.cachedPps = null;
        this.cachedKeyframeAu = null;  // Complete AU Buffer with SPS+PPS+IDR

        this.startedAt = 0;
        this.auCount = 0;
        this.keyframeCount = 0;
        this.lastAuAt = 0;
        this.lastKeyframeAt = 0;
        this.lastError = null;

        this.subscribers = new Set();  // Set<(auBuffer, meta) => void>
        this.idleTimer = null;
    }

    subscribe(callback) {
        this.subscribers.add(callback);
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (!this.proc && !this.stopping) {
            this.spawnFfmpeg();
        }
        // Push cached catch-up bytes immediately so the client's
        // VideoDecoder has parameter sets + a keyframe to anchor on.
        // Without this, the first live delta frame the client sees would
        // error out because no key has been seen yet.
        if (this.cachedKeyframeAu) {
            try {
                callback(this.cachedKeyframeAu, {
                    isKeyframe: true,
                    timestampUs: this.microsNow(),
                });
            } catch { /* subscriber's error path handles it */ }
        }
        return callback;
    }

    unsubscribe(callback) {
        this.subscribers.delete(callback);
        if (this.subscribers.size === 0 && this.proc && !this.idleTimer) {
            this.idleTimer = setTimeout(() => {
                this.idleTimer = null;
                if (this.subscribers.size === 0) {
                    this.killFfmpeg('idle');
                }
            }, IDLE_SHUTDOWN_MS);
        }
    }

    subscriberCount() {
        return this.subscribers.size;
    }

    spawnFfmpeg() {
        const dev = this.camera.devPath;
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            // Input: UVC MJPEG at target resolution/fps. The camera transports
            // MJPEG natively so decode overhead is minimal.
            '-f', 'v4l2',
            '-input_format', 'mjpeg',
            '-video_size', `${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}`,
            '-framerate', String(CAPTURE_FPS),
            '-i', dev,
            // Encode: software x264 in the fastest possible latency mode.
            // - ultrafast + zerolatency: no lookahead, no B-frames, no CABAC
            //   reordering that would delay first-frame output.
            // - baseline profile L3.1: universally supported by browser
            //   WebCodecs decoders (avc1.42E01E).
            // - keyint = 30: one keyframe per second so new subscribers
            //   see a picture within a second of connecting.
            // - repeat-headers: SPS/PPS prepended to every keyframe so
            //   the wire stream is self-descriptive even if the client
            //   started listening mid-GOP.
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-profile:v', 'baseline',
            '-level:v', '3.1',
            '-pix_fmt', 'yuv420p',
            '-g', String(KEYFRAME_INTERVAL),
            '-bf', '0',
            // sliced-threads=0: `-tune zerolatency` implicitly enables
            // sliced-threads, which produces one slice per CPU thread
            // per picture. Downstream WebCodecs decoders expect one
            // access unit per picture; if we let x264 emit 4 slices,
            // even a robust AU splitter has to correctly identify
            // slice-boundaries-within-a-picture vs new-picture-slices.
            // Forcing single-slice per picture keeps the wire format
            // trivially unambiguous. Ultrafast + baseline at 720p30
            // easily fits in one CM5 core, so we lose nothing.
            '-x264-params', `keyint=${KEYFRAME_INTERVAL}:min-keyint=${KEYFRAME_INTERVAL}:scenecut=0:repeat-headers=1:sliced-threads=0`,
            '-b:v', TARGET_BITRATE,
            // Video-only pipeline. V4L2 doesn't expose the camera's
            // microphone (that's an ALSA device we never open), but -an
            // makes the intent explicit and guards against any future
            // ffmpeg autodetection surprises.
            '-an',
            '-f', 'h264',
            '-',
        ];
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        this.startedAt = Date.now();
        this.auCount = 0;
        this.keyframeCount = 0;
        this.buf = Buffer.alloc(0);
        this.currentAu = [];
        this.currentAuHasSlice = false;
        this.currentAuHasIdr = false;

        proc.stdout.on('data', (chunk) => this.ingest(chunk));

        proc.stderr.on('data', (chunk) => {
            const msg = chunk.toString('utf8').trim();
            if (msg) {
                this.lastError = msg;
                console.warn(`[camera-streamer ${this.camera._id}] ffmpeg: ${msg}`);
            }
        });

        proc.on('exit', (code, signal) => {
            const uptime = Date.now() - this.startedAt;
            console.log(`[camera-streamer ${this.camera._id}] ffmpeg exited code=${code} signal=${signal} uptime=${uptime}ms aus=${this.auCount} subscribers=${this.subscribers.size}`);
            this.proc = null;
            if (this.subscribers.size === 0) return;
            if (this.stopping) return;
            const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)];
            this.restartAttempt = Math.min(this.restartAttempt + 1, RESTART_BACKOFF_MS.length - 1);
            setTimeout(() => {
                if (this.subscribers.size > 0 && !this.proc && !this.stopping) {
                    this.spawnFfmpeg();
                }
            }, delay);
        });

        proc.on('error', (err) => {
            this.lastError = err.message;
            console.error(`[camera-streamer ${this.camera._id}] ffmpeg spawn error:`, err);
        });

        console.log(`[camera-streamer ${this.camera._id}] started ffmpeg on ${dev} @ ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}@${CAPTURE_FPS} → H.264 (${this.subscribers.size} subscriber(s))`);
    }

    // Split the incoming byte stream into NAL units by scanning for
    // Annex-B start codes, then feed each NAL to the AU accumulator.
    ingest(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);

        // Anchor on the first start code we see. Anything before it is
        // pre-roll from ffmpeg and gets dropped.
        let firstSc = findStartCode(this.buf, 0);
        if (!firstSc) {
            if (this.buf.length > MAX_BUFFER_BYTES) {
                console.warn(`[camera-streamer ${this.camera._id}] no NAL start code in ${this.buf.length}B — resetting`);
                this.buf = Buffer.alloc(0);
            }
            return;
        }
        if (firstSc.pos > 0) {
            this.buf = this.buf.subarray(firstSc.pos);
        }

        // Emit every complete NAL. A NAL runs from one start code
        // (inclusive) up to just before the next start code. Only the
        // last, incomplete NAL stays in the buffer for the next chunk.
        while (true) {
            const scHere = findStartCode(this.buf, 0);
            if (!scHere) break;
            const scNext = findStartCode(this.buf, scHere.prefixLen);
            if (!scNext) break;
            const nal = Buffer.from(this.buf.subarray(0, scNext.pos));
            this.processNal(nal);
            this.buf = this.buf.subarray(scNext.pos);
        }

        if (this.buf.length > MAX_BUFFER_BYTES) {
            console.warn(`[camera-streamer ${this.camera._id}] NAL buffer overflow (${this.buf.length}B) — resetting`);
            this.buf = Buffer.alloc(0);
            this.currentAu = [];
            this.currentAuHasSlice = false;
            this.currentAuHasIdr = false;
        }
    }

    // Group NALs into access units. An AU boundary occurs when we see
    // an AUD (nal_unit_type 9), a parameter set that follows a slice,
    // or a new slice after we've already added one.
    processNal(nal) {
        const t = nalTypeOf(nal);

        // Cache latest parameter sets — pushed to new subscribers.
        if (t === NAL_TYPE_SPS) this.cachedSps = nal;
        else if (t === NAL_TYPE_PPS) this.cachedPps = nal;

        if (t === NAL_TYPE_AUD) {
            // AUD marks a new AU start explicitly.
            this.flushCurrentAu();
            this.currentAu.push(nal);
            return;
        }
        if (isParamNal(t) && this.currentAuHasSlice) {
            // Parameter set after slice ⇒ new AU begins.
            this.flushCurrentAu();
        }
        if (isSliceNal(t) && this.currentAuHasSlice && sliceStartsNewPicture(nal)) {
            // A slice whose first_mb_in_slice == 0 is the first slice of
            // a new picture — flush the previous picture's slices as one
            // AU. Slices that continue the current picture (multi-slice
            // encoding) stay in currentAu.
            this.flushCurrentAu();
        }

        this.currentAu.push(nal);
        if (isSliceNal(t)) {
            this.currentAuHasSlice = true;
            if (t === NAL_TYPE_SLICE_IDR) this.currentAuHasIdr = true;
        }
    }

    flushCurrentAu() {
        if (this.currentAu.length === 0) return;
        const au = Buffer.concat(this.currentAu);
        const isKeyframe = this.currentAuHasIdr;

        this.currentAu = [];
        this.currentAuHasSlice = false;
        this.currentAuHasIdr = false;

        this.publishAu(au, isKeyframe);
    }

    publishAu(au, isKeyframe) {
        const nowUs = this.microsNow();
        this.auCount++;
        this.lastAuAt = Date.now();
        this.restartAttempt = 0;

        if (isKeyframe) {
            // Prepend SPS/PPS if they aren't already in the AU. x264 with
            // repeat-headers=1 puts them in every IDR AU, but the guard
            // makes the code robust to encoder-config drift.
            let toCache = au;
            const hasSps = this.auContainsNalType(au, NAL_TYPE_SPS);
            const hasPps = this.auContainsNalType(au, NAL_TYPE_PPS);
            if ((!hasSps || !hasPps) && this.cachedSps && this.cachedPps) {
                const parts = [];
                if (!hasSps) parts.push(this.cachedSps);
                if (!hasPps) parts.push(this.cachedPps);
                parts.push(au);
                toCache = Buffer.concat(parts);
            }
            this.cachedKeyframeAu = toCache;
            this.keyframeCount++;
            this.lastKeyframeAt = Date.now();
            au = toCache;
        }

        for (const cb of this.subscribers) {
            try { cb(au, { isKeyframe, timestampUs: nowUs }); }
            catch (err) {
                console.warn(`[camera-streamer ${this.camera._id}] subscriber threw:`, err.message);
            }
        }
    }

    auContainsNalType(au, targetType) {
        let i = 0;
        while (i < au.length - 3) {
            const sc = findStartCode(au, i);
            if (!sc) return false;
            const off = sc.pos + sc.prefixLen;
            if (off < au.length && (au[off] & 0x1f) === targetType) return true;
            i = off;
        }
        return false;
    }

    microsNow() {
        // WebCodecs timestamps are microseconds. We just need monotonic.
        const [s, ns] = process.hrtime();
        return s * 1_000_000 + Math.floor(ns / 1000);
    }

    killFfmpeg(reason) {
        if (!this.proc) return;
        console.log(`[camera-streamer ${this.camera._id}] stopping ffmpeg (${reason})`);
        const proc = this.proc;
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
    }

    stop() {
        this.stopping = true;
        this.subscribers.clear();
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.killFfmpeg('shutdown');
    }

    getStatus() {
        return {
            running: !!this.proc,
            subscribers: this.subscribers.size,
            frameCount: this.auCount,             // kept name for status-endpoint compat
            keyframeCount: this.keyframeCount,
            uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
            lastFrameAgoMs: this.lastAuAt ? Date.now() - this.lastAuAt : null,
            lastKeyframeAgoMs: this.lastKeyframeAt ? Date.now() - this.lastKeyframeAt : null,
            lastError: this.lastError,
        };
    }
}

const streams = new Map();   // cameraId → StreamState

function subscribe(cameraDoc, callback) {
    const id = cameraDoc._id;
    let state = streams.get(id);
    if (!state) {
        state = new StreamState(cameraDoc);
        streams.set(id, state);
    } else {
        state.camera = cameraDoc;
    }
    return state.subscribe(callback);
}

function unsubscribe(cameraId, subscription) {
    const state = streams.get(cameraId);
    if (!state) return;
    state.unsubscribe(subscription);
}

function stopStream(cameraId) {
    const state = streams.get(cameraId);
    if (!state) return false;
    state.stop();
    streams.delete(cameraId);
    return true;
}

function getStatus(cameraId) {
    const state = streams.get(cameraId);
    return state ? state.getStatus() : { running: false, subscribers: 0 };
}

function stopAll() {
    for (const state of streams.values()) state.stop();
    streams.clear();
}

module.exports = {
    subscribe,
    unsubscribe,
    stopStream,
    getStatus,
    stopAll,
};
