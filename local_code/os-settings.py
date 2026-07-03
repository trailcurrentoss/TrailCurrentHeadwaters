#!/usr/bin/env python3
"""
os-settings.py — Host-side proxy for OS-level settings the PWA drives.

Runs on the host (not in Docker) because it needs to invoke privileged
system tools like `timedatectl` and read /usr/share/zoneinfo, neither of
which are accessible from the backend container.

Mirrors the MQTT request/response pattern used by discovery-mdns.py:
container publishes on `os/<setting>/request`, host replies on
`os/<setting>/response`, and a retained `os/<setting>/current` is kept
up to date so the backend can serve the current value without a
round-trip.

Currently handles:
  timezone — set/read IANA time zone via `timedatectl`.

Adding more OS settings (hostname, NTP servers, WiFi region, ...) is a
matter of a new topic pair + a handler function, no new systemd unit.
"""

import json
import os
import re
import signal
import ssl
import subprocess
import sys
import threading
import time

import paho.mqtt.client as mqtt

# ── Topics ──────────────────────────────────────────────────────────────
MQTT_TOPIC_TZ_REQUEST  = 'os/timezone/request'
MQTT_TOPIC_TZ_RESPONSE = 'os/timezone/response'
MQTT_TOPIC_TZ_CURRENT  = 'os/timezone/current'    # retained

# ── Zoneinfo validation ────────────────────────────────────────────────
ZONEINFO_DIR = '/usr/share/zoneinfo'
# Belt-and-braces regex before we ever touch the filesystem, so a
# hostile string can't slip through as a "/../.." traversal or hit a
# device node. IANA names are area/location with letters, digits,
# +/-/_ separators.
_TZ_RE = re.compile(r'^[A-Za-z][A-Za-z0-9+_-]*(?:/[A-Za-z0-9+_-]+)*$')

shutdown_requested = False


def handle_signal(signum, _frame):
    global shutdown_requested
    print(f"Received signal {signum}, shutting down...")
    shutdown_requested = True


# ── .env loader (matches discovery-mdns.py style) ─────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(SCRIPT_DIR, '.env')
if os.path.isfile(ENV_FILE):
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip().strip('\r')
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ[key.strip()] = value.strip()
    print(f"Loaded env from {ENV_FILE}")
else:
    print(f"Warning: No .env file found at {ENV_FILE}")

MQTT_BROKER_URL = os.environ.get('MQTT_BROKER_URL')
if not MQTT_BROKER_URL:
    print('ERROR: MQTT_BROKER_URL environment variable must be set', file=sys.stderr)
    sys.exit(1)

_match = re.match(r'(mqtts?)://([^:]+):(\d+)', MQTT_BROKER_URL)
if not _match:
    print(f'ERROR: Invalid MQTT_BROKER_URL format: {MQTT_BROKER_URL}', file=sys.stderr)
    sys.exit(1)

protocol = _match.group(1)
MQTT_BROKER = _match.group(2)
MQTT_PORT = int(_match.group(3))
USE_TLS = (protocol == 'mqtts')
MQTT_CA_CERT_PATH = os.path.join(SCRIPT_DIR, 'ca.pem')

MQTT_USERNAME = os.environ.get('MQTT_USERNAME')
MQTT_PASSWORD = os.environ.get('MQTT_PASSWORD')
if not MQTT_USERNAME or not MQTT_PASSWORD:
    print('ERROR: MQTT_USERNAME and MQTT_PASSWORD must be set', file=sys.stderr)
    sys.exit(1)


# ── Timezone helpers ───────────────────────────────────────────────────
def is_valid_timezone(tz):
    """Reject anything that isn't a real file under /usr/share/zoneinfo.
    Guards against shell injection and typos — no need to hardcode the
    list, tzdata is authoritative."""
    if not isinstance(tz, str) or not _TZ_RE.match(tz):
        return False
    # Resolve against ZONEINFO_DIR and check the result is still inside
    # it. Rejects tricks like ../../etc/passwd even though the regex
    # already forbids them.
    candidate = os.path.realpath(os.path.join(ZONEINFO_DIR, tz))
    root = os.path.realpath(ZONEINFO_DIR)
    if not candidate.startswith(root + os.sep):
        return False
    return os.path.isfile(candidate)


def read_current_timezone():
    """Return the OS's current IANA timezone or None on failure."""
    try:
        # timedatectl show is the canonical readout; parses machine-friendly.
        result = subprocess.run(
            ['timedatectl', 'show', '--property=Timezone', '--value'],
            capture_output=True, text=True, timeout=5, check=True,
        )
        tz = result.stdout.strip()
        return tz or None
    except Exception as e:
        print(f"[Timezone] Failed to read current timezone: {e}")
        return None


def set_timezone(tz):
    """Apply tz via `sudo -n timedatectl set-timezone`. The service user
    (`trailcurrent`) has passwordless sudo on the rig images we ship, so
    -n makes a missing grant fail fast instead of hanging on a prompt."""
    result = subprocess.run(
        ['sudo', '-n', 'timedatectl', 'set-timezone', tz],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"timedatectl set-timezone failed (rc={result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )


def publish_current_timezone(client):
    """Publish the current TZ as a retained message so a late-joining
    backend can render current state without an RPC round-trip."""
    tz = read_current_timezone()
    if tz:
        client.publish(
            MQTT_TOPIC_TZ_CURRENT,
            json.dumps({'tz': tz}),
            qos=1, retain=True,
        )
        print(f"[Timezone] Current TZ published as retained: {tz}")


def handle_timezone_request(client, msg):
    """Parse a timezone set request, apply it, publish response +
    updated retained current value."""
    reqId = None
    try:
        data = json.loads(msg.payload.decode('utf-8'))
        reqId = data.get('reqId')
        tz = data.get('tz')
        if not is_valid_timezone(tz):
            raise ValueError(f"Invalid or unknown timezone: {tz!r}")

        print(f"[Timezone] Setting to {tz} (reqId={reqId})")
        set_timezone(tz)

        # Read back what the OS actually applied — protects against a
        # future case where timedatectl accepts a symlinked TZ but
        # normalizes the name (e.g. "US/Pacific" → "America/Los_Angeles").
        applied = read_current_timezone() or tz

        client.publish(
            MQTT_TOPIC_TZ_RESPONSE,
            json.dumps({'reqId': reqId, 'ok': True, 'tz': applied}),
            qos=1,
        )
        client.publish(
            MQTT_TOPIC_TZ_CURRENT,
            json.dumps({'tz': applied}),
            qos=1, retain=True,
        )
    except Exception as e:
        print(f"[Timezone] Request failed: {e}")
        try:
            client.publish(
                MQTT_TOPIC_TZ_RESPONSE,
                json.dumps({'reqId': reqId, 'ok': False, 'error': str(e)}),
                qos=1,
            )
        except Exception:
            pass


# ── MQTT plumbing ──────────────────────────────────────────────────────
def on_connect(client, _userdata, _flags, reason_code, _properties):
    if reason_code == 0:
        print("Connected to MQTT broker")
        client.subscribe(MQTT_TOPIC_TZ_REQUEST)
        # Publish current state on (re)connect so the backend's cache
        # is populated even if the daemon was restarted after the
        # backend last subscribed.
        publish_current_timezone(client)
    else:
        print(f"Failed to connect to MQTT broker: {reason_code}")


def on_disconnect(_client, _userdata, _flags, reason_code, _properties):
    if reason_code == 0:
        print("Disconnected from MQTT broker (clean)")
    else:
        print(f"Disconnected unexpectedly (rc={reason_code}), will auto-reconnect")


def on_message(client, _userdata, msg):
    if msg.topic == MQTT_TOPIC_TZ_REQUEST:
        threading.Thread(
            target=handle_timezone_request,
            args=(client, msg),
            daemon=True,
        ).start()


def main():
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    if USE_TLS:
        client.tls_set(
            ca_certs=MQTT_CA_CERT_PATH,
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLS_CLIENT,
        )
        client.tls_insecure_set(False)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    print(f"Connecting to MQTT broker at {MQTT_BROKER}:{MQTT_PORT}...")
    client.connect(MQTT_BROKER, MQTT_PORT)
    client.loop_start()

    try:
        while not shutdown_requested:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        print("Shutting down...")
        client.loop_stop()
        client.disconnect()
        print("Shutdown complete")


if __name__ == '__main__':
    main()
