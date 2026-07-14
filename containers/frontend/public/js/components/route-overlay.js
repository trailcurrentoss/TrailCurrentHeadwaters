// Route overlay — adds MapLibre GL sources + layers for a Valhalla route,
// plus start/end markers. Owns nothing outside of the two `route-*` sources
// it creates on the map, so it composes cleanly next to map-display's own
// user-location and search-result layers.
//
// Usage:
//   const overlay = new RouteOverlay(mapDisplay.map);
//   overlay.ensureLayers();  // idempotent; safe to call after every setStyle
//   overlay.setRoute(valhallaTrip);  // valhallaTrip = response.trip
//   overlay.clearRoute();

// Decode a Google-style encoded polyline. Valhalla uses precision 6 (not 5
// like Google Maps' default), so we default to 1e-6.
function decodePolyline(encoded, precision = 6) {
    if (!encoded) return [];
    const factor = Math.pow(10, precision);
    const coords = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    while (index < encoded.length) {
        let b, shift = 0, result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dLat = (result & 1) ? ~(result >> 1) : (result >> 1);
        lat += dLat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dLng = (result & 1) ? ~(result >> 1) : (result >> 1);
        lng += dLng;

        // GeoJSON is [lon, lat].
        coords.push([lng / factor, lat / factor]);
    }
    return coords;
}

// Merge all legs' shapes into a single [lng, lat] list — legs share endpoints
// so we drop the first point of every leg after the first.
function mergeLegs(legs) {
    const out = [];
    (legs || []).forEach((leg, i) => {
        const pts = decodePolyline(leg.shape);
        if (i === 0) out.push(...pts);
        else out.push(...pts.slice(1));
    });
    return out;
}

export class RouteOverlay {
    constructor(map) {
        this.map = map;
        this._trip = null;
        this._layersReady = false;
    }

    // Called once after map load AND after every setStyle (map-display's
    // theme swap wipes sources). Idempotent.
    ensureLayers() {
        if (!this.map || !this.map.isStyleLoaded?.()) {
            // If style isn't ready yet, defer once.
            if (this.map) {
                this.map.once('style.load', () => this.ensureLayers());
            }
            return;
        }
        if (this.map.getSource('route-line')) {
            this._layersReady = true;
            return;
        }

        this.map.addSource('route-line', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        this.map.addSource('route-endpoints', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });

        // Casing (dark outline) drawn beneath the primary line for contrast
        // against light basemap styles.
        this.map.addLayer({
            id: 'route-line-casing',
            type: 'line',
            source: 'route-line',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#0b3d91', 'line-width': 8, 'line-opacity': 0.9 }
        });
        this.map.addLayer({
            id: 'route-line-main',
            type: 'line',
            source: 'route-line',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#3f8efc', 'line-width': 5, 'line-opacity': 1.0 }
        });

        // Endpoints: differentiated by feature.properties.role
        // ("origin" | "destination"). Origin gets a green dot; destination
        // a red pin echoing the search-result colour.
        this.map.addLayer({
            id: 'route-endpoint-shadow',
            type: 'circle',
            source: 'route-endpoints',
            paint: {
                'circle-radius': 10, 'circle-color': '#000',
                'circle-opacity': 0.25, 'circle-translate': [0, 2]
            }
        });
        this.map.addLayer({
            id: 'route-endpoint-dot',
            type: 'circle',
            source: 'route-endpoints',
            paint: {
                'circle-radius': 8,
                'circle-color': [
                    'match', ['get', 'role'],
                    'origin', '#2ecc71',
                    'destination', '#e94b3c',
                    '#3f8efc'
                ],
                'circle-stroke-width': 3,
                'circle-stroke-color': '#ffffff'
            }
        });

        this._layersReady = true;

        // If a route was set before layers were ready, apply it now.
        if (this._trip) this._applyTrip(this._trip);
    }

    // trip = the Valhalla response's `.trip` object (has .summary, .legs[]).
    setRoute(trip) {
        if (!trip || !Array.isArray(trip.legs) || trip.legs.length === 0) {
            this.clearRoute();
            return;
        }
        this._trip = trip;
        if (!this._layersReady) {
            this.ensureLayers();
            return;
        }
        this._applyTrip(trip);
    }

    _applyTrip(trip) {
        const coords = mergeLegs(trip.legs);
        if (coords.length < 2) {
            this.clearRoute();
            return;
        }
        this._shapeCache = coords;

        this.map.getSource('route-line').setData({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coords },
                properties: {}
            }]
        });

        this.map.getSource('route-endpoints').setData({
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: coords[0] },
                  properties: { role: 'origin' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: coords[coords.length - 1] },
                  properties: { role: 'destination' } }
            ]
        });

        // Fit the camera to the route with room for the turn-list panel on
        // the right and the search bar up top.
        const lons = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        const w = Math.min(...lons), e = Math.max(...lons);
        const s = Math.min(...lats), n = Math.max(...lats);
        this.map.fitBounds([[w, s], [e, n]], {
            padding: { top: 100, bottom: 80, left: 60, right: 340 },
            maxZoom: 15,
            duration: 700
        });
    }

    clearRoute() {
        this._trip = null;
        this._shapeCache = null;
        if (!this._layersReady || !this.map) return;
        const empty = { type: 'FeatureCollection', features: [] };
        const line = this.map.getSource('route-line');
        const ends = this.map.getSource('route-endpoints');
        if (line) line.setData(empty);
        if (ends) ends.setData(empty);
    }

    getTrip() {
        return this._trip;
    }

    // Merged [lng, lat] points across all legs of the current trip. Cached
    // on _applyTrip so off-route checks are O(N) per GPS tick without a
    // re-decode. Returns [] when no route is active.
    getShapePoints() {
        return this._shapeCache || [];
    }
}
