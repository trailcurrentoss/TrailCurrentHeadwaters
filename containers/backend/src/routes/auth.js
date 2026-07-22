const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const router = express.Router();

const SESSION_DURATION_HOURS = 24;

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateApiKey() {
    return 'rv_' + crypto.randomBytes(32).toString('hex');
}

module.exports = (db) => {
    const users = db.collection('users');
    const sessions = db.collection('sessions');

    const initDefaultUser = async () => {
        const existingUser = await users.findOne({ username: 'admin' });
        if (!existingUser) {
            const password = process.env.ADMIN_PASSWORD;
            if (!password) {
                throw new Error("ADMIN_PASSWORD is not set");
            }
            const hash = await bcrypt.hash(password, 10);
            await users.insertOne({
                username: 'admin',
                password_hash: hash,
                display_name: 'Administrator',
                created_at: new Date()
            });
            console.log('Default admin user created');
        }
    };
    initDefaultUser();

    // POST /api/auth/login
    router.post('/login', async (req, res) => {
        try {
            const { username, password } = req.body;

            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required' });
            }

            const user = await users.findOne({ username });

            if (!user) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const validPassword = await bcrypt.compare(password, user.password_hash);

            if (!validPassword) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            // Create session
            const token = generateToken();
            const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000);

            await sessions.insertOne({
                user_id: user._id,
                token,
                expires_at: expiresAt,
                created_at: new Date()
            });

            // Clean up old sessions for this user
            await sessions.deleteMany({
                user_id: user._id,
                expires_at: { $lt: new Date() }
            });

            res.json({
                token,
                user: {
                    id: user._id,
                    username: user.username,
                    display_name: user.display_name
                },
                expires_at: expiresAt.toISOString()
            });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ error: 'Login failed' });
        }
    });

    // POST /api/auth/logout
    router.post('/logout', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');

            if (token) {
                await sessions.deleteOne({ token });
            }

            res.json({ message: 'Logged out successfully' });
        } catch (error) {
            console.error('Logout error:', error);
            res.status(500).json({ error: 'Logout failed' });
        }
    });

    // GET /api/auth/check
    router.get('/check', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                return res.status(401).json({ authenticated: false });
            }

            const session = await sessions.findOne({
                token,
                expires_at: { $gt: new Date() }
            });

            if (!session) {
                return res.status(401).json({ authenticated: false });
            }

            const user = await users.findOne({ _id: session.user_id });

            if (!user) {
                return res.status(401).json({ authenticated: false });
            }

            res.json({
                authenticated: true,
                user: {
                    id: user._id,
                    username: user.username,
                    display_name: user.display_name
                },
                expires_at: session.expires_at.toISOString()
            });
        } catch (error) {
            console.error('Auth check error:', error);
            res.status(500).json({ error: 'Auth check failed' });
        }
    });

    // POST /api/auth/change-password
    router.post('/change-password', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            const session = await sessions.findOne({
                token,
                expires_at: { $gt: new Date() }
            });

            if (!session) {
                return res.status(401).json({ error: 'Invalid or expired session' });
            }

            const user = await users.findOne({ _id: session.user_id });

            if (!user) {
                return res.status(401).json({ error: 'User not found' });
            }

            const { current_password, new_password } = req.body;

            if (!current_password || !new_password) {
                return res.status(400).json({ error: 'Current password and new password are required' });
            }

            if (new_password.length < 6) {
                return res.status(400).json({ error: 'New password must be at least 6 characters' });
            }

            const validPassword = await bcrypt.compare(current_password, user.password_hash);

            if (!validPassword) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }

            const newHash = await bcrypt.hash(new_password, 10);
            await users.updateOne(
                { _id: session.user_id },
                { $set: { password_hash: newHash } }
            );

            res.json({ message: 'Password changed successfully' });
        } catch (error) {
            console.error('Change password error:', error);
            res.status(500).json({ error: 'Failed to change password' });
        }
    });

    // GET /api/auth/api-keys
    router.get('/api-keys', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            const session = await sessions.findOne({
                token,
                expires_at: { $gt: new Date() }
            });

            if (!session) {
                return res.status(401).json({ error: 'Invalid or expired session' });
            }

            const user = await users.findOne({ _id: session.user_id });

            if (!user) {
                return res.status(401).json({ error: 'User not found' });
            }

            const apiKeys = db.collection('api_keys');
            const keys = await apiKeys.find({ user_id: user._id }).toArray();

            res.json({
                keys: keys.map(key => ({
                    id: key._id,
                    name: key.name,
                    key_prefix: key.key_prefix,
                    created_at: key.created_at,
                    last_used: key.last_used,
                    is_active: key.is_active
                }))
            });
        } catch (error) {
            console.error('Get API keys error:', error);
            res.status(500).json({ error: 'Failed to fetch API keys' });
        }
    });

    // POST /api/auth/api-keys
    router.post('/api-keys', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            const session = await sessions.findOne({
                token,
                expires_at: { $gt: new Date() }
            });

            if (!session) {
                return res.status(401).json({ error: 'Invalid or expired session' });
            }

            const user = await users.findOne({ _id: session.user_id });

            if (!user) {
                return res.status(401).json({ error: 'User not found' });
            }

            const { name } = req.body;

            if (!name || name.trim().length === 0) {
                return res.status(400).json({ error: 'API key name is required' });
            }

            if (name.length > 100) {
                return res.status(400).json({ error: 'API key name must be less than 100 characters' });
            }

            const apiKeys = db.collection('api_keys');
            
            // Check if user already has 5 active keys
            const activeKeysCount = await apiKeys.countDocuments({
                user_id: user._id,
                is_active: true
            });

            if (activeKeysCount >= 5) {
                return res.status(400).json({ error: 'Maximum of 5 active API keys allowed per user' });
            }

            const fullKey = generateApiKey();
            const keyPrefix = fullKey.substring(0, 10);

            const apiKey = {
                user_id: user._id,
                name: name.trim(),
                key_prefix: keyPrefix,
                key_hash: await bcrypt.hash(fullKey, 10),
                is_active: true,
                created_at: new Date(),
                last_used: null
            };

            const result = await apiKeys.insertOne(apiKey);

            res.json({
                id: result.insertedId,
                name: apiKey.name,
                key_prefix: apiKey.key_prefix,
                full_key: fullKey,
                created_at: apiKey.created_at,
                last_used: apiKey.last_used,
                is_active: apiKey.is_active
            });
        } catch (error) {
            console.error('Create API key error:', error);
            res.status(500).json({ error: 'Failed to create API key' });
        }
    });

    // DELETE /api/auth/api-keys/:id
    router.delete('/api-keys/:id', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            const session = await sessions.findOne({
                token,
                expires_at: { $gt: new Date() }
            });

            if (!session) {
                return res.status(401).json({ error: 'Invalid or expired session' });
            }

            const user = await users.findOne({ _id: session.user_id });

            if (!user) {
                return res.status(401).json({ error: 'User not found' });
            }

            const apiKeys = db.collection('api_keys');
            
            // Convert string ID to ObjectId
            const ObjectId = require('mongodb').ObjectId;
            let keyId;
            try {
                keyId = new ObjectId(req.params.id);
            } catch (err) {
                return res.status(400).json({ error: 'Invalid API key ID format' });
            }

            const result = await apiKeys.deleteOne({
                _id: keyId,
                user_id: user._id
            });

            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'API key not found' });
            }

            res.json({ message: 'API key deleted successfully' });
        } catch (error) {
            console.error('Delete API key error:', error);
            res.status(500).json({ error: 'Failed to delete API key' });
        }
    });

    return router;
};

// Auth middleware for protecting routes
module.exports.authMiddleware = (db) => {
    const sessions = db.collection('sessions');
    const users = db.collection('users');
    const apiKeys = db.collection('api_keys');

    return async (req, res, next) => {
        // Skip auth for auth routes and health check
        if (req.path.startsWith('/api/auth') || req.path === '/api/health') {
            return next();
        }

        // Auth token normally rides in the Authorization header. HTML
        // elements that fetch resources — <img src>, <video src>, EventSource,
        // etc. — cannot attach custom headers, so we ALSO accept the same
        // tokens via ?token= / ?apiKey= query params. Restricted to GET so
        // no state-changing operation ever authenticates via URL params
        // (which can leak into logs, referer headers, and browser history).
        let authHeader = req.headers.authorization;
        if (!authHeader && req.method === 'GET') {
            if (typeof req.query.token === 'string' && req.query.token) {
                authHeader = `Bearer ${req.query.token}`;
            } else if (typeof req.query.apiKey === 'string' && req.query.apiKey) {
                authHeader = req.query.apiKey;
            }
        }

        const isBrowserNavigation = () => {
            const accept = req.headers.accept || '';
            return accept.includes('text/html') && !req.xhr && req.headers['x-requested-with'] !== 'XMLHttpRequest';
        };

        if (!authHeader) {
            if (isBrowserNavigation()) {
                return res.redirect('/#login');
            }
            return res.status(401).json({ error: 'Authentication required' });
        }

        try {
            // Check if it's a session token (Bearer token)
            if (authHeader.startsWith('Bearer ')) {
                const token = authHeader.replace('Bearer ', '');
                const session = await sessions.findOne({
                    token,
                    expires_at: { $gt: new Date() }
                });

                if (!session) {
                    if (isBrowserNavigation()) {
                        return res.redirect('/#login');
                    }
                    return res.status(401).json({ error: 'Invalid or expired session' });
                }

                const user = await users.findOne({ _id: session.user_id });

                if (!user) {
                    if (isBrowserNavigation()) {
                        return res.redirect('/#login');
                    }
                    return res.status(401).json({ error: 'User not found' });
                }

                req.user = {
                    id: user._id,
                    username: user.username
                };

                next();
                return;
            }

            // Check if it's an API key
            if (authHeader.startsWith('rv_')) {
                const apiKey = authHeader;
                
                // Find API key by prefix
                const keyPrefix = apiKey.substring(0, 10);
                const keyRecord = await apiKeys.findOne({
                    key_prefix: keyPrefix,
                    is_active: true
                });

                if (!keyRecord) {
                    return res.status(401).json({ error: 'Invalid API key' });
                }

                // Verify the full key
                const isValid = await bcrypt.compare(apiKey, keyRecord.key_hash);

                if (!isValid) {
                    return res.status(401).json({ error: 'Invalid API key' });
                }

                // Update last used timestamp
                await apiKeys.updateOne(
                    { _id: keyRecord._id },
                    { $set: { last_used: new Date() } }
                );

                // Get user info
                const user = await users.findOne({ _id: keyRecord.user_id });

                if (!user) {
                    return res.status(401).json({ error: 'Invalid API key' });
                }

                req.user = {
                    id: user._id,
                    username: user.username
                };

                next();
                return;
            }

            // Invalid auth header format
            return res.status(401).json({ error: 'Invalid authentication format' });

        } catch (error) {
            console.error('Auth middleware error:', error);
            res.status(500).json({ error: 'Authentication error' });
        }
    };
};
