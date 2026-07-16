// API communication module
const API_BASE = '/api';

// Auth token storage
class AuthStore {
    static TOKEN_KEY = 'rv_auth_token';
    static USER_KEY = 'rv_auth_user';

    static getToken() {
        return localStorage.getItem(this.TOKEN_KEY);
    }

    static setToken(token) {
        localStorage.setItem(this.TOKEN_KEY, token);
    }

    static getUser() {
        const user = localStorage.getItem(this.USER_KEY);
        return user ? JSON.parse(user) : null;
    }

    static setUser(user) {
        localStorage.setItem(this.USER_KEY, JSON.stringify(user));
    }

    static clear() {
        localStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.USER_KEY);
    }

    static isAuthenticated() {
        return !!this.getToken();
    }
}

class API {
    static async request(endpoint, options = {}) {
        const url = `${API_BASE}${endpoint}`;
        const token = AuthStore.getToken();
        const apiKey = this.getApiKey();

        const config = {
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                ...(apiKey ? { 'Authorization': apiKey } : {})
            },
            ...options
        };

        try {
            const response = await fetch(url, config);
            const data = await response.json();

            if (!response.ok) {
                // Handle auth errors
                if (response.status === 401) {
                    AuthStore.clear();
                    this.clearApiKey();
                    window.dispatchEvent(new CustomEvent('authRequired'));
                }
                throw new Error(data.error || 'API request failed');
            }

            return data;
        } catch (error) {
            console.error(`API Error (${endpoint}):`, error);
            throw error;
        }
    }

    // Auth
    static async login(username, password) {
        const data = await this.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });

        AuthStore.setToken(data.token);
        AuthStore.setUser(data.user);

        return data;
    }

    static async logout() {
        try {
            await this.request('/auth/logout', { method: 'POST' });
        } finally {
            AuthStore.clear();
        }
    }

    static async checkAuth() {
        if (!AuthStore.getToken()) {
            return { authenticated: false };
        }

        try {
            const data = await this.request('/auth/check');
            if (data.authenticated) {
                AuthStore.setUser(data.user);
            }
            return data;
        } catch (error) {
            AuthStore.clear();
            return { authenticated: false };
        }
    }

    static isAuthenticated() {
        return AuthStore.isAuthenticated();
    }

    static getUser() {
        return AuthStore.getUser();
    }

    static async changePassword(currentPassword, newPassword) {
        return this.request('/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword
            })
        });
    }

    // API Keys
    static async getApiKeys() {
        return this.request('/auth/api-keys');
    }

    static async createApiKey(name) {
        return this.request('/auth/api-keys', {
            method: 'POST',
            body: JSON.stringify({ name })
        });
    }

    static async deleteApiKey(id) {
        return this.request(`/auth/api-keys/${id}`, {
            method: 'DELETE'
        });
    }

    // API key storage
    static setApiKey(key) {
        localStorage.setItem('rv_api_key', key);
    }

    static getApiKey() {
        return localStorage.getItem('rv_api_key');
    }

    static clearApiKey() {
        localStorage.removeItem('rv_api_key');
    }

    // Lights
    static async getLights() {
        return this.request('/lights');
    }

    static async setLight(id, state, brightness = null) {
        const body = { state };
        if (brightness !== null) {
            body.brightness = brightness;
        }
        return this.request(`/lights/${id}`, {
            method: 'PUT',
            body: JSON.stringify(body)
        });
    }

    static async setLightBrightness(id, brightness) {
        // Send brightness change with current state (keeps light on)
        return this.request(`/lights/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ state: 1, brightness })
        });
    }

    static async setAllLights(state) {
        return this.request('/lights/all', {
            method: 'PUT',
            body: JSON.stringify({ state })
        });
    }

    // Settings
    static async getSettings() {
        return this.request('/settings');
    }

    static async setSettings(data) {
        return this.request('/settings', {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    static async getCaCertificate() {
        return this.request('/settings/ca-certificate');
    }

    // Peregrine
    static async getPeregrineConfig() {
        return this.request('/peregrine/config');
    }

    static async setPeregrineConfig(data) {
        return this.request('/peregrine/config', {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    static async installPeregrineCa(pem) {
        return this.request('/peregrine/ca', {
            method: 'POST',
            body: JSON.stringify({ certificate: pem })
        });
    }

    static async removePeregrineCa() {
        return this.request('/peregrine/ca', { method: 'DELETE' });
    }

    // System Stats (CPU temp, utilization, fan speed)
    static async getSystemStats() {
        return this.request('/system-stats');
    }

    // System Configuration
    static async getSystemConfig() {
        return this.request('/system-config');
    }

    static async updateSystemConfig(data) {
        return this.request('/system-config', {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    static async resetConfiguration() {
        return this.request('/system-config/reset', {
            method: 'POST'
        });
    }

    // OS-level settings (proxied to the host via os-settings.py)
    static async getTimezone() {
        return this.request('/os/timezone');
    }

    static async setTimezone(tz) {
        return this.request('/os/timezone', {
            method: 'POST',
            body: JSON.stringify({ tz })
        });
    }

    // Destructive: wipes .env and Docker volumes, then reboots. Device
    // comes back up on the Headwaters-XXXX captive-portal WiFi AP.
    // Caller must have already run a typed-confirmation modal — this
    // token is a "definitely-not-a-stray-request" marker, not a secret.
    static async factoryReset() {
        return this.request('/os/factory-reset', {
            method: 'POST',
            body: JSON.stringify({ confirm: 'FACTORY_RESET' })
        });
    }

    // Modules
    static async getModules() {
        return this.request('/modules');
    }

    static async getModuleTypes() {
        return this.request('/modules/types');
    }

    static async createModule(data) {
        return this.request('/modules', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    static async updateModule(id, data) {
        return this.request(`/modules/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    static async deleteModule(id) {
        return this.request(`/modules/${id}`, {
            method: 'DELETE'
        });
    }

    // Alarms
    static async getAlarmsConfig() {
        return this.request('/alarms/config');
    }

    static async updateAlarmsConfig(sensors) {
        return this.request('/alarms/config', {
            method: 'PUT',
            body: JSON.stringify({ sensors })
        });
    }

    static async updateAlarmsBattery(battery) {
        return this.request('/alarms/config', {
            method: 'PUT',
            body: JSON.stringify({ battery })
        });
    }

    static async getActiveAlarms() {
        return this.request('/alarms/active');
    }

    // Health check
    static async healthCheck() {
        return this.request('/health');
    }

    // Plateau calibration save
    static async saveCalibration() {
        return this.request('/plateau/save-calibration', { method: 'POST' });
    }

    // SMS test
    static async testSms(phone_number, router_ip, ssh_key) {
        return this.request('/sms/test', {
            method: 'POST',
            body: JSON.stringify({ phone_number, router_ip, ssh_key })
        });
    }

    // OTA trigger — pass wireless:true for WiFi-connected MCUs (e.g. Fireside)
    static async triggerOta(hostname, firmware_file, wireless = false) {
        return this.request('/ota/trigger', {
            method: 'POST',
            body: JSON.stringify({ hostname, firmware_file, wireless })
        });
    }

    // OTA firmware management
    static async listFirmware() {
        return this.request('/ota/firmware');
    }

    // Discovery
    static async startDiscovery() {
        return this.request('/discovery/start', { method: 'POST' });
    }

    static async getDiscoveredModules() {
        return this.request('/discovery/found');
    }

    static async confirmModule(hostname) {
        return this.request('/discovery/confirm', {
            method: 'POST',
            body: JSON.stringify({ hostname })
        });
    }

    static async stopDiscovery() {
        return this.request('/discovery/stop', { method: 'POST' });
    }

    static async resetModuleDiscovery(hostname) {
        return this.request('/discovery/reset', {
            method: 'POST',
            body: JSON.stringify({ hostname })
        });
    }

    // Deployments
    static async getDeployments() {
        return this.request('/deployments');
    }

    static async deleteDeployment(id) {
        return this.request(`/deployments/${id}`, { method: 'DELETE' });
    }

    // Maps
    static async getMapCurrent() {
        // Bypass API.request because the intentional 404 for no-bundle would
        // be surfaced as a thrown error otherwise. This endpoint's 404 body
        // is meaningful data, not an error.
        const token = AuthStore.getToken();
        const apiKey = this.getApiKey();
        const headers = { 'Content-Type': 'application/json' };
        if (token)  headers['Authorization']    = `Bearer ${token}`;
        if (apiKey) headers['x-api-key']        = apiKey;

        const response = await fetch(`${API_BASE}/maps/current`, { headers, credentials: 'include' });
        if (response.status === 404) {
            const body = await response.json().catch(() => ({}));
            return { status: 'no-bundle', ...body };
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to fetch current map');
        return data;
    }

    static async getMapVersions() {
        return this.request('/maps/versions');
    }

    static async getMapUploads() {
        return this.request('/maps/uploads');
    }

    static async rollbackMap() {
        return this.request('/maps/rollback', { method: 'POST' });
    }

    // Cross-region confirmation (Phase 5). When a bundle uploaded declares
    // a different region than what's installed, map-watcher pauses and
    // publishes an 'awaiting-confirmation' status. The user picks Confirm
    // or Cancel from the Maps page.
    static async confirmMapUpload(id) {
        return this.request(`/maps/confirm/${encodeURIComponent(id)}`, { method: 'POST' });
    }

    static async cancelMapUpload(id) {
        return this.request(`/maps/cancel/${encodeURIComponent(id)}`, { method: 'POST' });
    }

    // Phase 8 — sneakernet load path. Scans for map bundles on connected
    // external drives (USB / SD) auto-mounted under /media/tc-external/.
    // Returns [{path, name, size, mountpoint, mtime}].
    static async scanExternalMaps() {
        return this.request('/maps/scan-external');
    }

    // Copies a bundle from an external drive into staging. Same downstream
    // flow as PWA upload — MAPS_AVAILABLE fires, map-watcher applies.
    static async importExternalMap(path) {
        return this.request('/maps/import-external', {
            method: 'POST',
            body: JSON.stringify({ path })
        });
    }

    // Routing (Valhalla via backend proxy)
    //
    // locations: [{lat, lon, name?, type?}, ...] — at least two.
    // costing:   'auto' (default) | 'pedestrian' | 'bicycle' | 'truck' | ...
    //
    // Returns Valhalla's `/route` response envelope:
    //   { trip: { summary, legs: [{maneuvers, shape, summary}], ... } }
    static async getRoute(locations, costing = 'auto', extra = {}) {
        return this.request('/route', {
            method: 'POST',
            body: JSON.stringify({ locations, costing, ...extra })
        });
    }

    // Sources-to-targets matrix. Useful for "which of these N stops is
    // closest by driving time" — kept as a hook, no consumer yet.
    static async getRouteMatrix(sources, targets, costing = 'auto') {
        return this.request('/route/matrix', {
            method: 'POST',
            body: JSON.stringify({ sources, targets, costing })
        });
    }
}

// WebSocket connection for real-time updates
class WebSocketClient {
    constructor() {
        this.ws = null;
        this.listeners = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        this.isConnected = false;
        // Staleness tracking: topic -> { timeout, timerId, callbacks }
        this.stalenessTrackers = new Map();
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.emit('connection', { status: 'connected' });
            };

            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.isConnected = false;
                this.emit('connection', { status: 'disconnected' });
                this.attemptReconnect();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.emit('connection', { status: 'error' });
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.emit(message.type, message.data);
                } catch (error) {
                    console.error('WebSocket message parse error:', error);
                }
            };
        } catch (error) {
            console.error('WebSocket connection error:', error);
            this.attemptReconnect();
        }
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('Max reconnect attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    on(type, callback) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        this.listeners.get(type).push(callback);
    }

    off(type, callback) {
        if (this.listeners.has(type)) {
            const callbacks = this.listeners.get(type);
            const index = callbacks.indexOf(callback);
            if (index > -1) {
                callbacks.splice(index, 1);
            }
        }
    }

    emit(type, data) {
        if (this.listeners.has(type)) {
            this.listeners.get(type).forEach(callback => callback(data));
        }
        // Reset staleness timer for this topic
        this.resetStalenessTimer(type);
    }

    // Register a staleness callback for a topic. When no data arrives for
    // `timeoutMs` the callback fires. Returns an unsubscribe function.
    // Default timeout is 30 seconds — long enough to avoid flickering
    // between periodic readings.
    onStale(type, callback, timeoutMs = 30000) {
        if (!this.stalenessTrackers.has(type)) {
            this.stalenessTrackers.set(type, { timeout: timeoutMs, timerId: null, callbacks: [] });
        }
        const tracker = this.stalenessTrackers.get(type);
        tracker.callbacks.push(callback);
        tracker.timeout = timeoutMs;
        // Start the timer immediately (data hasn't arrived yet)
        this.startStalenessTimer(type);
        return () => {
            const idx = tracker.callbacks.indexOf(callback);
            if (idx > -1) tracker.callbacks.splice(idx, 1);
            if (tracker.callbacks.length === 0) {
                clearTimeout(tracker.timerId);
                this.stalenessTrackers.delete(type);
            }
        };
    }

    resetStalenessTimer(type) {
        const tracker = this.stalenessTrackers.get(type);
        if (!tracker) return;
        clearTimeout(tracker.timerId);
        this.startStalenessTimer(type);
    }

    startStalenessTimer(type) {
        const tracker = this.stalenessTrackers.get(type);
        if (!tracker) return;
        tracker.timerId = setTimeout(() => {
            tracker.callbacks.forEach(cb => cb());
        }, tracker.timeout);
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        // Clear all staleness timers
        for (const [, tracker] of this.stalenessTrackers) {
            clearTimeout(tracker.timerId);
        }
        this.stalenessTrackers.clear();
    }
}

// Export singleton instances
export { API, AuthStore };
export const wsClient = new WebSocketClient();
