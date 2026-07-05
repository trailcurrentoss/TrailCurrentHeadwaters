# Offline reverse-geocode service.
#
# Multi-stage: the builder image downloads GeoNames data + processes it
# into a compact SQLite. The runtime image ships only Python stdlib +
# the SQLite and server script. Final image is ~40 MB.
#
# Data source: download.geonames.org — CC BY 4.0 license.
#   cities1000.txt       — global cities population ≥ 1000 (~150k rows)
#   admin1CodesASCII.txt — first-level admin (state/province) names
#   countryInfo.txt      — country codes → names

# --- Builder ---
FROM python:3.12-alpine AS builder

RUN apk add --no-cache curl unzip

WORKDIR /data

# Cities file ships as a zip inside the tarball; the others are plain TSV.
RUN curl -fsSL https://download.geonames.org/export/dump/cities1000.zip -o cities1000.zip \
    && unzip cities1000.zip \
    && rm cities1000.zip \
    && curl -fsSL https://download.geonames.org/export/dump/admin1CodesASCII.txt -o admin1CodesASCII.txt \
    && curl -fsSL https://download.geonames.org/export/dump/countryInfo.txt -o countryInfo.txt

COPY src/build_index.py /build/build_index.py
RUN python3 /build/build_index.py \
    && ls -lh /data/geocoder.db \
    && rm /data/cities1000.txt /data/admin1CodesASCII.txt /data/countryInfo.txt

# --- Runtime ---
FROM python:3.12-alpine

RUN adduser -D -H -s /sbin/nologin geocoder

COPY --from=builder /data/geocoder.db /data/geocoder.db
COPY src/server.py /app/server.py

USER geocoder
WORKDIR /app

ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=2).read()" || exit 1

CMD ["python3", "/app/server.py"]
