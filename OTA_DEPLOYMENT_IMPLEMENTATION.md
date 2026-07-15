# OTA Firmware Deployment Implementation - Complete

## Overview

The MCU firmware OTA (Over-The-Air) deployment system has been successfully implemented and thoroughly tested. The system automatically updates MCU devices when firmware is included in a deployment package.

### Two independent OTA pipelines

TrailCurrent Headwaters ships with **two independent OTA pipelines**, both triggered from the PWA but with different domains:

1. **Deployment OTA** (this document) — ships code, containers, config, MCU firmware. Triggered from the PWA **Deployments** page. Watched on-device by `deployment-watcher.service`. Runs `deploy.sh` on the CM5 to apply.
2. **Map bundle OTA** — ships map tiles + geocoding index + routing tiles. Triggered from the PWA **Maps** page. Watched on-device by `map-watcher.service`. Applies via atomic-rename + symlink swap, no `deploy.sh` involvement.

The two pipelines share the auth model (Bearer / API-key middleware) and the streamed-upload + SHA256 + MongoDB metadata pattern, but nothing else. They deliberately don't share state, storage paths, MQTT topics, MongoDB collections, or systemd units. **Map data updates run on OSM's cadence; software updates run on ours** — coupling them would either force every code deploy to carry 100+ GB of tiles or hold up a map refresh waiting for a software release.

See [DOCS/UpdatingMaps.md](DOCS/UpdatingMaps.md) for the map bundle pipeline. This document covers only the deployment/firmware pipeline.

## Critical Fixes Applied (Feb 2026)

Three critical issues were discovered and resolved during testing to make OTA deployment fully functional:

### 1. CAN Message Format Mismatch
**Issue**: `trigger_ota_mqtt.py` sent incorrect message format that `can-to-mqtt.py` silently rejected.

**Root Cause**: Message used simple format `{id: 0x0, data: [bytes]}` instead of the required bit-array format with additional metadata fields.

**Fix Implemented**:
- Added `byte_to_bit_array()` function to convert bytes to 8-bit arrays
- Updated message structure to include all required fields:
  - `identifier`: CAN ID as hex string (e.g., "0x0")
  - `data_length_code`: Number of data bytes
  - `data`: Array of bit arrays (each byte becomes [b7,b6,b5,b4,b3,b2,b1,b0])
  - `extd`: Extended CAN ID flag (0)
  - `rtr`: Remote transmission request flag (0)
  - `ss`: Single shot flag (0)
  - `self`: Echo-back flag (0)

**Result**: Messages now pass `can-to-mqtt.py` validation and reach ESP32 via CAN bus. Device successfully receives OTA trigger.

### 2. MQTT Hostname Resolution for Host Scripts
**Issue**: Host scripts couldn't connect to MQTT broker using Docker-internal hostname `mosquitto`.

**Root Cause**:
- Docker containers use internal service name `mosquitto` (resolvable in Docker network)
- Host scripts run outside Docker and cannot resolve this hostname
- Both environments were receiving the same `.env` file with Docker-internal hostname

**Fix Implemented**:
- `deploy.sh` now creates separate configurations:
  1. Root `.env`: Keeps `MQTT_BROKER_URL=mqtts://mosquitto:8883` (for Docker services)
  2. `local_code/.env`: Modified with `sed` to replace `mosquitto` with `TLS_CERT_HOSTNAME` (for host scripts)
- Host scripts (`trigger_ota_mqtt.py`, `get_enabled_modules.py`, `can-to-mqtt.py`) load from `local_code/.env`
- Docker services load from the root `.env`

**Result**: Host scripts successfully connect to MQTT broker using external hostname (e.g., `trailcurrent01.local`)

### 3. Dynamic IP Detection for OTA Upload Server
**Issue**: ESP32 couldn't connect back to the upload server to download firmware.

**Root Cause**:
- Hostname (`trailcurrent01.local`) was used instead of IP address
- ESP32 couldn't resolve or reach the hostname from WiFi network
- Pi's network was on different segment than ESP32, requiring actual IP address

**Fix Implemented**:
- Added Python-based IP detection in `deploy.sh`
- Determines Pi's outbound IP automatically (socket-based detection)
- Falls back to hostname resolution if direct IP detection fails
- Firmware is uploaded via HTTP POST to the device's `/ota` endpoint

**Result**: ESP32 successfully receives firmware over WiFi via HTTP

## Completed Implementation

### 1. UI Bug Fixes (wizard.js)

#### Bug #1: Dropdown Display Names
- **Issue**: Dropdown showed snake_case values (e.g., "power_control_module") instead of friendly names
- **Fix**: Added `MODULE_DISPLAY_NAMES` mapping object that maps snake_case values to display names
- **Result**: Dropdown now shows "Power Control Module" while storing "power_control_module"

#### Bug #2: Duplicate Module Creation
- **Issue**: Adding a module resulted in duplicates due to listener stacking
- **Fix**: Implemented event delegation on `#wizard-content` with `step2ListenersAttached` flag
- **Result**: Single listener persists across re-renders, preventing duplicate handlers

### 2. Helper Scripts

#### get_enabled_modules.py
**Purpose**: Query MongoDB for enabled MCU modules from the host
- Reads connection details from local_code/.env
- Returns JSON array of enabled modules with hostname, type, and name
- Gracefully handles connection failures with empty array fallback

#### trigger_ota_mqtt.py
**Purpose**: Publish OTA trigger messages to MQTT
- Loads MQTT credentials from local_code/.env
- Extracts MAC address from ESP32 hostname format (esp32-XXXXXX)
- Creates and publishes CAN message to can/outbound topic
- Handles both MQTT and MQTTS (TLS) protocols

### 3. deploy.sh Enhancements

#### Step 5.5: Python Dependencies Installation
```bash
$VENV_PATH/bin/pip install -q -r local_code/requirements.txt
```
- Installs pymongo and python-dotenv in the cantomqtt venv
- Runs after Docker services start, before cantomqtt restart
- Uses the same venv that cantomqtt.service uses

#### Step 7: Firmware Deployment
```
for each enabled module with available firmware:
  1. Look up module's type and addr from MongoDB
  2. Select firmware: try {type}_addr{addr}.bin, fall back to {type}.bin
  3. Trigger OTA mode via MQTT message
  4. Wait 8-10 seconds for device to enter OTA
  5. Push firmware via HTTP POST to device's /ota endpoint
  6. Device reboots with new firmware
```

#### deploy_firmware() Function
- Handles individual device OTA updates
- Publishes CAN message via MQTT
- Waits for device readiness
- Uploads firmware via HTTP POST to device's `/ota` endpoint
- Reports success/failure per device

## Data Flow

### OTA Trigger Flow
```
deploy.sh
  |
get_enabled_modules.py (Query MongoDB)
  |
For each enabled module:
  trigger_ota_mqtt.py -> MQTT (can/outbound)
    | [Correct format: identifier, data_length_code, data (bit arrays), extd, rtr, ss, self]
    can-to-mqtt.py -> CAN Bus
      | [Validation passes, message sent]
      Device (receives CAN message with MAC address, enters OTA mode, connects to WiFi)
```

### Firmware Upload Flow
```
deploy.sh (determines Pi's IP dynamically)
  |
HTTP POST firmware.bin to http://<esp32-hostname>.local/ota
  | [Content-Type: application/octet-stream]
  WiFi Network
    | [Device receives firmware binary]
    Device (HTTP server on /ota endpoint)
      | [Writes to OTA partition, verifies]
      Device reboots with new firmware
```

## Configuration

### Environment Configuration

**Root .env** (Docker services — used by docker-compose.yml):
```env
MQTT_BROKER_URL=mqtts://mosquitto:8883          # Docker-internal hostname
MQTT_USERNAME=trailcurrent
MQTT_PASSWORD=mqttpass123
TLS_CERT_HOSTNAME=trailcurrent01.local
```

**local_code/.env** (Host scripts — auto-generated by deploy.sh):
```env
MQTT_BROKER_URL=mqtts://trailcurrent01.local:8883   # External hostname (modified from root .env)
MQTT_USERNAME=trailcurrent
MQTT_PASSWORD=mqttpass123
```

The `deploy.sh` script automatically:
1. Uses root `.env` for Docker services (unchanged — keeps `mosquitto`)
2. Copies root `.env` to `local_code/.env`
3. Uses `sed` to replace `mqtts://mosquitto:` with `mqtts://{TLS_CERT_HOSTNAME}:` in `local_code/.env`

This allows Docker containers and host scripts to each use their appropriate MQTT broker address.

### Module Type to Firmware Mapping
Firmware directories use module type names matching MCU_MODULES IDs. Multi-address modules (Torrent, Picket) store one binary per address:
```
firmware/wired/
├── aftline/aftline.bin
├── ampline/ampline.bin
├── bearing/bearing.bin
├── borealis/borealis.bin
├── milepost/milepost.bin
├── picket/
│   ├── picket_addr0.bin
│   ├── picket_addr1.bin
│   └── ... (up to picket_addr7.bin)
├── plateau/plateau.bin
├── solstice/solstice.bin
├── tapper/tapper.bin
├── therma/therma.bin
└── torrent/
    ├── torrent_addr0.bin
    ├── torrent_addr1.bin
    └── torrent_addr2.bin
```

### Address-Aware Firmware Selection

When deploying firmware OTA, `deploy.sh` selects the correct binary based on the module's `addr` field from MongoDB:

1. Try address-specific: `firmware/wired/{type}/{type}_addr{addr}.bin`
2. Fall back to single binary: `firmware/wired/{type}/{type}.bin`

This ensures multi-address modules get the correct firmware while single-instance modules continue to work unchanged.

## Database Schema

Devices stored in MongoDB (`system_config.mcu_modules`):
```json
{
  "_id": "main",
  "mcu_modules": [
    {
      "hostname": "esp32-8F56D8",
      "type": "torrent",
      "name": "Torrent 00",
      "addr": 0,
      "enabled": true
    },
    {
      "hostname": "esp32-E91EF8",
      "type": "torrent",
      "name": "Torrent 01",
      "addr": 1,
      "enabled": true
    }
  ]
}
```

The `addr` field determines which firmware binary is selected during OTA. For multi-address modules, `deploy.sh` resolves `{type}_addr{addr}.bin` (e.g., `torrent_addr1.bin`). Single-instance modules (addr 0 or unset) fall back to `{type}.bin`.
```

## Prerequisites for OTA Deployment

1. **MongoDB** - Running and accessible at localhost:27017
2. **MQTT Broker** - Running (mosquitto in Docker)
3. **CAN-to-MQTT Bridge** - cantomqtt.service running
4. **jq** - JSON command-line processor (for parsing module list)
5. **mDNS** - Devices accessible via hostname (e.g., esp32-XXXXXX)
6. **Python 3** - For helper scripts
7. **Python packages** - pymongo, paho-mqtt, python-dotenv (installed by deploy.sh)
8. **Network Connectivity** - CRITICAL
   - Pi must be able to reach ESP32's HTTP server (port 80) for firmware upload
   - If Pi is on Ethernet and ESP32 is on WiFi: Ensure router allows communication between networks
   - Devices should be on same network segment or subnets with routing enabled between them

## Deployment Process

### 1. Prepare Firmware
```bash
./create-deployment-package.sh --version=0.0.13
# Firmware bundled at: firmware/wired/power_control_module/firmware.bin
```

### 2. Extract on Pi
```bash
unzip trailcurrent-deployment-0.0.13.zip
```

### 3. Run Deployment
```bash
chmod +x deploy.sh
./deploy.sh
# Step 7 automatically handles OTA updates
```

### 4. Monitor Progress
```
Step 7: Deploying MCU firmware (if present)...
  Firmware directory found, querying enabled devices...
  Deploying firmware to enabled modules...
  Deploying firmware to Torrent 00 (esp32-8F56D8)...   # uses torrent_addr0.bin
  Deploying firmware to Torrent 01 (esp32-E91EF8)...   # uses torrent_addr1.bin
  Deploying firmware to Borealis (esp32-A1B2C3)...     # uses borealis.bin
  Firmware deployment complete
```

## Error Handling

- **No firmware directory**: Skips OTA deployment gracefully
- **No enabled modules**: Logs and continues
- **OTA trigger fails**: Logs error, continues to next device
- **Firmware upload fails**: Logs error, continues to next device
- **Missing jq**: Reports error, suggests installation

## Troubleshooting

### Device Not Entering OTA Mode

**Symptom**: OTA trigger sent, but ESP32 never connects to WiFi

**Diagnosis**:
1. Verify MQTT message is correct format:
   ```bash
   docker exec -it trailcurrent-mosquitto-1 mosquitto_sub -h localhost -t "can/outbound" -u trailcurrent -P mqttpass123 -v
   # Should show message with "identifier", "data_length_code", "data" (bit arrays)
   ```
2. Check CAN bus connection:
   ```bash
   ip link show can0  # Should show "UP" status
   candump can0       # Should see CAN messages
   ```
3. Verify device hostname format:
   - Must be exactly `esp32-XXXXXX` (where X is hexadecimal: 0-9, A-F)
   - Example: `esp32-8F56D8`, `esp32-E91EF8`

### Firmware Upload Fails

**Symptom**: OTA trigger sent successfully, device enters OTA mode and connects to WiFi, but HTTP POST to `/ota` endpoint fails or times out

**This indicates network connectivity issues between Pi and ESP32**:

1. **Check network connectivity**:
   ```bash
   # After device enters OTA mode:
   ping esp32-XXXXXX.local  # Should get response

   # Try reaching the device's HTTP server
   curl -s -o /dev/null -w "%{http_code}" http://esp32-XXXXXX.local/
   ```

2. **If device is unreachable**:
   - Pi and ESP32 may be on different network segments
   - Router may have AP isolation enabled (prevents WiFi clients from reaching wired devices)
   - mDNS may not be resolving — check avahi-daemon is running

3. **Verify device is in OTA mode**:
   - Device should connect to WiFi within 8-10 seconds of trigger
   - Monitor router logs or WiFi client list to confirm connection

### MongoDB Connection Error

1. Verify MongoDB is running:
   ```bash
   docker compose ps | grep mongodb
   ```
2. Check port binding:
   ```bash
   ss -tuln | grep 27017
   ```

### MQTT Connection Issues from Host Scripts

**Symptom**: "Failed to publish OTA trigger: Connection refused" or hostname resolution errors

**Solution**:
1. Verify `local_code/.env` exists and has correct hostname:
   ```bash
   cat local_code/.env | grep MQTT_BROKER_URL
   # Should show: MQTT_BROKER_URL=mqtts://trailcurrent01.local:8883 (external hostname)
   ```
2. Test MQTT connection:
   ```bash
   python3 -c "
   import paho.mqtt.client as mqtt
   import ssl
   client = mqtt.Client()
   client.tls_set('data/keys/ca.pem', cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLSv1_2)
   client.connect('trailcurrent01.local', 8883, 60)
   client.disconnect()
   print('MQTT connection successful')
   "
   ```

## Testing

To test the OTA deployment system:

1. **Add test device to database**:
   ```javascript
   db.system_config.updateOne(
     {_id: "main"},
     {$push: {mcu_modules: {
       hostname: "esp32-TESTID",
       type: "power_control_module",
       name: "Test Device",
       enabled: true
     }}}
   )
   ```

2. **Create test firmware** (copy existing or build new)
3. **Run deploy.sh** with firmware directory present
4. **Monitor** the OTA deployment output
5. **Verify** device has new firmware version

## Performance Characteristics

- **OTA trigger delay**: ~1 second (MQTT publish)
- **Device entry time**: 8-10 seconds (configurable in deploy.sh)
- **Firmware upload time**: 30-60 seconds (depends on firmware size)
- **Total per device**: ~40-70 seconds
- **Multiple devices**: Sequential (one at a time)

## Security Notes

- MQTT uses TLS with self-signed certificates
- MongoDB accessible only from localhost
- CAN bus not authenticated (local network only)
- OTA updates not signed (signed updates planned for future)
- Firmware files stored locally (no external downloads during OTA)

---

## Cloud-to-Pi OTA Deployment (Deployment Watcher)

The deployment watcher enables remote software updates from the TrailCurrent Cloud server. When a deployment zip is uploaded to the cloud, the Pi automatically downloads, verifies, and applies it.

### Architecture

```
TrailCurrentCloud
  → User uploads deployment zip via web UI
  → Cloud publishes MQTT message to rv/deployment/available (QoS 1, retained)
  → Message payload: { id, version, filename, size, sha256, downloadUrl, timestamp }

Raspberry Pi (deployment-watcher.py on host)
  → Reads cloud config from MongoDB via docker exec into backend container
  → Connects to cloud MQTT broker (mqtts://<cloud-host>:8883, CA-signed TLS)
  → Subscribes to rv/deployment/available
  → On message: downloads zip → verifies SHA256 → extracts to ~/ → runs deploy.sh
  → Listens on local MQTT (local/config/cloud_updated) for config changes from the PWA
```

### Cloud Configuration

Cloud credentials are collected through the PWA (setup wizard and settings page) and stored encrypted in MongoDB:

| Field | Description |
|-------|-------------|
| `cloud_enabled` | Toggle cloud connectivity on/off |
| `cloud_url` | Cloud server URL (e.g., `https://cloud.example.com`) |
| `cloud_mqtt_username` | MQTT username for cloud broker |
| `cloud_mqtt_password` | MQTT password (encrypted at rest) |
| `cloud_api_key` | API key for download authentication (`rv_...` format, encrypted at rest) |

The **setup wizard** (Step 1) and **Settings > Cloud Configuration** both allow managing these fields. When any cloud field is saved, the backend publishes a notification to `local/config/cloud_updated` on the local MQTT broker, triggering the deployment watcher to re-read the config.

### How the Deployment Watcher Works

**Files:**
- `local_code/deployment-watcher.py` — Main script
- `local_code/deployment-watcher.service` — Systemd unit file

**Startup sequence:**
1. Loads `.env` from its script directory (same pattern as `can-to-mqtt.py`)
2. Connects to the local MQTT broker (for config change notifications)
3. Reads cloud config from MongoDB via `docker exec` into the backend container
4. If cloud is enabled and config is complete, connects to the cloud MQTT broker
5. Subscribes to `rv/deployment/available` on the cloud broker
6. Enters main loop, waiting for deployment notifications

**On deployment notification:**
1. Parses JSON payload (`id`, `version`, `filename`, `size`, `sha256`, `downloadUrl`)
2. Checks `~/.deployment-watcher-last` — skips if this deployment ID was already applied
3. Constructs download URL: `cloud_url` + `downloadUrl` (e.g., `https://cloud.example.com/api/deployment-download/abc123`)
4. Downloads zip to `/tmp/deployment-<id>.zip` with `Authorization: <cloud_api_key>` header
5. Computes SHA256 during download, compares to expected checksum
6. Extracts zip to `~/`
7. Finds and executes `deploy.sh`
8. Records deployment ID in `~/.deployment-watcher-last`

**On config change (`local/config/cloud_updated`):**
1. Re-reads cloud config from MongoDB via `docker exec`
2. If connection details changed, disconnects and reconnects to cloud MQTT
3. If cloud was disabled, disconnects from cloud MQTT

### Reading Config via Docker Exec

The deployment watcher reads cloud configuration by running a Node.js one-liner inside the backend container via `docker exec`. This approach:
- Reuses the same decryption logic (AES-256-CBC with `ENCRYPTION_KEY`) already available in the container
- Requires no additional Python crypto dependencies
- Follows the same pattern used by `deploy.sh` for WiFi credential provisioning (Step 6.5)

### Systemd Service

```ini
[Unit]
Description=TrailCurrent Deployment Watcher
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=trailcurrent
WorkingDirectory=/home/trailcurrent/local_code
EnvironmentFile=/home/trailcurrent/local_code/.env
ExecStart=/home/trailcurrent/local_code/cantomqtt/bin/python /home/trailcurrent/local_code/deployment-watcher.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

The service uses the same Python venv (`cantomqtt`) as the CAN-to-MQTT bridge and is installed by `deploy.sh` Step 6.1.

### Resilience

- **Duplicate prevention:** Tracks last deployed ID in `~/.deployment-watcher-last` to handle retained MQTT messages
- **Concurrent deployment lock:** File lock at `/tmp/deployment-watcher.lock` prevents overlapping deployments
- **Automatic reconnection:** Paho MQTT handles reconnection to both local and cloud brokers
- **Crash recovery:** Script retries up to 100 times with 30-second backoff between attempts; crashes are logged to `deployment-watcher-crash.log`
- **Graceful shutdown:** Handles SIGTERM/SIGINT for clean disconnection

### Troubleshooting

#### Deployment watcher not running
```bash
sudo systemctl status deployment-watcher.service
sudo journalctl -u deployment-watcher.service -f
```

#### Cloud MQTT connection failing
- Verify cloud config is set via the PWA (Settings > Cloud Configuration)
- Check that the cloud server has CA-signed TLS certificates
- Verify MQTT credentials match the cloud broker's configuration
```bash
sudo journalctl -u deployment-watcher.service | grep "cloud MQTT"
```

#### Deployment downloads failing
- Verify the API key is correct (`rv_...` format)
- Check that the cloud URL is reachable from the Pi
- Look for HTTP error codes in the logs:
```bash
sudo journalctl -u deployment-watcher.service | grep -i "error\|failed\|HTTP"
```

#### Config changes not being picked up
- Verify the backend is publishing to `local/config/cloud_updated`:
```bash
docker exec -it trailcurrent-mosquitto-1 mosquitto_sub -h localhost -t "local/config/cloud_updated" -u trailcurrent -P mqttpass123 -v
```
- Save cloud settings again from the PWA to trigger a notification

---

## Future Enhancements

- [ ] Parallel firmware deployment (multiple devices at once)
- [ ] Firmware version verification before/after update
- [ ] Automatic rollback on deployment failure
- [ ] Signed firmware verification
- [ ] Web UI deployment progress monitoring
- [ ] Wireless device support (WebSocket-based OTA)
- [ ] Firmware pre-download and validation
- [ ] Deployment history logging
- [ ] Device update status tracking
