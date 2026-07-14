require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { connect: connectDb, getDb, close: closeDb } = require('./db/init');
const setupWebSocket = require('./websocket');
const mqttService = require('./mqtt');

// Import routes
const authRoutes = require('./routes/auth');
const { authMiddleware } = require('./routes/auth');
const thermostatRoutes = require('./routes/thermostat');
const lightsRoutes = require('./routes/lights');
const trailerRoutes = require('./routes/trailer');
const energyRoutes = require('./routes/energy');
const settingsRoutes = require('./routes/settings');
const waterRoutes = require('./routes/water');
const airqualityRoutes = require('./routes/airquality');
const systemConfigRoutes = require('./routes/system-config');
const modulesRoutes = require('./routes/modules');
const otaRoutes = require('./routes/ota');
const plateauRoutes = require('./routes/plateau');
const smsRoutes = require('./routes/sms');
const discoveryRoutes = require('./routes/discovery');
const osRoutes = require('./routes/os');
const systemStatsRoutes = require('./routes/system-stats');
const deploymentsRoutes = require('./routes/deployments');
const mapsRoutes = require('./routes/maps');
const routeRoutes = require('./routes/route');
const playbillRoutes = require('./routes/playbill');
const peregrineRoutes = require('./routes/peregrine');
const alarmsRoutes = require('./routes/alarms');
const geocodeRoutes = require('./routes/geocode');

const app = express();
const server = http.createServer(app);

// Node 18+ defaults server.requestTimeout to 300000 ms (5 minutes) as a
// slowloris defense — it kills any HTTP request whose body hasn't finished
// within that window, regardless of whether data is actively flowing. Map
// bundle uploads run 90–130 GB and take tens of minutes on the LAN, so the
// cap has to move. nginx caps runaway upstream reads at 24 h; match that
// here so both sides agree.
server.requestTimeout = 86400 * 1000;
// headersTimeout must be >= requestTimeout when both are set; keep them
// in sync so header-parse and body-receive share the same budget.
server.headersTimeout = 86400 * 1000;

const PORT = process.env.API_PORT;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function startServer() {
    try {
        // Connect to MongoDB
        await connectDb();
        const db = getDb();

        // Auth routes (public)
        app.use('/api/auth', authRoutes(db));

        // Auth middleware - protect all routes below
        app.use(authMiddleware(db));

        // API Routes (protected)
        app.use('/api/thermostat', thermostatRoutes(db));
        app.use('/api/lights', lightsRoutes(db));
        app.use('/api/trailer', trailerRoutes());
        app.use('/api/energy', energyRoutes());
        app.use('/api/settings', settingsRoutes(db));
        app.use('/api/water', waterRoutes());
        app.use('/api/airquality', airqualityRoutes());
        app.use('/api/system-config', systemConfigRoutes(db));
        app.use('/api/modules', modulesRoutes(db));
        app.use('/api/ota', otaRoutes(db));
        app.use('/api/plateau', plateauRoutes(db));
        app.use('/api/sms', smsRoutes(db));
        app.use('/api/discovery', discoveryRoutes(db));
        app.use('/api/os', osRoutes());
        app.use('/api/system-stats', systemStatsRoutes());
        app.use('/api/deployments', deploymentsRoutes(db));
        app.use('/api/maps', mapsRoutes(db));
        app.use('/api/route', routeRoutes());
        app.use('/api/playbill', playbillRoutes());
        app.use('/api/peregrine', peregrineRoutes(db));
        app.use('/api/alarms', alarmsRoutes(db));
        app.use('/api/geocode', geocodeRoutes());

        // Error handling middleware
        app.use((err, req, res, next) => {
            console.error('Error:', err);
            res.status(500).json({ error: 'Internal server error' });
        });

        // 404 handler
        app.use((req, res) => {
            const accept = req.headers.accept || '';
            const isBrowserNavigation = accept.includes('text/html') && !req.xhr && req.headers['x-requested-with'] !== 'XMLHttpRequest';

            if (isBrowserNavigation) {
                return res.redirect('/');
            }
            res.status(404).json({ error: 'Not found' });
        });

        // Setup WebSocket
        const { broadcast } = setupWebSocket(server);

        // Make broadcast available to routes if needed
        app.set('broadcast', broadcast);

        // Reinstall any saved Peregrine CA into the system trust store.
        // Best-effort: a failure here is logged but doesn't block startup.
        const peregrineCa = require('./services/peregrine-ca');
        peregrineCa.reinstallFromDb(db).catch(err =>
            console.error('[Startup] Peregrine CA reinstall failed:', err.message));

        // Initialize MQTT service
        mqttService.connect(db, broadcast);

        // Initialize CAN bridge (subscribes to can/inbound, routes to local/* topics)
        const canBridge = require('./services/can-bridge');
        canBridge.init(mqttService, db);

        // Initialize Alarms service — subscribes to spoor/picket input topics
        // and pushes live active-sensor set over WebSocket.
        const alarmsService = require('./services/alarms-service');
        alarmsService.init(mqttService, db);

        // Connect cloud bridge if cloud is enabled
        const cloudBridge = require('./services/cloud-bridge');
        const sysConfig = await db.collection('system_config').findOne({ _id: 'main' });
        if (sysConfig && sysConfig.cloud_enabled) {
            const { decrypt } = require('./utils/crypto');
            let mqttPass = '';
            if (sysConfig.cloud_mqtt_password_encrypted && sysConfig.cloud_mqtt_password_iv) {
                try { mqttPass = decrypt(sysConfig.cloud_mqtt_password_encrypted, sysConfig.cloud_mqtt_password_iv); } catch {}
            }
            try {
                const url = new URL(sysConfig.cloud_url);
                cloudBridge.connect(mqttService, url.hostname, sysConfig.cloud_mqtt_username, mqttPass);
                if (sysConfig.cloud_rate_limit) {
                    cloudBridge.updateRateLimit(sysConfig.cloud_rate_limit);
                }
            } catch (err) {
                console.error('[Startup] Cloud bridge connection failed:', err.message);
            }
        }

        // Sync PDM channel configs to lights collection (fire-and-forget)
        const { syncPdmChannelsToLights } = require('./services/pdm-channel-sync');
        syncPdmChannelsToLights(db, mqttService).catch(err =>
            console.error('[Startup] PDM channel sync failed:', err.message));

        // Sync Switchback relay configs to lights collection, then cache names for MQTT hot path,
        // then publish config snapshot to cloud if enabled
        const { syncSwitchbackChannelsToLights } = require('./services/switchback-channel-sync');
        syncSwitchbackChannelsToLights(db, mqttService)
            .then(() => mqttService.refreshLightNameCache())
            .then(async () => {
                if (sysConfig && sysConfig.cloud_enabled) {
                    const { buildConfigSnapshot } = require('./services/config-snapshot');
                    const snapshot = await buildConfigSnapshot(db);
                    if (snapshot) {
                        mqttService.publishSystemConfigSnapshot(snapshot);
                        console.log('[Startup] Published config snapshot for cloud sync');
                    }
                }
            })
            .catch(err => console.error('[Startup] Switchback sync/config snapshot failed:', err.message));

        // Start server
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`TrailCurrent API server running on port ${PORT}`);
            console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
async function shutdown(signal) {
    console.log(`${signal} received, shutting down gracefully`);
    try {
        require('./services/cloud-bridge').disconnect();
    } catch {}
    server.close(async () => {
        await closeDb();
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();
