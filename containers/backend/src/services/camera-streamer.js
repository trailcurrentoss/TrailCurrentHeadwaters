'use strict';

// Camera live-stream service.
//
// Runs one ffmpeg process per enabled camera, pulling MJPEG frames from
// /dev/videoN and fanning them out to any number of HTTP subscribers.
// UVC cameras (e.g. Logitech C920) output MJPEG natively, so ffmpeg is
// invoked with `-c:v copy` — JPEG frames pass through untouched at
// essentially zero CPU cost.
//
// Wire format on the client side is HTTP multipart/x-mixed-replace, but
// this service does NOT emit multipart HTTP — it emits raw JPEG frames
// via subscriber callbacks. The route handler wraps each frame in
// per-connection multipart boundaries. This keeps ffmpeg output clean
// and makes fanout trivial.

const { spawn } = require('child_process');
const EventEmitter = require('events');

// V4L2 capture params. 1280x720 @ 30 fps in native MJPEG is the target
// profile chosen because it (a) hits the ESP32-P4's hardware JPEG
// decoder sweet spot (720p @ 88 fps ceiling), (b) matches every modern
// UVC webcam's supported modes, and (c) stays under ~5 Mbps on LAN.
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const CAPTURE_FPS = 30;

// Restart backoff for ffmpeg crashes. A physically-unplugged camera
// makes ffmpeg exit immediately in a tight loop — exponential backoff
// keeps the log manageable while still recovering quickly on a real
// hiccup.
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

// JPEG frames start with 0xFF 0xD8 (Start Of Image) and end with
// 0xFF 0xD9 (End Of Image). The mjpeg muxer from ffmpeg emits a clean
// concatenation of frames, no wrapping. We split on SOI: when we spot
// a new SOI, the frame that just ended is complete and gets published.
const SOI_B0 = 0xff;
const SOI_B1 = 0xd8;

class StreamState extends EventEmitter {
    constructor(cameraDoc) {
        super();
        this.setMaxListeners(0);   // arbitrary number of frame subscribers
        this.camera = cameraDoc;
        this.proc = null;
        this.stopping = false;
        this.restartAttempt = 0;
        this.frameBuf = Buffer.alloc(0);
        this.lastFrame = null;         // most recent JPEG bytes, for new subscribers
        this.lastFrameAt = 0;
        this.startedAt = 0;
        this.frameCount = 0;
        this.lastError = null;
    }

    start() {
        if (this.proc) return;
        this.stopping = false;
        this.spawnFfmpeg();
    }

    spawnFfmpeg() {
        const dev = this.camera.devPath;
        // -f v4l2:            capture from Video4Linux2
        // -input_format mjpeg: negotiate MJPEG native output (zero transcode)
        // -c:v copy:          pass frames through, don't re-encode
        // -f mjpeg -:         emit a bare MJPEG stream to stdout
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
            console.log(`[camera-streamer ${this.camera._id}] ffmpeg exited code=${code} signal=${signal} uptime=${uptime}ms frames=${this.frameCount}`);
            this.proc = null;
            if (this.stopping) return;
            // Auto-restart with backoff.
            const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)];
            this.restartAttempt = Math.min(this.restartAttempt + 1, RESTART_BACKOFF_MS.length - 1);
            setTimeout(() => { if (!this.stopping) this.spawnFfmpeg(); }, delay);
        });

        proc.on('error', (err) => {
            this.lastError = err.message;
            console.error(`[camera-streamer ${this.camera._id}] ffmpeg spawn error:`, err);
        });

        console.log(`[camera-streamer ${this.camera._id}] started ffmpeg on ${dev} @ ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}@${CAPTURE_FPS}`);
    }

    ingest(chunk) {
        // Append to rolling buffer, then extract complete frames.
        // A complete frame runs from one SOI to just before the next SOI.
        this.frameBuf = this.frameBuf.length ? Buffer.concat([this.frameBuf, chunk]) : chunk;

        // Scan for SOI markers. Start from index 1 so we can look back
        // one byte to confirm 0xFF 0xD8.
        let searchFrom = 1;
        let lastSoi = -1;
        // Find the first SOI to anchor
        for (let i = 0; i < this.frameBuf.length - 1; i++) {
            if (this.frameBuf[i] === SOI_B0 && this.frameBuf[i + 1] === SOI_B1) {
                lastSoi = i;
                searchFrom = i + 2;
                break;
            }
        }
        if (lastSoi < 0) return;   // no SOI yet — keep buffering

        // Find subsequent SOIs; the bytes between them are complete frames.
        while (searchFrom < this.frameBuf.length - 1) {
            let nextSoi = -1;
            for (let i = searchFrom; i < this.frameBuf.length - 1; i++) {
                if (this.frameBuf[i] === SOI_B0 && this.frameBuf[i + 1] === SOI_B1) {
                    nextSoi = i;
                    break;
                }
            }
            if (nextSoi < 0) break;
            const frame = this.frameBuf.subarray(lastSoi, nextSoi);
            this.publishFrame(frame);
            lastSoi = nextSoi;
            searchFrom = nextSoi + 2;
        }

        // Retain from the last SOI forward (that's an in-progress frame).
        this.frameBuf = this.frameBuf.subarray(lastSoi);

        // Guardrail: if buffer grows unreasonably large, something is
        // wrong with framing — drop and resync on the next SOI.
        if (this.frameBuf.length > 4 * 1024 * 1024) {
            console.warn(`[camera-streamer ${this.camera._id}] frame buffer overflow (${this.frameBuf.length}B) — resetting`);
            this.frameBuf = Buffer.alloc(0);
        }
    }

    publishFrame(frame) {
        this.lastFrame = frame;
        this.lastFrameAt = Date.now();
        this.frameCount++;
        this.restartAttempt = 0;   // first frame after boot = healthy
        this.emit('frame', frame);
    }

    stop() {
        this.stopping = true;
        if (this.proc) {
            try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
            // Force-kill if ffmpeg doesn't exit in 2s
            const proc = this.proc;
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
        }
        this.removeAllListeners('frame');
    }

    getStatus() {
        return {
            running: !!this.proc,
            frameCount: this.frameCount,
            subscribers: this.listenerCount('frame'),
            uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
            lastFrameAgoMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
            lastError: this.lastError,
        };
    }
}

// Registry of active streams keyed by camera _id.
const streams = new Map();

function startStream(cameraDoc) {
    const id = cameraDoc._id;
    if (streams.has(id)) return streams.get(id);
    const state = new StreamState(cameraDoc);
    streams.set(id, state);
    state.start();
    return state;
}

function stopStream(cameraId) {
    const state = streams.get(cameraId);
    if (!state) return false;
    state.stop();
    streams.delete(cameraId);
    return true;
}

function getStream(cameraId) {
    return streams.get(cameraId) || null;
}

function getStatus(cameraId) {
    const state = streams.get(cameraId);
    return state ? state.getStatus() : { running: false };
}

function stopAll() {
    for (const state of streams.values()) state.stop();
    streams.clear();
}

module.exports = {
    startStream,
    stopStream,
    getStream,
    getStatus,
    stopAll,
};
