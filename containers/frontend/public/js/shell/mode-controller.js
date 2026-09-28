// Owns the top-level Camping / Driving / Storage mode.
//
// Camping = normal PWA: the router is in charge of what fills #main-content
// and the sidebar / bottom-nav are visible. Driving and Storage are dedicated
// full-screen dashboards that hide navigation entirely — the user switches
// back to Camping via the segmented control to get to Config / Deploy /
// Settings / etc.
//
// RIG STATE, NOT A BROWSER PREFERENCE. The mode used to live only in
// localStorage, which made it per-browser. It is persisted rig-wide now and
// republished retained on local/mode/current, because panels act on it: a
// Capstan's alarm profile says what a given sensor means in each mode, and a
// dial on a nightstand cannot read a browser's localStorage.
//
// localStorage is kept, demoted to a cache: it paints the right dashboard on
// the very first frame, before the config fetch lands, and it is the fallback
// when the backend is unreachable. The server's value wins whenever there is
// one.

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

    _cache(mode) {
        try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
    }

    getMode() {
        return this.mode;
    }

    /**
     * Adopt a mode that came from the rig — the initial config fetch, or a
     * mode_changed broadcast from another browser. Does NOT write back to the
     * server: that would turn every broadcast into a round trip and, with two
     * tabs open, a loop.
     */
    applyRemoteMode(mode) {
        if (!MODES.includes(mode) || mode === this.mode) return;
        this.mode = mode;
        this._cache(mode);
        this.dispatchEvent(new CustomEvent('change', { detail: { mode } }));
    }

    /**
     * The user picked a mode here. Switches the UI immediately and persists
     * in the background — the dashboards are local and should not wait on the
     * network. A failed save is logged and left alone rather than reverted:
     * yanking the view out from under someone who just chose it is worse than
     * a mode that is briefly only local, and the next successful change or
     * page load reconciles it.
     */
    setMode(mode) {
        if (!MODES.includes(mode) || mode === this.mode) return;
        this.mode = mode;
        this._cache(mode);
        this.dispatchEvent(new CustomEvent('change', { detail: { mode } }));

        import('../api.js')
            .then(({ API }) => API.updateRigMode(mode))
            .catch(err => console.error('[Mode] Failed to persist rig mode:', err));
    }
}

export const modeController = new ModeController();
export const AVAILABLE_MODES = MODES;
