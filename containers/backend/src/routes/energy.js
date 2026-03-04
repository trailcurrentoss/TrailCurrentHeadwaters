const express = require('express');
const router = express.Router();

module.exports = (db) => {
    const energy = db.collection('energy');

    // GET /api/energy
    router.get('/', async (req, res) => {
        try {
            const data = await energy.findOne({ _id: 'main' });
            res.json(data);
        } catch (error) {
            console.error('Error fetching energy:', error);
            res.status(500).json({ error: 'Failed to fetch energy data' });
        }
    });

    // PUT /api/energy (for simulation/testing)
    router.put('/', async (req, res) => {
        try {
            const { solar_watts, battery_percent, battery_voltage, charge_type, time_remaining_minutes, consumption_watts } = req.body;

            const updates = {};

            if (solar_watts !== undefined) {
                if (solar_watts < 0 || solar_watts > 2000) {
                    return res.status(400).json({ error: 'solar_watts must be between 0 and 2000' });
                }
                updates.solar_watts = solar_watts;
            }

            if (battery_percent !== undefined) {
                if (battery_percent < 0 || battery_percent > 100) {
                    return res.status(400).json({ error: 'battery_percent must be between 0 and 100' });
                }
                updates.battery_percent = battery_percent;
            }

            if (battery_voltage !== undefined) {
                if (battery_voltage < 0 || battery_voltage > 60) {
                    return res.status(400).json({ error: 'battery_voltage must be between 0 and 60' });
                }
                updates.battery_voltage = battery_voltage;
            }

            if (charge_type !== undefined) {
                if (!['off', 'float', 'bulk', 'absorption', 'equalize', 'fault'].includes(charge_type)) {
                    return res.status(400).json({ error: 'Invalid charge_type' });
                }
                updates.charge_type = charge_type;
            }

            if (time_remaining_minutes !== undefined) {
                if (time_remaining_minutes < 0) {
                    return res.status(400).json({ error: 'time_remaining_minutes must be non-negative' });
                }
                updates.time_remaining_minutes = time_remaining_minutes;
            }

            if (consumption_watts !== undefined) {
                if (consumption_watts < 0 || consumption_watts > 5000) {
                    return res.status(400).json({ error: 'consumption_watts must be between 0 and 5000' });
                }
                updates.consumption_watts = consumption_watts;
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'No valid fields to update' });
            }

            updates.updated_at = new Date();

            await energy.updateOne(
                { _id: 'main' },
                { $set: updates }
            );

            const data = await energy.findOne({ _id: 'main' });
            res.json(data);
        } catch (error) {
            console.error('Error updating energy:', error);
            res.status(500).json({ error: 'Failed to update energy' });
        }
    });

    return router;
};
