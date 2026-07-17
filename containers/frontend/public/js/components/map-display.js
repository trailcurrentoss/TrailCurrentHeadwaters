// Map display component using MapLibre GL JS for vector tiles
import { API, wsClient } from '../api.js';
import { units } from '../services/units.js';
import { gnssSimulator, LIVE_MARKER_COLOR, SIMULATED_MARKER_COLOR } from '../services/gnss-simulator.js';
import { RouteOverlay } from './route-overlay.js';
import { TurnList } from './turn-list.js';
import { NextManeuverBanner } from './next-maneuver-banner.js';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 2;

export class MapDisplay {
    constructor(containerId) {
        this.containerId = containerId;
        this.map = null;
        this.currentPosition = null;
        this.maplibreLoaded = false;
        this.wsHandler = null;
        this.wsGnssDetailsHandler = null;
        this.hasReceivedLocation = false;
        this.unsubStaleLatlon = null;
        this.unsubStaleGnss = null;
        this.followVehicle = true;
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
                        <button id="map-search-bounded" class="map-search-bounded" type="button"
                                aria-pressed="false" aria-label="Restrict search to current map view"
                                title="Restrict search to current map view">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                                <line x1="8" y1="12" x2="16" y2="12"></line>
                            </svg>
                        </button>
                        <button id="map-search-clear" class="map-search-clear" type="button" hidden aria-label="Clear search">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                    <ul id="map-search-results" class="map-search-results" hidden role="listbox"></ul>
                </div>
                <div id="location-info" class="location-info">
                    <span class="location-status">Waiting for GPS...</span>
                </div>
                <div class="map-controls">
                    <button id="locate-btn" class="map-btn" title="Center on current location">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M12 2v4m0 12v4m10-10h-4M6 12H2"></path>
                        </svg>
                    </button>
                    <button id="zoom-in-btn" class="map-btn" title="Zoom in">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                    <button id="zoom-out-btn" class="map-btn" title="Zoom out">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
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
            // Wire search-input events → /api/geocode/search. Must fire only
            // in the bundle-installed path — in the no-bundle path the input
            // is disabled by initNoMapDataState() and the geocode endpoint
            // returns 503, so there's no point attaching listeners.
            this.setupSearch();
        } catch (err) {
            console.error('[map] MapLibre/PMTiles init failed, falling back to no-data state:', err);
            this.initNoMapDataState();
        }
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
        const loadScript = (src) => new Promise((resolve, reject) => {
            // Reuse an existing tag if the script is already in the DOM
            // (defends against duplicate loads across page transitions).
            if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(s);
        });

        if (!document.querySelector('link[href="/libs/maplibre/maplibre-gl.css"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '/libs/maplibre/maplibre-gl.css';
            document.head.appendChild(link);
        }

        if (!window.maplibregl) {
            await loadScript('/libs/maplibre/maplibre-gl.js');
        }
        if (!window.pmtiles) {
            await loadScript('/libs/pmtiles/pmtiles.js');
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

        // Disable auto-follow when user manually pans
        this.map.on('dragstart', () => {
            this.followVehicle = false;
        });

        // Add location marker when map loads
        this.map.on('load', () => {
            this.addLocationLayers();
            this.setupRouting();
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
        this.map.on('click', () => {
            if (this._suppressNextMapClick) {
                this._suppressNextMapClick = false;
                return;
            }
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
        });
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

        // Search-result pin (populated when a user selects a search hit)
        this.map.addSource('search-result', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        this.map.addLayer({
            id: 'search-result-shadow',
            type: 'circle',
            source: 'search-result',
            paint: {
                'circle-radius': 10,
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
                'circle-radius': 9,
                'circle-color': '#e94b3c',
                'circle-stroke-width': 3,
                'circle-stroke-color': '#ffffff'
            }
        });
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
        const locateBtn = document.getElementById('locate-btn');
        const zoomInBtn = document.getElementById('zoom-in-btn');
        const zoomOutBtn = document.getElementById('zoom-out-btn');

        if (locateBtn) {
            locateBtn.addEventListener('click', () => this.centerOnLocation());
        }

        if (zoomInBtn) {
            zoomInBtn.addEventListener('click', () => {
                if (this.map) this.map.zoomIn();
            });
        }

        if (zoomOutBtn) {
            zoomOutBtn.addEventListener('click', () => {
                if (this.map) this.map.zoomOut();
            });
        }
    }

    setupSearch() {
        const input = document.getElementById('map-search-input');
        const clearBtn = document.getElementById('map-search-clear');
        const boundedBtn = document.getElementById('map-search-bounded');
        const resultsEl = document.getElementById('map-search-results');
        const searchEl = document.getElementById('map-search');
        if (!input || !resultsEl || !searchEl) return;

        // Restore + wire the "restrict to view" toggle. Persisted in
        // localStorage so a user who prefers bounded search doesn't have
        // to re-enable it every page load.
        try {
            this._searchBounded = localStorage.getItem('tc.mapSearchBounded') === '1';
        } catch (_) { this._searchBounded = false; }
        if (boundedBtn) {
            const apply = () => {
                boundedBtn.setAttribute('aria-pressed', this._searchBounded ? 'true' : 'false');
                boundedBtn.classList.toggle('map-search-bounded--active', !!this._searchBounded);
            };
            apply();
            boundedBtn.addEventListener('click', () => {
                this._searchBounded = !this._searchBounded;
                try { localStorage.setItem('tc.mapSearchBounded', this._searchBounded ? '1' : '0'); } catch (_) {}
                apply();
                // If a search is showing, re-run with the new mode so the
                // user sees the effect immediately.
                const q = input.value.trim();
                if (q.length >= SEARCH_MIN_CHARS) this.doSearch(q);
            });
        }

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

    async doSearch(q) {
        const seq = ++this.searchRequestSeq;
        let viewboxParam = '';
        if (this.map) {
            const b = this.map.getBounds();
            // Nominatim viewbox format: left,top,right,bottom (west,north,east,south)
            viewboxParam = `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
            // If the "restrict to view" toggle is on, also add bounded=1 so
            // Photon filters to strictly within the viewbox, not just bias
            // rank. Preference lives in localStorage under the map-search
            // namespace so it survives page reloads.
            if (this._searchBounded) {
                viewboxParam += '&bounded=1';
            }
        }
        try {
            const data = await API.request(
                `/geocode/search?q=${encodeURIComponent(q)}&limit=8${viewboxParam}`
            );
            // Ignore out-of-order responses
            if (seq !== this.searchRequestSeq) return;
            this.renderSearchResults(data && Array.isArray(data.results) ? data.results : []);
        } catch (err) {
            if (seq !== this.searchRequestSeq) return;
            this.renderSearchError();
        }
    }

    renderSearchResults(results) {
        const resultsEl = document.getElementById('map-search-results');
        if (!resultsEl) return;
        if (!results || results.length === 0) {
            resultsEl.innerHTML = '<li class="map-search-empty">No matches</li>';
            resultsEl.hidden = false;
            return;
        }
        resultsEl.innerHTML = results.map((r, i) => {
            const primary = this.primaryLabel(r);
            const secondary = this.secondaryLabel(r);
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
                    <button type="button" class="map-search-result-route" data-idx="${i}" aria-label="Directions to ${this.escapeHtml(primary)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </button>
                </li>
            `;
        }).join('');
        resultsEl.hidden = false;
        // Row click flies the camera and drops a pin (existing behavior).
        // The trailing "directions" button is a separate action that stops
        // propagation so it doesn't also fire the row click.
        resultsEl.querySelectorAll('.map-search-result').forEach((li) => {
            li.addEventListener('click', () => {
                const idx = parseInt(li.dataset.idx, 10);
                this.selectSearchResult(results[idx]);
            });
        });
        resultsEl.querySelectorAll('.map-search-result-route').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                const r = results[idx];
                if (!r || typeof r.lat !== 'number' || typeof r.lon !== 'number') return;
                this.selectSearchResult(r);   // pin the destination first
                this.computeAndShowRoute({
                    lat: r.lat, lon: r.lon, name: this.primaryLabel(r)
                });
            });
        });
    }

    renderSearchError() {
        const resultsEl = document.getElementById('map-search-results');
        if (!resultsEl) return;
        resultsEl.innerHTML = '<li class="map-search-empty">Search unavailable</li>';
        resultsEl.hidden = false;
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

    selectSearchResult(r) {
        if (!r || !this.map) return;
        this.followVehicle = false;
        this.updateSearchResultPin(r.lat, r.lon);

        // Fit to bbox when available (Nominatim returns [south, north, west, east]),
        // otherwise fly to point at zoom 15.
        if (r.bbox && r.bbox.length === 4) {
            const [south, north, west, east] = r.bbox;
            this.map.fitBounds([[west, south], [east, north]], {
                padding: 60, maxZoom: 17, duration: 700
            });
        } else {
            this.map.flyTo({ center: [r.lon, r.lat], zoom: 15, duration: 700 });
        }
        this.clearSearchResults();
        const input = document.getElementById('map-search-input');
        if (input) input.blur();
    }

    clearSearchResults() {
        const resultsEl = document.getElementById('map-search-results');
        if (resultsEl) {
            resultsEl.hidden = true;
            resultsEl.innerHTML = '';
        }
    }

    updateSearchResultPin(lat, lon) {
        if (!this.map) return;
        const source = this.map.getSource('search-result');
        if (!source) return;
        source.setData({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: {}
            }]
        });
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
        // Position at the click point. e.point is {x, y} within the map
        // container in pixels.
        const px = e.point;
        menuEl.style.left = `${px.x}px`;
        menuEl.style.top = `${px.y}px`;
        menuEl.hidden = false;

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
            this.followVehicle = false;
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
        this._offRouteStreak = 0;
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

        // Subscribe to GPS location updates
        wsClient.on('latlon', this.wsHandler);

        this.wsGnssDetailsHandler = (dataGnssDetails) => {
            this.handleGnssDetailsUpdate(dataGnssDetails);
        }
        wsClient.on('gnss_details',this.wsGnssDetailsHandler);

        this.unsubStaleLatlon = wsClient.onStale('latlon', () => {
            this.markLocationStale();
        });
        this.unsubStaleGnss = wsClient.onStale('gnss_details', () => {
            this.speed = null;
            this.heading = null;
            if (this.currentPosition) {
                this.currentPosition.speed = null;
                this.currentPosition.heading = null;
                this.updateLocationInfo(this.currentPosition.lat, this.currentPosition.lng, null, null);
            }
        });
    }

    markLocationStale() {
        const infoEl = document.getElementById('location-info');
        if (infoEl) {
            const statusEl = infoEl.querySelector('.location-status');
            if (statusEl) {
                statusEl.innerHTML = 'Waiting for GPS...';
            }
        }
    }

    handleGnssDetailsUpdate(dataGnssDetails) {
        if (this.currentPosition) {
            this.currentPosition.speed = dataGnssDetails.speedOverGround;
            this.currentPosition.heading = dataGnssDetails.courseOverGround;
        }
        this.speed = dataGnssDetails.speedOverGround;
        this.heading = dataGnssDetails.courseOverGround;
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
            accuracy: accuracy || null,
            speed: this.speed,
            heading: this.heading
        };

        // Update location on map
        if (this.map && this.map.loaded()) {
            this.updateLocationOnMap(latitude, longitude, accuracy);
        }

        // Center map on vehicle location when following
        if (this.followVehicle && this.map) {
            const zoom = isFirstPosition ? 15 : this.map.getZoom();
            this.map.easeTo({
                center: [longitude, latitude],
                zoom: zoom,
                duration: isFirstPosition ? 1000 : 500
            });
        }

        // Update location info display
        this.updateLocationInfo(latitude, longitude, this.speed, this.heading);

        // Push GPS tick into the next-maneuver banner if a route is active.
        // The banner handles its own no-op when no route is set — no need
        // to gate on route state here.
        if (this.nextManeuverBanner) {
            this.nextManeuverBanner.setPosition(latitude, longitude);
        }

        // Off-route recomputation. No-op if no route is active. Fires at
        // most once per 30 s and only after 3 consecutive off-route ticks
        // — see maybeRecomputeOffRoute for the guardrails.
        this.maybeRecomputeOffRoute(latitude, longitude);
    }

    updateLocationInfo(lat, lng, speed, heading) {
        const infoEl = document.getElementById('location-info');
        if (infoEl) {
            const statusEl = infoEl.querySelector('.location-status');
            if (statusEl) {
                let text = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
                text += ` <br /> ${units.formatSpeed(speed)} ${units.speedLabel()}`;
                statusEl.innerHTML = text;
                statusEl.classList.remove('error');
            }
        }
    }

    centerOnLocation() {
        if (this.currentPosition && this.map) {
            this.followVehicle = true;
            this.map.flyTo({
                center: [this.currentPosition.lng, this.currentPosition.lat],
                zoom: Math.max(this.map.getZoom(), 15),
                duration: 500
            });
        }
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

        // Remove WebSocket listener
        if (this.wsHandler) {
            wsClient.off('latlon', this.wsHandler);
            this.wsHandler = null;
        }

        // Remove Gnss Details WebSocket listener
        if (this.wsGnssDetailsHandler)  {
            wsClient.off('gnss_details',this.wsGnssDetailsHandler);
            this.wsGnssDetailsHandler = null;
        }

        if (this.unsubStaleLatlon) this.unsubStaleLatlon();
        if (this.unsubStaleGnss) this.unsubStaleGnss();

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
