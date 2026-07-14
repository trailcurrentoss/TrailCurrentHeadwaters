FROM node:18-alpine as maplibre-downloader

# Download MapLibre GL JS + CSS and the PMTiles protocol adapter. Both are
# pinned to specific versions so a rebuild produces identical output.
# PMTiles adapter registers a `pmtiles://` protocol on maplibregl that
# resolves HTTP Range requests against the static PMTiles file served by
# nginx at /maps/tiles.pmtiles.
RUN mkdir -p /maplibre /pmtiles && \
    cd /maplibre && \
    npm init -y && \
    npm install maplibre-gl@4.7.1 && \
    cp node_modules/maplibre-gl/dist/maplibre-gl.js maplibre-gl.js && \
    cp node_modules/maplibre-gl/dist/maplibre-gl.css maplibre-gl.css && \
    cd /pmtiles && \
    npm init -y && \
    npm install pmtiles@3.2.0 && \
    cp node_modules/pmtiles/dist/pmtiles.js pmtiles.js

FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf
COPY public /usr/share/nginx/html

# Copy MapLibre GL + PMTiles adapter into the served /libs/ tree.
COPY --from=maplibre-downloader /maplibre/maplibre-gl.js /usr/share/nginx/html/libs/maplibre/
COPY --from=maplibre-downloader /maplibre/maplibre-gl.css /usr/share/nginx/html/libs/maplibre/
COPY --from=maplibre-downloader /pmtiles/pmtiles.js /usr/share/nginx/html/libs/pmtiles/

EXPOSE 443

CMD ["nginx", "-g", "daemon off;"]
