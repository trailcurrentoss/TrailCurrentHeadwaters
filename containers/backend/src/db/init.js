const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;

let client = null;
let db = null;

async function connect() {
    if (db) return db;

    client = new MongoClient(uri);
    await client.connect();
    db = client.db();

    console.log('Connected to MongoDB');

    await seedDatabase();

    return db;
}

async function seedDatabase() {
    // Lights are managed dynamically by pdm-channel-sync and switchback-channel-sync.
    // No seed data — lights only exist when a module is enabled.

    // Migration: add icon and type fields if missing on legacy light entries
    const lights = db.collection('lights');
    const existingLights = await lights.countDocuments();
    if (existingLights > 0) {
        const sample = await lights.findOne({});
        if (sample && sample.icon === undefined) {
            await lights.updateMany(
                { icon: { $exists: false } },
                { $set: { icon: 'lightbulb', type: 'light' } }
            );
            console.log('Migrated lights: added icon and type fields');
        }
    }

    // Seed settings
    const settings = db.collection('settings');
    const existingSettings = await settings.findOne({ _id: 'main' });
    if (!existingSettings) {
        await settings.insertOne({
            _id: 'main',
            theme: 'dark',
            timezone: 'America/New_York',
            clock_format: '12h',
            updated_at: new Date()
        });
        console.log('Seeded settings');
    }

    // Seed system configuration
    const systemConfig = db.collection('system_config');
    const existingConfig = await systemConfig.findOne({ _id: 'main' });
    if (!existingConfig) {
        await systemConfig.insertOne({
            _id: 'main',
            wizard_completed: false,
            cloud_enabled: false,
            cloud_url: '',
            cloud_mqtt_username: '',
            cloud_mqtt_password_encrypted: '',
            cloud_mqtt_password_iv: '',
            cloud_api_key_encrypted: '',
            cloud_api_key_iv: '',
            mcu_modules: [],
            wifi_ssid: '',
            wifi_password_encrypted: '',
            wifi_password_iv: '',
            updated_at: new Date()
        });
        console.log('Seeded system configuration');
    } else {
        // Migration: add missing fields
        const updates = {};
        if (existingConfig.mcu_modules === undefined) {
            updates.mcu_modules = [];
        }
        if (existingConfig.wifi_ssid === undefined) {
            updates.wifi_ssid = '';
        }
        if (existingConfig.wifi_password_encrypted === undefined) {
            updates.wifi_password_encrypted = '';
        }
        if (existingConfig.wifi_password_iv === undefined) {
            updates.wifi_password_iv = '';
        }
        if (existingConfig.cloud_mqtt_username === undefined) {
            updates.cloud_mqtt_username = '';
        }
        if (existingConfig.cloud_mqtt_password_encrypted === undefined) {
            updates.cloud_mqtt_password_encrypted = '';
        }
        if (existingConfig.cloud_mqtt_password_iv === undefined) {
            updates.cloud_mqtt_password_iv = '';
        }
        if (existingConfig.cloud_api_key_encrypted === undefined) {
            updates.cloud_api_key_encrypted = '';
        }
        if (existingConfig.cloud_api_key_iv === undefined) {
            updates.cloud_api_key_iv = '';
        }
        if (existingConfig.alarm_enabled === undefined) {
            updates.alarm_enabled = false;
        }
        if (existingConfig.sms_max_messages === undefined) {
            updates.sms_max_messages = 3;
        }
        if (existingConfig.sms_throttle_window_minutes === undefined) {
            updates.sms_throttle_window_minutes = 60;
        }
        if (Object.keys(updates).length > 0) {
            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: updates }
            );
            console.log('Migrated system configuration fields:', Object.keys(updates).join(', '));
        }
    }

    console.log('Database seeding complete');
}

function getDb() {
    if (!db) {
        throw new Error('Database not connected. Call connect() first.');
    }
    return db;
}

async function close() {
    if (client) {
        await client.close();
        client = null;
        db = null;
        console.log('MongoDB connection closed');
    }
}

module.exports = { connect, getDb, close };
