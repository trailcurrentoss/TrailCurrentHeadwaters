// Map page - Location tracking and map display
import { MapDisplay } from '../components/map-display.js';
import { API } from '../api.js';

let mapDisplay = null;

// Persist across cleanup so navigating away from the map (and back) does
// not wipe the active GPX overlay or the in-progress route. Cleared only
// when the user explicitly clears either — MapDisplay fires onTrailChange
// /onRouteChange with null for that.
let savedTrailId = null;
let savedRoute = null;   // { destination, costing }

export const mapPage = {
    render() {
        return `
            <section class="page-map">
                <h1 class="section-title">Location</h1>
                <div id="map-display-container">
                    <!-- Map will be rendered here -->
                </div>
            </section>
        `;
    },

    // subPath: '' for plain #map, 'trail/<id>' when entered from the
    // Trails page's Navigate button. The trail overlay is layered on
    // top of the normal map — GPS tracking, search, and routing all
    // continue to work.
    async init(subPath) {
        try {
            mapDisplay = new MapDisplay('map-display-container');
            mapDisplay.onTrailChange = (id) => { savedTrailId = id; };
            mapDisplay.onRouteChange = (route) => { savedRoute = route; };
            document.getElementById('map-display-container').innerHTML = mapDisplay.render();
            await mapDisplay.init();

            // Deep-link trail takes precedence; otherwise re-hydrate the
            // last trail the user had loaded. loadTrailOverlay both applies
            // the overlay and re-seeds savedTrailId via onTrailChange.
            const trailId = parseTrailIdFromSubPath(subPath) || savedTrailId;
            if (trailId) await loadTrailOverlay(trailId);

            // Re-issue the previously active route. resumeRoute defers
            // until routing is set up and GPS is available.
            if (savedRoute) mapDisplay.resumeRoute(savedRoute);
        } catch (error) {
            console.error('Failed to initialize map:', error);
            document.getElementById('map-display-container').innerHTML =
                '<p style="color: var(--danger); padding: 1rem;">Failed to load map</p>';
        }
    },

    cleanup() {
        if (mapDisplay) {
            mapDisplay.cleanup();
            mapDisplay = null;
        }
    }
};

function parseTrailIdFromSubPath(subPath) {
    if (!subPath) return null;
    const parts = subPath.split('/');
    if (parts[0] !== 'trail' || !parts[1]) return null;
    try { return decodeURIComponent(parts[1]); } catch (_) { return parts[1]; }
}

async function loadTrailOverlay(id) {
    // Fetch metadata (for the display color) and the pre-parsed GeoJSON.
    let color = '#43a047';
    try {
        const list = await API.getTrails();
        const match = Array.isArray(list) ? list.find(t => t.id === id) : null;
        if (match?.color) color = match.color;
    } catch (err) {
        console.warn('[map] failed to fetch trail metadata:', err);
    }
    try {
        const geojson = await API.getTrailGeoJSON(id);
        if (mapDisplay) mapDisplay.showTrail(geojson, color, id);
    } catch (err) {
        console.error('[map] failed to load trail GeoJSON:', err);
    }
}
