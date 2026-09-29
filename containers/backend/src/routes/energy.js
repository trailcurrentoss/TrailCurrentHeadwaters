const express = require('express');
const router = express.Router();

module.exports = () => {
    // Energy data is streamed via WebSocket from CAN bus (no DB storage).
    // Returns null state — frontend waits for WebSocket data.
    router.get('/', (req, res) => {
        res.json({
            solar_watts: null,
            battery_percent: null,
            battery_voltage: null,
            charge_type: null,
            time_remaining_minutes: null,
            consumption_watts: null,
            battery_watts: null,   // signed: + charging, - discharging
        });
    });

    return router;
};
