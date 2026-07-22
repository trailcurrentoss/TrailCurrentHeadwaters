'use strict';

// Camera live-stream service.
//
// One ffmpeg process per camera, spawned ON DEMAND when the first HTTP
// subscriber connects and shut down after a grace period once the last
// subscriber disconnects. Under idle the entire pipeline is zero-cost.
//
// UVC cameras (Logitech C920 etc.) emit MJPEG natively, so ffmpeg is
// invoked with `-c:v copy` — JPEG frames pass through untouched with
// effectively no transcode CPU.
//
// The route handler drives the lifecycle via two calls:
//
//   const sub = streamer.subscribe(cameraDoc, writeFrameFn)
//   ...
//   streamer.unsubscribe(cameraId, sub)
//
// The route also owns backpressure — writeFrameFn is called for every
// frame, but the route is free to drop calls when the underlying socket
// is above its high-water mark (see cameras.js).

const { spawn } = require('child_process');

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const CAPTURE_FPS = 30;

// Grace period before an idle stream shuts down ffmpeg. Keeps a stream
// alive across quick nav-away-nav-back so we don't restart-spam ffmpeg,
// but shuts things down quickly when the user is genuinely gone.
const IDLE_SHUTDOWN_MS = 10_000;

// Backoff schedule for ffmpeg auto-restart after unexpected exit. Only
// kicks in when there are still subscribers; if the last subscriber
// left, we let it die.
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

// JPEG Start-Of-Image marker. Frames in the mjpeg muxer output are a
// bare concatenation of JPEGs; splitting on SOI gives one frame each.
const SOI = Buffer.from([0xff, 0xd8]);

// Sanity guard: if the ingest buffer grows past this without producing
// a frame, we've lost sync. Reset and re-anchor on the next SOI.
const MAX_FRAME_BUFFER_BYTES = 4 * 1024 * 1024;

class StreamState {
    constructor(cameraDoc) {
        this.camera = cameraDoc;
        this.proc = null;
        this.stopping = false;
        this.restartAttempt = 0;
        this.frameBuf = Buffer.alloc(0);
        this.lastFrame = null;
        this.lastFrameAt = 0;
        this.startedAt = 0;
        this.frameCount = 0;
        this.lastError = null;
        this.subscribers = new Set();   // Set<Function>
        this.idleTimer = null;
    }

    subscribe(callback) {
        this.subscribers.add(callback);
        // Cancel any pending idle-shutdown — someone's watching again.
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        // Start ffmpeg lazily on first subscriber.
        if (!this.proc && !this.stopping) {
            this.spawnFfmpeg();
        }
        // Push the most recent frame immediately so the client sees an
        // image within milliseconds of connecting, rather than waiting
        // for the next capture tick (up to ~33 ms at 30 fps).
        if (this.lastFrame) {
            try { callback(this.lastFrame); } catch { /* subscriber error, will cleanup on its own */ }
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
            '-f', 'v4l2',
            '-input_format', 'mjpeg',
            '-video_size', `${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}`,
            '-framerate', String(CAPTURE_FPS),
            '-i', dev,
            '-c:v', 'copy',
            '-f', 'mjpeg',
            '-',
        ];
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        this.startedAt = Date.now();
        this.frameCount = 0;
        this.frameBuf = Buffer.alloc(0);

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
            console.log(`[camera-streamer ${this.camera._id}] ffmpeg exited code=${code} signal=${signal} uptime=${uptime}ms frames=${this.frameCount} subscribers=${this.subscribers.size}`);
            this.proc = null;
            // Only auto-restart if there are still subscribers waiting.
            // If we exited because IDLE_SHUTDOWN killed us, subscribers
            // is 0 and we stay dead until a new subscribe() comes in.
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

        console.log(`[camera-streamer ${this.camera._id}] started ffmpeg on ${dev} @ ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}@${CAPTURE_FPS} (${this.subscribers.size} subscriber(s))`);
    }

    // Efficient frame splitter. Uses native Buffer.indexOf (SIMD-fast in
    // recent Node) instead of a JS byte-by-byte scan, and only searches
    // the newly-appended tail on each ingest — never re-scans the old
    // buffer contents.
    ingest(chunk) {
        // Track how many bytes were already in the buffer BEFORE this
        // chunk. New SOIs can only appear at or after (prevLen - 1) —
        // one byte back covers the case where the previous chunk ended
        // on 0xFF and this chunk starts with 0xD8.
        const prevLen = this.frameBuf.length;
        this.frameBuf = prevLen ? Buffer.concat([this.frameBuf, chunk]) : Buffer.from(chunk);

        let searchFrom = prevLen > 0 ? prevLen - 1 : 0;

        // Anchor on first SOI if we haven't yet (frameBuf starts with
        // SOI once anchored). Only runs once per camera lifetime, or
        // after a resync from overflow.
        if (this.frameBuf.length < 2) return;
        if (this.frameBuf[0] !== 0xff || this.frameBuf[1] !== 0xd8) {
            const firstSoi = this.frameBuf.indexOf(SOI);
            if (firstSoi < 0) {
                // No anchor yet; trim to last byte to preserve a possible
                // half-marker at the boundary.
                if (this.frameBuf.length > 1) {
                    this.frameBuf = this.frameBuf.subarray(this.frameBuf.length - 1);
                }
                return;
            }
            this.frameBuf = this.frameBuf.subarray(firstSoi);
            searchFrom = 2;
        }

        // Emit every complete frame in the buffer. A frame runs from one
        // SOI (inclusive) to just before the next SOI. Only the last SOI
        // stays in the buffer for the next chunk to complete.
        while (searchFrom < this.frameBuf.length) {
            const nextSoi = this.frameBuf.indexOf(SOI, searchFrom);
            if (nextSoi < 0) break;
            const frame = this.frameBuf.subarray(0, nextSoi);
            this.publishFrame(frame);
            this.frameBuf = this.frameBuf.subarray(nextSoi);
            searchFrom = 2;
        }

        if (this.frameBuf.length > MAX_FRAME_BUFFER_BYTES) {
            console.warn(`[camera-streamer ${this.camera._id}] frame buffer overflow (${this.frameBuf.length}B) — resetting`);
            this.frameBuf = Buffer.alloc(0);
        }
    }

    publishFrame(frame) {
        // Copy off the slice so the shared frameBuf can be safely resliced.
        const jpeg = Buffer.from(frame);
        this.lastFrame = jpeg;
        this.lastFrameAt = Date.now();
        this.frameCount++;
        this.restartAttempt = 0;   // healthy production = reset backoff
        for (const cb of this.subscribers) {
            try { cb(jpeg); } catch (err) {
                console.warn(`[camera-streamer ${this.camera._id}] subscriber threw:`, err.message);
            }
        }
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
            frameCount: this.frameCount,
            uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
            lastFrameAgoMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
            lastError: this.lastError,
        };
    }
}

// Registry of stream states keyed by camera _id. Entries persist across
// idle-shutdown cycles so a re-subscribe finds the same state (with the
// most recent metadata, backoff counter, etc.) and just spawns a fresh
// ffmpeg. Entries are only removed on explicit stopStream() — when a
// camera is disabled or deleted.
const streams = new Map();

function subscribe(cameraDoc, callback) {
    const id = cameraDoc._id;
    let state = streams.get(id);
    if (!state) {
        state = new StreamState(cameraDoc);
        streams.set(id, state);
    } else {
        // Refresh the doc in case the camera was renamed / re-detected
        // at a new devPath since we last saw it.
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
