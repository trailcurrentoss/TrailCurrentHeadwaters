# TrailCurrent Deployment Guide

## Overview

This document covers two scenarios:

1. **Updating an existing device** with a new deployment package (the
   primary use case for this guide)
2. **Installing the CA certificate** on client devices (phones, tablets,
   laptops)

**For initial device setup** (flashing a new CM5 and completing the
captive-portal setup from a phone), see [CM5/SETUP.md](CM5/SETUP.md). The
CM5 image includes all application code, Docker images, and map tiles
baked in — no deployment package transfer is needed for a fresh device,
and **no SSH, keyboard, or monitor is required or supported for initial
setup**. The CM5 must be the WiFi variant.

---

## Deployment Package

The deployment zip is used to **update** devices that already have a base
image flashed and configured. It is created on your development machine:

```bash
./create-deployment-package.sh --version=1.0.0
```

This produces `trailcurrent-deployment-1.0.0.zip` containing:
- `images/*.tar` — 5 pre-built ARM64 Docker images (4 custom + MongoDB)
- `docker-compose.yml` — Service orchestration
- `config/` — Mosquitto configuration
- `local_code/` — Python CAN-to-MQTT bridge and OTA helpers
- `firmware/wired/` — MCU firmware binaries (if available)
- `scripts/` — SSL certificate generation
- `.env.example` — Environment variable template
- `deploy.sh` — Deployment orchestrator
- `PI_DEPLOYMENT.md` — This file

> **Note:** `build-and-save-images.sh` must be run before creating a
> deployment package. It builds the ARM64 Docker images and saves them as
> tar files in `images/`. See [README.md](README.md#building-for-cm5-devices).

---

## Initial Setup (Fresh Devices)

For devices flashed with the current CM5 image, **no deployment package is
needed**. The image includes all application artifacts baked in. On first
boot the device brings up a `Headwaters-XXXX` WiFi access point and serves
a branded captive-portal setup page. The customer joins from their phone
and completes setup entirely through the portal — MQTT and admin passwords,
CA certificate installation, and startup of all services. See
[CM5/SETUP.md](CM5/SETUP.md) for the complete flashing and setup procedure.

**The WiFi variant of the CM5 is required.** There is no fallback setup
path that uses SSH, a keyboard, a monitor, or a serial console.

If you are working with an **older image** that does not include baked-in
artifacts, you can still deploy manually using the steps below.

### Manual First-Time Deployment (Legacy Images)

For devices running older images without baked-in application artifacts:

1. **Transfer the deployment package to the Pi:**
   ```bash
   scp trailcurrent-deployment-1.0.0.zip trailcurrent@headwaters.local:~
   ```

2. **SSH to the Pi and extract:**
   ```bash
   ssh trailcurrent@headwaters.local
   unzip trailcurrent-deployment-1.0.0.zip
   ```

3. **Run the deployment script:**
   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```

   On first run, `deploy.sh` will:
   - Create `.env` from `.env.example` and ask you to edit it (then re-run)
   - Generate TLS certificates automatically using `scripts/generate-certs.sh`
   - Install the CA certificate to the system trust store (for host-side TLS verification)
   - Load all Docker images from tar files
   - Start all services
   - Set up the CAN-to-MQTT bridge
   - Set up the deployment watcher (for cloud OTA updates)
   - Deploy MCU firmware via OTA (if firmware is included)

4. **Edit `.env` with your credentials** (first run only):
   ```bash
   nano .env
   # Set these values:
   #   MQTT_USERNAME / MQTT_PASSWORD
   #   ADMIN_PASSWORD
   #   TLS_CERT_HOSTNAME=headwaters.local
   #   ENCRYPTION_KEY=$(openssl rand -hex 32)
   ```
   Then re-run `./deploy.sh`.

5. **Map data:** *No manual step here.* Map bundles are uploaded via the PWA
   Maps page after first boot — see
   [PLANS/Offline-Maps-Migration.md](PLANS/Offline-Maps-Migration.md) for the
   architecture and [build/maps/README.md](build/maps/README.md) for how to
   build a region-specific bundle. The device boots into a healthy "Map Data
   not Loaded" state until the first upload lands.

<a id="install-the-ca-certificate"></a>

6. **Install the CA certificate on phones/tablets** (for PWA home screen icon):

   TrailCurrent uses a self-signed TLS certificate. Browsers will let you
   tap through the certificate warning, but iOS requires the CA to be
   trusted at the OS level for the PWA "Add to Home Screen" icon to work.
   Without this step the home screen icon will show a generic letter
   instead of the TrailCurrent logo.

   **Copy the CA certificate from the Pi:**
   ```bash
   scp trailcurrent@trailcurrent01.local:~/data/keys/ca.crt ~/Desktop/TrailCurrent-CA.crt
   ```

   **iOS (iPhone / iPad):**
   1. Transfer `TrailCurrent-CA.crt` to the device (AirDrop, email, or iCloud Drive)
   2. Open the file — iOS will show "Profile Downloaded"
   3. Go to **Settings > General > VPN & Device Management** and install the profile
   4. Go to **Settings > General > About > Certificate Trust Settings** and enable full trust for **TrailCurrent-CA**
   5. Force close Safari (swipe up from the app switcher)
   6. Go to **Settings > Apps > Safari > Clear History and Website Data** to flush any cached certificate state
   7. Reopen Safari, navigate to the app, and use **Share > Add to Home Screen**

   If you are **replacing** a previously installed CA (e.g., after regenerating
   certificates), you must first remove the old profile before installing the
   new one: **Settings > General > VPN & Device Management > TrailCurrent-CA >
   Remove Profile**. Then follow steps 1-7 above.

   **Android:**
   1. Transfer `TrailCurrent-CA.crt` to the device
   2. Open the file — Android will prompt to install it as a CA certificate
   3. Follow the on-screen prompts (you may need to set a screen lock if you haven't already)

   **macOS:**
   1. Double-click `TrailCurrent-CA.crt` to add it to Keychain Access
   2. Find **TrailCurrent-CA** in the System keychain, double-click it
   3. Expand **Trust** and set to **Always Trust**

   **Windows:**
   1. Double-click `TrailCurrent-CA.crt` > **Install Certificate**
   2. Choose **Local Machine** > **Place in: Trusted Root Certification Authorities**

   This only needs to be done once per device. The CA certificate is valid
   for 10 years and will trust any server certificates generated by your Pi.

7. **Access the application:**
   ```
   https://trailcurrent01.local
   ```

---

## Subsequent Updates

When deploying a new version:

1. **Transfer new zip to Pi:**
   ```bash
   scp trailcurrent-deployment-1.1.0.zip trailcurrent@trailcurrent01.local:~
   ```

2. **SSH in, extract, and deploy:**
   ```bash
   ssh trailcurrent@trailcurrent01.local
   unzip -o trailcurrent-deployment-1.1.0.zip
   ./deploy.sh
   ```

   On updates, `deploy.sh` will:
   - Stop existing services
   - Update the system CA trust store if certificates were renewed
   - Load updated Docker images
   - Preserve your `.env`, certificates, and map tiles
   - Restart all services
   - Restart the deployment watcher service
   - Update MCU firmware if new firmware is included

---

## What Persists Across Updates

These items are **PRESERVED** and never deleted by `deploy.sh`:

### Application Configuration
- `.env` — Device-specific secrets and settings
  - MQTT credentials, admin password, encryption keys, hostname

### Security
- `data/keys/` — TLS certificates
  - CA certificate: 10-year validity — no need to regenerate or re-install on devices
  - Server certificate: ~2-year validity (825 days, required by Apple/iOS)
  - To renew the server cert: `./scripts/generate-certs.sh 2` (uses existing CA, no need to re-install CA on devices)

### Data
- `data/maps/versions/<version>/` — Map bundles uploaded via the PWA Maps page (~130 GB per bundle for North America; one current + one previous version retained for rollback)
- `data/maps/current` — Symlink to the active bundle version, updated atomically by `map-watcher` on successful upload
- `data/firmware/` — Peripheral module firmware payloads
- `data/deployments/` — OTA deployment package history
- MongoDB data volume — All application state

**CRITICAL: Never delete `data/` directory during updates!**

---

## What Changes During Updates

- Docker container images (loaded from new tar files)
- Application code (backend, frontend, etc.)
- Container configurations (`config/`)
- Python local code (`local_code/`)
- MCU firmware (if included in package)

---

## Verification After Deployment

```bash
# All containers running
docker compose ps

# No errors in logs
docker compose logs --tail=20

# CAN-to-MQTT bridge running
sudo systemctl status cantomqtt.service

# Deployment watcher running (for cloud OTA updates)
sudo systemctl status deployment-watcher.service

# API responding
curl -k https://localhost/api/health

# Web UI accessible
curl -k -o /dev/null -s -w "%{http_code}" https://localhost/
```

---

## Troubleshooting

### Containers fail to start
```bash
# Check logs for specific service
docker compose logs <service-name>
# Services: backend, frontend, mosquitto, mongodb

# Restart all containers
docker compose down && docker compose up -d --no-build
```

### CAN-to-MQTT bridge not working
```bash
# Check service status
sudo systemctl status cantomqtt.service
sudo journalctl -u cantomqtt.service -f

# Verify CAN bus interface
ip link show can0

# Check local_code .env has correct external hostname
grep MQTT_BROKER_URL ~/local_code/.env
```

### Deployment watcher not picking up cloud updates
```bash
# Check service status and logs
sudo systemctl status deployment-watcher.service
sudo journalctl -u deployment-watcher.service -f

# Verify cloud is configured via the PWA (Settings > Cloud Configuration)
# The watcher logs will show "Cloud not enabled" or "config incomplete" if not set up
```

### Out of disk space
```bash
df -h
docker system prune -f  # Removes unused images, preserves data/
```

### Network issues
```bash
nslookup trailcurrent01.local
ping trailcurrent01.local
```

---

## Reference

- **Initial Device Setup**: [CM5/SETUP.md](CM5/SETUP.md)
- **Firmware Integration**: [FIRMWARE_SETUP.md](FIRMWARE_SETUP.md)
- **OTA System Details**: [OTA_DEPLOYMENT_IMPLEMENTATION.md](OTA_DEPLOYMENT_IMPLEMENTATION.md) (includes MCU firmware OTA and cloud-to-Pi deployment watcher)
- **Development**: [README.md](README.md)
- **Map Tiles**: [DOCS/UpdatingMapTiles.md](DOCS/UpdatingMapTiles.md)
- **Search Dataset (Nominatim)**: [DOCS/UpdatingNominatim.md](DOCS/UpdatingNominatim.md)
