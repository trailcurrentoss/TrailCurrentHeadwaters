// Unit preferences — user picks speed (mph|kph) and temperature (F|C).
//
// Data flow: on boot the AppShell primes this service from GET /api/settings.
// Whenever the Settings page saves a new pref, it calls `updatePrefs({...})`.
// Consumers subscribe to `change` events on `units` and re-render.
//
// Raw data on the WebSocket bus is NEVER converted — it flows in the sensor's
// native units (Fahrenheit for climate; 100ths-of-a-knot for GNSS speed).
// Only DISPLAY converts, right at the call site. This means switching units
// is instant across the whole app without touching any subscription code.

const LS_KEY = 'overlook.units';
const DEFAULTS = { speed: 'mph', temperature: 'F', length: 'ft' };

// speedOverGround from CAN is in 100ths of a knot (see backend/mqtt.js and
// map-display.js for the same factor). One knot = 1.15078 mph = 1.852 kph.
const SPEED_UNIT_TO_MPH = 0.0115078;
const SPEED_UNIT_TO_KPH = 0.01852;
// Altitude is emitted in feet (`altitudeFeet` from `alt` topic). Meters
// conversion is exact: 1 ft = 0.3048 m.
const FEET_TO_METERS = 0.3048;

function _load() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return { ...DEFAULTS, ...parsed };
        }
    } catch (_) {}
    return { ...DEFAULTS };
}

function _save(prefs) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (_) {}
}

class Units extends EventTarget {
    constructor() {
        super();
        this.prefs = _load();
    }

    get speed() { return this.prefs.speed; }
    get temperature() { return this.prefs.temperature; }
    get length() { return this.prefs.length; }

    /**
     * Merge a partial prefs update ({ speed?, temperature? }) into the
     * current state, persist to localStorage, and emit `change` so
     * subscribing pages can re-render.
     */
    updatePrefs(patch) {
        const next = { ...this.prefs };
        if (patch.speed && ['mph', 'kph'].includes(patch.speed)) next.speed = patch.speed;
        if (patch.temperature && ['F', 'C'].includes(patch.temperature)) next.temperature = patch.temperature;
        if (patch.length && ['ft', 'm'].includes(patch.length)) next.length = patch.length;
        const changed = next.speed !== this.prefs.speed
                     || next.temperature !== this.prefs.temperature
                     || next.length !== this.prefs.length;
        this.prefs = next;
        _save(next);
        if (changed) this.dispatchEvent(new CustomEvent('change', { detail: { prefs: next } }));
    }

    /**
     * Prime the service from a fetched settings record (from GET /api/settings).
     * If the server-side values differ from what's cached, emit `change`.
     */
    primeFromSettings(settings) {
        if (!settings) return;
        const patch = {};
        if (settings.units_speed) patch.speed = settings.units_speed;
        if (settings.units_temperature) patch.temperature = settings.units_temperature;
        if (settings.units_length) patch.length = settings.units_length;
        if (Object.keys(patch).length) this.updatePrefs(patch);
    }

    // ── Formatters ──────────────────────────────────────────

    /**
     * Format a raw speedOverGround reading (100ths of a knot from CAN) to the
     * user's preferred unit as a rounded integer string (no unit suffix).
     * Returns '--' for null/NaN.
     */
    formatSpeed(raw) {
        if (raw === null || raw === undefined || Number.isNaN(raw)) return '--';
        const factor = this.prefs.speed === 'kph' ? SPEED_UNIT_TO_KPH : SPEED_UNIT_TO_MPH;
        return String(Math.round(raw * factor));
    }

    /** Suffix label ('mph' or 'kph'). */
    speedLabel() { return this.prefs.speed; }

    /**
     * Format a Fahrenheit reading (native climate/thermostat unit) to the
     * user's preferred unit as an integer string (no ° or unit suffix).
     * Returns '--' for null/NaN.
     */
    formatTemp(f) {
        if (f === null || f === undefined || Number.isNaN(f)) return '--';
        const converted = this.prefs.temperature === 'C' ? ((f - 32) * 5) / 9 : f;
        return String(Math.round(converted));
    }

    /** Suffix character with degree — '°F' or '°C'. */
    tempLabel() { return `°${this.prefs.temperature}`; }

    /**
     * Convert an F-native value to the user's preferred temperature unit
     * (returns a number, unrounded). For places that need to do further
     * arithmetic on the value (e.g., thermostat delta buttons).
     */
    tempToUser(f) {
        if (f === null || f === undefined || Number.isNaN(f)) return null;
        return this.prefs.temperature === 'C' ? ((f - 32) * 5) / 9 : f;
    }

    /** Convert a user-supplied value back to F for backend commands. */
    tempFromUser(v) {
        if (v === null || v === undefined || Number.isNaN(v)) return null;
        return this.prefs.temperature === 'C' ? (v * 9) / 5 + 32 : v;
    }

    /**
     * Format a feet reading (native GNSS `alt` topic unit) to the user's
     * preferred elevation unit. Independent from the speed preference so
     * the user can mix (e.g., mph + m if they want). Rounded, no suffix.
     */
    formatAltitude(feet) {
        if (feet === null || feet === undefined || Number.isNaN(feet)) return '--';
        const converted = this.prefs.length === 'm' ? feet * FEET_TO_METERS : feet;
        return String(Math.round(converted));
    }

    /** Suffix label ('ft' or 'm') from the elevation pref. */
    altitudeLabel() { return this.prefs.length; }
}

export const units = new Units();
