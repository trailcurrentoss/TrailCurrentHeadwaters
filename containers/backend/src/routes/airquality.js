const express = require('express');
const router = express.Router();

module.exports = (db) => {
    const airquality = db.collection('airquality');

    // GET /api/airquality
    router.get('/', async (req, res) => {
        try {
            const data = await airquality.findOne({ _id: 'main' });
            res.json(data);
        } catch (error) {
            console.error('Error fetching air quality:', error);
            res.status(500).json({ error: 'Failed to fetch air quality data' });
        }
    });

    // PUT /api/airquality (for simulation/testing)
    router.put('/', async (req, res) => {
        try {
            const { tvoc_ppb, eco2_ppm } = req.body;

            const updates = {};

            if (tvoc_ppb !== undefined) {
                if (tvoc_ppb < 0 || tvoc_ppb > 60000) {
                    return res.status(400).json({ error: 'tvoc_ppb must be between 0 and 60000' });
                }
                updates.tvoc_ppb = tvoc_ppb;
            }

            if (eco2_ppm !== undefined) {
                if (eco2_ppm < 0 || eco2_ppm > 60000) {
                    return res.status(400).json({ error: 'eco2_ppm must be between 0 and 60000' });
                }
                updates.eco2_ppm = eco2_ppm;
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'No valid fields to update' });
            }

            updates.updated_at = new Date();

            await airquality.updateOne(
                { _id: 'main' },
                { $set: updates }
            );

            const data = await airquality.findOne({ _id: 'main' });
            res.json(data);
        } catch (error) {
            console.error('Error updating air quality:', error);
            res.status(500).json({ error: 'Failed to update air quality' });
        }
    });

    return router;
};
