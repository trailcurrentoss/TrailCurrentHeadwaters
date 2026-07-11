#!/bin/bash
set -e

# TrailCurrent First-Boot Setup
#
# Runs once on first boot to configure per-device settings that require
# actual hardware (EEPROM) or per-device uniqueness (TLS certificates).
# Controlled by trailcurrent-firstboot.service with a ConditionPathExists
# guard so it only runs once.
#
# Storage layout after first boot:
#   NVMe (/) - OS, packages, Docker, app data, Python venv
#   The root partition is expanded to fill the entire NVMe drive.

LOG_TAG="trailcurrent-firstboot"
log() { echo "$1"; logger -t "$LOG_TAG" "$1"; }

# Detect the first non-root user (created by rpi-image-gen user layer)
TC_USER=$(getent passwd 1000 | cut -d: -f1)
if [ -z "$TC_USER" ]; then
    log "ERROR: No user with UID 1000 found"
    exit 1
fi
TC_HOME="/home/$TC_USER"

log "Starting first-boot setup for user: $TC_USER"

# -------------------------------------------
# 1. Expand root partition to fill the NVMe
# -------------------------------------------
log "Expanding root partition to fill NVMe drive..."

ROOT_DEV=$(findmnt -n -o SOURCE /)
ROOT_DISK="/dev/$(lsblk -n -o PKNAME "$ROOT_DEV")"
# Extract partition number from device name (e.g., /dev/nvme0n1p2 -> 2)
ROOT_PARTNUM=$(echo "$ROOT_DEV" | sed 's/.*[^0-9]\([0-9]\+\)$/\1/')

if [ -n "$ROOT_DISK" ] && [ -n "$ROOT_PARTNUM" ]; then
    if growpart "$ROOT_DISK" "$ROOT_PARTNUM" 2>/dev/null; then
        resize2fs "$ROOT_DEV"
        log "  Root partition expanded: $(lsblk -n -o SIZE "$ROOT_DEV" | tr -d ' ')"
    else
        log "  Root partition already fills the drive (growpart returned no change)"
    fi
else
    log "  WARNING: Could not detect root partition for expansion"
fi

# Create application data directories that Docker bind-mounts.
# All must exist before docker.service starts (this service runs Before=docker.service)
# so Docker uses the existing user-owned directories instead of creating root-owned ones.
sudo -u "$TC_USER" mkdir -p "$TC_HOME/data/keys"
sudo -u "$TC_USER" mkdir -p "$TC_HOME/data/tileserver"
sudo -u "$TC_USER" mkdir -p "$TC_HOME/data/nominatim"
sudo -u "$TC_USER" mkdir -p "$TC_HOME/data/firmware"
sudo -u "$TC_USER" mkdir -p "$TC_HOME/data/deployments"
sudo -u "$TC_USER" mkdir -p "$TC_HOME/local_code"

# -------------------------------------------
# 2. Configure EEPROM for auto-boot on power
# -------------------------------------------
log "Configuring EEPROM for NVMe boot..."

if command -v rpi-eeprom-config > /dev/null 2>&1; then
    EEPROM_CONFIG=$(rpi-eeprom-config 2>/dev/null || true)

    if echo "$EEPROM_CONFIG" | grep -q "WAKE_ON_GPIO=0"; then
        log "  EEPROM auto-boot already configured"
    else
        EEPROM_TMP=$(mktemp)
        echo "$EEPROM_CONFIG" \
            | grep -v "^WAKE_ON_GPIO=" \
            | grep -v "^POWER_OFF_ON_HALT=" \
            | grep -v "^BOOT_ORDER=" \
            > "$EEPROM_TMP"
        echo "WAKE_ON_GPIO=0" >> "$EEPROM_TMP"
        echo "POWER_OFF_ON_HALT=1" >> "$EEPROM_TMP"
        echo "BOOT_ORDER=0xfe6" >> "$EEPROM_TMP"
        rpi-eeprom-config --apply "$EEPROM_TMP"
        rm -f "$EEPROM_TMP"
        log "  EEPROM configured: boot NVMe only, auto-boot on power, full power-off on halt"
    fi
else
    log "  rpi-eeprom-config not found, skipping EEPROM setup"
fi

# -------------------------------------------
# 3. Generate TLS/SSL certificates
# -------------------------------------------
log "Generating TLS/SSL certificates..."

KEYS_DIR="$TC_HOME/data/keys"
TLS_HOSTNAME="$(hostname).local"
CA_VALIDITY_DAYS=3650
SERVER_VALIDITY_DAYS=825      # Apple requires server certs <= 825 days

if [ -f "$KEYS_DIR/server.crt" ] && [ -f "$KEYS_DIR/server.key" ]; then
    log "  Certificates already exist, skipping"
else
    # Detect local network IPs for SAN list
    LOCAL_IPS=""
    if command -v hostname >/dev/null 2>&1; then
        LOCAL_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' || true)
    fi
    SAN_LIST="DNS:$TLS_HOSTNAME,IP:127.0.0.1,IP:::1"
    if [ -n "$LOCAL_IPS" ]; then
        while IFS= read -r ip; do
            [ -n "$ip" ] && SAN_LIST="$SAN_LIST,IP:$ip"
        done <<< "$LOCAL_IPS"
    fi

    # CA config file (config file approach works on all OpenSSL versions)
    cat > "$KEYS_DIR/_ca.cnf" <<'CAEOF'
[req]
distinguished_name = req_dn
x509_extensions = v3_ca
prompt = no

[req_dn]
C = US
ST = State
L = City
O = TrailCurrent
OU = Engineering
CN = TrailCurrent-CA

[v3_ca]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
CAEOF

    # CA key + cert
    openssl genrsa -out "$KEYS_DIR/ca.key" 2048 2>/dev/null
    openssl req -new -x509 -days $CA_VALIDITY_DAYS \
        -key "$KEYS_DIR/ca.key" \
        -out "$KEYS_DIR/ca.crt" \
        -config "$KEYS_DIR/_ca.cnf"
    cp "$KEYS_DIR/ca.crt" "$KEYS_DIR/ca.pem"

    # Server extension config file
    cat > "$KEYS_DIR/_server.cnf" <<SRVEOF
[req]
distinguished_name = req_dn
req_extensions = v3_server
prompt = no

[req_dn]
C = US
ST = State
L = City
O = TrailCurrent
OU = Engineering
CN = $TLS_HOSTNAME

[v3_server]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $SAN_LIST
SRVEOF

    # Server key + CSR + signed cert
    openssl genrsa -out "$KEYS_DIR/server.key" 2048 2>/dev/null
    openssl req -new \
        -key "$KEYS_DIR/server.key" \
        -out "$KEYS_DIR/server.csr" \
        -config "$KEYS_DIR/_server.cnf"
    openssl x509 -req -days $SERVER_VALIDITY_DAYS \
        -in "$KEYS_DIR/server.csr" \
        -CA "$KEYS_DIR/ca.crt" \
        -CAkey "$KEYS_DIR/ca.key" \
        -CAcreateserial \
        -out "$KEYS_DIR/server.crt" \
        -extfile "$KEYS_DIR/_server.cnf" \
        -extensions v3_server

    # Clean up temp files and set permissions
    rm -f "$KEYS_DIR/server.csr" "$KEYS_DIR/ca.srl" "$KEYS_DIR/_ca.cnf" "$KEYS_DIR/_server.cnf"
    chmod 644 "$KEYS_DIR"/*
    chown "$TC_USER:$TC_USER" "$KEYS_DIR"/*

    log "  Certificates generated for $TLS_HOSTNAME (valid 10 years)"
fi

# -------------------------------------------
# 4. Set up Python virtual environment
# -------------------------------------------
log "Setting up Python virtual environment..."

VENV_PATH="$TC_HOME/local_code/cantomqtt"

if [ -d "$VENV_PATH" ]; then
    log "  Virtual environment already exists"
else
    sudo -u "$TC_USER" python3 -m venv "$VENV_PATH"
    log "  Created virtual environment at $VENV_PATH"
fi

# Install Python dependencies from baked-in requirements or fall back to base set
if [ -f "$TC_HOME/local_code/requirements.txt" ]; then
    sudo -u "$TC_USER" "$VENV_PATH/bin/pip" install -q -r "$TC_HOME/local_code/requirements.txt"
else
    sudo -u "$TC_USER" "$VENV_PATH/bin/pip" install -q \
        paho-mqtt==2.1.0 \
        python-can==4.6.1 \
        pymongo==4.10.1 \
        python-dotenv==1.0.1 \
        packaging==25.0 \
        typing_extensions==4.15.0 \
        wrapt==1.17.3
fi

log "  Python dependencies installed"

# -------------------------------------------
# Done
# -------------------------------------------
log "First-boot setup complete."
log ""
log "Storage layout:"
log "  NVMe (/) : OS, packages, Docker, app data, Python venv"
log "  Root partition expanded to fill NVMe drive"
log ""
log "A reboot is recommended for EEPROM changes to take effect."
