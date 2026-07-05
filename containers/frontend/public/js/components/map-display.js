// Map display component using MapLibre GL JS for vector tiles
import { wsClient } from '../api.js';
import { units } from '../services/units.js';

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
    }

    render() {
        return `
            <div class="map-wrapper">
                <div id="map-container" class="map-container">
                    <div class="map-loading">Loading map...</div>
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
            </div>
        `;
    }

    async init() {
        await this.loadMapLibre();
        this.initMap();
        this.setupControls();
        this.setupWebSocket();
    }

    async loadMapLibre() {
        if (this.maplibreLoaded || window.maplibregl) {
            this.maplibreLoaded = true;
            return;
        }

        return new Promise((resolve, reject) => {
            // Load MapLibre GL CSS from local bundle
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '/libs/maplibre/maplibre-gl.css';
            document.head.appendChild(link);

            // Load MapLibre GL JS from local bundle
            const script = document.createElement('script');
            script.src = '/libs/maplibre/maplibre-gl.js';
            script.onload = () => {
                this.maplibreLoaded = true;
                resolve();
            };
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    initMap() {
        const container = document.getElementById('map-container');
        if (!container || !window.maplibregl) return;

        // Clear loading message
        container.innerHTML = '';

        // Default center (roughly center of North America)
        const defaultCenter = [-98.5795, 39.8283]; // MapLibre uses [lng, lat]
        const defaultZoom = 4;

        // Get the theme-appropriate style from tileserver-gl
        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        // Map themes to tileserver styles: '3d-dark' for dark mode, '3d' for light mode
        const styleName = theme === 'dark' ? '3d-dark' : '3d';

        // Use the tileserver-gl style endpoint for vector tiles
        const styleUrl = `/styles/${styleName}/style.json`;

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

        // Add accuracy circle layer
        this.map.addLayer({
            id: 'user-accuracy',
            type: 'circle',
            source: 'user-location',
            paint: {
                'circle-radius': ['get', 'accuracy_radius'],
                'circle-color': '#4a90d9',
                'circle-opacity': 0.15,
                'circle-stroke-width': 1,
                'circle-stroke-color': '#4a90d9'
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
                'circle-color': '#4a90d9',
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
                'circle-color': '#4a90d9',
                'circle-opacity': 0.3
            },
            filter: ['==', ['get', 'type'], 'location']
        });
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

        // Destroy map
        if (this.map) {
            this.map.remove();
            this.map = null;
        }

        this.currentPosition = null;
        this.hasReceivedLocation = false;
    }
}
