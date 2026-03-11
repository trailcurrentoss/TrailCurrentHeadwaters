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

const app = express();
const server = http.createServer(app);

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
        app.use('/api/trailer', trailerRoutes(db));
        app.use('/api/energy', energyRoutes(db));
        app.use('/api/settings', settingsRoutes(db));
        app.use('/api/water', waterRoutes(db));
        app.use('/api/airquality', airqualityRoutes(db));
        app.use('/api/system-config', systemConfigRoutes(db));
        app.use('/api/modules', modulesRoutes(db));
        app.use('/api/ota', otaRoutes(db));

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
        const { broadcast } = setupWebSocket(server, db);

        // Make broadcast available to routes if needed
        app.set('broadcast', broadcast);

        // Initialize MQTT service
        mqttService.connect(db, broadcast);

        // Inject starter flow into Node-RED if empty (must complete before cloud workflow)
        const { injectStarterFlowIfEmpty, injectWithRetry } = require('./services/nodered-cloud-workflow');
        try {
            await injectStarterFlowIfEmpty();
        } catch (err) {
            console.error('[Startup] Starter flow injection failed:', err.message);
        }

        // Re-inject cloud workflow if cloud is enabled (picks up template changes on deploy)
        const sysConfig = await db.collection('system_config').findOne({ _id: 'main' });
        if (sysConfig && sysConfig.cloud_enabled) {
            const { decrypt } = require('./utils/crypto');
            let mqttPass = '';
            if (sysConfig.cloud_mqtt_password_encrypted && sysConfig.cloud_mqtt_password_iv) {
                try { mqttPass = decrypt(sysConfig.cloud_mqtt_password_encrypted, sysConfig.cloud_mqtt_password_iv); } catch {}
            }
            injectWithRetry(sysConfig.cloud_url, sysConfig.cloud_mqtt_username, mqttPass).catch(err =>
                console.error('[Startup] Cloud workflow re-injection failed:', err.message));
        }

        // Sync PDM channel configs to lights collection (fire-and-forget)
        const { syncPdmChannelsToLights } = require('./services/pdm-channel-sync');
        syncPdmChannelsToLights(db, mqttService).catch(err =>
            console.error('[Startup] PDM channel sync failed:', err.message));

        // Sync Switchback relay configs to lights collection, then cache names for MQTT hot path
        const { syncSwitchbackChannelsToLights } = require('./services/switchback-channel-sync');
        syncSwitchbackChannelsToLights(db, mqttService)
            .then(() => mqttService.refreshRelayNameCache())
            .catch(err => console.error('[Startup] Switchback channel sync failed:', err.message));

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
    server.close(async () => {
        await closeDb();
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();
