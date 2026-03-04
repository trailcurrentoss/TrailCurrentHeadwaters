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
    // Seed thermostat
    const thermostat = db.collection('thermostat');
    const existingThermostat = await thermostat.findOne({ _id: 'main' });
    if (!existingThermostat) {
        await thermostat.insertOne({
            _id: 'main',
            target_temp: 72.0,
            mode: 'auto',
            updated_at: new Date()
        });
        console.log('Seeded thermostat');
    }

    // Seed lights
    const lights = db.collection('lights');
    const existingLights = await lights.countDocuments();
    if (existingLights === 0) {
        const lightNames = [
            'Living Room', 'Kitchen', 'Bedroom', 'Bathroom',
            'Exterior', 'Awning', 'Porch', 'Storage'
        ];
        const lightDocs = lightNames.map((name, index) => ({
            _id: index + 1,
            name,
            icon: 'lightbulb',
            type: 'light',
            updated_at: new Date()
        }));
        await lights.insertMany(lightDocs);
        console.log('Seeded lights');
    } else {
        // Migration: add icon and type fields if missing
        const sample = await lights.findOne({});
        if (sample && sample.icon === undefined) {
            await lights.updateMany(
                { icon: { $exists: false } },
                { $set: { icon: 'lightbulb', type: 'light' } }
            );
            console.log('Migrated lights: added icon and type fields');
        }
    }

    // Seed trailer level
    const trailerLevel = db.collection('trailer_level');
    const existingLevel = await trailerLevel.findOne({ _id: 'main' });
    if (!existingLevel) {
        await trailerLevel.insertOne({
            _id: 'main',
            front_back: 0.0,
            side_to_side: 0.0,
            updated_at: new Date()
        });
        console.log('Seeded trailer level');
    }

    // Seed energy
    const energy = db.collection('energy');
    const existingEnergy = await energy.findOne({ _id: 'main' });
    if (!existingEnergy) {
        await energy.insertOne({
            _id: 'main',
            solar_watts: 245.0,
            battery_percent: 87,
            battery_voltage: 13.2,
            charge_type: 'float',
            time_remaining_minutes: 2880, // 48 hours
            consumption_watts: 0,
            updated_at: new Date()
        });
        console.log('Seeded energy');
    } else {
        // Migration: add missing fields
        const updates = {};
        if (existingEnergy.time_remaining_minutes === undefined) {
            updates.time_remaining_minutes = 2880;
        }
        if (existingEnergy.battery_voltage === undefined) {
            updates.battery_voltage = 13.2;
        }
        if (existingEnergy.consumption_watts === undefined) {
            updates.consumption_watts = 0;
        }
        if (Object.keys(updates).length > 0) {
            await energy.updateOne(
                { _id: 'main' },
                { $set: updates }
            );
            console.log('Migrated energy fields:', Object.keys(updates).join(', '));
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
        if (Object.keys(updates).length > 0) {
            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: updates }
            );
            console.log('Migrated system configuration fields:', Object.keys(updates).join(', '));
        }
    }

    // Seed water tanks
    const water = db.collection('water');
    const existingWater = await water.findOne({ _id: 'main' });
    if (!existingWater) {
        await water.insertOne({
            _id: 'main',
            fresh: 75.0,
            grey: 30.0,
            black: 15.0,
            updated_at: new Date()
        });
        console.log('Seeded water tanks');
    }

    // Seed air quality
    const airquality = db.collection('airquality');
    const existingAirQuality = await airquality.findOne({ _id: 'main' });
    if (!existingAirQuality) {
        await airquality.insertOne({
            _id: 'main',
            iaq_index: 85,
            co2_ppm: 650,
            updated_at: new Date()
        });
        console.log('Seeded air quality');
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
