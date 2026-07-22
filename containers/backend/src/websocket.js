const WebSocket = require('ws');
const { URL } = require('url');
const streamer = require('./services/camera-streamer');

// Set up two logical WebSocket endpoints on the same HTTP server:
//
//   /ws                — the app-wide broadcast channel used by MQTT
//                         handlers to push live sensor updates to every
//                         open dashboard. Unauthenticated by design (it
//                         only carries data the user is already looking
//                         at on another screen).
//
//   /ws/cameras/<id>   — one-per-camera binary H.264 stream. Auth is
//                         enforced at the HTTP upgrade using the same
//                         ?token=<session> query pattern the rest of
//                         the app uses for GET-only in-URL auth.
//
// We use two `noServer: true` WebSocket.Server instances routed manually
// off the HTTP server's 'upgrade' event so both paths coexist cleanly.
function setupWebSocket(server, db) {
    const broadcastWss = new WebSocket.Server({ noServer: true });
    const cameraWss    = new WebSocket.Server({ noServer: true });

    const broadcastClients = new Set();

    function heartbeat() { this.isAlive = true; }

    broadcastWss.on('connection', (ws) => {
        console.log('WebSocket client connected');
        broadcastClients.add(ws);
        ws.isAlive = true;
        ws.on('pong', heartbeat);

        ws.on('close', () => {
            console.log('WebSocket client disconnected');
            broadcastClients.delete(ws);
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            broadcastClients.delete(ws);
        });
    });

    const sessions = db.collection('sessions');
    const cameras  = db.collection('cameras');

    cameraWss.on('connection', async (ws, req) => {
        const cameraId = req._cameraId;   // populated in upgrade handler
        console.log(`[camera-ws] client connected for camera ${cameraId}`);

        let cameraDoc;
        try {
            cameraDoc = await cameras.findOne({ _id: cameraId });
        } catch (err) {
            console.error('[camera-ws] camera lookup failed:', err);
            ws.close(1011, 'camera lookup failed');
            return;
        }
        if (!cameraDoc) { ws.close(1008, 'camera not found'); return; }
        if (!cameraDoc.enabled) { ws.close(1008, 'camera disabled'); return; }

        // Subscribe to the camera streamer. The callback receives an
        // access-unit Buffer we forward to the client as a binary frame.
        const sub = streamer.subscribe(cameraDoc, (auBuffer /*, meta */) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            // Backpressure: if the socket buffer fills, drop the AU so
            // we don't grow node's writable stream unboundedly. The next
            // keyframe will re-sync the decoder on a slow client.
            if (ws.bufferedAmount > 4 * 1024 * 1024) return;
            try { ws.send(auBuffer, { binary: true }); }
            catch { /* socket closing race — cleanup below handles it */ }
        });

        const cleanup = () => {
            streamer.unsubscribe(cameraId, sub);
        };
        ws.on('close', () => {
            console.log(`[camera-ws] client disconnected for camera ${cameraId}`);
            cleanup();
        });
        ws.on('error', (err) => {
            console.warn(`[camera-ws] socket error for ${cameraId}:`, err.message);
            cleanup();
        });
    });

    // Route incoming HTTP upgrades to the right WebSocketServer.
    server.on('upgrade', async (req, socket, head) => {
        let url;
        try { url = new URL(req.url, 'http://x'); }
        catch { socket.destroy(); return; }
        const pathname = url.pathname;

        if (pathname === '/ws') {
            broadcastWss.handleUpgrade(req, socket, head, (ws) => {
                broadcastWss.emit('connection', ws, req);
            });
            return;
        }

        // /ws/cameras/<id>?token=<session>
        const camMatch = pathname.match(/^\/ws\/cameras\/([^/]+)$/);
        if (camMatch) {
            const cameraId = decodeURIComponent(camMatch[1]);
            const token = url.searchParams.get('token');
            if (!token) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            let session;
            try {
                session = await sessions.findOne({
                    token,
                    expires_at: { $gt: new Date() },
                });
            } catch (err) {
                console.error('[camera-ws] session lookup failed:', err);
                socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            if (!session) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            req._cameraId = cameraId;
            cameraWss.handleUpgrade(req, socket, head, (ws) => {
                cameraWss.emit('connection', ws, req);
            });
            return;
        }

        socket.destroy();
    });

    // Server-driven heartbeat: ping every 25s. Any socket that hasn't
    // ponged since the previous cycle is treated as dead and terminated
    // immediately, so broadcasts stop being sent into a zombie
    // connection. Applies to the broadcast channel only; per-camera
    // sockets close naturally when the ffmpeg pipe or the client's
    // WebCodecs decoder drops.
    const heartbeatInterval = setInterval(() => {
        broadcastWss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                broadcastClients.delete(ws);
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 25000);

    broadcastWss.on('close', () => clearInterval(heartbeatInterval));

    function broadcast(type, data) {
        const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
        broadcastClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    return { broadcast };
}

module.exports = setupWebSocket;
