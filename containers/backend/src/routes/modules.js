const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

const MCU_MODULES = [
    'air_quality_module',
    'cabinet_and_door_sensor',
    'can_esp_now_gateway',
    'eight_button_panel',
    'electric_heater_control',
    'gnss_module',
    'mppt_can_gateway',
    'power_distribution_module',
    'seven_pin_trailer_monitor',
    'shunt_gateway',
    'switchback_relay',
    'vehicle_leveler',
    'wall_mounted_display'
];

module.exports = (db) => {
    const modules = db.collection('modules');

    // GET /api/modules - Get all modules
    router.get('/', async (req, res) => {
        try {
            const allModules = await modules.find().sort({ created_at: -1 }).toArray();
            // Convert _id to id for frontend compatibility
            const result = allModules.map(m => ({
                id: m._id.toString(),
                name: m.name,
                type: m.type,
                hostname: m.hostname || '',
                enabled: m.enabled,
                config: m.config || {},
                created_at: m.created_at,
                updated_at: m.updated_at
            }));
            res.json(result);
        } catch (error) {
            console.error('Error fetching modules:', error);
            res.status(500).json({ error: 'Failed to fetch modules' });
        }
    });

    // GET /api/modules/types - Get available module types
    router.get('/types', async (req, res) => {
        try {
            const moduleTypes = MCU_MODULES.map(module => ({
                id: module,
                name: module
            }));
            res.json(moduleTypes);
        } catch (error) {
            console.error('Error fetching module types:', error);
            res.status(500).json({ error: 'Failed to fetch module types' });
        }
    });

    // POST /api/modules - Create a new module
    router.post('/', async (req, res) => {
        try {
            const { name, type, hostname, config } = req.body;

            // Validation
            if (!name || typeof name !== 'string' || name.trim().length === 0) {
                return res.status(400).json({ error: 'Module name is required and must be a non-empty string' });
            }

            if (!type || typeof type !== 'string') {
                return res.status(400).json({ error: 'Module type is required' });
            }

            if (!MCU_MODULES.includes(type)) {
                return res.status(400).json({ error: `Invalid module type. Must be one of: ${MCU_MODULES.join(', ')}` });
            }

            if (!hostname || typeof hostname !== 'string' || hostname.trim().length === 0) {
                return res.status(400).json({ error: 'Hostname is required and must be a non-empty string' });
            }

            const newModule = {
                name: name.trim(),
                type: type,
                hostname: hostname.trim(),
                enabled: true,
                config: config || {},
                created_at: new Date(),
                updated_at: new Date()
            };

            const result = await modules.insertOne(newModule);

            res.status(201).json({
                id: result.insertedId.toString(),
                ...newModule
            });
        } catch (error) {
            console.error('Error creating module:', error);
            res.status(500).json({ error: 'Failed to create module' });
        }
    });

    // PUT /api/modules/:id - Update a module
    router.put('/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { name, hostname, enabled, config } = req.body;

            // Validate ID
            if (!ObjectId.isValid(id)) {
                return res.status(400).json({ error: 'Invalid module ID' });
            }

            const updates = {};

            if (name !== undefined) {
                if (typeof name !== 'string' || name.trim().length === 0) {
                    return res.status(400).json({ error: 'Module name must be a non-empty string' });
                }
                updates.name = name.trim();
            }

            if (hostname !== undefined) {
                if (typeof hostname !== 'string' || hostname.trim().length === 0) {
                    return res.status(400).json({ error: 'Hostname must be a non-empty string' });
                }
                updates.hostname = hostname.trim();
            }

            if (enabled !== undefined) {
                if (typeof enabled !== 'boolean') {
                    return res.status(400).json({ error: 'enabled must be a boolean' });
                }
                updates.enabled = enabled;
            }

            if (config !== undefined) {
                if (typeof config !== 'object' || config === null) {
                    return res.status(400).json({ error: 'config must be an object' });
                }
                updates.config = config;
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'No valid fields to update' });
            }

            updates.updated_at = new Date();

            const result = await modules.findOneAndUpdate(
                { _id: new ObjectId(id) },
                { $set: updates },
                { returnDocument: 'after' }
            );

            if (!result.value) {
                return res.status(404).json({ error: 'Module not found' });
            }

            const module = result.value;
            res.json({
                id: module._id.toString(),
                name: module.name,
                type: module.type,
                hostname: module.hostname || '',
                enabled: module.enabled,
                config: module.config || {},
                created_at: module.created_at,
                updated_at: module.updated_at
            });
        } catch (error) {
            console.error('Error updating module:', error);
            res.status(500).json({ error: 'Failed to update module' });
        }
    });

    // DELETE /api/modules/:id - Delete a module
    router.delete('/:id', async (req, res) => {
        try {
            const { id } = req.params;

            // Validate ID
            if (!ObjectId.isValid(id)) {
                return res.status(400).json({ error: 'Invalid module ID' });
            }

            const result = await modules.deleteOne({ _id: new ObjectId(id) });

            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'Module not found' });
            }

            res.json({ success: true, message: 'Module deleted successfully' });
        } catch (error) {
            console.error('Error deleting module:', error);
            res.status(500).json({ error: 'Failed to delete module' });
        }
    });

    return router;
};
