#!/bin/bash
set -e

# TrailCurrent Deployment Script
# Deploys the TrailCurrent system on a Raspberry Pi from a deployment package
#
# This script:
#   1. Stops existing services
#   2. Loads Docker images from tar files
#   3. Sets up environment files
#   4. Starts Docker services
#   5. Installs Python dependencies
#   6. Restarts the CAN-to-MQTT service
#   7. Deploys MCU firmware via OTA (if firmware is included)
#
# Usage: ./deploy.sh
# Must be run from the deployment package directory.

# Venv path for the cantomqtt systemd service (matches can-to-mqtt.service)
VENV_PATH="$HOME/local_code/cantomqtt"
LOCAL_CODE_DEST="$HOME/local_code"

# Function to deploy firmware to a wired device via OTA
# Uses CAN trigger (via MQTT) then HTTP POST of the binary to the module's /ota endpoint
deploy_firmware() {
    local hostname=$1
    local firmware_path=$2
    local device_name=$3

    # Step 1: Trigger OTA mode via MQTT (CAN ID 0x00)
    echo "  Triggering OTA mode for $device_name ($hostname)..."
    "$VENV_PATH/bin/python3" local_code/trigger_ota_mqtt.py "$hostname"

    if [ $? -ne 0 ]; then
        echo "  Failed to send OTA trigger to $hostname"
        return 1
    fi

    # Step 2: Wait for device to connect to WiFi and start HTTP server
    echo "  Waiting for $hostname to enter OTA mode..."
    sleep 8

    # Step 3: POST firmware binary to the module's /ota endpoint
    echo "  Uploading firmware to $hostname via HTTP..."
    curl -sf -X POST "http://${hostname}.local/ota" \
        --data-binary "@${firmware_path}" \
        --connect-timeout 10 \
        --max-time 180

    if [ $? -eq 0 ]; then
        echo "  Successfully deployed firmware to $device_name"
        return 0
    else
        echo "  Failed to deploy firmware to $device_name"
        return 1
    fi
}

# Function to deploy firmware to a wireless device via OTA
# Uses MQTT local/ota/trigger then HTTP POST (device is already on WiFi)
deploy_firmware_wireless() {
    local hostname=$1
    local firmware_path=$2
    local device_name=$3

    # Step 1: Trigger OTA mode via MQTT (local/ota/trigger topic)
    echo "  Triggering wireless OTA for $device_name ($hostname)..."
    "$VENV_PATH/bin/python3" local_code/trigger_ota_wireless.py "$hostname"

    if [ $? -ne 0 ]; then
        echo "  Failed to send wireless OTA trigger to $hostname"
        return 1
    fi

    # Step 2: Short wait — wireless device is already on the network
    echo "  Waiting for $hostname to enter OTA mode..."
    sleep 3

    # Step 3: POST firmware binary to the module's /ota endpoint
    echo "  Uploading firmware to $hostname via HTTP..."
    curl -sf -X POST "http://${hostname}.local/ota" \
        --data-binary "@${firmware_path}" \
        --connect-timeout 10 \
        --max-time 180

    if [ $? -eq 0 ]; then
        echo "  Successfully deployed firmware to $device_name"
        return 0
    else
        echo "  Failed to deploy firmware to $device_name"
        return 1
    fi
}

echo "=========================================="
echo "TrailCurrent Deployment Script"
echo "=========================================="

# Check if Docker is installed
if ! [ -x "$(command -v docker)" ] && ! [ -f /usr/bin/docker ]; then
    echo "ERROR: Docker is not installed. Please install Docker first."
    exit 1
fi

cd "$(dirname "$0")"

# Fix ownership of files that may be root-owned from a previous deployment or
# image build. Without this, unzip cannot overwrite these files as a normal user.
for dir in scripts config; do
    if [ -d "$dir" ] && [ ! -w "$dir" ]; then
        echo "Fixing ownership of $dir/ (owned by root)..."
        sudo chown -R "$(id -u):$(id -g)" "$dir/"
    fi
done

# Step 0: Check for .env file, offer to create from template
echo "Step 0: Checking prerequisites..."

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo ""
        echo "  No .env file found. Creating from .env.example..."
        echo "  IMPORTANT: You must edit .env and set your own passwords/secrets before continuing."
        echo ""
        cp .env.example .env
        echo "  Created .env from template."
        echo "  Please edit .env now, then re-run ./deploy.sh"
        echo ""
        echo "  Quick setup commands:"
        echo "    nano .env"
        echo "    # Set MQTT_PASSWORD, ADMIN_PASSWORD, etc."
        echo "    # Generate secrets:"
        echo "    #   ENCRYPTION_KEY: openssl rand -hex 32"
        echo ""
        exit 1
    else
        echo "ERROR: .env file not found and no .env.example template available."
        echo "Please create a .env file before running this script."
        exit 1
    fi
fi

# Check for TLS certificates
if [ ! -d "data/keys" ] || [ ! -f "data/keys/server.crt" ]; then
    echo ""
    echo "  TLS certificates not found at data/keys/"
    if [ -f "scripts/generate-certs.sh" ]; then
        echo "  Generating certificates..."
        chmod +x scripts/generate-certs.sh
        ./scripts/generate-certs.sh 2
        echo "  Certificates generated."
    else
        echo "  ERROR: No certificate generation script found."
        echo "  Please generate TLS certificates manually and place them in data/keys/"
        exit 1
    fi
fi

echo "  Prerequisites OK"

# Install CA certificate to system trust store (enables host-side TLS verification)
if [ -f "data/keys/ca.crt" ]; then
    SYSTEM_CA="/usr/local/share/ca-certificates/trailcurrent-ca.crt"
    # Install or update if the CA cert has changed (handles renewals between runs)
    if [ ! -f "$SYSTEM_CA" ] || ! cmp -s "data/keys/ca.crt" "$SYSTEM_CA"; then
        echo "  Installing CA certificate to system trust store..."
        sudo cp data/keys/ca.crt "$SYSTEM_CA"
        sudo update-ca-certificates
    else
        echo "  CA certificate already in system trust store"
    fi
fi

# Step 1: Stop existing services
echo ""
echo "Step 1: Stopping existing services..."

# Stop Docker services and remove orphaned containers from previous deployments
docker compose down --remove-orphans 2>/dev/null || true

# Stop systemd service for Python code
if systemctl is-active --quiet cantomqtt.service; then
    echo "  Stopping cantomqtt.service..."
    sudo systemctl stop cantomqtt.service
fi

# Step 2: Load Docker images from tar files
echo ""
echo "Step 2: Loading Docker images..."
images_loaded=0
for image_file in images/*.tar; do
    if [ -f "$image_file" ]; then
        echo "  Loading $image_file..."
        if docker load -i "$image_file"; then
            images_loaded=$((images_loaded+1))
        else
            echo "  Warning: Failed to load $image_file"
        fi
    fi
done
echo "  Loaded $images_loaded image(s)"

# Prune dangling images left over from previous deployments
pruned=$(docker image prune -f 2>/dev/null | grep "Total reclaimed space" || true)
if [ -n "$pruned" ]; then
    echo "  Cleaned up old images: $pruned"
fi

# Step 3: Set up environment files
echo ""
echo "Step 3: Setting up environment files..."

TLS_HOSTNAME=$(grep "^TLS_CERT_HOSTNAME=" .env | cut -d'=' -f2)

# Create local_code .env with external hostname for host scripts
cp .env local_code/.env
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|mqtts://mosquitto:|mqtts://${TLS_HOSTNAME}:|g" local_code/.env
else
    sed -i "s|mqtts://mosquitto:|mqtts://${TLS_HOSTNAME}:|g" local_code/.env
fi

echo "  Root .env: MQTT_BROKER_URL=mqtts://mosquitto:8883 (for Docker)"
echo "  local_code/.env: MQTT_BROKER_URL=mqtts://${TLS_HOSTNAME}:8883 (for host scripts)"

# Step 3.9: Bind-mount preflight
# ------------------------------
# Guarantee every host bind-mount source in docker-compose.yml exists AS
# trailcurrent:trailcurrent, mode 0755, BEFORE any container starts. If we
# skip this and let Docker auto-create a missing bind source, Docker creates
# it as root, and every subsequent write from a non-root process (map-watcher,
# a container running with `user: 1000`, this script itself when not sudo'd)
# fails with permission-denied. That failure mode has bitten us multiple
# times; this step makes it structurally impossible.
#
# The preflight enumerates EVERY bind mount across EVERY profile in the
# resolved compose config — no per-service code, no hardcoded list. Any
# future service that adds a bind mount is automatically covered.
echo ""
echo "Step 3.9: Bind-mount preflight (every host bind source: exists + ownership + mode)..."

TARGET_UID="$(id -u)"
TARGET_GID="$(id -g)"

# Discover every profile the compose file declares, so `config --format json`
# yields the full service catalog (photon lives behind `profiles: [maps]`,
# valhalla will follow the same pattern).
COMPOSE_PROFILES="$(docker compose config --profiles 2>/dev/null | tr '\n' ' ')"
PROFILE_ARGS=""
for p in $COMPOSE_PROFILES; do
    PROFILE_ARGS="$PROFILE_ARGS --profile $p"
done

# shellcheck disable=SC2086  # PROFILE_ARGS is intentionally word-split
COMPOSE_JSON="$(docker compose $PROFILE_ARGS config --format json 2>/dev/null)"

if [ -z "$COMPOSE_JSON" ]; then
    echo "  WARNING: docker compose config produced no output — falling back to legacy hardcoded skeleton."
    mkdir -p data/keys data/firmware data/deployments data/maps/versions data/maps/staging
    chmod 0755 data/maps data/maps/versions data/maps/staging
else
    # Emit every bind source as one path per line. Filter to paths inside the
    # working tree — we don't touch /var/run/avahi-daemon/socket etc.
    BIND_SOURCES="$(printf '%s' "$COMPOSE_JSON" | python3 -c '
import json, os, sys
cfg = json.load(sys.stdin)
for svc in (cfg.get("services") or {}).values():
    for vol in svc.get("volumes") or []:
        if vol.get("type") == "bind":
            src = vol.get("source")
            if src:
                print(src)
' | sort -u)"

    PWD_ABS="$(pwd)"
    while IFS= read -r src; do
        [ -n "$src" ] || continue

        # Only preflight paths inside our working tree. Anything under /var,
        # /sys, /proc, /run, /etc etc. is host-owned and not ours to manage.
        case "$src" in
            "$PWD_ABS"/*|"$PWD_ABS") ;;
            *) continue ;;
        esac

        # Symlink (e.g. data/maps/current, which is managed by map-watcher):
        # never create or rewrite. Silently correct the link's own ownership
        # if wrong; the target may not exist yet on a virgin device — that's
        # fine, map-watcher creates it on first successful bundle apply.
        if [ -L "$src" ]; then
            current_owner="$(stat -c '%u:%g' "$src" 2>/dev/null || echo "?")"
            if [ "$current_owner" != "$TARGET_UID:$TARGET_GID" ]; then
                echo "  fixing symlink ownership on $src (was $current_owner)"
                sudo chown -h "$TARGET_UID:$TARGET_GID" "$src"
            fi
            continue
        fi

        # Regular file (TLS certs, ca.pem, socket): leave alone. If missing,
        # something upstream is broken and we don't want to paper over it by
        # creating an empty stub.
        if [ -f "$src" ]; then
            continue
        fi

        # Directory case: create if missing, fix ownership if wrong.
        if [ ! -e "$src" ]; then
            echo "  creating $src (was missing)"
            sudo mkdir -p "$src"
        fi

        current_owner="$(stat -c '%u:%g' "$src" 2>/dev/null || echo "?")"
        if [ "$current_owner" != "$TARGET_UID:$TARGET_GID" ]; then
            echo "  fixing ownership on $src (was $current_owner, wanted $TARGET_UID:$TARGET_GID)"
            sudo chown "$TARGET_UID:$TARGET_GID" "$src"
        fi
        sudo chmod 0755 "$src"
    done <<< "$BIND_SOURCES"

    # Reclaim any root-owned leftovers under data/maps/staging (partial
    # uploads that died before the backend's fs.chownSync handoff ran).
    # This lets map-watcher clean up its own staging dir on the next apply
    # without needing sudo.
    if [ -d data/maps/staging ]; then
        find data/maps/staging -mindepth 1 \! -user "$TARGET_UID" -print 2>/dev/null | while IFS= read -r stray; do
            echo "  reclaiming $stray from wrong ownership"
            sudo chown -h "$TARGET_UID:$TARGET_GID" "$stray"
        done
    fi
fi

echo "  Bind-mount preflight complete."

# Step 4: Start Docker services
echo ""
echo "Step 4: Starting Docker services..."
# --no-build: use pre-loaded images, don't try to build from source
# --remove-orphans: clean up containers from services removed in newer versions
#   (including tileserver-gl, nominatim, geocoder — killed in the offline-maps
#   migration; --remove-orphans lets an in-flight upgrade sweep them away).
docker compose up -d --no-build --remove-orphans

# Step 4.1: Sweep profile-gated services
# --------------------------------------
# Services behind `profiles: [...]` in docker-compose.yml are deliberately
# omitted from the plain `up` above so they don't start on virgin devices
# where their bind sources aren't ready (e.g. photon needs data/maps/current
# to exist). Once a bundle is installed, though, they MUST be recreated on
# every deploy so config changes (image tag, mount mode, env vars) take
# effect. Without this step, `docker compose up` would happily leave a
# stale-config profile-gated container running from a prior deploy — which
# is exactly the trap we hit with photon's :ro→writable fix.
#
# We recreate ONE running profile-gated container at a time, force-recreate
# so any compose config drift is reconciled. If the container isn't running
# (virgin device, or bundle not applied yet) we don't touch it — map-watcher
# will start it explicitly when it applies its first bundle.
RUNNING_PROFILE_SERVICES=""
for p in $COMPOSE_PROFILES; do
    # shellcheck disable=SC2086
    for svc in $(docker compose --profile "$p" config --services 2>/dev/null); do
        if ! docker compose config --services 2>/dev/null | grep -qx "$svc"; then
            # Service ONLY appears under a profile — it's profile-gated.
            if [ -n "$(docker compose --profile "$p" ps -q "$svc" 2>/dev/null)" ]; then
                RUNNING_PROFILE_SERVICES="$RUNNING_PROFILE_SERVICES $svc:$p"
            fi
        fi
    done
done

if [ -n "$RUNNING_PROFILE_SERVICES" ]; then
    echo ""
    echo "Step 4.1: Sweeping profile-gated services (config drift reconcile)..."
    for entry in $RUNNING_PROFILE_SERVICES; do
        svc="${entry%:*}"
        profile="${entry#*:}"
        echo "  recreating $svc (profile: $profile)"
        docker compose --profile "$profile" up -d --no-deps --force-recreate "$svc"
    done
fi

# Step 5: Ensure local_code is deployed to the user's home directory
echo ""
echo "Step 5: Deploying local_code to $LOCAL_CODE_DEST..."
SRC_LOCAL_CODE="$(cd local_code && pwd)"
DEST_LOCAL_CODE="$(cd "$LOCAL_CODE_DEST" 2>/dev/null && pwd || echo "$LOCAL_CODE_DEST")"
if [ "$SRC_LOCAL_CODE" = "$DEST_LOCAL_CODE" ]; then
    echo "  local_code already in place, skipping copy"
else
    if [ -d "$LOCAL_CODE_DEST" ]; then
        # Preserve existing .env if it exists
        if [ -f "$LOCAL_CODE_DEST/.env" ]; then
            cp "$LOCAL_CODE_DEST/.env" /tmp/cantomqtt_env_backup
        fi
    fi
    mkdir -p "$LOCAL_CODE_DEST"
    cp -r local_code/* "$LOCAL_CODE_DEST/"

    # Restore or deploy the local_code .env
    if [ -f /tmp/cantomqtt_env_backup ]; then
        # Keep existing env (may have manual customizations)
        mv /tmp/cantomqtt_env_backup "$LOCAL_CODE_DEST/.env"
    else
        cp local_code/.env "$LOCAL_CODE_DEST/.env"
    fi
fi

# Copy CA certificate for host-side scripts (separate from Docker volume mounts)
if [ -f "data/keys/ca.pem" ]; then
    cp data/keys/ca.pem "$LOCAL_CODE_DEST/ca.pem"
fi

# Step 5.5: Install Python dependencies
echo ""
echo "Step 5.5: Installing Python dependencies..."
if [ -f "local_code/requirements.txt" ]; then
    if [ -d "$VENV_PATH" ]; then
        "$VENV_PATH/bin/pip" install -q -r local_code/requirements.txt
        echo "  Python dependencies installed"
    else
        echo "  Virtual environment not found at $VENV_PATH"
        echo "  Creating virtual environment..."
        python3 -m venv "$VENV_PATH"
        "$VENV_PATH/bin/pip" install -q -r local_code/requirements.txt
        echo "  Virtual environment created and dependencies installed"
    fi
else
    echo "  local_code/requirements.txt not found"
fi

# Step 6: Restart Python service (cantomqtt)
echo ""
echo "Step 6: Restarting Python service (cantomqtt)..."
if [ -f "local_code/can-to-mqtt.service" ]; then
    sudo cp local_code/can-to-mqtt.service /etc/systemd/system/cantomqtt.service
    sudo systemctl daemon-reload
    if sudo systemctl is-enabled --quiet cantomqtt.service 2>/dev/null; then
        sudo systemctl restart cantomqtt.service
        echo "  cantomqtt.service updated and restarted"
    else
        sudo systemctl enable --now cantomqtt.service
        echo "  cantomqtt.service installed and started"
    fi
else
    echo "  ERROR: local_code/can-to-mqtt.service not found"
fi

# Install/restart discovery mDNS browser service
if [ -f "local_code/discovery-mdns.service" ]; then
    sudo cp local_code/discovery-mdns.service /etc/systemd/system/discovery-mdns.service
    sudo systemctl daemon-reload
    if sudo systemctl is-enabled --quiet discovery-mdns.service 2>/dev/null; then
        sudo systemctl restart discovery-mdns.service
        echo "  discovery-mdns.service updated and restarted"
    else
        sudo systemctl enable --now discovery-mdns.service
        echo "  discovery-mdns.service installed and started"
    fi
fi

# Install/restart OS settings proxy service (timezone etc. driven by PWA).
# Uses passwordless sudo on the rig image; no polkit rule needed.
if [ -f "local_code/os-settings.service" ]; then
    sudo cp local_code/os-settings.service /etc/systemd/system/os-settings.service
    sudo systemctl daemon-reload
    if sudo systemctl is-enabled --quiet os-settings.service 2>/dev/null; then
        sudo systemctl restart os-settings.service
        echo "  os-settings.service updated and restarted"
    else
        sudo systemctl enable --now os-settings.service
        echo "  os-settings.service installed and started"
    fi
fi

# Install/restart Bearing-GNSS time sync service (and the chrony NTP daemon
# it pairs with). Pre-baked CM5 images already have both - this branch
# only fires the first time deploy.sh runs on an older image.
if [ -f "local_code/time-from-bearing.service" ]; then
    if ! command -v chronyd >/dev/null 2>&1; then
        echo "  Installing chrony NTP daemon..."
        sudo apt-get install -y -q chrony
    fi
    if [ -f "config/chrony/chrony.conf" ]; then
        sudo cp config/chrony/chrony.conf /etc/chrony/chrony.conf
        sudo systemctl restart chrony
    fi
    if [ ! -L /etc/systemd/system/systemd-timesyncd.service ]; then
        sudo ln -sf /dev/null /etc/systemd/system/systemd-timesyncd.service
        sudo systemctl daemon-reload
        sudo systemctl stop systemd-timesyncd 2>/dev/null || true
    fi
    sudo cp local_code/time-from-bearing.service /etc/systemd/system/time-from-bearing.service
    sudo systemctl daemon-reload
    if sudo systemctl is-enabled --quiet time-from-bearing.service 2>/dev/null; then
        sudo systemctl restart time-from-bearing.service
        echo "  time-from-bearing.service updated and restarted"
    else
        sudo systemctl enable --now time-from-bearing.service
        echo "  time-from-bearing.service installed and started"
    fi
fi

# Wait for cantomqtt to initialize (connect to MQTT broker and CAN bus)
echo "  Waiting for CAN-to-MQTT bridge to initialize..."
sleep 5

# Step 6.1: Install (or stage update of) the deployment watcher service.
# We deliberately do NOT restart an already-running watcher here. When this
# script is invoked by the watcher itself (cloud or PWA deploy), the watcher
# is our parent process and `systemctl restart` would cgroup-SIGTERM us
# before Step 7 (firmware OTA) runs. The actual restart is deferred to the
# end of deploy.sh via systemd-run, so the new code takes effect only after
# this run completes cleanly.
echo ""
echo "Step 6.1: Setting up deployment watcher service..."
if [ -f "local_code/deployment-watcher.service" ]; then
    sudo cp local_code/deployment-watcher.service /etc/systemd/system/deployment-watcher.service
    sudo systemctl daemon-reload
fi
if sudo systemctl is-active --quiet deployment-watcher.service 2>/dev/null || sudo systemctl is-enabled --quiet deployment-watcher.service 2>/dev/null; then
    echo "  deployment-watcher.service unit file refreshed (restart deferred to end of deploy)"
else
    echo "  deployment-watcher.service not installed, installing..."
    if [ -f "local_code/deployment-watcher.service" ]; then
        sudo systemctl enable --now deployment-watcher.service
        echo "  deployment-watcher.service installed and started"
    else
        echo "  local_code/deployment-watcher.service not found, skipping"
    fi
fi

# Step 6.2: Install (or refresh) the map watcher service. Independent
# pipeline from deployment-watcher — see PLANS/Offline-Maps-Migration.md.
echo ""
echo "Step 6.2: Setting up map watcher service..."
if [ -f "local_code/map-watcher.service" ]; then
    sudo cp local_code/map-watcher.service /etc/systemd/system/map-watcher.service
    sudo systemctl daemon-reload
    if sudo systemctl is-active --quiet map-watcher.service 2>/dev/null; then
        sudo systemctl restart map-watcher.service
        echo "  map-watcher.service refreshed and restarted"
    elif sudo systemctl is-enabled --quiet map-watcher.service 2>/dev/null; then
        sudo systemctl start map-watcher.service
        echo "  map-watcher.service enabled but was stopped, started"
    else
        sudo systemctl enable --now map-watcher.service
        echo "  map-watcher.service installed and started"
    fi
else
    echo "  local_code/map-watcher.service not found, skipping"
fi

# Step 6.5: Provision WiFi credentials to MCUs (needed for OTA)
echo ""
echo "Step 6.5: Provisioning WiFi credentials to MCUs..."
if [ -f "local_code/provision_wifi_mqtt.py" ]; then
    BACKEND_CONTAINER=$(docker compose ps -q backend 2>/dev/null)
    if [ -n "$BACKEND_CONTAINER" ]; then
        # Query MongoDB and decrypt WiFi password inside the backend container
        # (it has Node.js crypto, ENCRYPTION_KEY env var, and mongodb driver)
        WIFI_CREDS=$(docker exec "$BACKEND_CONTAINER" node -e '
            const { MongoClient } = require("mongodb");
            const crypto = require("crypto");
            async function main() {
                const client = await MongoClient.connect("mongodb://mongodb:27017");
                const config = await client.db("trailcurrent").collection("system_config").findOne({_id: "main"});
                await client.close();
                if (!config || !config.wifi_ssid || !config.wifi_password_encrypted || !config.wifi_password_iv) {
                    process.exit(1);
                }
                const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
                const iv = Buffer.from(config.wifi_password_iv, "hex");
                const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
                let password = decipher.update(config.wifi_password_encrypted, "hex", "utf8");
                password += decipher.final("utf8");
                console.log(config.wifi_ssid);
                console.log(password);
            }
            main().catch(() => process.exit(1));
        ' 2>/dev/null)

        if [ $? -eq 0 ] && [ -n "$WIFI_CREDS" ]; then
            WIFI_SSID=$(echo "$WIFI_CREDS" | head -n 1)
            WIFI_PASSWORD=$(echo "$WIFI_CREDS" | tail -n 1)

            if [ -n "$WIFI_SSID" ] && [ -n "$WIFI_PASSWORD" ]; then
                echo "  Sending WiFi credentials to MCUs (SSID: $WIFI_SSID)..."
                "$VENV_PATH/bin/python3" local_code/provision_wifi_mqtt.py "$WIFI_SSID" "$WIFI_PASSWORD"
                if [ $? -eq 0 ]; then
                    echo "  WiFi credentials provisioned successfully"
                    # Brief wait for MCUs to store credentials in NVS
                    sleep 2
                else
                    echo "  Warning: Failed to provision WiFi credentials"
                fi
            else
                echo "  Warning: Could not parse WiFi credentials"
            fi
        else
            echo "  No WiFi credentials configured, skipping (configure via Settings > Wireless)"
        fi
    else
        echo "  Backend container not running, skipping WiFi provisioning"
    fi
else
    echo "  provision_wifi_mqtt.py not found, skipping WiFi provisioning"
fi

# Step 7: Deploy MCU firmware (if included in this deployment package)
echo ""
echo "Step 7: Deploying MCU firmware (if present)..."
# Check the .firmware-included flag written by create-deployment-package.sh.
# This flag is always in the zip, so unzip overwrites it even when firmware/
# binaries from a previous deployment are left behind (unzip overlays, it
# never deletes old files).
FIRMWARE_INCLUDED=$(cat .firmware-included 2>/dev/null)
if [ "$FIRMWARE_INCLUDED" = "yes" ] && [ -f "local_code/trigger_ota_mqtt.py" ]; then
    # Copy firmware files to data/firmware so the backend can serve them for UI-triggered OTA
    if [ -d "firmware" ]; then
        find firmware -name "*.bin" -exec cp {} data/firmware/ \;
        echo "  Copied firmware files to data/firmware/ for UI access"
    fi

    echo "  Firmware directory found, querying enabled devices..."

    # Query MongoDB for enabled modules via Docker (MongoDB is not exposed to host)
    MONGODB_CONTAINER=$(docker compose ps -q mongodb 2>/dev/null)
    if [ -z "$MONGODB_CONTAINER" ]; then
        echo "  MongoDB container not running, skipping OTA deployment"
        MODULES="[]"
    else
        MODULES=$(docker exec "$MONGODB_CONTAINER" mongosh --quiet --eval '
            const config = db.getSiblingDB("trailcurrent").system_config.findOne({_id: "main"});
            const modules = (config && config.mcu_modules) || [];
            const enabled = modules.filter(m => m.enabled === true).map(m => ({hostname: m.hostname, type: m.type, name: m.name, addr: m.addr, target: m.target || "", wireless: m.wireless === true}));
            JSON.stringify(enabled);
        ' 2>/dev/null || echo "[]")
    fi

    if [ "$MODULES" = "[]" ]; then
        echo "  No enabled modules found in database, skipping OTA deployment"
    else
        echo "  Deploying firmware to enabled modules..."

        if command -v jq &> /dev/null; then
            echo "$MODULES" | jq -c '.[]' | while read -r module; do
                HOSTNAME=$(echo "$module" | jq -r '.hostname')
                TYPE=$(echo "$module" | jq -r '.type')
                NAME=$(echo "$module" | jq -r '.name')
                ADDR=$(echo "$module" | jq -r '.addr // 0')
                TARGET=$(echo "$module" | jq -r '.target // empty')
                WIRELESS=$(echo "$module" | jq -r '.wireless // false')

                FIRMWARE_PATH=""

                if [ "$WIRELESS" = "true" ]; then
                    # Wireless devices use a flat single binary under firmware/wireless/<type>/
                    FIRMWARE_PATH="firmware/wireless/${TYPE}/${TYPE}.bin"
                    if [ ! -f "$FIRMWARE_PATH" ]; then
                        FIRMWARE_PATH=$(find "firmware/wireless/${TYPE}" -name "*.bin" 2>/dev/null | head -1)
                    fi

                    if [ -n "$FIRMWARE_PATH" ] && [ -f "$FIRMWARE_PATH" ]; then
                        echo "  Deploying wireless firmware to $NAME ($HOSTNAME)..."
                        deploy_firmware_wireless "$HOSTNAME" "$FIRMWARE_PATH" "$NAME" || true
                    else
                        echo "  No wireless firmware found for $NAME (type: $TYPE), skipping..."
                    fi
                else
                    # Wired devices: try target+address binary, then address-only, then single binary
                    if [ -n "$TARGET" ]; then
                        FIRMWARE_PATH="firmware/wired/${TYPE}/${TYPE}_${TARGET}_addr${ADDR}.bin"
                    fi
                    if [ -z "$FIRMWARE_PATH" ] || [ ! -f "$FIRMWARE_PATH" ]; then
                        FIRMWARE_PATH="firmware/wired/${TYPE}/${TYPE}_addr${ADDR}.bin"
                    fi
                    if [ ! -f "$FIRMWARE_PATH" ]; then
                        FIRMWARE_PATH=$(find "firmware/wired/${TYPE}" -name "*.bin" 2>/dev/null | head -1)
                    fi

                    if [ -n "$FIRMWARE_PATH" ] && [ -f "$FIRMWARE_PATH" ]; then
                        echo "  Deploying firmware to $NAME ($HOSTNAME)..."
                        deploy_firmware "$HOSTNAME" "$FIRMWARE_PATH" "$NAME" || true
                    else
                        echo "  No firmware found for $NAME (type: $TYPE), skipping..."
                    fi
                fi
            done
            echo "  Firmware deployment complete"
        else
            echo "  jq not found, skipping firmware deployment (install jq to enable OTA updates)"
        fi
    fi
else
    echo "  No firmware included in this deployment package, skipping OTA deployment"
fi

echo ""
echo "=========================================="
echo "Deployment complete!"
echo "=========================================="
echo ""
echo "Docker services status:"
docker compose ps
echo ""
echo "Python service status:"
sudo systemctl status cantomqtt.service --no-pager 2>/dev/null || echo "  (not installed or not enabled)"
echo ""
echo "Access the application at:"
if [ -n "$TLS_HOSTNAME" ]; then
    echo "  https://$TLS_HOSTNAME"
else
    echo "  https://$(hostname).local"
fi
echo ""
echo "Useful commands:"
echo "  View Docker logs:  docker compose logs -f"
echo "  View Python logs:  sudo journalctl -u cantomqtt.service -f"
echo "  Restart services:  docker compose restart"
echo "  Stop services:     docker compose down"
echo ""

# Step 8: Deferred deployment-watcher restart (paired with Step 6.1).
# `systemd-run --no-block --on-active=2` schedules a one-shot transient unit
# in its own cgroup so the restart fires ~2 seconds after deploy.sh exits.
# This avoids the SIGTERM-our-own-parent loop that Step 6.1 used to cause.
# Only runs if the watcher is currently active — if Step 6.1 just installed
# it for the first time, `enable --now` already started fresh code.
if sudo systemctl is-active --quiet deployment-watcher.service 2>/dev/null; then
    echo "Scheduling deployment watcher restart (in 2s, after this script exits)..."
    if sudo systemd-run --no-block --on-active=2 \
            systemctl restart deployment-watcher.service 2>/dev/null; then
        echo "  Deployment watcher restart scheduled"
    else
        echo "  WARNING: failed to schedule deferred watcher restart"
    fi
fi
