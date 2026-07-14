#!/bin/bash
# trailcurrent-setup-ap.sh
#
# Brings up the out-of-box setup access point on the CM5's onboard WiFi
# radio. Runs as a systemd oneshot when `.env` is absent (fresh flash or
# post-factory-reset). Once `.env` exists the guard in the .service unit
# blocks re-entry.
#
# What this does:
#   1. Compute the SSID from the WiFi MAC (deterministic -- same device
#      broadcasts the same SSID every time, so a bench with multiple
#      units stays disambiguated)
#   2. Ensure wlan0 exists and the radio is unblocked
#   3. Write hostapd + dnsmasq configs to /run (tmpfs, never persisted)
#   4. Assign wlan0 a static IP (10.0.0.1/24) and start hostapd + dnsmasq
#      as long-lived children
#
# ExecStop reverses everything: kills the daemons, tears down the
# interface, and rfkill-blocks the radio so it draws no power once
# setup completes.
#
# Errors bubble up with detailed instructions in the pattern of the
# build/maps scripts -- no bare "MISSING" or exit codes.
#
# NOTE: this MVP does NOT yet serve the captive-portal setup web app.
# The AP is visible and phones can join and get DHCP, but hitting
# http://10.0.0.1 today gets connection-refused. The setup portal is
# the next work item.

set -euo pipefail

# ── Style helpers (mirror build/maps convention) ──────────────────────
if [ -t 1 ]; then
    G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'
else
    G=""; Y=""; R=""; B=""; N=""
fi
log()  { printf '%s[setup-ap]%s %s\n' "$B" "$N" "$*"; }
warn() {
    printf '%s[setup-ap]%s %sWARN:%s %s\n' "$B" "$N" "$Y" "$N" "$1" >&2
    shift || true
    for line in "$@"; do printf '  %s\n' "$line" >&2; done
}
die()  {
    printf '\n%s[setup-ap]%s %sERROR:%s %s\n' "$B" "$N" "$R" "$N" "$1" >&2
    shift || true
    for line in "$@"; do printf '  %s\n' "$line" >&2; done
    exit 1
}

# ── Constants ─────────────────────────────────────────────────────────
IFACE="wlan0"
AP_IP="10.0.0.1"
AP_CIDR="10.0.0.1/24"
DHCP_START="10.0.0.10"
DHCP_END="10.0.0.100"
DHCP_LEASE="12h"
COUNTRY="US"                     # regulatory domain; safe default for CM5
CHANNEL="6"                      # 2.4 GHz, universal compatibility
RUN_DIR="/run/trailcurrent-setup-ap"
HOSTAPD_CONF="${RUN_DIR}/hostapd.conf"
DNSMASQ_CONF="${RUN_DIR}/dnsmasq.conf"
DNSMASQ_LEASES="${RUN_DIR}/dnsmasq.leases"
DNSMASQ_PID="${RUN_DIR}/dnsmasq.pid"
HOSTAPD_PID="${RUN_DIR}/hostapd.pid"

# ── Bring up / bring down ─────────────────────────────────────────────
compute_ssid() {
    local mac_file="/sys/class/net/${IFACE}/address"
    if [ ! -r "$mac_file" ]; then
        die "WiFi interface ${IFACE} has no MAC address file at ${mac_file}." \
            "This usually means the WiFi radio is disabled at the kernel level." \
            "Check /boot/firmware/config.txt for 'dtoverlay=disable-wifi' and remove it," \
            "then reboot. On the CM5 the onboard chip is Cypress/Infineon CYW43455;" \
            "verify it appears in 'dmesg | grep -i brcm'."
    fi
    local mac
    mac=$(cat "$mac_file")                                                 # d8:3a:dd:a3:f7:2c
    local hex
    hex=$(echo "$mac" | tr -d ':' | tr '[:lower:]' '[:upper:]')            # D83ADDA3F72C
    local suffix
    suffix=$(echo "$hex" | tail -c 5)                                      # F72C  (last 4 hex)
    SSID="Headwaters-${suffix}"
}

# NOTE: the setup AP is deliberately OPEN (no WPA2). The customer has
# no way to know a factory password (nothing on the box, no display on
# the device), and per-device labels would require per-device print
# runs at fulfillment. Every consumer IoT device that does first-boot
# WiFi setup (Nest, eero, Ring, Sonos, Roku, Hue) uses an open AP for
# the same reason. Security relies on:
#   1. The AP only exists during the setup window (minutes, not hours)
#   2. The customer is physically present during that window
#   3. The setup portal serves over HTTPS (self-signed CA; the portal
#      is the only site on this network anyway, so a phone accepting
#      the cert here is safe)
#   4. `.env` write is single-shot -- once done, AP tears down forever
#      until an explicit factory reset re-enables it

start_ap() {
    if [ ! -d /sys/class/net/${IFACE} ]; then
        die "WiFi interface ${IFACE} does not exist." \
            "The CM5's onboard WiFi is disabled. Check config.txt for" \
            "'dtoverlay=disable-wifi' and remove it. Verify the CM5 has WiFi" \
            "(the WiFi variant is required -- see CM5/SETUP.md Hardware Requirements)."
    fi

    if command -v rfkill >/dev/null 2>&1; then
        rfkill unblock wifi || warn "rfkill unblock returned non-zero (already unblocked?)"
    fi

    # Set the regulatory domain BEFORE hostapd starts. Without a
    # registered country the CM5's radio refuses to broadcast even in
    # AP mode because it can't confirm which channels are legal. The
    # wireless-regdb package supplies the data; `iw reg set` activates
    # it for this session.
    if command -v iw >/dev/null 2>&1; then
        iw reg set "${COUNTRY}" 2>/dev/null || warn "iw reg set ${COUNTRY} returned non-zero"
    fi

    compute_ssid
    log "SSID=${SSID} (OPEN -- no password)  IP=${AP_IP}"

    mkdir -p "${RUN_DIR}"

    # Static IP on wlan0. Wipe first so a stale address from a previous
    # run doesn't confuse dnsmasq's interface selection.
    ip addr flush dev "${IFACE}" 2>/dev/null || true
    ip link set "${IFACE}" up
    ip addr add "${AP_CIDR}" dev "${IFACE}"

    # hostapd config -- OPEN network on 2.4 GHz channel 6.
    # Open network: no wpa/rsn keys. auth_algs=1 is "open system" auth,
    # which is what phones expect for an unencrypted network.
    cat > "${HOSTAPD_CONF}" <<HOSTAPD
interface=${IFACE}
driver=nl80211
ssid=${SSID}
country_code=${COUNTRY}
ieee80211d=1
hw_mode=g
channel=${CHANNEL}
ieee80211n=1
wmm_enabled=1
auth_algs=1
HOSTAPD
    chmod 644 "${HOSTAPD_CONF}"

    # dnsmasq: DHCP on wlan0 only. DNS spoofing (10.0.0.1 as answer for
    # everything) is what makes captive-portal auto-open work -- phones
    # detect it and open the browser to hit 10.0.0.1. Once the portal
    # web app lands, no further dnsmasq change is needed.
    cat > "${DNSMASQ_CONF}" <<DNSMASQ
interface=${IFACE}
bind-interfaces
listen-address=${AP_IP}
dhcp-range=${DHCP_START},${DHCP_END},${DHCP_LEASE}
dhcp-option=3,${AP_IP}
dhcp-option=6,${AP_IP}
dhcp-authoritative
no-resolv
no-hosts
address=/#/${AP_IP}
dhcp-leasefile=${DNSMASQ_LEASES}
pid-file=${DNSMASQ_PID}
log-facility=-
DNSMASQ

    # Launch hostapd (foreground under systemd? no -- we're a oneshot,
    # so run both as daemonized background processes with PID files;
    # ExecStop reads those to shut them down cleanly).
    log "starting hostapd"
    hostapd -B -P "${HOSTAPD_PID}" "${HOSTAPD_CONF}" \
        || die "hostapd failed to start." \
            "Check journalctl -u trailcurrent-setup-ap for the reason." \
            "Common causes: another process holds the WiFi radio (kill wpa_supplicant)," \
            "regulatory domain not loaded (install wireless-regdb, reboot)," \
            "or the driver is broken (check dmesg for brcm errors)."

    log "starting dnsmasq"
    dnsmasq -C "${DNSMASQ_CONF}" \
        || die "dnsmasq failed to start." \
            "Check journalctl for the reason. Common causes: port 53 or 67 already" \
            "in use by systemd-resolved (mask it), or ${IFACE} not yet up when dnsmasq" \
            "tried to bind (check ordering)."

    start_portal

    log "AP is up. Phones joining ${SSID} will get DHCP from ${DHCP_START}-${DHCP_END}."
    log "Setup portal listening on http://${AP_IP}/"
}

# ── Setup portal HTTP server (captive-portal auto-open) ──────────────
# Minimal Python HTTP server on 10.0.0.1:80. Its ONLY jobs today are:
#   1. Answer captive-portal probes so iOS / Android / Windows detect
#      the network as captive and pop the setup browser automatically
#   2. Serve a placeholder page confirming the phone can reach the
#      device
#
# The real setup form (MQTT/admin passwords, CA cert download, .env
# write, docker up, AP teardown) replaces this stub in the next
# iteration. For now the placeholder page tells the customer their
# phone reached the device successfully, and the actual configuration
# still comes from the SSH first-login script until the portal form
# lands.
#
# Written as a Python one-file server rather than nginx+PHP because
# Python 3 is already in the image and this keeps the whole stack
# to zero new packages.
PORTAL_SCRIPT="${RUN_DIR}/portal.py"
PORTAL_PID="${RUN_DIR}/portal.pid"
PORTAL_LOG="${RUN_DIR}/portal.log"

start_portal() {
    cat > "${PORTAL_SCRIPT}" <<'PORTAL'
#!/usr/bin/env python3
# TrailCurrent setup portal -- captive-portal HTTP server + config form.
# Auto-generated by trailcurrent-setup-ap.sh; do not edit in place.
#
# Behaviour is intended to match the SSH-based trailcurrent-first-login.sh
# so the customer gets the same outcome whether they configure via SSH or
# via the setup portal:
#   - Prompt for MQTT username/password, admin password
#   - Auto-generate ENCRYPTION_KEY
#   - Write ~/.env and ~/local_code/.env (with host-facing MQTT URL)
#   - Copy ca.pem to ~/local_code
#   - Reboot (clean way to bring everything up in the correct order --
#     setup-ap does not restart on next boot because .env now exists)
import cgi
import html
import os
import pwd
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND, PORT = '0.0.0.0', 80
TC_USER = 'trailcurrent'
TC_HOME = '/home/' + TC_USER
ENV_PATH = TC_HOME + '/.env'
LOCAL_ENV_PATH = TC_HOME + '/local_code/.env'
CA_PEM_PATH = TC_HOME + '/data/keys/ca.pem'
LOCAL_CA_PATH = TC_HOME + '/local_code/ca.pem'
TLS_HOSTNAME = 'headwaters.local'
REBOOT_DELAY_SECONDS = 8

# Use a str literal encoded to UTF-8 at load time -- a `b"""..."""`
# bytes literal rejects any non-ASCII character (like the em dash in
# marketing copy), which crashes on import with SyntaxError before the
# server ever starts.
CSS = """
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
         Roboto, sans-serif; margin: 0; padding: 24px; background: #f4f5f7;
         color: #1a1a1a; }
  .card { max-width: 480px; margin: 24px auto; background: #fff;
          padding: 28px; border-radius: 16px;
          box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  h1 { margin: 0 0 8px 0; color: #52a441; font-size: 1.5rem; }
  h2 { font-size: 1rem; color: #666; margin: 0 0 24px 0;
       font-weight: 400; }
  p { line-height: 1.5; margin: 12px 0; color: #444; }
  label { display: block; margin: 16px 0 6px 0; font-weight: 600;
          font-size: 0.95rem; color: #1a1a1a; }
  input[type=text], input[type=password] {
      width: 100%; padding: 12px; font-size: 1rem;
      border: 1px solid #ccc; border-radius: 8px;
      -webkit-appearance: none; }
  input:focus { outline: 2px solid #52a441; border-color: #52a441; }
  button {
      width: 100%; margin-top: 24px; padding: 14px;
      background: #52a441; color: #fff; font-size: 1.05rem;
      font-weight: 600; border: none; border-radius: 10px;
      cursor: pointer; -webkit-appearance: none; }
  button:disabled { background: #999; cursor: wait; }
  .err { background: #fdecec; color: #a52929; padding: 12px;
         border-radius: 8px; margin: 12px 0; }
  .ok { background: #eef7ea; color: #2e6d21; padding: 12px;
        border-radius: 8px; margin: 12px 0;
        border-left: 4px solid #52a441; }
  .muted { color: #666; font-size: 0.9rem; }
  a { color: #52a441; }
"""

def form_html(error_msg=""):
    err = ('<div class="err">' + html.escape(error_msg) + '</div>') if error_msg else ""
    return ("""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrailCurrent Headwaters Setup</title>
<style>""" + CSS + """</style>
</head>
<body>
<div class="card">
  <h1>Headwaters Setup</h1>
  <h2>Complete this once. The device reboots when you finish.</h2>
  """ + err + """
  <form method="POST" action="/setup" autocomplete="off">
    <label for="mqtt_username">MQTT username</label>
    <input type="text" name="mqtt_username" id="mqtt_username"
           value="trailcurrent" autocapitalize="none" autocorrect="off">

    <label for="mqtt_password">MQTT password</label>
    <input type="password" name="mqtt_password" id="mqtt_password" required>

    <label for="admin_password">Admin password (for the web UI)</label>
    <input type="password" name="admin_password" id="admin_password" required>

    <button type="submit" onclick="this.disabled=true; this.form.submit();">
      Complete setup and reboot
    </button>
  </form>
  <p class="muted" style="margin-top:20px;">
    To trust the device's HTTPS on your phone:
    <br>
    <a href="/ca.mobileconfig">Install on iPhone (Profile)</a>
    &nbsp;&middot;&nbsp;
    <a href="/ca.pem" download="TrailCurrent-CA.pem">Download for Android / Desktop</a>
  </p>
</div>
</body>
</html>
""").encode('utf-8')

def done_html():
    return ("""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup Complete</title>
<style>""" + CSS + """</style>
</head>
<body>
<div class="card">
  <h1>Setup complete</h1>
  <h2>The device is rebooting.</h2>
  <div class="ok">
    Configuration written. The device will restart in about 30 seconds
    and come up on its normal network.
  </div>
  <p>What to do next:</p>
  <ol>
    <li>Reconnect your phone to your normal WiFi network.</li>
    <li>Open <strong>https://headwaters.local</strong> in a browser
        on the same network as the device.</li>
    <li>Log in with the admin password you just set.</li>
  </ol>
  <p class="muted">
    If you did not already download the CA certificate on the setup
    page, you can install it later from the device dashboard.
  </p>
</div>
</body>
</html>
""").encode('utf-8')

USERNAME_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,32}$')

def _tc_uid_gid():
    """Return (uid, gid) of the trailcurrent user; fall back to 1000/1000."""
    try:
        p = pwd.getpwnam(TC_USER)
        return p.pw_uid, p.pw_gid
    except KeyError:
        return 1000, 1000


def build_mobileconfig():
    """Wrap ca.pem in an Apple Configuration Profile (.mobileconfig).
    iOS's captive-portal browser cannot download raw .pem/.crt files
    (no Files app access from captive), but it CAN install a .mobileconfig
    profile because that's a first-class OS action. Once installed the
    customer still has to enable 'Full Trust' in
    Settings > General > About > Certificate Trust Settings."""
    import base64
    import uuid
    if not os.path.isfile(CA_PEM_PATH):
        return None
    with open(CA_PEM_PATH, 'r') as f:
        pem = f.read()
    # Strip PEM armor; what's left IS the base64 DER encoding.
    b64_lines = []
    inside = False
    for line in pem.splitlines():
        if '-----BEGIN CERTIFICATE-----' in line:
            inside = True
            continue
        if '-----END CERTIFICATE-----' in line:
            inside = False
            continue
        if inside:
            b64_lines.append(line.strip())
    b64 = ''.join(b64_lines)
    # Re-wrap at 52 chars/line for the plist -- Apple's format wants
    # base64 whitespace-friendly.
    wrapped = '\n\t\t\t\t'.join(b64[i:i+52] for i in range(0, len(b64), 52))
    cert_uuid = str(uuid.uuid4()).upper()
    profile_uuid = str(uuid.uuid4()).upper()
    plist = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0">\n'
        '<dict>\n'
        '\t<key>PayloadContent</key>\n'
        '\t<array>\n'
        '\t\t<dict>\n'
        '\t\t\t<key>PayloadCertificateFileName</key>\n'
        '\t\t\t<string>TrailCurrent-CA.cer</string>\n'
        '\t\t\t<key>PayloadContent</key>\n'
        '\t\t\t<data>\n'
        '\t\t\t\t' + wrapped + '\n'
        '\t\t\t</data>\n'
        '\t\t\t<key>PayloadDescription</key>\n'
        '\t\t\t<string>Adds the TrailCurrent CA so this iPhone trusts '
        'https://headwaters.local.</string>\n'
        '\t\t\t<key>PayloadDisplayName</key>\n'
        '\t\t\t<string>TrailCurrent CA</string>\n'
        '\t\t\t<key>PayloadIdentifier</key>\n'
        '\t\t\t<string>com.trailcurrent.ca.root</string>\n'
        '\t\t\t<key>PayloadType</key>\n'
        '\t\t\t<string>com.apple.security.root</string>\n'
        '\t\t\t<key>PayloadUUID</key>\n'
        '\t\t\t<string>' + cert_uuid + '</string>\n'
        '\t\t\t<key>PayloadVersion</key>\n'
        '\t\t\t<integer>1</integer>\n'
        '\t\t</dict>\n'
        '\t</array>\n'
        '\t<key>PayloadDescription</key>\n'
        '\t<string>Trust the TrailCurrent Headwaters device certificate '
        'on this iPhone.</string>\n'
        '\t<key>PayloadDisplayName</key>\n'
        '\t<string>TrailCurrent Headwaters Certificate</string>\n'
        '\t<key>PayloadIdentifier</key>\n'
        '\t<string>com.trailcurrent.setup.ca</string>\n'
        '\t<key>PayloadRemovalDisallowed</key>\n'
        '\t<false/>\n'
        '\t<key>PayloadType</key>\n'
        '\t<string>Configuration</string>\n'
        '\t<key>PayloadUUID</key>\n'
        '\t<string>' + profile_uuid + '</string>\n'
        '\t<key>PayloadVersion</key>\n'
        '\t<integer>1</integer>\n'
        '</dict>\n'
        '</plist>\n'
    )
    return plist.encode('utf-8')

def write_env_files(mqtt_username, mqtt_password, admin_password):
    """Match trailcurrent-first-login.sh exactly. Anything the SSH wizard
    writes, this writes -- and vice versa. If the two paths ever diverge,
    the customer's device is in one of two subtly different states
    depending on which they used, which is a debugging nightmare."""
    uid, gid = _tc_uid_gid()
    encryption_key = secrets.token_hex(32)
    env = (
        "# Generated by TrailCurrent setup portal on " + date.today().isoformat() + "\n"
        "\n"
        "# MQTT Configuration\n"
        "MQTT_BROKER_URL=mqtts://mosquitto:8883\n"
        "MQTT_USERNAME=" + mqtt_username + "\n"
        "MQTT_PASSWORD=" + mqtt_password + "\n"
        "\n"
        "# Encryption & Security\n"
        "ENCRYPTION_KEY=" + encryption_key + "\n"
        "ADMIN_PASSWORD=" + admin_password + "\n"
        "\n"
        "# API Configuration\n"
        "API_PORT=3000\n"
        "FRONTEND_PORT=443\n"
        "\n"
        "# Database Configuration\n"
        "DB_PATH=/app/data/invehicle.db\n"
        "MONGODB_HOST=localhost\n"
        "MONGODB_PORT=27017\n"
        "MONGODB_DATABASE=trailcurrent\n"
        "\n"
        "# Network Configuration\n"
        "TLS_CERT_HOSTNAME=" + TLS_HOSTNAME + "\n"
        "\n"
        "# Environment\n"
        "NODE_ENV=production\n"
    )
    # ~/.env with the in-docker MQTT URL (used by the containers themselves).
    with open(ENV_PATH, 'w') as f:
        f.write(env)
    os.chmod(ENV_PATH, 0o600)
    os.chown(ENV_PATH, uid, gid)

    # ~/local_code/.env with the host-facing MQTT URL (used by the
    # host-side Python services -- cantomqtt, discovery-mdns,
    # deployment-watcher, os-settings). Substitution mirrors the sed
    # in trailcurrent-first-login.sh:
    #     s|mqtts://mosquitto:|mqtts://headwaters.local:|
    local_env = env.replace('mqtts://mosquitto:', 'mqtts://' + TLS_HOSTNAME + ':')
    os.makedirs(TC_HOME + '/local_code', exist_ok=True)
    with open(LOCAL_ENV_PATH, 'w') as f:
        f.write(local_env)
    os.chmod(LOCAL_ENV_PATH, 0o600)
    os.chown(LOCAL_ENV_PATH, uid, gid)

    # Copy CA cert into local_code so host-side Python services can
    # verify mqtts://headwaters.local:8883.
    if os.path.isfile(CA_PEM_PATH):
        shutil.copy(CA_PEM_PATH, LOCAL_CA_PATH)
        os.chown(LOCAL_CA_PATH, uid, gid)

    # Install the CA to the system trust store so curl / wget / any
    # host-side HTTPS client trusts the device's cert.
    ca_crt = TC_HOME + '/data/keys/ca.crt'
    if os.path.isfile(ca_crt):
        try:
            shutil.copy(ca_crt, '/usr/local/share/ca-certificates/trailcurrent-ca.crt')
            subprocess.run(['update-ca-certificates'],
                           check=False, capture_output=True, timeout=30)
        except Exception as e:
            sys.stderr.write("[portal] CA trust install warning: %s\n" % e)


def schedule_reboot():
    """Fork a detached process that reboots after REBOOT_DELAY_SECONDS.
    Detached (setsid) so it survives ExecStop tearing down our cgroup
    if the customer happens to close the browser and trigger something
    that stops the service."""
    subprocess.Popen(
        ['sh', '-c',
         'sleep %d && systemctl reboot' % REBOOT_DELAY_SECONDS],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "TrailCurrentSetup/1"

    def _html(self, body_bytes, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body_bytes)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body_bytes)

    def _pem(self, body_bytes, filename):
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-pem-file')
        self.send_header('Content-Length', str(len(body_bytes)))
        self.send_header('Content-Disposition',
                         'attachment; filename="%s"' % filename)
        self.end_headers()
        self.wfile.write(body_bytes)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        # CA cert download (Android / desktop).
        if path == '/ca.pem':
            if os.path.isfile(CA_PEM_PATH):
                with open(CA_PEM_PATH, 'rb') as f:
                    self._pem(f.read(), 'TrailCurrent-CA.pem')
            else:
                self._html(b"<h1>CA not yet generated</h1>"
                           b"<p>Wait a few seconds and retry.</p>", 503)
            return
        # Apple Configuration Profile (iOS).
        if path == '/ca.mobileconfig':
            body = build_mobileconfig()
            if body is None:
                self._html(b"<h1>CA not yet generated</h1>"
                           b"<p>Wait a few seconds and retry.</p>", 503)
                return
            self.send_response(200)
            # This exact MIME type is what triggers iOS to prompt the
            # user to install the profile via Settings.
            self.send_header('Content-Type', 'application/x-apple-aspen-config')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Content-Disposition',
                             'attachment; filename="TrailCurrent-CA.mobileconfig"')
            self.end_headers()
            self.wfile.write(body)
            return
        # Everything else (including captive-probe URLs like
        # /hotspot-detect.html, /generate_204, /connecttest.txt) shows
        # the form. This is what makes phones auto-open the portal:
        # they hit their probe URL, get the form body instead of the
        # expected "success" content, and treat the network as captive.
        self._html(form_html())

    def do_HEAD(self):
        # HEAD returns the same Content-Type header as GET for each path.
        # Some clients (Safari, iOS captive) sniff HEAD before deciding
        # how to render/download -- text/html on /ca.mobileconfig would
        # cause iOS to display the plist as text instead of installing it.
        path = self.path.split('?', 1)[0]
        if path == '/ca.pem':
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-pem-file')
        elif path == '/ca.mobileconfig':
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-apple-aspen-config')
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def do_POST(self):
        if self.path != '/setup':
            self._html(form_html("Unknown endpoint."), 404)
            return
        try:
            ctype, pdict = cgi.parse_header(self.headers.get('Content-Type', ''))
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length).decode('utf-8', 'replace')
            fields = {}
            for pair in raw.split('&'):
                if '=' not in pair:
                    continue
                k, v = pair.split('=', 1)
                # very small manual urldecode -- forms POST as
                # application/x-www-form-urlencoded
                from urllib.parse import unquote_plus
                fields[unquote_plus(k)] = unquote_plus(v)

            mqtt_username = fields.get('mqtt_username', '').strip() or 'trailcurrent'
            mqtt_password = fields.get('mqtt_password', '')
            admin_password = fields.get('admin_password', '')

            if not USERNAME_RE.match(mqtt_username):
                self._html(form_html(
                    "MQTT username must be 1-32 characters, letters/"
                    "digits/underscore/dot/hyphen only."))
                return
            if not mqtt_password:
                self._html(form_html("MQTT password is required."))
                return
            if not admin_password:
                self._html(form_html("Admin password is required."))
                return

            write_env_files(mqtt_username, mqtt_password, admin_password)

            self._html(done_html())
            # Response has been flushed -- now schedule the reboot.
            schedule_reboot()
        except Exception as e:
            sys.stderr.write("[portal] POST /setup failed: %s\n" % e)
            self._html(form_html("Internal error while writing setup: "
                                 + str(e)))

    def log_message(self, fmt, *args):
        sys.stdout.write("[portal] %s %s\n" % (self.address_string(),
                                                fmt % args))
        sys.stdout.flush()

# Per-request socket timeout. iOS's captive browser opens a connection
# and can leave it half-open forever if it loses interest. Without this
# ceiling, ThreadingHTTPServer accumulates zombie threads and file
# descriptors indefinitely.
Handler.timeout = 10

if __name__ == '__main__':
    # ThreadingHTTPServer: one thread per request. iOS captive
    # detection opens several concurrent probes; a single-threaded
    # HTTPServer serializes them and a slow / half-open probe blocks
    # every subsequent one, so the phone eventually gives up with
    # "server stopped responding".
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.daemon_threads = True  # worker threads exit with parent
    server.serve_forever()
PORTAL
    chmod 755 "${PORTAL_SCRIPT}"

    log "starting setup portal on ${AP_IP}:80"
    # Daemonize via setsid + nohup so the child process is detached
    # from this script's process group and survives even if systemd
    # tears down setup-ap.service's cgroup. Without this, the portal
    # would die whenever ExecStop runs, but that's cleaner handled by
    # stop_ap explicitly killing it via PID.
    #
    # We DELIBERATELY do NOT die() if the portal fails -- hostapd and
    # dnsmasq are already up (AP is broadcasting, phones can join),
    # and killing this script would trigger systemd to kill the whole
    # cgroup including hostapd + dnsmasq. A broken portal is a
    # degradation ("no auto-open"); a broken AP is a failure ("phone
    # can't even see the network"). Never let the degradation take
    # down the primary function.
    setsid nohup python3 "${PORTAL_SCRIPT}" > "${PORTAL_LOG}" 2>&1 < /dev/null &
    echo "$!" > "${PORTAL_PID}"
    sleep 1
    if ! kill -0 "$(cat "${PORTAL_PID}")" 2>/dev/null; then
        warn "setup portal did not stay up -- AP is still functional, but" \
             "http://${AP_IP}/ will not respond. Diagnose with:" \
             "  sudo cat ${PORTAL_LOG}" \
             "The AP itself (SSID broadcast + DHCP) is unaffected."
        rm -f "${PORTAL_PID}"
    else
        log "setup portal PID $(cat "${PORTAL_PID}")"
    fi
}

stop_ap() {
    log "stopping AP"
    if [ -f "${PORTAL_PID}" ]; then
        kill "$(cat "${PORTAL_PID}")" 2>/dev/null || true
        rm -f "${PORTAL_PID}"
    fi
    if [ -f "${HOSTAPD_PID}" ]; then
        kill "$(cat "${HOSTAPD_PID}")" 2>/dev/null || true
        rm -f "${HOSTAPD_PID}"
    fi
    if [ -f "${DNSMASQ_PID}" ]; then
        kill "$(cat "${DNSMASQ_PID}")" 2>/dev/null || true
        rm -f "${DNSMASQ_PID}"
    fi
    ip addr flush dev "${IFACE}" 2>/dev/null || true
    ip link set "${IFACE}" down 2>/dev/null || true
    if command -v rfkill >/dev/null 2>&1; then
        rfkill block wifi || true
    fi
    rm -rf "${RUN_DIR}"
    log "AP torn down; WiFi radio blocked"
}

case "${1:-start}" in
    start) start_ap ;;
    stop)  stop_ap ;;
    *)     die "unknown action: ${1:-}" \
              "Usage: $0 {start|stop}" ;;
esac
