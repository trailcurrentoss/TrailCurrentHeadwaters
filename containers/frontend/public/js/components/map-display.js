// Map display component using MapLibre GL JS for vector tiles
import { API, wsClient } from '../api.js';
import { gnssSimulator, LIVE_MARKER_COLOR, SIMULATED_MARKER_COLOR } from '../services/gnss-simulator.js';
import { RouteOverlay } from './route-overlay.js';
import { TurnList } from './turn-list.js';
import { NextManeuverBanner } from './next-maneuver-banner.js';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 2;

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export class MapDisplay {
    constructor(containerId) {
        this.containerId = containerId;
        this.map = null;
        this.currentPosition = null;
        this.maplibreLoaded = false;
        this.wsHandler = null;
        this.hasReceivedLocation = false;
        // Camera tracking mode — Apple-Maps style cycle driven by the
        // single locate/track button. `'free'` is entered by a user pan;
        // taps cycle between the two active modes. See setTrackingMode /
        // cycleTrackingMode for the state machine.
        this.trackingMode = 'heading-up';
        this.currentHeading = null; // degrees, from gnss_details.courseOverGround
        this.gnssDetailsHandler = null;
        this.searchDebounceId = null;
        this.searchRequestSeq = 0;
        this.searchOutsideClickHandler = null;
        // Phase 4 — routing state
        this.routeOverlay = null;
        this.turnList = null;
        this.nextManeuverBanner = null;
        this.contextMenuTarget = null;   // {lat, lon} of last long-press
        this._contextMenuOutsideHandler = null;
        // Active-route memory for off-route recompute (Phase 4 follow-up).
        this._activeRoute = null;        // { destination, costing } — set on successful executeRoute
        this._lastRecomputeAt = 0;
        this._offRouteStreak = 0;        // consecutive off-route GPS ticks
        // Currently-displayed trail id (GPX overlay). Tracked so the map
        // page can persist it across route-mounted/unmounted cycles.
        this._activeTrailId = null;
        // Optional listeners the page module attaches to persist state
        // across navigation. onRouteChange fires with { destination, costing }
        // or null; onTrailChange fires with a trail id or null.
        this.onRouteChange = null;
        this.onTrailChange = null;
    }

    render() {
        return `
            <div class="map-wrapper">
                <div id="map-container" class="map-container">
                    <div class="map-loading">Loading map...</div>
                </div>
                <div class="map-search" id="map-search">
                    <div class="map-search-input-wrapper">
                        <svg class="map-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <circle cx="11" cy="11" r="7"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        </svg>
                        <input type="text" id="map-search-input" class="map-search-input"
                            placeholder="Search places, addresses..." autocomplete="off"
                            spellcheck="false" enterkeyhint="search" />
                        <button id="map-search-clear" class="map-search-clear" type="button" hidden aria-label="Clear search">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                    <ul id="map-search-results" class="map-search-results" hidden role="listbox"></ul>
                </div>
                <div class="map-controls">
                    <button id="track-mode-btn" class="map-btn map-track-btn" type="button"
                            title="Tracking mode" aria-label="Tracking mode">
                    </button>
                    <!-- Dual-mode trail button: acts as "browse trails" when no
                         trail is loaded, "clear trail" once one is on the map.
                         The icon + title swap in _updateTrailButton(). -->
                    <button id="trail-btn" class="map-btn map-trail-btn" type="button"
                            data-mode="pick"
                            title="Browse trails" aria-label="Browse trails">
                    </button>
                </div>
                <!-- Trail picker drawer — opened by the map's trail button
                     when no trail is loaded. Bottom sheet on narrow screens,
                     side panel on wide screens (via CSS media queries). -->
                <div id="trail-picker" class="trail-picker" hidden>
                    <div class="trail-picker-handle" aria-hidden="true"></div>
                    <div class="trail-picker-header">
                        <span class="trail-picker-title">Load Trail</span>
                        <button id="trail-picker-close" class="trail-picker-close" type="button" aria-label="Close">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                    <div class="trail-picker-search-wrap">
                        <svg class="trail-picker-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <circle cx="11" cy="11" r="7"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        </svg>
                        <input type="text" id="trail-picker-search" class="trail-picker-search"
                               placeholder="Search trails..." autocomplete="off" spellcheck="false">
                    </div>
                    <ul id="trail-picker-list" class="trail-picker-list" role="listbox"></ul>
                </div>
                <!-- Long-press / right-click context menu: appears at the click
                     position with a single "Route to here" action. Populated
                     dynamically by onMapContextMenu(). -->
                <div id="map-context-menu" class="map-context-menu" hidden role="menu"></div>
                <!-- Turn-by-turn side panel host. Owned by the TurnList
                     component; hidden while empty. -->
                <div id="turn-list-slot" class="turn-list-slot"></div>
                <!-- Next-maneuver banner slot — persists at the top of the
                     map while a route is active, driven by vehicle GPS ticks. -->
                <div id="next-maneuver-slot"></div>
            </div>
        `;
    }

    async init() {
        // Two entry points depending on whether a map bundle is installed:
        //   no-bundle  → render the placeholder, wire up WebSocket, done.
        //   installed  → load MapLibre + PMTiles adapter, register protocol,
        //                init the map, wire theme-change listener, WebSocket.
        // We consult /api/maps/current so a device that gets a bundle uploaded
        // via the Maps page can render the map on the next page load without
        // any special case.
        this.setupWebSocket();

        let bundleInstalled = false;
        try {
            const resp = await API.getMapCurrent();
            bundleInstalled = resp && resp.status === 'installed';
        } catch (err) {
            console.warn('[map] /api/maps/current failed, assuming no bundle:', err);
        }

        if (!bundleInstalled) {
            this.initNoMapDataState();
            return;
        }

        try {
            await this.loadMapLibre();
            this.registerPmtilesProtocol();
            this.initMap();
            this.setupThemeListener();
        } catch (err) {
            console.error('[map] MapLibre/PMTiles init failed, falling back to no-data state:', err);
            this.initNoMapDataState();
            return;
        }

        // Overlay wiring is intentionally outside the map-init try/catch —
        // a failure here should NOT tear down the working map or disable
        // the search input. Wrap each independently so one broken button
        // handler can't break the other.
        try { this.setupControls(); }
        catch (err) { console.error('[map] setupControls failed:', err); }
        try { this.setupSearch(); }
        catch (err) { console.error('[map] setupSearch failed:', err); }
    }

    // Wire the pmtiles:// protocol into MapLibre. The pmtiles UMD bundle
    // creates a top-level `pmtiles` global; `Protocol` handles Range-based
    // reads against the static PMTiles file served by nginx.
    registerPmtilesProtocol() {
        if (this._pmtilesRegistered) return;
        if (!window.pmtiles || !window.maplibregl) {
            throw new Error('pmtiles or maplibregl not loaded');
        }
        const protocol = new window.pmtiles.Protocol();
        window.maplibregl.addProtocol('pmtiles', protocol.tile);
        this._pmtilesRegistered = true;
    }

    // Watch for data-theme flips on <html>. The button in app-shell.js
    // toggles the attribute, which used to require a full page reload
    // to switch the map style. MutationObserver + setStyle gives us
    // instant swaps.
    setupThemeListener() {
        if (this._themeObserver) return;
        this._themeObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName === 'data-theme') {
                    this.applyThemeStyle();
                    return;
                }
            }
        });
        this._themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }

    // Swap the MapLibre style JSON to match the current data-theme without
    // tearing down the map (preserves camera, layers we added, etc.).
    applyThemeStyle() {
        if (!this.map) return;
        const styleUrl = this.currentStyleUrl();
        // Preserve our added sources/layers (user-location, search-result)
        // across the style change — MapLibre wipes them when setStyle runs.
        // Re-add them on the next `style.load` event.
        this.map.once('style.load', () => {
            this.addLocationLayers();
        });
        this.map.setStyle(styleUrl);
    }

    currentStyleUrl() {
        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        const styleName = theme === 'dark' ? '3d-dark' : '3d';
        return `/maps-static/styles/${styleName}/style.json`;
    }

    initNoMapDataState() {
        const container = document.getElementById('map-container');
        if (container) {
            container.innerHTML = `
                <div class="map-no-data">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0 0 21 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7"></path>
                    </svg>
                    <h3>Map Data not Loaded</h3>
                    <p>This device does not have a map bundle installed.</p>
                </div>
            `;
        }
        const controls = document.querySelector('.map-controls');
        if (controls) controls.style.display = 'none';
        const searchInput = document.getElementById('map-search-input');
        if (searchInput) {
            searchInput.disabled = true;
            searchInput.placeholder = 'Search unavailable — no map data loaded';
        }
    }

    async loadMapLibre() {
        if (this.maplibreLoaded && window.pmtiles) return;

        // Load MapLibre CSS + JS + PMTiles adapter. Order matters:
        // pmtiles registers into maplibregl.addProtocol at map-init time,
        // so both scripts must be present before initMap runs.
        //
        // Reuses an existing <script> tag if one is already in the DOM,
        // but waits for its `load` event (or checks a `data-loaded` marker
        // for tags that finished earlier). Naive `if (tag) resolve()`
        // returns while the script is still executing, which lets a
        // second MapDisplay instance race past into initMap with the
        // globals still undefined — exactly what happens when
        // initAuthenticatedApp navigates twice at boot.
        const loadScript = (src) => new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                if (existing.dataset.loaded === '1') return resolve();
                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error',
                    () => reject(new Error(`Failed to load ${src}`)), { once: true });
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => { s.dataset.loaded = '1'; resolve(); };
            s.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(s);
        });

        // Poll until a global appears. Even after `load` fires, some UMD
        // bundles set their global in a microtask; a second pass through
        // the event loop lets that settle before initMap reads it.
        const waitForGlobal = async (name, timeoutMs = 5000) => {
            const start = Date.now();
            while (typeof window[name] === 'undefined') {
                if (Date.now() - start > timeoutMs) {
                    throw new Error(`${name} script loaded but global never appeared`);
                }
                await new Promise(r => setTimeout(r, 25));
            }
        };

        if (!document.querySelector('link[href="/libs/maplibre/maplibre-gl.css"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '/libs/maplibre/maplibre-gl.css';
            document.head.appendChild(link);
        }

        if (!window.maplibregl) {
            await loadScript('/libs/maplibre/maplibre-gl.js');
            await waitForGlobal('maplibregl');
        }
        if (!window.pmtiles) {
            await loadScript('/libs/pmtiles/pmtiles.js');
            await waitForGlobal('pmtiles');
        }
        this.maplibreLoaded = true;
    }

    initMap() {
        const container = document.getElementById('map-container');
        if (!container || !window.maplibregl) return;

        // Clear loading message
        container.innerHTML = '';

        // Default center (roughly center of North America)
        const defaultCenter = [-98.5795, 39.8283]; // MapLibre uses [lng, lat]
        const defaultZoom = 4;

        // Style JSON is a static asset baked into the frontend container.
        // The `pmtiles://` source URL inside the JSON is resolved by the
        // adapter we registered in registerPmtilesProtocol.
        const styleUrl = this.currentStyleUrl();

        // Initialize the map
        this.map = new maplibregl.Map({
            container: 'map-container',
            style: styleUrl,
            center: defaultCenter,
            zoom: defaultZoom,
            attributionControl: false
        });

        // Add attribution control
        this.map.addControl(new maplibregl.AttributionControl({
            compact: true,
            customAttribution: '© OpenStreetMap contributors'
        }));

        // Manual pan drops the camera into `free` (overridden) mode.
        // The tracking button reflects this immediately via the
        // updateTrackModeButton() call inside setTrackingMode.
        this.map.on('dragstart', () => {
            if (this.trackingMode !== 'free') this.setTrackingMode('free');
        });

        // Add location marker when map loads. `_mapLoaded` is set here so
        // showTrail() (which can race against the load event) can tell
        // whether it's safe to add sources/layers immediately vs. defer
        // until this callback runs.
        this._mapLoaded = false;
        this.map.on('load', () => {
            this._mapLoaded = true;
            this.addLocationLayers();
            this.setupRouting();
            if (this._pendingTrail) this._applyPendingTrail();
        });

        // React to Simulate Location toggle at runtime — recolor the dot
        // without waiting for the next fix so the switch feels immediate.
        this._simUnsub = gnssSimulator.onChange(() => this.applyLocationMarkerColor());

        // Right-click on desktop fires MapLibre's contextmenu event, so that
        // path stays. Touch long-press on mobile does NOT — iOS Safari never
        // emits a native contextmenu from a touch hold, and Android is
        // inconsistent. Detect the long-press ourselves from touchstart /
        // touchmove / touchend below.
        this.map.on('contextmenu', (e) => this.onMapContextMenu(e));
        this.setupLongPress();
        // Any regular click on the map dismisses the context menu, unless it
        // is the trailing click generated by the touch we just interpreted as
        // a long-press (which would immediately hide the menu we just opened).
        this.map.on('click', (e) => {
            if (this._suppressNextMapClick) {
                this._suppressNextMapClick = false;
                return;
            }
            // Don't hide when the click landed on the context menu itself —
            // the menu's own button handler needs the DOM intact to run.
            const menuEl = document.getElementById('map-context-menu');
            const target = e && e.originalEvent && e.originalEvent.target;
            if (menuEl && !menuEl.hidden && target && menuEl.contains(target)) return;
            this.hideContextMenu();
        });
    }

    // Manual touch long-press detection. Fires onMapContextMenu after ~500ms
    // of a single stationary finger, mirroring the desktop right-click flow.
    // Cancelled by movement > 10 px, a second finger (pinch/rotate), or an
    // early lift.
    setupLongPress() {
        const LONG_PRESS_MS = 500;
        const MOVE_TOLERANCE_PX = 10;

        this._longPressTimer = null;
        this._longPressStart = null;
        this._suppressNextMapClick = false;

        const clear = () => {
            if (this._longPressTimer) {
                clearTimeout(this._longPressTimer);
                this._longPressTimer = null;
            }
            this._longPressStart = null;
        };

        this.map.on('touchstart', (e) => {
            const touches = (e.originalEvent && e.originalEvent.touches) || [];
            if (touches.length !== 1) { clear(); return; }
            this._longPressStart = e.point;
            this._longPressTimer = setTimeout(() => {
                this._longPressTimer = null;
                // Swallow the click that MapLibre synthesizes on the following
                // touchend so it doesn't immediately dismiss the menu.
                this._suppressNextMapClick = true;
                this.onMapContextMenu(e);
            }, LONG_PRESS_MS);
        });
        this.map.on('touchmove', (e) => {
            if (!this._longPressTimer || !this._longPressStart) return;
            const dx = e.point.x - this._longPressStart.x;
            const dy = e.point.y - this._longPressStart.y;
            if ((dx * dx + dy * dy) > (MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX)) clear();
        });
        this.map.on('touchend', clear);
        this.map.on('touchcancel', clear);
    }

    // Set up the routing overlay and the turn-list panel. Called once, after
    // MapLibre's `load` event fires so getSource/addLayer calls are safe.
    setupRouting() {
        this.routeOverlay = new RouteOverlay(this.map);
        this.routeOverlay.ensureLayers();

        this.nextManeuverBanner = new NextManeuverBanner();
        const bannerSlot = document.getElementById('next-maneuver-slot');
        if (bannerSlot) this.nextManeuverBanner.mount(bannerSlot);

        this.turnList = new TurnList();
        const slot = document.getElementById('turn-list-slot');
        if (slot) {
            this.turnList.mount(slot);
            this.turnList.on('close', () => this.clearRoute());
            this.turnList.on('maneuver-click', (m) => this.flyToManeuver(m));
            // "Go" pressed in the preview drawer. The drawer switches itself
            // to compact nav mode internally; on the map side we re-enable
            // vehicle-follow so the camera tracks GPS as the user drives.
            this.turnList.on('go', () => {
                // Default to heading-up when navigation starts — matches the
                // "start driving" affordance drivers expect. User can still
                // tap through to north-up.
                this.setTrackingMode('heading-up');
            });
            // The setup UI asks the user to pick an origin. Route the search
            // through the existing backend proxy and hand results back to
            // the panel to render its own dropdown.
            this.turnList.on('origin-search', async ({ query }) => {
                try {
                    const viewboxParam = this.map ? (() => {
                        const b = this.map.getBounds();
                        return `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
                    })() : '';
                    const data = await API.request(
                        `/geocode/search?q=${encodeURIComponent(query)}&limit=6${viewboxParam}`
                    );
                    this.turnList.setOriginSearchResults(
                        (data && Array.isArray(data.results)) ? data.results : []
                    );
                } catch (err) {
                    console.error('[route] origin search failed:', err);
                    this.turnList.setOriginSearchResults([]);
                }
            });
            // User confirmed origin + destination — actually run the route.
            // Costing defaults to 'auto' when not supplied (legacy callers).
            this.turnList.on('route-confirm', ({ origin, destination, costing }) => {
                this.executeRoute(origin, destination, costing || 'auto');
            });
        }

        // Re-attach the route sources after any setStyle (theme swap) — the
        // theme observer wipes sources when it calls setStyle, so we listen
        // for style.load and re-run ensureLayers + re-apply the current route.
        this.map.on('style.load', () => {
            if (this.routeOverlay) {
                this.routeOverlay.ensureLayers();
                const trip = this.routeOverlay.getTrip();
                if (trip) this.routeOverlay.setRoute(trip);
            }
            // Re-apply the pending trail after a theme swap wipes sources.
            if (this._pendingTrail) this._applyPendingTrail();
        });

        // Routing stack is now ready — kick a resume if the page seeded
        // one before GPS or routing were live.
        this._maybeResumeRoute();
    }

    addLocationLayers() {
        // Add a source for the user's location
        this.map.addSource('user-location', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });

        // Marker color reflects live vs. simulated GNSS. When the user toggles
        // "Simulate Location" in settings the layers restyle via
        // applyLocationMarkerColor() so the dot signals "not live data".
        const markerColor = gnssSimulator.getMarkerColor();

        // Add accuracy circle layer
        this.map.addLayer({
            id: 'user-accuracy',
            type: 'circle',
            source: 'user-location',
            paint: {
                'circle-radius': ['get', 'accuracy_radius'],
                'circle-color': markerColor,
                'circle-opacity': 0.15,
                'circle-stroke-width': 1,
                'circle-stroke-color': markerColor
            },
            filter: ['==', ['get', 'type'], 'accuracy']
        });

        // Add location dot layer
        this.map.addLayer({
            id: 'user-location-dot',
            type: 'circle',
            source: 'user-location',
            paint: {
                'circle-radius': 8,
                'circle-color': markerColor,
                'circle-stroke-width': 3,
                'circle-stroke-color': '#ffffff'
            },
            filter: ['==', ['get', 'type'], 'location']
        });

        // Add pulsing effect layer
        this.map.addLayer({
            id: 'user-location-pulse',
            type: 'circle',
            source: 'user-location',
            paint: {
                'circle-radius': 16,
                'circle-color': markerColor,
                'circle-opacity': 0.3
            },
            filter: ['==', ['get', 'type'], 'location']
        });

        // Search-result pins. One feature per result (up to 25); the
        // `selected` boolean property drives per-pin paint via `case`
        // expressions so the currently previewed row stands out without
        // needing a second source.
        this.map.addSource('search-result', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        this.map.addLayer({
            id: 'search-result-shadow',
            type: 'circle',
            source: 'search-result',
            paint: {
                'circle-radius': ['case', ['get', 'selected'], 12, 8],
                'circle-color': '#000',
                'circle-opacity': 0.25,
                'circle-translate': [0, 2]
            }
        });
        this.map.addLayer({
            id: 'search-result-pin',
            type: 'circle',
            source: 'search-result',
            paint: {
                'circle-radius': ['case', ['get', 'selected'], 11, 7],
                'circle-color': ['case', ['get', 'selected'], '#e94b3c', '#f4a58e'],
                'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
                'circle-stroke-color': '#ffffff'
            }
        });
    }

    // Trail overlay — a single polyline drawn in the trail's user-picked
    // color. Called by the Trails page via router deep-link (#map/trail/<id>).
    // Owns its own source ('trail-line') and layers ('trail-line-casing',
    // 'trail-line-main'). Only called AFTER `_mapLoaded` flips true inside
    // initMap's on('load') handler, so we can trust the style is ready
    // without gating on `isStyleLoaded()` — that method has quirks and
    // returns false transiently even after the load event has fired.
    _ensureTrailLayers() {
        if (!this.map) return false;
        if (this.map.getSource('trail-line')) return true;
        try {
            this.map.addSource('trail-line', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
            // Casing gives contrast against light basemap styles — matches
            // how route-overlay draws the routing line.
            this.map.addLayer({
                id: 'trail-line-casing',
                type: 'line',
                source: 'trail-line',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 8,
                    'line-opacity': 0.7
                }
            });
            this.map.addLayer({
                id: 'trail-line-main',
                type: 'line',
                source: 'trail-line',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': this._pendingTrail?.color || '#43a047',
                    'line-width': 5,
                    'line-opacity': 1.0
                }
            });
            return true;
        } catch (err) {
            console.error('[trail] failed to add trail source/layers:', err);
            return false;
        }
    }

    // geojson: server-parsed FeatureCollection with a `bbox` and a single
    // LineString feature (produced by the backend at upload time).
    // color:   hex string like '#a1b2c3'.
    // id:      optional trail id — persisted so the map page can restore
    //          the overlay after navigating away and back.
    showTrail(geojson, color, id = null) {
        this._pendingTrail = { geojson, color };
        this._activeTrailId = id || null;
        if (typeof this.onTrailChange === 'function') {
            try { this.onTrailChange(this._activeTrailId); } catch (_) {}
        }
        if (!this.map) return;
        // `_mapLoaded` flips to true inside initMap's on('load') handler.
        // If it's already true, apply immediately; otherwise leave the
        // pending state — the on('load') handler picks it up. Using a
        // class flag rather than `map.loaded()` because the latter also
        // requires all tiles to be idle, which may still be false long
        // after the style is loaded and ready for sources/layers.
        if (this._mapLoaded) this._applyPendingTrail();
    }

    _applyPendingTrail() {
        if (!this._pendingTrail || !this.map) return;
        const { geojson, color } = this._pendingTrail;

        const bbox = geojson && Array.isArray(geojson.bbox) ? geojson.bbox : null;
        if (!bbox || bbox.length !== 4) return;

        if (!this._ensureTrailLayers()) return;

        if (color) {
            try { this.map.setPaintProperty('trail-line-main', 'line-color', color); }
            catch (_) {}
        }
        const src = this.map.getSource('trail-line');
        if (!src) return;
        src.setData(geojson);

        // Drop out of vehicle-follow so the next GPS fix doesn't recenter
        // the camera on the vehicle and undo the fit-to-trail below. The
        // user can tap the recenter button to go back to tracking.
        this.setTrackingMode('free');

        const [w, s, e, n] = bbox;
        this.map.fitBounds([[w, s], [e, n]], {
            padding: { top: 100, bottom: 80, left: 60, right: 60 },
            maxZoom: 16,
            duration: 700
        });

        // Flip the map button into "clear trail" mode.
        this._updateTrailButton();
    }

    clearTrail() {
        this._pendingTrail = null;
        this._activeTrailId = null;
        if (this.map) {
            const src = this.map.getSource('trail-line');
            if (src) src.setData({ type: 'FeatureCollection', features: [] });
        }
        this._updateTrailButton();
        if (typeof this.onTrailChange === 'function') {
            try { this.onTrailChange(null); } catch (_) {}
        }
    }

    // Restyle the three user-location layers to reflect the current live vs.
    // simulated GNSS color. Safe to call before map load — bails out when the
    // layers aren't present yet.
    applyLocationMarkerColor() {
        if (!this.map) return;
        const color = gnssSimulator.getMarkerColor();
        const layers = [
            ['user-accuracy',      'circle-color'],
            ['user-accuracy',      'circle-stroke-color'],
            ['user-location-dot',  'circle-color'],
            ['user-location-pulse','circle-color'],
        ];
        for (const [layerId, prop] of layers) {
            if (this.map.getLayer(layerId)) {
                try { this.map.setPaintProperty(layerId, prop, color); } catch (_) {}
            }
        }
    }

    updateLocationOnMap(lat, lng, accuracy) {
        const source = this.map.getSource('user-location');
        if (!source) return;

        const features = [
            {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lng, lat]
                },
                properties: {
                    type: 'location'
                }
            }
        ];

        // Only add accuracy circle if we have accuracy data
        if (accuracy && accuracy > 0) {
            const metersPerPixel = this.getMetersPerPixel(lat);
            const accuracyRadius = accuracy / metersPerPixel;

            features.unshift({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lng, lat]
                },
                properties: {
                    type: 'accuracy',
                    accuracy_radius: Math.min(accuracyRadius, 100) // Cap at 100px
                }
            });
        }

        source.setData({
            type: 'FeatureCollection',
            features
        });
    }

    getMetersPerPixel(latitude) {
        const zoom = this.map.getZoom();
        return 156543.03392 * Math.cos(latitude * Math.PI / 180) / Math.pow(2, zoom);
    }

    setupControls() {
        const trackBtn = document.getElementById('track-mode-btn');
        if (trackBtn) {
            trackBtn.addEventListener('click', () => this.cycleTrackingMode());
        }
        this.updateTrackModeButton();

        // Dual-mode trail button. Behavior is driven off `_hasTrailLoaded`
        // (instance state) rather than a DOM data-attribute — dataset
        // reads can get out of sync with the class flag when the button
        // markup is re-rendered, but this instance boolean is the single
        // source of truth.
        const trailBtn = document.getElementById('trail-btn');
        if (trailBtn) {
            trailBtn.addEventListener('click', () => {
                if (this._hasTrailLoaded) this.clearTrail();
                else this.openTrailPicker();
            });
        }
        this._updateTrailButton();
        this._setupTrailPicker();
    }

    // Refresh the trail button's icon + title based on current overlay
    // state. Called after showTrail applies + after clearTrail wipes.
    _updateTrailButton() {
        const btn = document.getElementById('trail-btn');
        if (!btn) return;
        this._hasTrailLoaded = !!(this.map && this.map.getSource
            && this.map.getSource('trail-line')
            && this._pendingTrail);
        if (this._hasTrailLoaded) {
            btn.dataset.mode = 'clear';
            btn.title = 'Clear trail';
            btn.setAttribute('aria-label', 'Clear trail');
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true">
                    <path d="M4 20l4-8 4 4 4-10 4 14"></path>
                    <line x1="4" y1="4" x2="20" y2="20"></line>
                </svg>`;
        } else {
            btn.dataset.mode = 'pick';
            btn.title = 'Browse trails';
            btn.setAttribute('aria-label', 'Browse trails');
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true">
                    <path d="M4 20l4-8 4 4 4-10 4 14"></path>
                </svg>`;
        }
    }

    _setupTrailPicker() {
        const drawer = document.getElementById('trail-picker');
        const closeBtn = document.getElementById('trail-picker-close');
        const search = document.getElementById('trail-picker-search');
        const list = document.getElementById('trail-picker-list');
        if (!drawer || !closeBtn || !search || !list) return;

        closeBtn.addEventListener('click', () => this.closeTrailPicker());

        // Live search — filters the cached list; no debounce needed for
        // the ~dozens of trails a user typically has.
        search.addEventListener('input', () => this._renderTrailPickerList());

        // Row click via delegation — data-id carries the trail id.
        list.addEventListener('click', async (e) => {
            const li = e.target.closest('[data-id]');
            if (!li) return;
            const id = li.dataset.id;
            this.closeTrailPicker();
            await this._loadTrailById(id);
        });
    }

    async openTrailPicker() {
        const drawer = document.getElementById('trail-picker');
        const search = document.getElementById('trail-picker-search');
        const list = document.getElementById('trail-picker-list');
        if (!drawer || !list) return;

        // Fetch fresh list every open so a trail added in another tab
        // shows up immediately.
        list.innerHTML = '<li class="trail-picker-empty">Loading…</li>';
        drawer.hidden = false;
        try {
            this._trailPickerCache = await API.getTrails();
        } catch (err) {
            console.error('[trail-picker] failed to load trails:', err);
            this._trailPickerCache = [];
        }
        this._renderTrailPickerList();
        if (search) {
            search.value = '';
            // Auto-focus only on wide screens — on phones a focus() would
            // open the on-screen keyboard immediately, covering the list.
            if (window.matchMedia('(min-width: 900px)').matches) {
                setTimeout(() => search.focus(), 50);
            }
        }
    }

    closeTrailPicker() {
        const drawer = document.getElementById('trail-picker');
        if (drawer) drawer.hidden = true;
    }

    _renderTrailPickerList() {
        const list = document.getElementById('trail-picker-list');
        const search = document.getElementById('trail-picker-search');
        if (!list) return;
        const q = ((search && search.value) || '').trim().toLowerCase();
        const all = Array.isArray(this._trailPickerCache) ? this._trailPickerCache : [];
        const filtered = q
            ? all.filter(t => (t.name || '').toLowerCase().includes(q))
            : all;
        if (!filtered.length) {
            list.innerHTML = `<li class="trail-picker-empty">${
                all.length ? 'No trails match your search.' : 'No trails saved yet.'
            }</li>`;
            return;
        }
        list.innerHTML = filtered.map(t => {
            const name = escapeHtml(t.name || 'Untitled');
            const color = escapeHtml(t.color || '#888888');
            const pts = t.bounds?.pointCount
                ? `${t.bounds.pointCount.toLocaleString()} points`
                : '';
            return `
                <li class="trail-picker-row" data-id="${escapeHtml(t.id)}" role="option">
                    <span class="trail-picker-swatch" style="background:${color}"></span>
                    <span class="trail-picker-name">${name}</span>
                    <span class="trail-picker-meta">${pts}</span>
                </li>
            `;
        }).join('');
    }

    async _loadTrailById(id) {
        try {
            const meta = (this._trailPickerCache || []).find(t => t.id === id);
            const color = meta?.color || '#43a047';
            const geojson = await API.getTrailGeoJSON(id);
            this.showTrail(geojson, color, id);
        } catch (err) {
            console.error('[trail-picker] failed to load trail:', err);
        }
    }

    // Icon markup for each tracking mode. Kept as a static map so
    // updateTrackModeButton() is a single innerHTML swap.
    static TRACK_MODE_ICONS = {
        'free':
            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linejoin="round" aria-hidden="true">
                <polygon points="12 2 6 21 12 17 18 21 12 2"></polygon>
             </svg>`,
        'north-up':
            `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
                  stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
                <polygon points="12 3 8 11 12 9 16 11 12 3"></polygon>
                <text x="12" y="21" text-anchor="middle" font-size="9"
                      font-weight="700" font-family="inherit"
                      fill="currentColor" stroke="none">N</text>
             </svg>`,
        'heading-up':
            `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
                  stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
                <polygon points="12 2 6 21 12 17 18 21 12 2"></polygon>
             </svg>`,
    };

    static TRACK_MODE_TITLES = {
        'free': 'Not tracking — tap to follow',
        'north-up': 'Following, north-up',
        'heading-up': 'Following, heading-up',
    };

    updateTrackModeButton() {
        const btn = document.getElementById('track-mode-btn');
        if (!btn) return;
        const mode = this.trackingMode;
        btn.innerHTML = MapDisplay.TRACK_MODE_ICONS[mode] || MapDisplay.TRACK_MODE_ICONS['free'];
        btn.title = MapDisplay.TRACK_MODE_TITLES[mode] || '';
        btn.setAttribute('aria-label', btn.title);
        btn.classList.toggle('map-track-btn--active', mode !== 'free');
        btn.dataset.mode = mode;
    }

    // Tap-cycle used by the single tracking button. Apple-Maps semantics:
    //   free       → heading-up   (first tap after a manual pan)
    //   heading-up → north-up
    //   north-up   → heading-up
    // The `free` state is only entered by a user pan (see the dragstart
    // handler in initMap), never by tapping this button.
    cycleTrackingMode() {
        const next = this.trackingMode === 'heading-up' ? 'north-up' : 'heading-up';
        this.setTrackingMode(next);
    }

    // Apply a tracking mode. Handles the camera state that goes with it:
    // north-up resets bearing to 0; heading-up snaps to the last known
    // heading if we have one; free leaves the camera where the user put it.
    // Safe to call before the map is ready — the follow logic in
    // handleLocationUpdate/onHeadingUpdate reads trackingMode each tick.
    setTrackingMode(mode) {
        if (!['free', 'north-up', 'heading-up'].includes(mode)) return;
        this.trackingMode = mode;
        this.updateTrackModeButton();

        if (!this.map) return;

        if (mode === 'free') return;

        // Snap the camera to the appropriate follow pose. If we don't yet
        // have a fix, just fix the bearing so the map already looks right
        // when the first location arrives. Reset transform padding — a
        // preceding search-result fitBounds/easeTo leaves bottom-heavy
        // padding on the transform, which would otherwise push the follow
        // center toward the top of the screen.
        const opts = { duration: 400, padding: { top: 0, right: 0, bottom: 0, left: 0 } };
        if (mode === 'north-up') opts.bearing = 0;
        if (mode === 'heading-up' && Number.isFinite(this.currentHeading)) {
            opts.bearing = this.currentHeading;
        }
        if (this.currentPosition) {
            opts.center = [this.currentPosition.lng, this.currentPosition.lat];
            opts.zoom = Math.max(this.map.getZoom(), 15);
        }
        this.map.easeTo(opts);
    }

    setupSearch() {
        const input = document.getElementById('map-search-input');
        const clearBtn = document.getElementById('map-search-clear');
        const resultsEl = document.getElementById('map-search-results');
        const searchEl = document.getElementById('map-search');
        if (!input || !resultsEl || !searchEl) return;

        input.addEventListener('input', () => {
            const q = input.value.trim();
            clearBtn.hidden = q.length === 0;
            if (this.searchDebounceId) clearTimeout(this.searchDebounceId);
            if (q.length < SEARCH_MIN_CHARS) {
                this.clearSearchResults();
                return;
            }
            this.searchDebounceId = setTimeout(() => this.doSearch(q), SEARCH_DEBOUNCE_MS);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                input.value = '';
                clearBtn.hidden = true;
                this.clearSearchResults();
                input.blur();
            } else if (e.key === 'Enter') {
                // Fire the search immediately (bypass the debounce) and drop
                // focus so mobile's on-screen keyboard collapses — otherwise
                // the results drawer / "No results" message sits behind the
                // keyboard and the user can't see it.
                e.preventDefault();
                if (this.searchDebounceId) {
                    clearTimeout(this.searchDebounceId);
                    this.searchDebounceId = null;
                }
                const q = input.value.trim();
                if (q.length >= SEARCH_MIN_CHARS) this.doSearch(q);
                input.blur();
            }
        });

        input.addEventListener('focus', () => {
            const q = input.value.trim();
            if (q.length >= SEARCH_MIN_CHARS && resultsEl.children.length > 0) {
                resultsEl.hidden = false;
            }
        });

        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.hidden = true;
            this.clearSearchResults();
            this.clearSearchResultPin();
            input.focus();
        });

        this.searchOutsideClickHandler = (e) => {
            if (!searchEl.contains(e.target)) this.clearSearchResults();
        };
        document.addEventListener('click', this.searchOutsideClickHandler);
    }

    // Miles → km radii for the escalation ladder. Fixed steps keep the
    // widening predictable: try the current view; if empty, jump to 25 mi,
    // then 100 mi, then 300 mi, all anchored on the map's centre. Anything
    // beyond that gives up ("no results"). The visible view is tried first
    // so that when a user has framed exactly what they want, we respect it
    // and don't grab distant matches.
    static SEARCH_RADII_KM = [40, 161, 483];

    async doSearch(q) {
        const seq = ++this.searchRequestSeq;
        if (!this.map) {
            this.renderSearchResults([], { expanded: false });
            return;
        }
        const center = this.map.getCenter();
        const visible = this.map.getBounds();
        const attempts = [
            { west: visible.getWest(), east: visible.getEast(),
              north: visible.getNorth(), south: visible.getSouth(),
              expanded: false }
        ];
        for (const km of MapDisplay.SEARCH_RADII_KM) {
            attempts.push({ ...this.bboxAroundCenter(center, km), expanded: true });
        }
        // Final fallback: unbounded global search, still soft-biased toward
        // the current view via lat/lon on the backend. Handles cross-country
        // queries like searching "Chicago" from San Francisco.
        attempts.push({ expanded: true, unbounded: true });
        for (const a of attempts) {
            const url = `/geocode/search?q=${encodeURIComponent(q)}&limit=25`
                + (a.unbounded
                    ? ''
                    : `&viewbox=${a.west},${a.north},${a.east},${a.south}&bounded=1`);
            let data;
            try {
                data = await API.request(url);
            } catch (_) {
                if (seq !== this.searchRequestSeq) return;
                this.renderSearchError();
                return;
            }
            // Bail if the user typed something newer while we were escalating.
            if (seq !== this.searchRequestSeq) return;
            const results = data && Array.isArray(data.results) ? data.results : [];
            if (results.length > 0) {
                this.renderSearchResults(results, { expanded: a.expanded, anchor: center });
                return;
            }
        }
        this.renderSearchResults([], { expanded: false, anchor: center });
    }

    // Build a bounding box around (center.lat, center.lng) that spans
    // approximately radiusKm in every direction. Cosine correction keeps the
    // east/west spread honest at higher latitudes; the 0.05 floor guards
    // against a divide-by-tiny cos near the poles.
    bboxAroundCenter(center, radiusKm) {
        const latDelta = (radiusKm * 1000) / 111320;
        const lonDelta = latDelta / Math.max(0.05, Math.cos(center.lat * Math.PI / 180));
        return {
            west:  center.lng - lonDelta,
            east:  center.lng + lonDelta,
            north: center.lat + latDelta,
            south: center.lat - latDelta
        };
    }

    renderSearchResults(results, opts = {}) {
        const resultsEl = document.getElementById('map-search-results');
        if (!resultsEl) return;
        // Drawer chrome, both mobile-only via CSS: a drag-handle pill at the
        // top for affordance, and a close button in the top-right that
        // clears the input + pins + drawer (see `wireDrawerCloseButton`).
        const closeMarkup = '<li class="map-search-results-close-wrap" role="presentation">'
            + '<button type="button" class="map-search-results-close" aria-label="Close search results">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
            + '<line x1="18" y1="6" x2="6" y2="18"></line>'
            + '<line x1="6" y1="6" x2="18" y2="18"></line>'
            + '</svg></button></li>';
        const handleMarkup = '<li class="map-search-results-handle" aria-hidden="true"></li>';
        if (!results || results.length === 0) {
            resultsEl.innerHTML = closeMarkup + handleMarkup + '<li class="map-search-empty">No matches</li>';
            resultsEl.hidden = false;
            this._searchResults = [];
            this.updateSearchResultPins([], null);
            this.wireDrawerCloseButton(resultsEl);
            return;
        }
        // Sort anchor: prefer live GPS ("closest to me"), fall back to the
        // map's current center ("closest to what I'm looking at") so the list
        // is still meaningful before we get a fix. Same anchor drives the
        // distance chip when GPS is available.
        const gps = this.currentPosition;
        const hasGps = !!(gps && typeof gps.lat === 'number'
            && typeof (gps.lng ?? gps.lon) === 'number');
        const gpsLat = hasGps ? gps.lat : null;
        const gpsLon = hasGps ? (gps.lng ?? gps.lon) : null;
        let anchorLat = gpsLat, anchorLon = gpsLon;
        if (anchorLat == null && this.map) {
            const c = this.map.getCenter();
            anchorLat = c.lat; anchorLon = c.lng;
        }
        // Sort closest-first so the top of the list is the nearest result.
        // Rows missing coordinates fall to the bottom.
        if (anchorLat != null) {
            results = results.slice().sort((a, b) => {
                const aValid = typeof a.lat === 'number' && typeof a.lon === 'number';
                const bValid = typeof b.lat === 'number' && typeof b.lon === 'number';
                if (!aValid && !bValid) return 0;
                if (!aValid) return 1;
                if (!bValid) return -1;
                const da = this.haversineMeters(anchorLat, anchorLon, a.lat, a.lon);
                const db = this.haversineMeters(anchorLat, anchorLon, b.lat, b.lon);
                return da - db;
            });
        }
        // Keep the sorted list on the instance so preview-tap and pin-select
        // stay in sync without re-fetching.
        this._searchResults = results;

        resultsEl.innerHTML = closeMarkup + handleMarkup + results.map((r, i) => {
            const primary = this.primaryLabel(r);
            const secondary = this.secondaryLabel(r);
            const distanceMarkup = (hasGps && typeof r.lat === 'number' && typeof r.lon === 'number')
                ? `<div class="map-search-result-distance">${this.escapeHtml(
                        this.formatDistanceMeters(this.haversineMeters(gpsLat, gpsLon, r.lat, r.lon))
                    )}</div>`
                : '';
            // Approximate hint: when the query asked for a house number the
            // OSM data doesn't have, backend marks the result approximate.
            // Surface that honestly so the user doesn't get misled into
            // thinking the pin is precisely at "2625 Skokie Drive."
            const approxHint = r.approximate
                ? `<div class="map-search-result-approx" title="OSM doesn't have this exact address; pin is at street center">
                       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                           <circle cx="12" cy="12" r="10"></circle>
                           <line x1="12" y1="8" x2="12" y2="12"></line>
                           <line x1="12" y1="16" x2="12.01" y2="16"></line>
                       </svg>
                       Approximate — no exact match for ${this.escapeHtml(r.requested_housenumber || 'that number')}, showing street
                   </div>`
                : '';
            return `
                <li class="map-search-result${r.approximate ? ' map-search-result--approximate' : ''}" role="option" data-idx="${i}">
                    <svg class="map-search-result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M12 22s7-7.58 7-13a7 7 0 10-14 0c0 5.42 7 13 7 13z"></path>
                        <circle cx="12" cy="9" r="2.5"></circle>
                    </svg>
                    <div class="map-search-result-text">
                        <div class="map-search-result-primary">${this.escapeHtml(primary)}</div>
                        <div class="map-search-result-secondary">${this.escapeHtml(secondary)}</div>
                        ${approxHint}
                    </div>
                    ${distanceMarkup}
                    <button type="button" class="map-search-result-route" data-idx="${i}" aria-label="Directions to ${this.escapeHtml(primary)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </button>
                </li>
            `;
        }).join('');
        resultsEl.hidden = false;

        // Drop every result onto the map so the user can eyeball the spatial
        // spread before picking one. No pin is highlighted yet — the first
        // preview tap lights one up.
        this.updateSearchResultPins(results, null);
        this.wireDrawerCloseButton(resultsEl);
        // If matches were found inside the visible view (opts.expanded===false)
        // leave the camera exactly where it is — the user framed this spot for
        // a reason. Only re-fit when we had to widen; then frame the map
        // centre + the closest result so "how far away the nearest one is"
        // becomes visually obvious.
        if (opts.expanded && opts.anchor) {
            this.fitCameraToAnchorAndClosest(opts.anchor, results[0]);
        }

        // Row click previews (flies to the pin and highlights it) but keeps
        // the results card open. The trailing chevron is the commit action
        // — it hands off to routing and dismisses.
        resultsEl.querySelectorAll('.map-search-result').forEach((li) => {
            li.addEventListener('click', () => {
                const idx = parseInt(li.dataset.idx, 10);
                this.selectSearchResult(results[idx], idx);
            });
        });
        resultsEl.querySelectorAll('.map-search-result-route').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                const r = results[idx];
                if (!r || typeof r.lat !== 'number' || typeof r.lon !== 'number') return;
                this.selectSearchResult(r, idx);   // pin the destination first
                // Cancel any pending debounced search AND invalidate any
                // in-flight response — otherwise a stale search that lands
                // after this click re-populates the drawer and it looks
                // like our "close" didn't take.
                if (this.searchDebounceId) {
                    clearTimeout(this.searchDebounceId);
                    this.searchDebounceId = null;
                }
                this.searchRequestSeq++;
                this.clearSearchResults();
                // Take the browse pins off the map — the route overlay will
                // draw its own start/end markers and 25 stray dots on top
                // would just be visual noise.
                this.clearSearchResultPin();
                const input = document.getElementById('map-search-input');
                if (input) { input.value = ''; input.blur(); }
                const clearBtn = document.getElementById('map-search-clear');
                if (clearBtn) clearBtn.hidden = true;
                this.computeAndShowRoute({
                    lat: r.lat, lon: r.lon, name: this.primaryLabel(r)
                });
            });
        });
    }

    // Frame the map so that both the search anchor (map centre at the time
    // of the query) and the closest result are visible. Runs only when the
    // search had to escalate beyond the visible view — the point is to make
    // "how far away the nearest one is" visually obvious. Results farther
    // out stay pinned; the user can pan to see them.
    fitCameraToAnchorAndClosest(anchor, closest) {
        if (!this.map || !anchor || !closest) return;
        if (typeof closest.lat !== 'number' || typeof closest.lon !== 'number') return;
        const minLon = Math.min(anchor.lng, closest.lon);
        const maxLon = Math.max(anchor.lng, closest.lon);
        const minLat = Math.min(anchor.lat, closest.lat);
        const maxLat = Math.max(anchor.lat, closest.lat);
        this.setTrackingMode('free');
        const opts = {
            padding: this.cameraPaddingForResultsCard(),
            maxZoom: 15,
            duration: 700
        };
        // Preflight: MapLibre silently no-ops fitBounds when a small bbox
        // combined with a large mobile-drawer padding leaves no room for the
        // bounds to fit at any zoom. Fall back to flyTo the midpoint.
        const cam = this.map.cameraForBounds([[minLon, minLat], [maxLon, maxLat]], opts);
        if (cam) {
            this.map.easeTo({ ...cam, duration: 700 });
        } else {
            this.map.flyTo({
                center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
                zoom: 15,
                duration: 700,
                padding: opts.padding
            });
        }
    }

    renderSearchError() {
        const resultsEl = document.getElementById('map-search-results');
        if (!resultsEl) return;
        resultsEl.innerHTML = '<li class="map-search-results-close-wrap" role="presentation">'
            + '<button type="button" class="map-search-results-close" aria-label="Close search results">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
            + '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'
            + '</svg></button></li>'
            + '<li class="map-search-results-handle" aria-hidden="true"></li>'
            + '<li class="map-search-empty">Search unavailable</li>';
        resultsEl.hidden = false;
        this.wireDrawerCloseButton(resultsEl);
    }

    // Bind the drawer's top-right close button. Full reset of the search
    // surface: clear the input, dump the pins, hide the drawer. Called from
    // every render branch since the button lives inside the innerHTML we just
    // wrote (no persistent listener to reuse).
    wireDrawerCloseButton(resultsEl) {
        const btn = resultsEl.querySelector('.map-search-results-close');
        if (!btn) return;
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const input = document.getElementById('map-search-input');
            const clearBtn = document.getElementById('map-search-clear');
            if (input) { input.value = ''; input.blur(); }
            if (clearBtn) clearBtn.hidden = true;
            if (this.searchDebounceId) {
                clearTimeout(this.searchDebounceId);
                this.searchDebounceId = null;
            }
            this._searchResults = [];
            this.clearSearchResultPin();
            this.clearSearchResults();
        });
    }

    // Great-circle distance in metres. Small enough that we compute per row
    // during render — cheaper than pulling in a geo library for one call.
    haversineMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const toRad = (d) => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // Same thresholds as next-maneuver-banner.js so the units feel consistent
    // across the app (US convention — matches Valhalla units=miles).
    formatDistanceMeters(meters) {
        if (meters == null || !Number.isFinite(meters)) return '';
        const feet = meters * 3.28084;
        if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`;
        const miles = meters / 1609.344;
        if (miles < 10) return `${miles.toFixed(1)} mi`;
        return `${Math.round(miles)} mi`;
    }

    primaryLabel(r) {
        // First segment of display_name is typically the specific place name.
        if (!r.display_name) return '';
        const idx = r.display_name.indexOf(',');
        return idx === -1 ? r.display_name : r.display_name.slice(0, idx);
    }

    secondaryLabel(r) {
        if (!r.display_name) return '';
        const idx = r.display_name.indexOf(',');
        return idx === -1 ? '' : r.display_name.slice(idx + 1).trim();
    }

    escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Preview a result: highlight its pin and move the camera to it, but
    // leave the results card open and the input focused so the user can
    // keep scrolling and previewing other rows. Committing (routing / final
    // pick) is a separate action — see the chevron handler in renderSearchResults.
    selectSearchResult(r, idx) {
        if (!r || !this.map) return;
        this.setTrackingMode('free');
        // Re-emit all pins with the new selected index so the previous
        // highlight fades back to the muted color and this one lights up.
        if (typeof idx === 'number') this.setSelectedResultPin(idx);

        // Leave room at the bottom of the viewport for the mobile bottom
        // card, otherwise the pin lands behind it. On desktop the card
        // isn't repositioned, so bottom padding stays at the baseline.
        const padding = this.cameraPaddingForResultsCard();

        // Fit to bbox when available (Nominatim returns [south, north, west, east]),
        // otherwise fly to point at zoom 15. Preflight fitBounds with
        // cameraForBounds — for tiny bboxes (single POIs) combined with heavy
        // mobile drawer padding, MapLibre can't compute a valid camera and
        // silently no-ops; fall back to flyTo so the map still recenters.
        const fitOpts = { padding, maxZoom: 17, duration: 700 };
        let cam = null;
        if (r.bbox && r.bbox.length === 4) {
            const [south, north, west, east] = r.bbox;
            cam = this.map.cameraForBounds([[west, south], [east, north]], fitOpts);
        }
        if (cam) {
            this.map.easeTo({ ...cam, duration: 700 });
        } else {
            this.map.flyTo({
                center: [r.lon, r.lat],
                zoom: 17,
                duration: 700,
                padding
            });
        }
    }

    // Compute MapLibre camera padding that keeps a fitBounds / flyTo target
    // above whatever the results card is currently covering. Returns a
    // {top,bottom,left,right} object with a symmetric 60 px baseline plus
    // however much of the viewport the card actually occupies on the bottom.
    cameraPaddingForResultsCard() {
        const base = 60;
        const padding = { top: base, right: base, left: base, bottom: base };
        const resultsEl = document.getElementById('map-search-results');
        if (!resultsEl || resultsEl.hidden || !this.map) return padding;

        const cardRect = resultsEl.getBoundingClientRect();
        const mapRect = this.map.getContainer().getBoundingClientRect();
        // Identify the mobile bottom-sheet layout by the drawer's BOTTOM edge
        // aligning with the map's bottom edge (both anchored above the fixed
        // bottom nav via `bottom: calc(80px + safe-area)`). Checking the
        // drawer's TOP position instead breaks for tall drawers — with many
        // results the drawer can reach ~55 vh, pushing its top above the map
        // midpoint even though it's still a bottom sheet.
        const isBottomSheet = cardRect.bottom >= mapRect.bottom - 20;
        if (!isBottomSheet) return padding;

        const overlap = mapRect.bottom - cardRect.top;
        if (overlap <= 0) return padding;
        // Cap at 60% of map height so a nearly-full-screen drawer still
        // leaves a comfortable slot above it for the pin rather than
        // collapsing the un-padded region to a sliver.
        padding.bottom = base + Math.min(overlap, mapRect.height * 0.6);
        return padding;
    }

    clearSearchResults() {
        const resultsEl = document.getElementById('map-search-results');
        if (resultsEl) {
            resultsEl.hidden = true;
            resultsEl.innerHTML = '';
        }
    }

    // Push every result onto the map as a pin. `selectedIdx` (nullable)
    // marks one pin as the currently previewed row so paint expressions
    // can highlight it.
    updateSearchResultPins(results, selectedIdx) {
        if (!this.map) return;
        const source = this.map.getSource('search-result');
        if (!source) return;
        const features = (results || [])
            .filter(r => typeof r.lat === 'number' && typeof r.lon === 'number')
            .map((r, i) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
                properties: { idx: i, selected: i === selectedIdx }
            }));
        source.setData({ type: 'FeatureCollection', features });
    }

    // Change which pin is highlighted without rebuilding the whole feature
    // set. Used when the user taps a row to preview a different result.
    setSelectedResultPin(selectedIdx) {
        if (!this.map || !this._searchResults) return;
        this.updateSearchResultPins(this._searchResults, selectedIdx);
    }

    clearSearchResultPin() {
        if (!this.map) return;
        const source = this.map.getSource('search-result');
        if (source) source.setData({ type: 'FeatureCollection', features: [] });
    }

    // --- Routing (Phase 4) --------------------------------------------------

    // Long-press / right-click on the map. Shows a small floating menu at
    // the click position with a single "Route to here" action. Dismissed
    // by any subsequent click, escape, or route action.
    onMapContextMenu(e) {
        const menuEl = document.getElementById('map-context-menu');
        if (!menuEl) return;
        // Prevent the browser's native context menu on desktop right-click.
        if (e.originalEvent && typeof e.originalEvent.preventDefault === 'function') {
            e.originalEvent.preventDefault();
        }
        const { lng, lat } = e.lngLat;
        this.contextMenuTarget = { lat, lon: lng };

        menuEl.innerHTML = `
            <button type="button" class="map-context-menu-item" data-action="route">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
                <span>Route to here</span>
            </button>
        `;
        // Show first so getBoundingClientRect returns real dimensions, then
        // position horizontally centered on the tap and vertically above it
        // with a 20 px finger-clearance gap. Flip below the tap if there's
        // not enough room above.
        menuEl.hidden = false;
        const FINGER_GAP = 20;
        const px = e.point;
        const menuRect = menuEl.getBoundingClientRect();
        const mapRect = this.map.getContainer().getBoundingClientRect();
        let left = px.x - menuRect.width / 2;
        let top = px.y - menuRect.height - FINGER_GAP;
        // Clamp horizontally so the menu stays inside the map container.
        left = Math.max(4, Math.min(left, mapRect.width - menuRect.width - 4));
        // Flip below the tap when the tap is near the top edge.
        if (top < 4) top = px.y + FINGER_GAP;
        menuEl.style.left = `${left}px`;
        menuEl.style.top = `${top}px`;

        const btn = menuEl.querySelector('button[data-action="route"]');
        if (btn) {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const target = this.contextMenuTarget;
                this.hideContextMenu();
                if (target) this.computeAndShowRoute(target);
            });
        }

        // Dismiss on any click outside the menu. Delay attach so that on
        // touch, the click synthesized by the long-press's own touchend has
        // already fired and won't be caught by this handler.
        if (!this._contextMenuOutsideHandler) {
            this._contextMenuOutsideHandler = (ev) => {
                if (!menuEl.contains(ev.target)) this.hideContextMenu();
            };
            setTimeout(() => document.addEventListener('click', this._contextMenuOutsideHandler), 300);
        }
    }

    hideContextMenu() {
        const menuEl = document.getElementById('map-context-menu');
        if (menuEl) {
            menuEl.hidden = true;
            menuEl.innerHTML = '';
        }
        if (this._contextMenuOutsideHandler) {
            document.removeEventListener('click', this._contextMenuOutsideHandler);
            this._contextMenuOutsideHandler = null;
        }
    }

    // Entry point from search-result "Directions" button and long-press
    // "Route to here". Opens the route-setup UI in the turn-list panel.
    // If vehicle GPS is available, pre-fills "From: Current Location" so
    // the user can just tap Go. If not, the panel prompts for a starting
    // point via search — matching Apple/Google Maps behaviour.
    computeAndShowRoute(destination) {
        if (!destination || !this.turnList) return;

        // Existing `handleLocationUpdate` stores GPS as {lat, lng} (google-
        // style), but this file's routing code + Valhalla API use {lat, lon}.
        // Normalize here so downstream code sees a consistent {lat, lon}.
        const hasGps = !!(this.currentPosition
            && typeof this.currentPosition.lat === 'number'
            && typeof this.currentPosition.lng === 'number');

        this.turnList.showSetup(destination, {
            gpsAvailable: hasGps,
            gpsLat: hasGps ? this.currentPosition.lat : undefined,
            gpsLon: hasGps ? this.currentPosition.lng : undefined
        });

        // If GPS is available, kick off the route immediately — user still
        // sees a "Finding the best route…" state and can cancel via Esc or
        // the X button.
        if (hasGps) {
            const origin = {
                lat: this.currentPosition.lat,
                lon: this.currentPosition.lng,
                name: 'Current Location',
                kind: 'gps'
            };
            this.executeRoute(origin, destination);
        }
    }

    // Actually perform the /api/route call and render the result. Called
    // once we have BOTH origin and destination (either straight through
    // from computeAndShowRoute when GPS is available, or after the user
    // picks an origin from the setup UI). Costing chosen in the setup
    // picker; defaults to 'auto' when the caller doesn't specify.
    async executeRoute(origin, destination, costing = 'auto') {
        if (!origin || !destination || !this.routeOverlay || !this.turnList) return;
        this.turnList.setLoading();

        try {
            const resp = await API.getRoute([origin, destination], costing);
            if (!resp || !resp.trip || !Array.isArray(resp.trip.legs) || resp.trip.legs.length === 0) {
                this.turnList.setError('No route found between those two points.');
                return;
            }
            this.routeOverlay.setRoute(resp.trip);
            this.turnList.setTrip(resp.trip);
            if (this.nextManeuverBanner) this.nextManeuverBanner.setTrip(resp.trip);
            // Remember what we're routing to so off-route detection can
            // silently re-request from the current position.
            this._activeRoute = { destination, costing };
            this._lastRecomputeAt = Date.now();
            this._offRouteStreak = 0;
            // Route preview should show the whole trip, not follow — user
            // taps Go to start navigation, which re-enters heading-up.
            this.setTrackingMode('free');
            if (typeof this.onRouteChange === 'function') {
                try { this.onRouteChange({ destination, costing }); } catch (_) {}
            }
        } catch (err) {
            console.error('[route] request failed:', err);
            let msg = 'Route request failed.';
            const msgText = String(err?.message || '');
            if (/no-bundle|503/i.test(msgText)) {
                msg = 'Routing unavailable — no map data installed. Upload a bundle via the Maps page.';
            } else if (/valhalla unreachable|502/i.test(msgText)) {
                msg = 'Routing service is starting up — try again in a moment.';
            } else if (/timeout/i.test(msgText)) {
                msg = 'Routing timed out. The route may be too long or the device is under load.';
            }
            this.turnList.setError(msg);
        }
    }

    clearRoute() {
        if (this.routeOverlay) this.routeOverlay.clearRoute();
        if (this.turnList) this.turnList.clear();
        if (this.nextManeuverBanner) this.nextManeuverBanner.clear();
        this._activeRoute = null;
        this._pendingResumeRoute = null;
        this._offRouteStreak = 0;
        if (typeof this.onRouteChange === 'function') {
            try { this.onRouteChange(null); } catch (_) {}
        }
    }

    // Restore an active route across page navigation. Called by the map
    // page on re-entry when a route was previously running. Silent about
    // GPS/routing readiness — dispatch is deferred until both the routing
    // stack (setupRouting on map load) and a GPS fix are available.
    resumeRoute(route) {
        if (!route || !route.destination) return;
        this._pendingResumeRoute = { destination: route.destination, costing: route.costing || 'auto' };
        this._maybeResumeRoute();
    }

    _maybeResumeRoute() {
        if (!this._pendingResumeRoute) return;
        if (!this.routeOverlay || !this.turnList) return;
        const hasGps = !!(this.currentPosition
            && typeof this.currentPosition.lat === 'number'
            && typeof this.currentPosition.lng === 'number');
        if (!hasGps) return;
        const { destination, costing } = this._pendingResumeRoute;
        this._pendingResumeRoute = null;
        const origin = {
            lat: this.currentPosition.lat,
            lon: this.currentPosition.lng,
            name: 'Current Location',
            kind: 'gps'
        };
        this.executeRoute(origin, destination, costing);
    }

    // Minimum distance from (lat, lon) to any point on the current route.
    // Returns null when no route is active. O(N) in the number of shape
    // points — 6371-radius haversine per point. Cheap enough for a
    // once-per-GPS-tick check.
    distanceToActiveRoute(lat, lon) {
        if (!this.routeOverlay) return null;
        const shape = this.routeOverlay.getShapePoints();
        if (!shape || shape.length === 0) return null;
        const R = 6371000;
        const toRad = (d) => d * Math.PI / 180;
        const cosLat = Math.cos(toRad(lat));
        let best = Infinity;
        for (const [pLon, pLat] of shape) {
            // Approximate flat-earth for speed — accurate within ~1 m at
            // driving-scale distances.
            const dx = toRad(pLon - lon) * cosLat;
            const dy = toRad(pLat - lat);
            const d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
        }
        return Math.sqrt(best) * R;
    }

    // Off-route recomputation trigger. Called from handleLocationUpdate on
    // every GPS tick. Uses a small streak counter + cooldown so brief GPS
    // jitter or a legitimate detour that reconnects doesn't spam Valhalla.
    maybeRecomputeOffRoute(lat, lon) {
        if (!this._activeRoute) return;
        const OFF_ROUTE_M = 120;             // ~130 ft — beyond one lane width
        const STREAK_TRIGGER = 3;            // 3 consecutive off-route ticks
        const COOLDOWN_MS = 30_000;          // no more than one recompute per 30 s

        const dist = this.distanceToActiveRoute(lat, lon);
        if (dist === null) return;
        if (dist < OFF_ROUTE_M) {
            this._offRouteStreak = 0;
            return;
        }
        this._offRouteStreak++;
        if (this._offRouteStreak < STREAK_TRIGGER) return;
        if (Date.now() - this._lastRecomputeAt < COOLDOWN_MS) return;

        // Recompute from current position to the saved destination.
        console.log(`[route] off-route by ${Math.round(dist)} m; recomputing`);
        this._offRouteStreak = 0;
        this._lastRecomputeAt = Date.now();
        const origin = { lat, lon, name: 'Current Location', kind: 'gps' };
        this.executeRoute(origin, this._activeRoute.destination, this._activeRoute.costing);
    }

    // Jump to a maneuver's begin_shape_index position when the user taps
    // a step in the turn list. Best-effort: decodes the polyline for the
    // leg the maneuver lives in and flies to its start point.
    flyToManeuver(maneuver) {
        if (!this.map || !this.routeOverlay) return;
        const trip = this.routeOverlay.getTrip();
        if (!trip || !Array.isArray(trip.legs)) return;
        // Find which leg contains this maneuver. Valhalla nests maneuvers
        // per leg; we passed a flat click index so it's easier to search by
        // maneuver identity than reconstruct.
        for (const leg of trip.legs) {
            const list = leg.maneuvers || [];
            const found = list.find(m => m === maneuver);
            if (!found) continue;
            const shape = leg.shape;
            if (!shape) return;
            // Reuse the overlay's polyline decoder via a temporary decode.
            // Import it? Simplest: inline-decode just the point we need.
            const point = this._decodePolylinePoint(shape, maneuver.begin_shape_index || 0);
            if (point) {
                this.map.flyTo({ center: point, zoom: 16, duration: 600 });
            }
            return;
        }
    }

    // Minimal polyline6 decoder — pulls out the coordinate at `targetIndex`.
    // Same algorithm as route-overlay.js's decodePolyline; kept local to
    // avoid pulling a public helper out of that module.
    _decodePolylinePoint(encoded, targetIndex) {
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

    // --- End routing --------------------------------------------------------

    setupWebSocket() {
        // Listen for GPS/location updates from MQTT via WebSocket
        this.wsHandler = (data) => {
            this.handleLocationUpdate(data);
        };
        wsClient.on('latlon', this.wsHandler);

        // Course over ground arrives on the separate gnss_details channel.
        // Cache it so heading-up mode can rotate the map on the next
        // location tick without waiting for another gnss_details frame.
        this.gnssDetailsHandler = (data) => {
            if (data && Number.isFinite(data.courseOverGround)) {
                this.currentHeading = data.courseOverGround;
            }
        };
        wsClient.on('gnss_details', this.gnssDetailsHandler);
    }

    handleLocationUpdate(data) {
        const { latitude, longitude, accuracy } = data;

        if (latitude === undefined || longitude === undefined) {
            return;
        }

        const isFirstPosition = !this.hasReceivedLocation;
        this.hasReceivedLocation = true;

        this.currentPosition = {
            lat: latitude,
            lng: longitude,
            accuracy: accuracy || null
        };

        // Update location on map
        if (this.map && this.map.loaded()) {
            this.updateLocationOnMap(latitude, longitude, accuracy);
        }

        // Camera-follow. north-up and heading-up both center on the vehicle;
        // heading-up additionally rotates the map to the current course
        // (courseOverGround arrives on the separate gnss_details channel —
        // whichever value we have most recently is applied here).
        if (this.trackingMode !== 'free' && this.map) {
            const zoom = isFirstPosition ? 15 : this.map.getZoom();
            const opts = {
                center: [longitude, latitude],
                zoom,
                duration: isFirstPosition ? 1000 : 500,
                // Neutralize any leftover transform padding from search-result
                // camera moves so the vehicle sits at the geometric center.
                padding: { top: 0, right: 0, bottom: 0, left: 0 },
            };
            if (this.trackingMode === 'heading-up'
                    && Number.isFinite(this.currentHeading)) {
                opts.bearing = this.currentHeading;
            } else if (this.trackingMode === 'north-up') {
                opts.bearing = 0;
            }
            this.map.easeTo(opts);
        }

        // Push GPS tick into the next-maneuver banner if a route is active.
        // The banner handles its own no-op when no route is set — no need
        // to gate on route state here.
        if (this.nextManeuverBanner) {
            this.nextManeuverBanner.setPosition(latitude, longitude);
            // Mirror the banner's current-maneuver index into the compact
            // nav drawer so "remaining time / distance" ticks down as we
            // drive. Cheap DOM writes only when the index actually advances.
            if (this.turnList) {
                this.turnList.setNavProgress(this.nextManeuverBanner.getCurrentManeuverIndex());
            }
        }

        // Off-route recomputation. No-op if no route is active. Fires at
        // most once per 30 s and only after 3 consecutive off-route ticks
        // — see maybeRecomputeOffRoute for the guardrails.
        this.maybeRecomputeOffRoute(latitude, longitude);

        // If the page re-entered mid-route, this is the tick that lets
        // resumeRoute finally dispatch. No-op when nothing is pending.
        this._maybeResumeRoute();
    }

    // Kept for external callers (nothing inside this file uses it anymore —
    // the button routes through cycleTrackingMode instead). Re-enters
    // heading-up which is the default follow pose.
    centerOnLocation() {
        this.setTrackingMode('heading-up');
    }

    cleanup() {
        // Cancel any pending debounced search and invalidate in-flight responses
        if (this.searchDebounceId) {
            clearTimeout(this.searchDebounceId);
            this.searchDebounceId = null;
        }
        this.searchRequestSeq++;

        // Remove outside-click listener installed by setupSearch
        if (this.searchOutsideClickHandler) {
            document.removeEventListener('click', this.searchOutsideClickHandler);
            this.searchOutsideClickHandler = null;
        }

        // Remove WebSocket listeners
        if (this.wsHandler) {
            wsClient.off('latlon', this.wsHandler);
            this.wsHandler = null;
        }
        if (this.gnssDetailsHandler) {
            wsClient.off('gnss_details', this.gnssDetailsHandler);
            this.gnssDetailsHandler = null;
        }

        // Detach the simulator listener installed in initMap.
        if (this._simUnsub) {
            this._simUnsub();
            this._simUnsub = null;
        }

        // Stop watching data-theme; otherwise a stale observer keeps firing
        // setStyle on a destroyed map after the page navigates away.
        if (this._themeObserver) {
            this._themeObserver.disconnect();
            this._themeObserver = null;
        }

        // Tear down routing UI (context menu outside-click listener, then
        // the turn-list panel itself). The overlay's sources are owned by
        // the map so they go with map.remove() below.
        this.hideContextMenu();
        if (this.turnList) {
            this.turnList.destroy();
            this.turnList = null;
        }
        if (this.nextManeuverBanner) {
            this.nextManeuverBanner.destroy();
            this.nextManeuverBanner = null;
        }
        this.routeOverlay = null;
        this.contextMenuTarget = null;

        // Destroy map
        if (this.map) {
            this.map.remove();
            this.map = null;
        }

        this.currentPosition = null;
        this.hasReceivedLocation = false;
    }
}

