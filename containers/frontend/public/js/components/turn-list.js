// Route setup + turn-list panel. One component, three states:
//
//   1. "setup"   — user just triggered a route to somewhere; needs to pick
//                  or confirm a starting point. Renders From/To fields, a
//                  Go button, and a search-for-origin dropdown.
//   2. "loading" — route request is in flight; renders a spinner.
//   3. "trip"    — route received; renders summary + turn-by-turn steps.
//
// Also exposes a persistent close/dismiss affordance in the header and
// hooks ESC to trigger it.
//
// Events emitted (subscribe via on(event, fn)):
//   'close'          — user closed / cleared the route
//   'origin-search'  — user typed >=2 chars in the origin field
//                      payload: { query: string }
//   'origin-chosen'  — user selected an origin
//                      payload: { origin: {lat, lon, name} }
//   'route-confirm'  — user pressed Go with a valid origin+destination
//                      payload: { origin, destination }
//   'maneuver-click' — user tapped a step in the turn list
//                      payload: (maneuver, index)

// Costing modes match the whitelist in the backend proxy. Icon-per-mode
// so the segmented control reads at a glance.
const COSTING_MODES = [
    { id: 'auto',       label: 'Drive',   svg: '<rect x="1" y="6" width="22" height="12" rx="2"></rect><circle cx="6" cy="18" r="2"></circle><circle cx="18" cy="18" r="2"></circle>' },
    { id: 'truck',      label: 'RV',      svg: '<rect x="1" y="8" width="14" height="10"></rect><path d="M15 12h6l2 4v2h-8"></path><circle cx="5.5" cy="18.5" r="1.5"></circle><circle cx="18.5" cy="18.5" r="1.5"></circle>' },
    { id: 'bicycle',    label: 'Bike',    svg: '<circle cx="5.5" cy="17.5" r="3.5"></circle><circle cx="18.5" cy="17.5" r="3.5"></circle><path d="M15 6h3l-3.5 11.5-4-8L15 6z"></path>' },
    { id: 'pedestrian', label: 'Walk',    svg: '<circle cx="13" cy="4" r="2"></circle><path d="M9 20l3-6 4 2 2-4M9 13l4-3 3 2"></path>' }
];

const MANEUVER_TYPE = {
    0: 'None', 1: 'Start', 2: 'Start right', 3: 'Start left',
    4: 'Destination', 5: 'Destination right', 6: 'Destination left',
    8: 'Continue',
    9: 'Slight right', 10: 'Right', 11: 'Sharp right',
    12: 'U-turn right', 13: 'U-turn left',
    14: 'Sharp left', 15: 'Left', 16: 'Slight left',
    17: 'Ramp straight', 18: 'Ramp right', 19: 'Ramp left',
    20: 'Exit right', 21: 'Exit left',
    22: 'Stay straight', 23: 'Stay right', 24: 'Stay left',
    25: 'Merge', 26: 'Roundabout enter', 27: 'Roundabout exit',
    28: 'Ferry enter', 29: 'Ferry exit',
    36: 'Merge right', 37: 'Merge left'
};

function formatDurationMin(seconds) {
    if (typeof seconds !== 'number' || seconds < 0) return '';
    const min = Math.round(seconds / 60);
    if (min < 1) return '< 1 min';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function formatDistance(miles) {
    if (typeof miles !== 'number') return '';
    if (miles < 0.1) return `${Math.round(miles * 5280)} ft`;
    if (miles < 10) return `${miles.toFixed(1)} mi`;
    return `${Math.round(miles)} mi`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export class TurnList {
    constructor() {
        this.host = null;
        this.rootEl = null;
        this._trip = null;
        this._state = 'hidden';      // 'hidden' | 'setup' | 'loading' | 'trip' | 'error'
        this._destination = null;
        this._origin = null;         // {lat, lon, name} — may be 'gps' placeholder while awaiting
        this._gpsAvailable = false;
        this._costing = 'auto';      // one of COSTING_MODES below
        this._searchDebounceId = null;
        this._searchSeq = 0;
        this._listeners = {
            'close': [], 'origin-search': [], 'origin-chosen': [],
            'route-confirm': [], 'maneuver-click': [], 'go': []
        };
        this._escHandler = null;
        // Nav-mode state. `_flatManeuvers` is a flat list of every maneuver
        // across all legs (built during setTrip); `_navProgressIdx` advances
        // as GPS ticks come in so we can sum "time / distance remaining"
        // forward from the current position. `_navExpanded` controls whether
        // the compact ETA bar or the full trip view is showing.
        this._flatManeuvers = [];
        this._navProgressIdx = 0;
        this._navExpanded = false;
    }

    on(event, fn) {
        (this._listeners[event] || []).push(fn);
        return this;
    }

    _emit(event, ...args) {
        for (const fn of (this._listeners[event] || [])) {
            try { fn(...args); } catch (_) { /* isolate */ }
        }
    }

    mount(host) {
        this.host = host;
        this.host.innerHTML = `
            <aside class="turn-list turn-list--hidden" id="turn-list-root" role="complementary" aria-label="Directions">
                <div class="turn-list-header">
                    <div class="turn-list-title" id="turn-list-title">Directions</div>
                    <button type="button" class="turn-list-close" id="turn-list-close" aria-label="Close directions" title="Close (Esc)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
                <div class="turn-list-body" id="turn-list-body"></div>
            </aside>
        `;
        this.rootEl = host.querySelector('#turn-list-root');
        host.querySelector('#turn-list-close').addEventListener('click', () => {
            this._emit('close');
        });

        // Global ESC to close. Only active while panel is visible.
        this._escHandler = (ev) => {
            if (ev.key !== 'Escape') return;
            if (this._state === 'hidden') return;
            ev.preventDefault();
            this._emit('close');
        };
        document.addEventListener('keydown', this._escHandler);
    }

    // Called by the map-display component when it triggers a route from a
    // search result or long-press. If we already have a resolved origin
    // (GPS available), the caller can pass options.origin to skip the setup
    // step and go straight to loading — otherwise we show the picker.
    showSetup(destination, options = {}) {
        this._destination = destination;
        this._gpsAvailable = !!options.gpsAvailable;
        this._origin = options.origin || (this._gpsAvailable
            ? { lat: options.gpsLat, lon: options.gpsLon, name: 'Current Location', kind: 'gps' }
            : null);
        this._state = 'setup';
        this._render();
        this.rootEl.classList.remove('turn-list--hidden');
    }

    setLoading() {
        this._state = 'loading';
        this._render();
        if (this.rootEl) this.rootEl.classList.remove('turn-list--hidden');
    }

    setTrip(trip) {
        this._trip = trip;
        this._state = 'trip';
        // Flatten the maneuver list once per trip so nav-mode's per-tick
        // "remaining" computation is a cheap forward-sum instead of a
        // nested walk.
        this._flatManeuvers = [];
        (trip?.legs || []).forEach((leg) => {
            (leg.maneuvers || []).forEach((m) => this._flatManeuvers.push(m));
        });
        this._navProgressIdx = 0;
        this._navExpanded = false;
        this._render();
        if (this.rootEl) this.rootEl.classList.remove('turn-list--hidden');
    }

    // Move from "trip" (route preview) to "nav" (compact drawer with live
    // ETA / remaining metrics, tap-to-expand for the full step list + end
    // route). Called after the user taps Go in the preview drawer.
    setNav() {
        if (!this._trip) return;
        this._state = 'nav';
        this._navExpanded = false;
        this._render();
        if (this.rootEl) this.rootEl.classList.remove('turn-list--hidden');
    }

    // Called on each GPS tick while navigating. `idx` is the index into the
    // flattened maneuver list — sourced from next-maneuver-banner so both
    // components agree on progress. Updates the compact metrics in place
    // (no full re-render of the drawer).
    setNavProgress(idx) {
        if (this._state !== 'nav' || typeof idx !== 'number') return;
        if (idx === this._navProgressIdx) return;
        this._navProgressIdx = idx;
        this._updateNavMetrics();
    }

    setError(message) {
        this._state = 'error';
        this._errorMessage = message || 'Route request failed.';
        this._render();
        if (this.rootEl) this.rootEl.classList.remove('turn-list--hidden');
    }

    // Programmatic origin update — used by the map-display when the user
    // clicks a search result while the setup panel is open (or picks a
    // point from the map). Re-renders the setup form to reflect it.
    setOrigin(origin) {
        this._origin = origin;
        if (this._state === 'setup') this._render();
    }

    // Populate the origin search dropdown with backend results.
    setOriginSearchResults(results) {
        const dropdown = this.host?.querySelector?.('#tl-origin-results');
        if (!dropdown) return;
        if (!results || results.length === 0) {
            dropdown.innerHTML = '<li class="tl-origin-empty">No matches</li>';
            dropdown.hidden = false;
            return;
        }
        dropdown.innerHTML = results.map((r, i) => `
            <li class="tl-origin-result" data-idx="${i}">
                <div class="tl-origin-result-primary">${escapeHtml(r.place || r.display_name || '')}</div>
                <div class="tl-origin-result-secondary">${escapeHtml(r.display_name || '')}</div>
            </li>
        `).join('');
        dropdown.hidden = false;
        dropdown.querySelectorAll('.tl-origin-result').forEach((li) => {
            li.addEventListener('click', () => {
                const idx = parseInt(li.dataset.idx, 10);
                const r = results[idx];
                if (!r || typeof r.lat !== 'number' || typeof r.lon !== 'number') return;
                this._origin = {
                    lat: r.lat, lon: r.lon,
                    name: r.place || r.display_name, kind: 'search'
                };
                this._emit('origin-chosen', { origin: this._origin });
                // Auto-advance: user picked an origin, kick off the route.
                if (this._destination) {
                    this._emit('route-confirm', {
                        origin: this._origin,
                        destination: this._destination,
                        costing: this._costing
                    });
                }
                dropdown.hidden = true;
                this._render();
            });
        });
    }

    clear() {
        this._trip = null;
        this._destination = null;
        this._origin = null;
        this._state = 'hidden';
        this._flatManeuvers = [];
        this._navProgressIdx = 0;
        this._navExpanded = false;
        if (this.rootEl) {
            this.rootEl.classList.add('turn-list--hidden');
            this.rootEl.classList.remove('turn-list--nav', 'turn-list--nav-compact');
            const slot = this.rootEl.parentElement;
            if (slot) slot.classList.remove('turn-list-slot--nav-compact');
        }
    }

    destroy() {
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        if (this._searchDebounceId) clearTimeout(this._searchDebounceId);
        if (this.host) this.host.innerHTML = '';
        this.rootEl = null;
        this._trip = null;
        this._listeners = {
            'close': [], 'origin-search': [], 'origin-chosen': [],
            'route-confirm': [], 'maneuver-click': [], 'go': []
        };
    }

    // --- private -----------------------------------------------------------

    _render() {
        if (!this.host) return;
        const titleEl = this.host.querySelector('#turn-list-title');
        const bodyEl = this.host.querySelector('#turn-list-body');
        if (!titleEl || !bodyEl) return;

        if (this._state === 'setup') {
            titleEl.textContent = 'Directions';
            bodyEl.innerHTML = this._renderSetup();
            this._wireSetup(bodyEl);
        } else if (this._state === 'loading') {
            titleEl.textContent = 'Directions';
            bodyEl.innerHTML = `
                <div class="tl-loading">
                    <div class="tl-spinner"></div>
                    <div>Finding the best route…</div>
                </div>
            `;
        } else if (this._state === 'trip') {
            const summary = this._trip?.summary || {};
            titleEl.innerHTML = `
                <div class="turn-list-summary-primary">${formatDurationMin(summary.time)}</div>
                <div class="turn-list-summary-secondary">${formatDistance(summary.length)}</div>
            `;
            bodyEl.innerHTML = this._renderTripBody();
            this._wireTripBody(bodyEl);
            this.rootEl.classList.remove('turn-list--nav', 'turn-list--nav-compact');
            this._syncSlotClass();
        } else if (this._state === 'nav') {
            // Compact drawer has no header — the ETA row IS the header.
            // Expanded drawer reuses the metric row at the top of the body
            // so the tap-target chevron stays visible while scrolling.
            titleEl.textContent = '';
            bodyEl.innerHTML = this._renderNavBody();
            this._wireNavBody(bodyEl);
            this.rootEl.classList.add('turn-list--nav');
            this.rootEl.classList.toggle('turn-list--nav-compact', !this._navExpanded);
            this._syncSlotClass();
        } else if (this._state === 'error') {
            titleEl.textContent = 'Directions';
            bodyEl.innerHTML = `
                <div class="tl-error">
                    <div class="tl-error-msg">${escapeHtml(this._errorMessage || '')}</div>
                    <button type="button" class="tl-btn" id="tl-error-back">Change starting point</button>
                </div>
            `;
            const back = bodyEl.querySelector('#tl-error-back');
            if (back) back.addEventListener('click', () => {
                this._state = 'setup';
                this._render();
            });
        }
    }

    _renderSetup() {
        const dest = this._destination;
        const origin = this._origin;
        const originValue = origin ? escapeHtml(origin.name || 'Selected point') : '';
        const goEnabled = !!origin;
        return `
            <div class="tl-route-form">
                <div class="tl-row">
                    <label class="tl-label" for="tl-origin-input">
                        <span class="tl-dot tl-dot--origin"></span>From
                    </label>
                    ${origin
                        ? `<div class="tl-picked" id="tl-origin-picked">
                             <span>${originValue}</span>
                             <button type="button" class="tl-picked-clear" id="tl-origin-clear" aria-label="Change starting point">Change</button>
                           </div>`
                        : `<div class="tl-input-wrap">
                             <input type="text" class="tl-input" id="tl-origin-input"
                                    placeholder="Search a starting point..." autocomplete="off" />
                             <ul class="tl-origin-results" id="tl-origin-results" hidden></ul>
                           </div>`
                    }
                </div>
                <div class="tl-row">
                    <label class="tl-label">
                        <span class="tl-dot tl-dot--dest"></span>To
                    </label>
                    <div class="tl-picked">
                        <span>${escapeHtml(dest?.name || 'Selected point')}</span>
                    </div>
                </div>
                <div class="tl-row">
                    <label class="tl-label">Mode</label>
                    <div class="tl-mode-picker" role="radiogroup" aria-label="Route mode">
                        ${COSTING_MODES.map(m => `
                            <button type="button"
                                    class="tl-mode-btn${m.id === this._costing ? ' tl-mode-btn--active' : ''}"
                                    data-mode="${m.id}"
                                    role="radio"
                                    aria-checked="${m.id === this._costing}"
                                    aria-label="${m.label}"
                                    title="${m.label}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${m.svg}</svg>
                                <span>${m.label}</span>
                            </button>
                        `).join('')}
                    </div>
                </div>
                <button type="button" class="tl-btn tl-btn--go" id="tl-go" ${goEnabled ? '' : 'disabled'}>
                    Go
                </button>
                ${!this._gpsAvailable && !origin
                    ? `<div class="tl-hint">No vehicle GPS yet — type an address, or press Esc to cancel.</div>`
                    : ''
                }
            </div>
        `;
    }

    _wireSetup(bodyEl) {
        // Change/clear origin
        const clearBtn = bodyEl.querySelector('#tl-origin-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this._origin = null;
                this._render();
            });
        }

        // Origin search input
        const input = bodyEl.querySelector('#tl-origin-input');
        if (input) {
            input.focus();
            input.addEventListener('input', () => {
                const q = input.value.trim();
                if (this._searchDebounceId) clearTimeout(this._searchDebounceId);
                if (q.length < 2) {
                    const dropdown = bodyEl.querySelector('#tl-origin-results');
                    if (dropdown) { dropdown.hidden = true; dropdown.innerHTML = ''; }
                    return;
                }
                const seq = ++this._searchSeq;
                this._searchDebounceId = setTimeout(() => {
                    if (seq !== this._searchSeq) return;
                    this._emit('origin-search', { query: q });
                }, 300);
            });
        }

        // Mode picker — segmented control. Click updates _costing in place;
        // re-renders the picker so aria-checked stays in sync.
        bodyEl.querySelectorAll('.tl-mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (!mode || mode === this._costing) return;
                this._costing = mode;
                bodyEl.querySelectorAll('.tl-mode-btn').forEach((b) => {
                    const active = b.dataset.mode === mode;
                    b.classList.toggle('tl-mode-btn--active', active);
                    b.setAttribute('aria-checked', active ? 'true' : 'false');
                });
            });
        });

        // Go button
        const go = bodyEl.querySelector('#tl-go');
        if (go && this._origin && this._destination) {
            go.addEventListener('click', () => {
                this._emit('route-confirm', {
                    origin: this._origin,
                    destination: this._destination,
                    costing: this._costing
                });
            });
        }
    }

    _renderTripBody() {
        // Preview state (post-route, pre-Go): user is deciding whether to
        // commit. Prominent Go button pinned to the top of the body; the
        // header X still lets the user discard the route. Committing (Go)
        // hands off to the compact nav drawer via setNav().
        return `
            <div class="turn-list-actions">
                <button type="button" class="tl-btn tl-btn--go" id="tl-preview-go">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                    Go
                </button>
            </div>
            ${this._renderStepList()}
        `;
    }

    _wireTripBody(bodyEl) {
        const goBtn = bodyEl.querySelector('#tl-preview-go');
        if (goBtn) goBtn.addEventListener('click', () => {
            this._emit('go');
            this.setNav();
        });
        this._wireStepClicks(bodyEl);
    }

    // Nav body — compact when collapsed (metrics only, tap to expand),
    // full step list + End Route when expanded. The metric row's DOM ids
    // are stable so _updateNavMetrics can rewrite them without a rebuild
    // that would kill the current scroll position of the step list.
    _renderNavBody() {
        const metrics = this._computeRemaining();
        const metricsRow = `
            <div class="tl-nav-metrics" id="tl-nav-metrics">
                <div class="tl-nav-metric">
                    <div class="tl-nav-metric-value" id="tl-nav-eta">${escapeHtml(metrics.etaText)}</div>
                    <div class="tl-nav-metric-label">Arrival</div>
                </div>
                <div class="tl-nav-metric">
                    <div class="tl-nav-metric-value" id="tl-nav-time">${escapeHtml(metrics.timeText)}</div>
                    <div class="tl-nav-metric-label">Remaining</div>
                </div>
                <div class="tl-nav-metric">
                    <div class="tl-nav-metric-value" id="tl-nav-dist">${escapeHtml(metrics.distText)}</div>
                    <div class="tl-nav-metric-label">Distance</div>
                </div>
                <button type="button" class="tl-nav-toggle" id="tl-nav-toggle"
                        aria-label="${this._navExpanded ? 'Collapse directions' : 'Expand directions'}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
                        ${this._navExpanded
                            ? '<polyline points="6 15 12 9 18 15"></polyline>'
                            : '<polyline points="6 9 12 15 18 9"></polyline>'}
                    </svg>
                </button>
            </div>
        `;
        if (!this._navExpanded) return metricsRow;
        return `
            ${metricsRow}
            ${this._renderStepList()}
            <div class="turn-list-actions turn-list-actions--footer">
                <button type="button" class="tl-btn tl-btn--danger" id="tl-nav-end">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                    End Route
                </button>
            </div>
        `;
    }

    _wireNavBody(bodyEl) {
        // Whole compact drawer is a tap target (per user spec) — clicking
        // anywhere on the metric row expands the drawer. In expanded mode
        // the toggle button collapses it; the End Route button ends nav.
        const metricsRow = bodyEl.querySelector('#tl-nav-metrics');
        if (metricsRow && !this._navExpanded) {
            metricsRow.addEventListener('click', () => {
                this._navExpanded = true;
                this._render();
            });
        } else if (metricsRow) {
            // In expanded mode we only want the toggle chevron to collapse;
            // clicks elsewhere in the metric row shouldn't accidentally close
            // the drawer while the user is reading it.
            const toggle = bodyEl.querySelector('#tl-nav-toggle');
            if (toggle) toggle.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._navExpanded = false;
                this._render();
            });
        }
        const endBtn = bodyEl.querySelector('#tl-nav-end');
        if (endBtn) endBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._emit('close');
        });
        this._wireStepClicks(bodyEl);
    }

    // The .turn-list-slot's height is what actually reserves screen real
    // estate on mobile (55 % of viewport). To make compact nav shrink the
    // drawer to just the metric row, we mark the slot itself so its CSS
    // rule can drop it to auto-height. Kept in sync with every render so a
    // state transition never leaves a stale class.
    _syncSlotClass() {
        const slot = this.rootEl?.parentElement;
        if (!slot) return;
        slot.classList.toggle(
            'turn-list-slot--nav-compact',
            this._state === 'nav' && !this._navExpanded
        );
    }

    _updateNavMetrics() {
        if (this._state !== 'nav' || !this.host) return;
        const metrics = this._computeRemaining();
        const eta  = this.host.querySelector('#tl-nav-eta');
        const time = this.host.querySelector('#tl-nav-time');
        const dist = this.host.querySelector('#tl-nav-dist');
        if (eta)  eta.textContent  = metrics.etaText;
        if (time) time.textContent = metrics.timeText;
        if (dist) dist.textContent = metrics.distText;
    }

    _computeRemaining() {
        // Sum every maneuver from _navProgressIdx onward. Uses the same
        // fields Valhalla returns in trip.summary (time = seconds, length
        // = miles) so units line up with the rest of the routing UI.
        let secs = 0, miles = 0;
        for (let i = this._navProgressIdx; i < (this._flatManeuvers || []).length; i++) {
            const m = this._flatManeuvers[i];
            if (typeof m.time === 'number') secs += m.time;
            if (typeof m.length === 'number') miles += m.length;
        }
        const now = new Date();
        const eta = new Date(now.getTime() + secs * 1000);
        const etaText = eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return { etaText, timeText: formatDurationMin(secs), distText: formatDistance(miles) };
    }

    _renderStepList() {
        const maneuvers = this._flatManeuvers || [];
        return `
            <ol class="turn-list-steps" id="turn-list-steps">
                ${maneuvers.map((m, i) => {
                    const primary = escapeHtml(m.instruction || MANEUVER_TYPE[m.type] || 'Continue');
                    const streets = (m.street_names && m.street_names.length)
                        ? escapeHtml(m.street_names.join(' / '))
                        : '';
                    const dist = formatDistance(m.length);
                    const dur = formatDurationMin(m.time);
                    const passed = i < this._navProgressIdx ? ' turn-list-step--passed' : '';
                    return `
                        <li class="turn-list-step${passed}" data-idx="${i}">
                            <div class="turn-list-step-icon">${escapeHtml(String(i + 1))}</div>
                            <div class="turn-list-step-body">
                                <div class="turn-list-step-primary">${primary}</div>
                                ${streets ? `<div class="turn-list-step-secondary">${streets}</div>` : ''}
                                <div class="turn-list-step-meta">${dist} · ${dur}</div>
                            </div>
                        </li>
                    `;
                }).join('')}
            </ol>
        `;
    }

    _wireStepClicks(bodyEl) {
        bodyEl.querySelectorAll('.turn-list-step').forEach((li) => {
            li.addEventListener('click', () => {
                const idx = parseInt(li.dataset.idx, 10);
                const m = (this._flatManeuvers || [])[idx];
                if (m) this._emit('maneuver-click', m, idx);
            });
        });
    }
}
