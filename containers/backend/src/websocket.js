const WebSocket = require('ws');

function setupWebSocket(server, db) {
    const wss = new WebSocket.Server({ server, path: '/ws' });

    const clients = new Set();

    wss.on('connection', (ws) => {
        console.log('WebSocket client connected');
        clients.add(ws);

        ws.on('close', () => {
            console.log('WebSocket client disconnected');
            clients.delete(ws);
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            clients.delete(ws);
        });
    });

    // Broadcast function
    function broadcast(type, data) {
        const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    // Simulate real-time thermostat updates (uses air quality temperature as source)
    setInterval(async () => {
        if (clients.size === 0) return;

        try {
            const thermostatCollection = db.collection('thermostat');

            const thermostat = await thermostatCollection.findOne({ _id: 'main' });
            if (!thermostat) return;

            broadcast('thermostat', {
                ...thermostat,
            });
        } catch (error) {
            console.error('Error updating thermostat simulation:', error);
        }
    }, 5000);

    // Simulate energy data updates
    setInterval(async () => {
        if (clients.size === 0) return;

        try {
            const energyCollection = db.collection('energy');
            const energy = await energyCollection.findOne({ _id: 'main' });
            if (!energy) return;

            // Simulate solar watts based on "time of day"
            const hour = new Date().getHours();
            const isDayTime = hour >= 6 && hour <= 18;
            const solarVariation = isDayTime ? (Math.random() * 50 - 25) : -energy.solar_watts * 0.1;
            let newSolarWatts = Math.max(0, Math.min(800, energy.solar_watts + solarVariation));
            newSolarWatts = Math.round(newSolarWatts);

            // Simulate battery percent change
            const batteryChange = newSolarWatts > 100 ? 0.1 : -0.05;
            let newBatteryPercent = Math.max(0, Math.min(100, energy.battery_percent + batteryChange));
            newBatteryPercent = Math.round(newBatteryPercent * 10) / 10;

            // Update charge type based on battery level
            let newChargeType = energy.charge_type;
            if (newBatteryPercent < 50) {
                newChargeType = 'bulk';
            } else if (newBatteryPercent < 80) {
                newChargeType = 'absorption';
            } else if (newBatteryPercent >= 95) {
                newChargeType = 'float';
            }

            // Simulate consumption (higher at night when solar is low)
            const baseConsumption = isDayTime ? 80 : 150;
            const consumptionVariation = Math.random() * 40 - 20;
            const newConsumptionWatts = Math.max(0, Math.round(baseConsumption + consumptionVariation));

            await energyCollection.updateOne(
                { _id: 'main' },
                { $set: {
                    solar_watts: newSolarWatts,
                    battery_percent: newBatteryPercent,
                    charge_type: newChargeType,
                    consumption_watts: newConsumptionWatts,
                    updated_at: new Date()
                } }
            );

            broadcast('energy', {
                ...energy,
                solar_watts: newSolarWatts,
                battery_percent: newBatteryPercent,
                charge_type: newChargeType,
                consumption_watts: newConsumptionWatts
            });
        } catch (error) {
            console.error('Error updating energy simulation:', error);
        }
    }, 3000);

    // Simulate trailer level slight movements
    setInterval(async () => {
        if (clients.size === 0) return;

        try {
            const trailerLevelCollection = db.collection('trailer_level');
            const level = await trailerLevelCollection.findOne({ _id: 'main' });
            if (!level) return;

            // Small random movements to simulate wind/settling
            const frontBackChange = (Math.random() - 0.5) * 0.2;
            const sideChange = (Math.random() - 0.5) * 0.2;

            let newFrontBack = Math.max(-15, Math.min(15, level.front_back + frontBackChange));
            let newSideToSide = Math.max(-15, Math.min(15, level.side_to_side + sideChange));

            newFrontBack = Math.round(newFrontBack * 10) / 10;
            newSideToSide = Math.round(newSideToSide * 10) / 10;

            await trailerLevelCollection.updateOne(
                { _id: 'main' },
                { $set: {
                    front_back: newFrontBack,
                    side_to_side: newSideToSide,
                    updated_at: new Date()
                } }
            );

            broadcast('level', {
                ...level,
                front_back: newFrontBack,
                side_to_side: newSideToSide
            });
        } catch (error) {
            console.error('Error updating trailer level simulation:', error);
        }
    }, 2000);

    // Simulate water tank level changes
    setInterval(async () => {
        if (clients.size === 0) return;

        try {
            const waterCollection = db.collection('water');
            const water = await waterCollection.findOne({ _id: 'main' });
            if (!water) return;

            // Fresh water slowly decreases (usage)
            const freshChange = -Math.random() * 0.3;
            let newFresh = Math.max(0, Math.min(100, water.fresh + freshChange));
            newFresh = Math.round(newFresh * 10) / 10;

            // Grey water slowly increases (from usage)
            const greyChange = Math.random() * 0.2;
            let newGrey = Math.max(0, Math.min(100, water.grey + greyChange));
            newGrey = Math.round(newGrey * 10) / 10;

            // Black water increases very slowly
            const blackChange = Math.random() * 0.05;
            let newBlack = Math.max(0, Math.min(100, water.black + blackChange));
            newBlack = Math.round(newBlack * 10) / 10;

            await waterCollection.updateOne(
                { _id: 'main' },
                { $set: {
                    fresh: newFresh,
                    grey: newGrey,
                    black: newBlack,
                    updated_at: new Date()
                } }
            );

            broadcast('water', {
                ...water,
                fresh: newFresh,
                grey: newGrey,
                black: newBlack
            });
        } catch (error) {
            console.error('Error updating water simulation:', error);
        }
    }, 10000);

    // Simulate air quality data updates
    setInterval(async () => {
        if (clients.size === 0) return;

        try {
            const airqualityCollection = db.collection('airquality');
            const airquality = await airqualityCollection.findOne({ _id: 'main' });
            if (!airquality) return;

            // IAQ index varies slightly (65-120 range typically)
            const iaqChange = (Math.random() - 0.5) * 5;
            let newIaqIndex = Math.max(25, Math.min(175, airquality.iaq_index + iaqChange));
            newIaqIndex = Math.round(newIaqIndex);

            // CO2 varies based on "occupancy" simulation
            const co2Change = (Math.random() - 0.5) * 30;
            let newCo2Ppm = Math.max(400, Math.min(1500, airquality.co2_ppm + co2Change));
            newCo2Ppm = Math.round(newCo2Ppm);

            await airqualityCollection.updateOne(
                { _id: 'main' },
                { $set: {
                    iaq_index: newIaqIndex,
                    co2_ppm: newCo2Ppm,
                    updated_at: new Date()
                } }
            );

            broadcast('airquality', {
                ...airquality,
                iaq_index: newIaqIndex,
                co2_ppm: newCo2Ppm
            });
        } catch (error) {
            console.error('Error updating air quality simulation:', error);
        }
    }, 15000);

    return { broadcast };
}

module.exports = setupWebSocket;
