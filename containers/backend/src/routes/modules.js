const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// All TrailCurrent modules — the union of ESP32-class MCUs and Linux-class
// endpoints (Playbill, future Peregrine head, etc.). Variable name kept for
// backward-compat with the persisted system_config.mcu_modules field, but
// the concept is "TrailCurrent module" generally; the `linux` flag marks
// the small set that don't have a CAN address.
const MCU_MODULES = [
    { id: 'fireside', name: 'Fireside', wireless: true },
    { id: 'spotter', name: 'Spotter' },
    { id: 'milepost', name: 'Milepost' },
    { id: 'solstice', name: 'Solstice' },
    { id: 'ampline', name: 'Ampline' },
    { id: 'torrent', name: 'Torrent' },
    { id: 'tapper', name: 'Tapper' },
    { id: 'reservoir', name: 'Reservoir' },
    { id: 'borealis', name: 'Borealis' },
    { id: 'aftline', name: 'Aftline' },
    { id: 'plateau', name: 'Plateau' },
    { id: 'picket', name: 'Picket' },
    { id: 'bearing', name: 'Bearing' },
    { id: 'therma', name: 'Therma' },
    { id: 'switchback', name: 'Switchback' },
    { id: 'playbill', name: 'Playbill', wireless: true, linux: true }
];

const VALID_MODULE_IDS = MCU_MODULES.map(m => m.id);

const createModulesRouter = (db) => {
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
                addr: m.addr,
                target: m.target || '',
                canid: m.canid || '',
                fw: m.fw || '',
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
            res.json(MCU_MODULES);
        } catch (error) {
            console.error('Error fetching module types:', error);
            res.status(500).json({ error: 'Failed to fetch module types' });
        }
    });

    // POST /api/modules - Create a new module
    router.post('/', async (req, res) => {
        try {
            const { name, type, hostname, addr, canid, fw, config } = req.body;

            // Validation
            if (!name || typeof name !== 'string' || name.trim().length === 0) {
                return res.status(400).json({ error: 'Module name is required and must be a non-empty string' });
            }

            if (!type || typeof type !== 'string') {
                return res.status(400).json({ error: 'Module type is required' });
            }

            if (!VALID_MODULE_IDS.includes(type)) {
                return res.status(400).json({ error: `Invalid module type. Must be one of: ${VALID_MODULE_IDS.join(', ')}` });
            }

            if (!hostname || typeof hostname !== 'string' || hostname.trim().length === 0) {
                return res.status(400).json({ error: 'Hostname is required and must be a non-empty string' });
            }

            const newModule = {
                name: name.trim(),
                type: type,
                hostname: hostname.trim(),
                addr: addr !== undefined ? addr : null,
                canid: canid || '',
                fw: fw || '',
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
                addr: module.addr,
                canid: module.canid || '',
                fw: module.fw || '',
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

createModulesRouter.MCU_MODULES = MCU_MODULES;
createModulesRouter.VALID_MODULE_IDS = VALID_MODULE_IDS;

module.exports = createModulesRouter;
