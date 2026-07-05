// Trailer configuration prefs — currently just the axle count (1|2|3) which
// drives how many tire positions the Driving-mode trailer diagram renders.
// Follows the same EventTarget + primeFromSettings pattern as units.js.

const LS_KEY = 'overlook.trailer_config';
const DEFAULTS = { axles: 2 };  // tandem is the most common trailer type

const VALID_AXLES = [1, 2, 3];

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

class TrailerConfig extends EventTarget {
    constructor() {
        super();
        this.prefs = _load();
    }

    get axles() { return this.prefs.axles; }

    updatePrefs(patch) {
        const next = { ...this.prefs };
        if (patch.axles !== undefined) {
            const n = Number(patch.axles);
            if (VALID_AXLES.includes(n)) next.axles = n;
        }
        const changed = next.axles !== this.prefs.axles;
        this.prefs = next;
        _save(next);
        if (changed) this.dispatchEvent(new CustomEvent('change', { detail: { prefs: next } }));
    }

    primeFromSettings(settings) {
        if (!settings) return;
        if (settings.trailer_axles !== undefined) {
            this.updatePrefs({ axles: settings.trailer_axles });
        }
    }

    /** Human-readable label ("Single Axle", "Tandem Axle", "Triple Axle"). */
    axleLabel() {
        return ({ 1: 'Single Axle', 2: 'Tandem Axle', 3: 'Triple Axle' })[this.prefs.axles] || 'Tandem Axle';
    }
}

export const trailerConfig = new TrailerConfig();
export const AVAILABLE_AXLES = VALID_AXLES;
