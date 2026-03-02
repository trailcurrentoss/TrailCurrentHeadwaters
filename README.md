# TrailCurrent In-Vehicle Compute

Dockerized edge gateway with MQTT broker, tile server, and local dashboards. Part of the [TrailCurrent](https://trailcurrent.com) open-source vehicle platform.

## Quick Navigation

| I want to... | Go here |
|--------------|---------|
| Set up a development environment | [Development Setup](#development-setup) below |
| Build a deployment package | [Building Deployment Packages](#building-deployment-packages) below |
| Set up a new Raspberry Pi | [DOCS/RaspberryPiOneTimeSetup.md](DOCS/RaspberryPiOneTimeSetup.md) |
| Deploy or update a Pi | [PI_DEPLOYMENT.md](PI_DEPLOYMENT.md) |
| Set up Node-RED flows | [Node-RED Setup](#node-red-setup) below |
| Understand cloud OTA updates | [OTA_DEPLOYMENT_IMPLEMENTATION.md](OTA_DEPLOYMENT_IMPLEMENTATION.md#cloud-to-pi-ota-deployment-deployment-watcher) |

## Prerequisites

- **Hardware:** [Raspberry Pi 5](https://www.waveshare.com/raspberry-pi-5.htm?aff_id=Trailcurrent) — selected for its industry-standard form factor and well-documented ecosystem, with plenty of headroom for additional expansion in the future
- **Docker Engine** (or Docker Desktop) with the `compose` plugin and `buildx`
- **Git**

---

## Development Setup

This gets your local development environment running with hot-reload and debugging enabled. All services build from local Dockerfiles for the host platform.

### Step 1: Clone and configure environment

```bash
git clone <REPO_URL>
cd TrailCurrentInVehicleCompute
git config core.hooksPath .githooks
docker buildx use default
cp .env.example .env
```

### Step 2: Generate secure random values

```bash
# Generate ENCRYPTION_KEY (64 character hex string)
openssl rand -hex 32

# Generate NODE_RED_CREDENTIAL_SECRET (128 character hex string)
openssl rand -hex 64
```

Copy these values into the corresponding fields in `.env`.

### Step 3: Edit `.env` and set your values

- `NODE_RED_ADMIN_USER` - Your Node-RED admin username
- `NODE_RED_ADMIN_PASSWORD` - Your desired admin password (plain text - auto-hashed at startup)
- `ENCRYPTION_KEY` - Paste the value from step 2
- `NODE_RED_CREDENTIAL_SECRET` - Paste the value from step 2
- `ADMIN_PASSWORD` - Strong password for system admin access
- `MQTT_USERNAME` - Username for MQTT broker
- `MQTT_PASSWORD` - Password for MQTT broker (plain text - auto-added to broker at startup)
- `TLS_CERT_HOSTNAME` - Your device's hostname (e.g., `trailcurrent01.local`)

### Step 4: Generate SSL certificates

```bash
./scripts/generate-certs.sh
# Select option 1 for Development or option 2 for Production
```

See [SSL Certificate Generation](#ssl-certificate-generation) for details.

### Step 5: Obtain map tiles

The tileserver requires a pre-generated mbtiles file to serve map data.

```bash
mkdir -p data/tileserver
# Place your tiles file at: data/tileserver/map.mbtiles
```

To generate tiles from OpenStreetMap data, use the **PbfTileConverter** utility:
[../../Utilities/PbfTileConverter](../../Utilities/PbfTileConverter)

Or copy `map.mbtiles` from an existing team member's machine.

### Step 6: Build and start in development mode

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

The `--build` flag ensures all images are built from local Dockerfiles for your host platform. Development mode enables:
- Hot-reload for frontend and backend code changes
- Node.js debug port (9229) for VSCode debugger attachment
- MongoDB accessible on localhost:27017
- Node-RED accessible on localhost:1880
- Tileserver styles hot-reload

Containers will automatically:
- Generate the bcrypt hash for Node-RED from your plain password
- Create the mosquitto password file from your credentials
- Initialize all services with consistent credentials
- Mount the SSL certificates for HTTPS/MQTTS communication
- Load map tiles from the mbtiles file

### Verification Checklist

After startup, verify all services are healthy:

```bash
# All 7 containers should be running
docker compose ps

# Frontend loads
curl -k https://localhost/

# Tileserver healthy
curl http://localhost:8080/health

# Map style served
curl -s http://localhost:8080/styles/3d-dark/style.json | head -5

# Font glyphs available
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/fonts/Noto%20Sans%20Regular/0-255.pbf"
# Expected: 200
```

**Access the web UI:** https://localhost (accept the self-signed certificate warning)

### Security Notes

- `.env` is in `.gitignore` - will never be committed
- Use strong, randomly generated passwords for all credentials
- All values in `.env.example` are placeholders only
- Passwords are auto-hashed/auto-configured at container startup

---

## Building Deployment Packages

For creating the offline zip that gets deployed to Raspberry Pis. The deployment pipeline builds Docker images for ARM64, packages them as tar files, and creates a self-contained zip.

```bash
# Build everything and create the zip
./create-deployment-package.sh --version=1.0.0
```

This will:
1. Build all 6 service images for `linux/arm64` (plus pull `mongo:7`)
2. Save images as `.tar` files in `images/`
3. Fetch MCU firmware from GitHub releases (if available)
4. Package everything into `trailcurrent-deployment-1.0.0.zip`

**Transfer and deploy to Pi:**
```bash
scp trailcurrent-deployment-1.0.0.zip trailcurrent@pi.local:~
# On the Pi:
unzip trailcurrent-deployment-1.0.0.zip && chmod +x deploy.sh && ./deploy.sh
```

See [PI_DEPLOYMENT.md](PI_DEPLOYMENT.md) for detailed deployment instructions.

---

## Project Structure

```
containers/          Dockerfiles for each service
  frontend/          nginx + MapLibre GL web UI
  backend/           Node.js Express API
  mosquitto/         Eclipse Mosquitto MQTT broker
  node-red/          Node-RED flow engine
  noderedproxy/      nginx HTTPS proxy for Node-RED
  tileserver/        Custom tile server (styles, fonts, sprites)
config/              Version-controlled service configurations
  mosquitto/         mosquitto.conf
  node-red/          settings.js, starter-flow.json, cloud-workflow.json
data/                Runtime data (gitignored)
  keys/              TLS certificates
  tileserver/        map.mbtiles
  node-red/          Node-RED flows
local_code/          Python host services (CAN-to-MQTT bridge, deployment watcher, OTA helpers)
scripts/             Utility scripts (cert generation)
```

**Docker Compose files:**
- `docker-compose.yml` — Production orchestration (7 services)
- `docker-compose.dev.yml` — Development overrides (hot-reload, debug ports)

---

## SSL Certificate Generation

The application uses TLS/SSL for secure communication. Certificates must be generated before running `docker compose up`. The `scripts/generate-certs.sh` script supports two modes:

### Quick Reference

```bash
# Interactive mode (prompts for selection)
./scripts/generate-certs.sh

# Non-interactive mode (development)
./scripts/generate-certs.sh 1

# Non-interactive mode (production)
./scripts/generate-certs.sh 2

# Using environment variable
CERT_MODE=2 ./scripts/generate-certs.sh

# Show help
./scripts/generate-certs.sh --help
```

### Development Certificates (Local Testing)

For local development with `localhost` or `127.0.0.1`:

```bash
./scripts/generate-certs.sh 1
```

**Development certificates include:**
- DNS names: `localhost`, plus your `TLS_CERT_HOSTNAME` from `.env`
- IP addresses: `127.0.0.1`, `::1` (IPv6 localhost)

**Access locally:**
```
https://localhost           - Frontend (HTTPS)
https://localhost:8443      - Node-RED (HTTPS)
```

Accept the self-signed certificate warning in your browser (one-time).

### Production Certificates (Deployment)

For deployed devices accessed from other machines on the network:

1. **Set your device's hostname** in `.env`:
   ```
   TLS_CERT_HOSTNAME=trailcurrent01.local
   ```

2. **Generate production certificates:**
   ```bash
   ./scripts/generate-certs.sh 2
   ```

3. **Install the CA certificate** (`data/keys/ca.crt`) on devices that will access the web UI.

4. **Access from the network:**
   ```
   https://trailcurrent01.local       - Web UI
   mqtts://trailcurrent01.local:8883  - MQTT broker
   ```

### Regenerating Certificates

Run the script anytime to regenerate. It will prompt before overwriting existing certificates and create backups.

```bash
./scripts/generate-certs.sh
docker compose restart
```

Certificates are automatically protected by `.gitignore`. Never commit them to version control.

---

## Docker

### Running Containers

```bash
# Development mode (hot-reload, debug ports) — always use --build to ensure local images
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# Production mode (after verification)
docker compose up -d --build
```

### Docker Networking

**MongoDB Access:**
- Services communicate via Docker's internal network: `mongodb:27017`
- MongoDB is NOT exposed to localhost (127.0.0.1)
- To access MongoDB from your host: `docker compose exec mongodb mongosh`

Docker containers use service names for inter-container communication.

### Data Persistence

The `data/` directory contains all persistent application data:

- **SSL certificates** (`data/keys/`) — Generated once, valid for 10 years
- **Map tiles** (`data/tileserver/map.mbtiles`) — Set up once, rarely updated
- **Node-RED flows** (`data/node-red/`) — User-created flows and settings
- **MongoDB** — Named volume `mongodb-data`, persists across rebuilds

**Never delete `data/` during updates** unless performing a complete reset. All data persists across container rebuilds.

**Updating the Application (No Data Loss):**
```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
# Certificates, .env, map tiles, and Node-RED flows are preserved
```

---

## Node-RED Setup

Node-RED bridges CAN bus messages to local MQTT topics that the PWA consumes. Flow templates are stored in `config/node-red/`.

### What the Starter Flow Does

- **Inbound:** Subscribes to `can/inbound`, routes by CAN identifier, and publishes parsed data to `local/*` topics:
  - Light status (8 channels) → `local/lights/{1-8}/status`
  - Temperature & humidity → `local/airquality/temphumid`
  - GPS coordinates, altitude, details, time → `local/gps/*`
- **Outbound:** Subscribes to `local/lights/{1-8}/command` (from PWA light toggles) and sends CAN messages to `can/outbound`
- **Test controls:** Manual inject nodes for toggling lights, setting brightness, and all-on/all-off

### Automatic Loading (First Startup)

On first startup, the backend automatically detects that Node-RED has no flows and injects the starter flow via the Node-RED Admin API. Existing installations with flows already present are not affected.

### Cloud Workflow (Auto-Injected)

When cloud synchronization is enabled in Settings, the backend automatically injects a "Cloud Workflow" tab into Node-RED that bridges messages between the local and cloud MQTT brokers:

- **Cloud → Local (Commands):** `rv/lights/N/command` → CAN toggle, `rv/thermostat/command` → local passthrough
- **Local → Cloud (Status):** Light status, air quality, GPS, energy, thermostat — each rate-limited to 30 msg/sec

The cloud workflow is automatically removed when cloud is disabled or the system config is reset. The template is at `config/node-red/cloud-workflow.json`.

### Manual Import (Existing Installations)

1. Open Node-RED at `https://<hostname>:8443`
2. Click the hamburger menu (top right) → **Import**
3. Select **Upload** and choose `config/node-red/starter-flow.json`
4. Click **Import**

### Configure MQTT Credentials

After importing, Node-RED needs MQTT credentials to connect to Mosquitto:

1. Double-click any MQTT node (e.g. "CAN Inbound")
2. Click the pencil icon next to **Local MQTT Broker**
3. Go to the **Security** tab
4. Enter your `MQTT_USERNAME` and `MQTT_PASSWORD` (same values from `.env`)
5. Click **Update**, then click the red **Deploy** button

The broker is pre-configured to connect to `mosquitto:8883` via Docker internal DNS with TLS.

---

## Debugging

### VSCode Node.js Debugger

The backend Node.js server can be debugged using VSCode's built-in debugger. The setup uses `--inspect-brk` to pause the application at startup, waiting for the debugger to attach before continuing execution.

#### Quick Start

1. **Open the project in VSCode** (if not already open)

2. **Start debugging:**
   - Open the Debug panel (Ctrl+Shift+D / Cmd+Shift+D)
   - Select "Backend Debug" from the dropdown
   - Click the green "Start Debugging" button (or press F5)

3. **What happens automatically:**
   - Docker containers start in development mode (`docker-compose -f docker-compose.yml -f docker-compose.dev.yml up`)
   - Backend container starts with `--inspect-brk=0.0.0.0:9229` (pauses at startup)
   - VSCode automatically attaches the debugger to port 9229
   - Application resumes and you can now set breakpoints

4. **Stop debugging:**
   - Press Shift+F5 or click the stop button in the debug panel
   - Docker containers are automatically stopped (`docker-compose down`)

#### Manual Debugging (Without VSCode Integration)

```bash
# Start containers in development mode
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# In VSCode, attach manually:
# - Open Debug panel (Ctrl+Shift+D)
# - Select "Backend Debug"
# - Click "Start Debugging" (F5)
```

#### Debugging Configuration

The debugging setup is configured in `.vscode/launch.json`:

```json
{
  "name": "Backend Debug",
  "type": "node",
  "request": "attach",
  "port": 9229,
  "address": "localhost",
  "restart": true,
  "skipFiles": ["<node_internals>/**"],
  "outFiles": ["${workspaceFolder}/containers/backend/src/**/*.js"]
}
```

#### Troubleshooting

**"Connection refused" error:**
- Ensure containers are running: `docker compose ps`
- Check backend container logs: `docker compose logs backend`
- Verify port 9229 is exposed: `docker compose port backend 9229`

**Breakpoints not being hit:**
- Verify the file path matches exactly (case-sensitive on Linux)
- Check development mode: `docker compose config | grep "NODE_ENV"`

**Backend container exits immediately:**
- Check logs: `docker compose logs backend`
- Ensure `.env` file is set up correctly
- Verify MongoDB: `docker compose logs mongodb`

**Mosquitto or other containers failing to start:**
- Check logs: `docker compose logs mosquitto`
- Certificate permissions: `chmod 644 data/keys/*.key data/keys/*.crt data/keys/*.pem`

**Port conflicts:**
- Clean up: `docker system prune -f --volumes`
- Verify no containers running: `docker ps -a`
- Restart Docker: `sudo systemctl restart docker`

#### Tips for Effective Debugging

1. **Breakpoint in startServer()** in `src/index.js` to debug initialization
2. **Route breakpoints** in route handlers (e.g., `src/routes/thermostat.js`)
3. **MQTT debugging** via breakpoints in `src/mqtt.js`
4. **Database debugging** via breakpoints in `src/db/init.js`
5. **Conditional breakpoints**: Right-click a breakpoint to set conditions
6. **Logpoints**: Right-click line number to log values without pausing

---
