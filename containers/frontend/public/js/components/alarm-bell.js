// AlarmBell — shared state source for currently-active alarms + a rolling
// history buffer. Rendering is handled by AlertHost (js/shell/alert-host.js),
// which subscribes to this store and paints the three v02 surfaces:
//
//   1. Persistent banner across the top of #main-content (wide screens)
//   2. Persistent pill fixed to the top of the viewport (narrow screens)
//   3. Sidebar-footer bell + count badge (always accurate)
//
// Data flow: GET /api/alarms/active on start() for the initial snapshot,
// then WS `alarms_update` events drive updates. Emits `change` with
// { active, history } after each update.

import { API, wsClient } from '../api.js';

const HISTORY_MAX = 50;

export class AlarmBell extends EventTarget {
    constructor() {
        super();
        this.active = [];
        // Rolling history — most recent first. Each entry: { id, label, time }.
        // Populated when alarms leave the active list (Phase 6 side panel uses this).
        this.history = [];
        this._wsListener = null;
        this._started = false;
    }

    async start() {
        if (this._started) return;
        this._started = true;

        this._wsListener = (data) => {
            this._applyActive(data && data.active);
        };
        wsClient.on('alarms_update', this._wsListener);

        try {
            const snap = await API.getActiveAlarms();
            this._applyActive(snap && snap.active);
        } catch (err) {
            console.error('[AlarmBell] Failed to load active alarms:', err);
        }
    }

    getActive() { return this.active; }
    getHistory() { return this.history; }

    // Alias for backward compatibility with existing app.js call sites.
    destroy() { this.stop(); }

    stop() {
        if (this._wsListener) {
            wsClient.off('alarms_update', this._wsListener);
            this._wsListener = null;
        }
        this._started = false;
    }

    _applyActive(nextRaw) {
        const next = Array.isArray(nextRaw) ? nextRaw : [];
        const prevIds = new Set(this.active.map(a => a.id));
        const nextIds = new Set(next.map(a => a.id));

        // Any alarm that was active but no longer is → push to history.
        const cleared = this.active.filter(a => !nextIds.has(a.id));
        if (cleared.length) {
            const ts = new Date().toISOString();
            for (const a of cleared) {
                this.history.unshift({
                    id: a.id,
                    label: a.label || '',
                    time: ts,
                    cleared: true
                });
            }
            if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
        }

        // Fresh alarms → also push to history so the side-panel timeline shows
        // both fire and clear events.
        const fresh = next.filter(a => !prevIds.has(a.id));
        if (fresh.length) {
            const ts = new Date().toISOString();
            for (const a of fresh) {
                this.history.unshift({
                    id: a.id,
                    label: a.label || '',
                    time: ts,
                    cleared: false
                });
            }
            if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
        }

        this.active = next;
        this.dispatchEvent(new CustomEvent('change', {
            detail: { active: this.active, history: this.history }
        }));
    }
}

// Shared singleton — AppShell creates AlertHost pointing at this instance.
export const alarmBell = new AlarmBell();
