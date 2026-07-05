// Owns the top-level Camping / Driving / Storage mode.
//
// Camping = normal PWA: the router is in charge of what fills #main-content
// and the sidebar / bottom-nav are visible. Driving and Storage are dedicated
// full-screen dashboards that hide navigation entirely — the user switches
// back to Camping via the segmented control to get to Config / Deploy /
// Settings / etc.

const STORAGE_KEY = 'overlook.mode';
const MODES = ['camping', 'driving', 'storage'];

export class ModeController extends EventTarget {
    constructor() {
        super();
        this.mode = this._loadFromStorage();
    }

    _loadFromStorage() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved && MODES.includes(saved)) return saved;
        } catch (_) {}
        return 'camping';
    }

    getMode() {
        return this.mode;
    }

    setMode(mode) {
        if (!MODES.includes(mode) || mode === this.mode) return;
        this.mode = mode;
        try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
        this.dispatchEvent(new CustomEvent('change', { detail: { mode } }));
    }
}

export const modeController = new ModeController();
export const AVAILABLE_MODES = MODES;
