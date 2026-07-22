FROM node:24-slim

# Node.js 24 LTS with npm included
#
# ca-certificates + openssl are needed so we can install custom CA certs
# (e.g. a Peregrine board's self-signed CA) into the system trust store
# at runtime via `update-ca-certificates`. NODE_EXTRA_CA_CERTS makes
# Node.js trust the system bundle in addition to its bundled Mozilla CAs.
#
# avahi-utils + dbus give us `avahi-resolve` so the backend can resolve
# `*.local` hostnames (Docker's bridge networks don't forward mDNS
# multicast and don't ship libnss-mdns). At runtime we mount the host's
# /run/dbus and /var/run/avahi-daemon sockets so the resolver talks to
# the host's avahi-daemon instead of needing one in the container.
#
# ffmpeg reads V4L2 from /dev/video*, transcodes to H.264 baseline
# (ultrafast + zerolatency via libx264, or h264_v4l2m2m where the kernel
# driver supports it), and pipes an Annex-B elementary stream to
# camera-streamer. The Debian ffmpeg build ships with both libx264 and
# the v4l2m2m encoder wrapper.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates openssl avahi-utils dbus ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src

EXPOSE 3000
CMD ["node", "src/index.js"]
