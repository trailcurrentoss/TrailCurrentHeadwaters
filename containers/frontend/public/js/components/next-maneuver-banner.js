// Next-maneuver banner — floats at the top of the map while a route is
// active, showing the upcoming turn and how far away it is. Consumes the
// vehicle GPS stream (Bearing → MQTT → WebSocket → map-display's
// `handleLocationUpdate`) via `setPosition(lat, lon)`.
//
// Advancement heuristic: for each GPS tick compute haversine distance to
// the current maneuver's begin point. If we were close (< 50 m) and are
// now moving away, we passed it — advance to the next maneuver.
//
// Usage:
//   const banner = new NextManeuverBanner();
//   banner.mount(document.querySelector('#next-maneuver-slot'));
//   banner.setTrip(trip);                    // called when a route lands
//   banner.setPosition(lat, lon);            // called on every latlon tick
//   banner.clear();                          // called on route end
//   banner.destroy();

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same polyline6 decoder as route-overlay (kept local to avoid coupling).
function decodePolylinePoint(encoded, targetIndex) {
    const factor = 1e6;
    let index = 0, lat = 0, lng = 0, i = 0;
    while (index < encoded.length) {
        let b, shift = 0, result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);

        shift = 0; result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        lng += (result & 1) ? ~(result >> 1) : (result >> 1);

        if (i === targetIndex) return [lng / factor, lat / factor];
        i++;
    }
    return null;
}

// Distance thresholds tuned for automotive/RV navigation:
//   - < 50 m → we're on top of the maneuver; consider it "passed" the
//     moment distance starts increasing.
//   - Advancement never runs off the end of the maneuver list; the last
//     maneuver ("Arrive at destination") stays until the route is cleared.
const PASS_THRESHOLD_M = 50;

function formatDistance(meters) {
    if (meters == null || !Number.isFinite(meters)) return '';
    // Under 300 m: show feet (US convention — matches directions_options
    // units=miles set in the backend route request).
    const feet = meters * 3.28084;
    if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`;
    const miles = meters / 1609.344;
    if (miles < 10) return `${miles.toFixed(1)} mi`;
    return `${Math.round(miles)} mi`;
}

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

// Feature-detect the Web Speech API once at module load. Any modern browser
// (Chrome/Edge/Firefox/Safari) exposes it. Older/embedded WebViews may not.
const HAS_TTS = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && 'SpeechSynthesisUtterance' in window;

function speak(text) {
    if (!HAS_TTS || !text) return;
    try {
        // Cancel any queued utterances so we don't stack "Turn left" +
        // "Turn right" if maneuvers advance rapidly.
        window.speechSynthesis.cancel();
        const u = new window.SpeechSynthesisUtterance(text);
        u.rate = 1.0;
        u.pitch = 1.0;
        u.volume = 1.0;
        window.speechSynthesis.speak(u);
    } catch (_) { /* isolate */ }
}

function silence() {
    if (!HAS_TTS) return;
    try { window.speechSynthesis.cancel(); } catch (_) {}
}

function voiceEnabled() {
    try { return localStorage.getItem('tc.voiceGuidance') !== '0'; }
    catch (_) { return true; }   // default on
}

function setVoiceEnabled(on) {
    try { localStorage.setItem('tc.voiceGuidance', on ? '1' : '0'); } catch (_) {}
    if (!on) silence();
}

export class NextManeuverBanner {
    constructor() {
        this.host = null;
        this.rootEl = null;
        this._maneuvers = null;
        this._currentIdx = 0;
        this._lastDist = null;
    }

    mount(host) {
        this.host = host;
        this.host.innerHTML = `
            <div class="next-maneuver-banner" id="next-maneuver-banner" hidden aria-live="polite">
                <div class="next-maneuver-distance" id="nm-distance"></div>
                <div class="next-maneuver-text">
                    <div class="next-maneuver-instruction" id="nm-instruction"></div>
                    <div class="next-maneuver-detail" id="nm-detail"></div>
                </div>
                <button type="button" class="next-maneuver-voice" id="nm-voice"
                        aria-pressed="true" aria-label="Toggle voice guidance"
                        title="Toggle voice guidance">
                </button>
            </div>
        `;
        this.rootEl = host.querySelector('#next-maneuver-banner');
        const voiceBtn = this.host.querySelector('#nm-voice');
        if (voiceBtn) {
            const apply = () => {
                const on = voiceEnabled();
                voiceBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
                voiceBtn.classList.toggle('next-maneuver-voice--muted', !on);
                voiceBtn.innerHTML = on
                    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`
                    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
            };
            if (HAS_TTS) apply();
            else voiceBtn.hidden = true;
            voiceBtn.addEventListener('click', () => {
                setVoiceEnabled(!voiceEnabled());
                apply();
            });
        }
    }

    // Called by map-display when a route lands. Flattens the maneuver list
    // and pre-decodes each maneuver's begin coordinate so distance updates
    // are cheap on every GPS tick.
    setTrip(trip) {
        this._maneuvers = [];
        this._currentIdx = 0;
        this._lastDist = null;

        if (!trip || !Array.isArray(trip.legs)) {
            this._hide();
            return;
        }
        trip.legs.forEach((leg) => {
            const shape = leg.shape;
            if (!shape) return;
            (leg.maneuvers || []).forEach((m) => {
                const idx = m.begin_shape_index || 0;
                const pt = decodePolylinePoint(shape, idx);
                if (pt) {
                    this._maneuvers.push({
                        instruction: m.instruction || MANEUVER_TYPE[m.type] || 'Continue',
                        // Valhalla-supplied TTS-optimized text. Prefer these
                        // for spoken guidance; fall back to visual instruction.
                        verbal_pre: m.verbal_pre_transition_instruction || null,
                        verbal_alert: m.verbal_transition_alert_instruction || null,
                        verbal_post: m.verbal_post_transition_instruction || null,
                        street_names: m.street_names || [],
                        beginLon: pt[0],
                        beginLat: pt[1]
                    });
                }
            });
        });
        if (this._maneuvers.length === 0) {
            this._hide();
            return;
        }
        // Announce the first maneuver immediately (voice guidance) — user
        // hears "Head north on Main Street" as soon as the route lands.
        if (voiceEnabled()) {
            const first = this._maneuvers[0];
            speak(first.verbal_pre || first.instruction);
        }
        // Show the first maneuver even before we have GPS — the user gets
        // "Head <direction>" style guidance immediately.
        this._render(null);
    }

    // Advance state on each GPS tick. Handles the "we were close, now
    // moving away" pattern to detect passing a maneuver.
    setPosition(lat, lon) {
        if (!this._maneuvers || this._maneuvers.length === 0) return;
        const m = this._maneuvers[this._currentIdx];
        const dist = haversineMeters(lat, lon, m.beginLat, m.beginLon);

        // Advance criteria:
        //   - we were within PASS_THRESHOLD_M last tick
        //   - we're now further away than we were
        //   - there's a next maneuver to advance to
        if (this._lastDist != null
            && this._lastDist < PASS_THRESHOLD_M
            && dist > this._lastDist
            && this._currentIdx < this._maneuvers.length - 1) {
            this._currentIdx++;
            this._lastDist = null;
            const next = this._maneuvers[this._currentIdx];
            const nextDist = haversineMeters(lat, lon, next.beginLat, next.beginLon);
            // Voice: announce the newly-current maneuver. Uses Valhalla's
            // verbal_pre when available (built for TTS), instruction as fallback.
            if (voiceEnabled()) {
                speak(next.verbal_pre || next.instruction);
            }
            this._render(nextDist);
            return;
        }
        this._lastDist = dist;
        this._render(dist);
    }

    // Consumers (e.g. the compact navigation drawer) read this to compute
    // remaining time / distance by summing forward from _currentIdx across
    // the flat maneuver list — avoids duplicating advance logic.
    getCurrentManeuverIndex() {
        return this._currentIdx;
    }

    clear() {
        this._maneuvers = null;
        this._currentIdx = 0;
        this._lastDist = null;
        silence();       // stop any queued voice guidance when route ends
        this._hide();
    }

    destroy() {
        this.clear();
        if (this.host) this.host.innerHTML = '';
        this.rootEl = null;
    }

    _hide() {
        if (this.rootEl) this.rootEl.hidden = true;
    }

    _render(distMeters) {
        if (!this.rootEl || !this._maneuvers || this._maneuvers.length === 0) return;
        const m = this._maneuvers[this._currentIdx];
        this.rootEl.hidden = false;
        const distEl = this.host.querySelector('#nm-distance');
        const instrEl = this.host.querySelector('#nm-instruction');
        const detailEl = this.host.querySelector('#nm-detail');
        if (distEl) distEl.textContent = distMeters != null ? formatDistance(distMeters) : '—';
        if (instrEl) instrEl.textContent = m.instruction;
        if (detailEl) {
            detailEl.textContent = m.street_names.length
                ? m.street_names.join(' / ')
                : '';
        }
    }
}
