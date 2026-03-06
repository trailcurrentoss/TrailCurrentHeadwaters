#!/bin/bash
set -e

# TrailCurrent Raspberry Pi One-Time Setup Script
#
# Run this ONCE on a fresh Raspberry Pi OS Lite installation.
# It installs all dependencies needed to run the TrailCurrent system.
#
# What this script does:
#   1. Updates the system
#   2. Installs system packages (jq, openssl, python3, can-utils, avahi, etc.)
#   3. Installs Docker and Docker Compose plugin
#   4. Enables SPI interface (required for MCP2515 CAN controller)
#   5. Configures MCP2515 CAN bus overlay (12MHz crystal, SPI0/CE0, GPIO25 interrupt)
#   6. Installs can0 systemd service to auto-start on boot (500kbps)
#   7. Adds user to the docker group
#   8. Configures Pi 5 to auto-boot on power (no power button needed)
#   9. Disables unused hardware for power savings (GPU, HDMI, BT, WiFi, USB, audio)
#  10. Sets up the Python virtual environment for the CAN-to-MQTT bridge
#  11. Installs the cantomqtt systemd service
#  12. Creates the deployment directory structure
#  13. Generates TLS/SSL certificates using the Pi's hostname
#
# Prerequisites:
#   - Raspberry Pi OS Lite 64-bit flashed via Pi Imager
#   - User created in Pi Imager (with SSH and sudo)
#
# Usage:
#   sudo ./setup-pi.sh
#
# After running this script:
#   1. Reboot the Pi (required for SPI and CAN overlay to take effect)
#   2. Transfer a deployment package and run deploy.sh
#
# Hardware assumptions:
#   - MCP2515 CAN controller on SPI0/CE0 with 12MHz crystal, 2MHz SPI clock
#   - Interrupt on GPIO25 (default for mcp2515-can0 overlay)
#   - If your hardware differs, edit the MCP2515 CONFIGURATION section below.

# ============================================================================
# MCP2515 CONFIGURATION - Edit these if your hardware differs
# ============================================================================
MCP2515_OSCILLATOR=12000000    # Crystal frequency in Hz (12MHz)
MCP2515_INTERRUPT=25           # GPIO pin for MCP2515 INT (BCM numbering)
MCP2515_SPI_FREQ=2000000       # SPI clock limit in Hz (2MHz)
CAN_BITRATE=500000             # CAN bus bitrate in bps
# ============================================================================

# Must run as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root (sudo ./setup-pi.sh)"
    exit 1
fi

# Detect the user who invoked sudo — all paths are derived from this
CURRENT_USER="${SUDO_USER:?ERROR: Could not detect user. Run with: sudo ./setup-pi.sh}"
USER_HOME="/home/$CURRENT_USER"

echo "=========================================="
echo "TrailCurrent Raspberry Pi One-Time Setup"
echo "=========================================="
echo ""
echo "Setting up for user: $CURRENT_USER ($USER_HOME)"
echo ""

# Detect Pi model for config.txt location
# Pi 5 and newer Bookworm images use /boot/firmware/config.txt
# Older Pi 4 images use /boot/config.txt
if [ -f /boot/firmware/config.txt ]; then
    BOOT_CONFIG="/boot/firmware/config.txt"
elif [ -f /boot/config.txt ]; then
    BOOT_CONFIG="/boot/config.txt"
else
    echo "ERROR: Could not find boot config.txt"
    exit 1
fi
echo "Detected boot config: $BOOT_CONFIG"

# -------------------------------------------
# Step 1: Update system packages
# -------------------------------------------
echo ""
echo "Step 1: Updating system packages..."
apt-get update
apt-get upgrade -y

# -------------------------------------------
# Step 2: Install system dependencies
# -------------------------------------------
echo ""
echo "Step 2: Installing system dependencies..."
apt-get install -y \
    jq \
    openssl \
    python3 \
    python3-venv \
    python3-pip \
    can-utils \
    avahi-daemon \
    avahi-utils \
    curl \
    unzip

echo "  System packages installed"

# -------------------------------------------
# Step 3: Install Docker
# -------------------------------------------
echo ""
echo "Step 3: Installing Docker..."

if command -v docker &> /dev/null; then
    echo "  Docker is already installed: $(docker --version)"
else
    # Install Docker using the official convenience script
    curl -fsSL https://get.docker.com | sh

    echo "  Docker installed: $(docker --version)"
fi

# Install Docker Compose plugin if not present
if docker compose version &> /dev/null; then
    echo "  Docker Compose plugin already installed: $(docker compose version)"
else
    apt-get install -y docker-compose-plugin
    echo "  Docker Compose plugin installed"
fi

# Enable Docker to start on boot
systemctl enable docker

echo "  Docker configured to start on boot"

# -------------------------------------------
# Step 4: Enable SPI interface
# -------------------------------------------
echo ""
echo "Step 4: Enabling SPI interface..."

# raspi-config nonint: 0 = enable, 1 = disable
if raspi-config nonint get_spi 2>/dev/null | grep -q "0"; then
    echo "  SPI is already enabled"
else
    raspi-config nonint do_spi 0
    echo "  SPI enabled (reboot required to take effect)"
fi

# -------------------------------------------
# Step 5: Configure MCP2515 CAN bus overlay
# -------------------------------------------
echo ""
echo "Step 5: Configuring MCP2515 CAN bus overlay..."

MCP2515_OVERLAY="dtoverlay=mcp2515-can0,oscillator=${MCP2515_OSCILLATOR},interrupt=${MCP2515_INTERRUPT},spimaxfrequency=${MCP2515_SPI_FREQ}"

if grep -q "dtoverlay=mcp2515" "$BOOT_CONFIG"; then
    echo "  MCP2515 overlay already configured in $BOOT_CONFIG"
    echo "  Existing line: $(grep 'dtoverlay=mcp2515' "$BOOT_CONFIG")"
else
    # Add the overlay to config.txt
    echo "" >> "$BOOT_CONFIG"
    echo "# TrailCurrent CAN bus controller (MCP2515 on SPI0/CE0)" >> "$BOOT_CONFIG"
    echo "$MCP2515_OVERLAY" >> "$BOOT_CONFIG"
    echo "  Added MCP2515 overlay to $BOOT_CONFIG"
    echo "  $MCP2515_OVERLAY"
fi

# Also ensure SPI is enabled via dtparam (belt and suspenders with raspi-config)
if grep -q "^dtparam=spi=on" "$BOOT_CONFIG"; then
    echo "  SPI dtparam already set"
else
    # Check if there's a commented-out version
    if grep -q "^#dtparam=spi=on" "$BOOT_CONFIG"; then
        sed -i 's/^#dtparam=spi=on/dtparam=spi=on/' "$BOOT_CONFIG"
        echo "  Uncommented dtparam=spi=on in $BOOT_CONFIG"
    fi
    # raspi-config should have handled this, but verify
fi

# -------------------------------------------
# Step 6: Configure can0 interface to auto-start on boot
# -------------------------------------------
echo ""
echo "Step 6: Configuring can0 network interface..."

CAN_SERVICE="/etc/systemd/system/can0.service"

if [ -f "$CAN_SERVICE" ]; then
    echo "  can0.service already exists"
else
    cat > "$CAN_SERVICE" << EOF
[Unit]
Description=CAN bus interface can0
Requires=sys-subsystem-net-devices-can0.device
After=sys-subsystem-net-devices-can0.device

[Service]
Type=oneshot
RemainAfterExit=yes
# Delay to let the MCP2515 crystal oscillator stabilize after power-on.
# Without this, the chip fails to enter config mode (~7s into boot).
ExecStartPre=/bin/sleep 15
ExecStart=/sbin/ip link set can0 type can bitrate ${CAN_BITRATE}
ExecStart=/sbin/ip link set can0 up
ExecStop=/sbin/ip link set can0 down
Restart=on-failure
RestartSec=10
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable can0.service
    echo "  Created and enabled can0.service (can0 at ${CAN_BITRATE} bps)"
fi

# Clean up legacy ifupdown config if present (from earlier versions of this script)
OLD_IFACE_FILE="/etc/network/interfaces.d/can0"
if [ -f "$OLD_IFACE_FILE" ]; then
    rm -f "$OLD_IFACE_FILE"
    echo "  Removed legacy ifupdown config ($OLD_IFACE_FILE)"
fi

# -------------------------------------------
# Step 7: Add user to docker group
# -------------------------------------------
echo ""
echo "Step 7: Configuring user for Docker access..."

# The user is created via Raspberry Pi Imager with sudo and SSH already configured.
# We just need to add them to the docker group so they can run Docker without sudo.
if groups "$CURRENT_USER" | grep -q docker; then
    echo "  User '$CURRENT_USER' already in docker group"
else
    usermod -aG docker "$CURRENT_USER"
    echo "  Added '$CURRENT_USER' to docker group"
fi

# -------------------------------------------
# Step 8: Configure auto-boot on power (Pi 5)
# -------------------------------------------
echo ""
echo "Step 8: Configuring auto-boot on power..."

# Pi 5 has a PMIC that waits for a power button press by default.
# In a headless/vehicle install with no power button, the Pi must boot
# automatically when power is applied.
# Pi 4 already auto-boots on power — no change needed.
if [ -f /proc/device-tree/model ] && grep -q "Raspberry Pi 5" /proc/device-tree/model; then
    EEPROM_CONFIG=$(rpi-eeprom-config 2>/dev/null || true)

    if echo "$EEPROM_CONFIG" | grep -q "WAKE_ON_GPIO=0"; then
        echo "  Auto-boot on power already configured"
    else
        # Write updated EEPROM config
        EEPROM_TMP=$(mktemp)
        echo "$EEPROM_CONFIG" | grep -v "^WAKE_ON_GPIO=" | grep -v "^POWER_OFF_ON_HALT=" > "$EEPROM_TMP"
        echo "WAKE_ON_GPIO=0" >> "$EEPROM_TMP"
        echo "POWER_OFF_ON_HALT=1" >> "$EEPROM_TMP"
        rpi-eeprom-config --apply "$EEPROM_TMP"
        rm -f "$EEPROM_TMP"
        echo "  EEPROM configured: auto-boot on power, full power-off on halt"
        echo "  (Takes effect after reboot)"
    fi
else
    echo "  Not a Pi 5 — auto-boots on power by default, no change needed"
fi

# -------------------------------------------
# Step 9: Power savings — disable unused hardware
# -------------------------------------------
echo ""
echo "Step 9: Disabling unused hardware for power savings..."

# This is a headless system using only Ethernet and SPI (CAN bus).
# Disable everything else to reduce power draw (~250-450 mW savings).
POWER_OVERLAYS=(
    "dtoverlay=disable-bt"
    "dtoverlay=disable-wifi"
)
POWER_PARAMS=(
    "dtparam=audio=off"
    "dtparam=act_led_trigger=none"
    "dtparam=act_led_activelow=off"
    "gpu_mem=16"
)

for overlay in "${POWER_OVERLAYS[@]}"; do
    if grep -q "^${overlay}$" "$BOOT_CONFIG"; then
        echo "  Already set: $overlay"
    else
        echo "$overlay" >> "$BOOT_CONFIG"
        echo "  Added: $overlay"
    fi
done

for param in "${POWER_PARAMS[@]}"; do
    key="${param%%=*}"
    if grep -q "^${key}=" "$BOOT_CONFIG"; then
        # Replace existing line
        sed -i "s|^${key}=.*|${param}|" "$BOOT_CONFIG"
        echo "  Updated: $param"
    else
        echo "$param" >> "$BOOT_CONFIG"
        echo "  Added: $param"
    fi
done

# Pi 5: disable both HDMI ports via overlays
if [ -f /proc/device-tree/model ] && grep -q "Raspberry Pi 5" /proc/device-tree/model; then
    for hdmi in "dtoverlay=disable-hdmi0" "dtoverlay=disable-hdmi1"; do
        if grep -q "^${hdmi}$" "$BOOT_CONFIG"; then
            echo "  Already set: $hdmi"
        else
            echo "$hdmi" >> "$BOOT_CONFIG"
            echo "  Added: $hdmi"
        fi
    done
fi

# Disable USB hub at boot via a one-shot systemd service.
# On Pi 4 the hub is on bus 1-1; on Pi 5 it may differ.
USB_SERVICE="/etc/systemd/system/disable-usb.service"
if [ -f "$USB_SERVICE" ]; then
    echo "  disable-usb.service already exists"
else
    cat > "$USB_SERVICE" << 'EOF'
[Unit]
Description=Disable USB hub to save power
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'for port in /sys/bus/usb/devices/[0-9]-[0-9]; do [ -e "$port/driver" ] && echo "$(basename $port)" > /sys/bus/usb/drivers/usb/unbind || true; done'

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable disable-usb.service
    echo "  Created and enabled disable-usb.service"
fi

echo "  Power savings configured (reboot required)"

# -------------------------------------------
# Step 10: Set up Python virtual environment
# -------------------------------------------
echo ""
echo "Step 10: Setting up Python virtual environment..."

LOCAL_CODE_DIR="$USER_HOME/local_code"
VENV_PATH="$LOCAL_CODE_DIR/cantomqtt"

# Run as the actual user so all files are owned correctly from the start
sudo -u "$CURRENT_USER" mkdir -p "$LOCAL_CODE_DIR"

if [ -d "$VENV_PATH" ]; then
    echo "  Virtual environment already exists at $VENV_PATH"
else
    sudo -u "$CURRENT_USER" python3 -m venv "$VENV_PATH"
    echo "  Created virtual environment at $VENV_PATH"
fi

# Install Python dependencies if requirements.txt is available alongside this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_REQUIREMENTS="$SCRIPT_DIR/../local_code/requirements.txt"

if [ -f "$REPO_REQUIREMENTS" ]; then
    sudo -u "$CURRENT_USER" "$VENV_PATH/bin/pip" install -q -r "$REPO_REQUIREMENTS"
    echo "  Python dependencies installed from $REPO_REQUIREMENTS"
else
    echo "  No requirements.txt found at $REPO_REQUIREMENTS"
    echo "  Python dependencies will be installed during first deployment (deploy.sh)"
fi

# -------------------------------------------
# Step 11: Install cantomqtt systemd service
# -------------------------------------------
echo ""
echo "Step 11: Installing cantomqtt systemd service..."

SERVICE_SRC="$SCRIPT_DIR/../local_code/can-to-mqtt.service"
SERVICE_DEST="/etc/systemd/system/cantomqtt.service"

if [ -f "$SERVICE_SRC" ]; then
    # Replace hardcoded username/paths with the actual user
    sed "s|/home/trailcurrent|$USER_HOME|g; s|User=trailcurrent|User=$CURRENT_USER|g" \
        "$SERVICE_SRC" > "$SERVICE_DEST"
    systemctl daemon-reload
    systemctl enable cantomqtt.service
    echo "  cantomqtt.service installed and enabled"
    echo "  (It will start after first deployment provides the config and code)"
else
    echo "  can-to-mqtt.service not found at $SERVICE_SRC"
    echo "  Service will be installed during first deployment"
fi

# -------------------------------------------
# Step 12: Create deployment directory structure
# -------------------------------------------
echo ""
echo "Step 12: Creating deployment directory structure..."

# Run as the actual user so all files are owned correctly from the start
DEPLOY_DIR="$USER_HOME"
sudo -u "$CURRENT_USER" mkdir -p "$DEPLOY_DIR/data/keys"
sudo -u "$CURRENT_USER" mkdir -p "$DEPLOY_DIR/data/tileserver"
sudo -u "$CURRENT_USER" mkdir -p "$DEPLOY_DIR/data/node-red"

echo "  Created $DEPLOY_DIR with data subdirectories"

# -------------------------------------------
# Step 13: Generate TLS/SSL certificates
# -------------------------------------------
echo ""
echo "Step 13: Generating TLS/SSL certificates..."

KEYS_DIR="$DEPLOY_DIR/data/keys"
TLS_HOSTNAME="$(hostname).local"
VALIDITY_DAYS=3650

if [ -f "$KEYS_DIR/server.crt" ] && [ -f "$KEYS_DIR/server.key" ]; then
    echo "  Certificates already exist, skipping"
else
    echo "  Using hostname: $TLS_HOSTNAME"

    # Generate CA key
    openssl genrsa -out "$KEYS_DIR/ca.key" 2048 2>/dev/null
    chmod 644 "$KEYS_DIR/ca.key"

    # Generate CA certificate
    openssl req -new -x509 -days $VALIDITY_DAYS \
        -key "$KEYS_DIR/ca.key" \
        -out "$KEYS_DIR/ca.crt" \
        -subj "/C=US/ST=State/L=City/O=TrailCurrent/OU=Engineering/CN=TrailCurrent-CA" 2>/dev/null
    chmod 644 "$KEYS_DIR/ca.crt"
    cp "$KEYS_DIR/ca.crt" "$KEYS_DIR/ca.pem"

    # Generate server key
    openssl genrsa -out "$KEYS_DIR/server.key" 2048 2>/dev/null
    chmod 644 "$KEYS_DIR/server.key"

    # Generate CSR with SANs
    SAN_LIST="DNS:$TLS_HOSTNAME,IP:127.0.0.1,IP:::1"
    openssl req -new \
        -key "$KEYS_DIR/server.key" \
        -out "$KEYS_DIR/server.csr" \
        -subj "/C=US/ST=State/L=City/O=TrailCurrent/OU=Engineering/CN=$TLS_HOSTNAME" \
        -addext "subjectAltName=$SAN_LIST" 2>/dev/null

    # Sign certificate with CA
    openssl x509 -req -days $VALIDITY_DAYS \
        -in "$KEYS_DIR/server.csr" \
        -CA "$KEYS_DIR/ca.crt" \
        -CAkey "$KEYS_DIR/ca.key" \
        -CAcreateserial \
        -out "$KEYS_DIR/server.crt" \
        -copy_extensions copyall 2>/dev/null
    chmod 644 "$KEYS_DIR/server.crt"

    # Cleanup temp files
    rm -f "$KEYS_DIR/server.csr" "$KEYS_DIR/ca.srl"

    # Set ownership
    chown "$CURRENT_USER:$CURRENT_USER" "$KEYS_DIR"/*

    echo "  Certificates generated for $TLS_HOSTNAME (valid 10 years)"
fi

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "Installed:"
echo "  - System packages: jq, openssl, python3, can-utils, avahi, curl, unzip"
echo "  - Docker $(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',')"
echo "  - Docker Compose $(docker compose version 2>/dev/null | cut -d' ' -f4)"
echo "  - SPI interface: enabled"
echo "  - CAN overlay: mcp2515-can0 (${MCP2515_OSCILLATOR}Hz crystal, GPIO${MCP2515_INTERRUPT} interrupt)"
echo "  - CAN service: can0.service (auto-starts can0 at ${CAN_BITRATE} bps)"
echo "  - User: $CURRENT_USER added to docker group"
echo "  - Boot: auto-boot on power (Pi 5 EEPROM configured)"
echo "  - Power: disabled GPU/HDMI/Bluetooth/WiFi/USB/audio"
echo "  - Python venv: $VENV_PATH"
echo "  - Service: cantomqtt.service (enabled, starts after deployment)"
echo "  - TLS certs: $(hostname).local (valid 10 years)"
echo ""
echo "IMPORTANT: You must REBOOT for SPI and CAN overlay changes to take effect."
echo ""
echo "  sudo reboot"
echo ""
echo "After reboot:"
echo "  1. Verify CAN interface:  ip link show can0"
echo "  2. Verify SPI:            ls /dev/spidev0.*"
echo "  3. Transfer deployment package to $DEPLOY_DIR/"
echo "  4. Run deploy.sh"
echo ""
