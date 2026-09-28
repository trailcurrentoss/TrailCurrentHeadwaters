"""
time-from-bearing.py — Sync system clock from Bearing GNSS time over MQTT.

Headwaters runs chronyd as the LAN NTP server and as a client of public
NTP pools when internet is reachable. This service is the no-internet
fallback: when Bearing has a satellite fix, it publishes the GNSS UTC
date/time on the CAN bus, which the on-host can-to-mqtt bridge republishes
on the MQTT `can/inbound` topic. We watch for those frames and, if the
system clock is clearly wrong, step it via clock_settime so chronyd can
resume normal slewing from a correct starting point.

Bearing CAN frames consumed here:
  0x06 DateTime  [year_h, year_l, month, day, hour, minute, second]   UTC
  0x07 NavStat   [sats, speed_h, speed_l, course_h, course_l, gnss_mode]

NOTE on fix-validity: the GNSS module's `gnss_mode` byte is the
configured constellation (1=GPS, 2=Beidou, 3=GPS+Beidou, ...) - it is
NOT a fix-valid flag. The module broadcasts a datetime continuously
even while it is still cold-starting, and the values are nonsense (or
stuck at the module's epoch) until the first satellite lock provides
time. The right validity signal is the satellite-count byte (0x07
byte 0).

A 0x06 frame is only acted on when:
  (a) a 0x07 frame in the last GNSS_VALIDITY_TIMEOUT_SEC seconds
      reported at least MIN_SATELLITES satellites in-use,
  (b) the year decodes to something plausible (2025..2100),
  (c) the system-clock offset exceeds DRIFT_THRESHOLD_SEC, and
  (d) we have not already stepped the clock within the last
      MIN_INTERVAL_SEC.
The intent is to intervene only when something is obviously wrong —
chronyd handles the steady state.

Backward-step guard
-------------------
The satellite-count gate above is necessary but NOT sufficient: a demo/mock
GNSS build (Cornerstone's gnss_mock.c, compiled with MOCK_GNSS_DENVER=1)
fabricates a plausible satellite count (10-12) alongside a synthetic wall
clock. Nothing in the 0x06/0x07 frame pair distinguishes it from a real fix,
so the gate passes and a fabricated date is adopted as authoritative.

Observed 2026-09-28: a mock Cornerstone broadcast a date 36 days stale whose
synthetic clock also ran ~9% slow, so every ~60 s it was another 5-6 s behind.
This service faithfully stepped the clock backward each time, ratcheting the
host permanently into the past, overriding a correct RTC and starving chronyd.
A 90 s sleep elapsed as 85 s of wall clock.

Two defences, because a legitimate correction can also be large and backward
(a host that boots with a bogus future date):

  * Sanity floor — a proposed time below the floor is refused outright. The
    floor is the highest of the RTC, a persisted high-water mark, and this
    file's mtime, advanced by monotonic elapsed time and relaxed by
    FLOOR_SLACK_SEC. That blocks days-scale errors while still permitting an
    hour-scale correction.
  * Repeat latch — a real correction happens once and then the source agrees.
    A source that keeps asking to go backward is broken, not drifting, so
    after MAX_BACKWARD_STEPS consecutive backward steps we stop stepping and
    leave the clock to chronyd. The latch clears as soon as a sample agrees
    with the system clock again.
"""

import ctypes
import ctypes.util
import json
import logging
import os
import re
import signal
import ssl
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(SCRIPT_DIR, ".env")
CA_CERT_PATH = os.path.join(SCRIPT_DIR, "ca.pem")
MQTT_INBOUND_TOPIC = "can/inbound"

CAN_ID_DATETIME = "0x006"
CAN_ID_NAVSTAT = "0x007"

# Only step the clock if drift exceeds this offset
DRIFT_THRESHOLD_SEC = 5.0
# Refuse to re-step more often than this (debounces a chrony-fight)
MIN_INTERVAL_SEC = 60.0
# Reject a 0x06 frame unless a 0x07 frame in the last N seconds confirmed the fix
GNSS_VALIDITY_TIMEOUT_SEC = 10.0
# Minimum satellites in-use to trust Bearing's GNSS time. 3 is enough for a 2D
# fix; the module reports a stuck datetime (year=0 or factory epoch) before it
# first locks. The year-range filter below is the secondary backstop.
MIN_SATELLITES = 3

# --- Backward-step guard ---------------------------------------------------
# A proposed time this far below the sanity floor is refused. The slack allows a
# legitimate modest correction while still blocking the days-scale error a mock
# or desynced source produces.
FLOOR_SLACK_SEC = 3600.0
# Consecutive backward steps tolerated before the source is latched off.
MAX_BACKWARD_STEPS = 3
# 0x06 arrives at ~22 Hz, so every rejection path must be rate-limited.
REJECT_LOG_INTERVAL_SEC = 300.0
# Persisted high-water mark: the newest time we have ever trusted.
STATE_DIR = "/var/lib/trailcurrent"
HIGH_WATER_FILE = os.path.join(STATE_DIR, "time-from-bearing.highwater")
# hwclock lives in sbin; this unit runs as root but may inherit a thin PATH.
HWCLOCK_BIN = "/usr/sbin/hwclock"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("time-from-bearing")

# ---------------------------------------------------------------------------
# clock_settime via libc — requires CAP_SYS_TIME (root)
# ---------------------------------------------------------------------------
CLOCK_REALTIME = 0


class _Timespec(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]


_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)


def set_system_clock(epoch_seconds: float) -> None:
    ts = _Timespec()
    ts.tv_sec = int(epoch_seconds)
    ts.tv_nsec = int(round((epoch_seconds - ts.tv_sec) * 1_000_000_000))
    if _libc.clock_settime(CLOCK_REALTIME, ctypes.byref(ts)) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


# ---------------------------------------------------------------------------
# .env loader (matches can-to-mqtt.py style)
# ---------------------------------------------------------------------------
def load_env(path: str) -> None:
    if not os.path.isfile(path):
        log.warning("No .env file found at %s", path)
        return
    with open(path) as f:
        for line in f:
            line = line.strip().strip("\r")
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()


load_env(ENV_FILE)

MQTT_BROKER_URL = os.environ.get("MQTT_BROKER_URL", "")
_match = re.match(r"(mqtts?)://([^:]+):(\d+)", MQTT_BROKER_URL)
if not _match:
    log.error("Invalid or missing MQTT_BROKER_URL: %r", MQTT_BROKER_URL)
    sys.exit(1)
USE_TLS = _match.group(1) == "mqtts"
MQTT_HOST = _match.group(2)
MQTT_PORT = int(_match.group(3))
MQTT_USERNAME = os.environ.get("MQTT_USERNAME", "")
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD", "")
if not MQTT_USERNAME or not MQTT_PASSWORD:
    log.error("MQTT_USERNAME and MQTT_PASSWORD must be set in %s", ENV_FILE)
    sys.exit(1)

# ---------------------------------------------------------------------------
# State + signals
# ---------------------------------------------------------------------------
state = {
    "satellites": 0,
    "fix_ts": 0.0,
    "last_set_ts": 0.0,
    # Backward-step guard
    "backward_steps": 0,
    "latched": False,
    "floor_epoch": 0.0,
    "floor_monotonic": 0.0,
    "last_reject_log": 0.0,
}
shutdown_requested = False


def handle_signal(signum, _frame):
    global shutdown_requested
    log.info("Received signal %d, shutting down", signum)
    shutdown_requested = True


# ---------------------------------------------------------------------------
# can-to-mqtt encodes each CAN byte as an array of 8 bits, MSB first.
# Decode back to a list of byte values.
# ---------------------------------------------------------------------------
def bits_to_bytes(bit_arrays):
    out = []
    for ba in bit_arrays:
        v = 0
        for i, bit in enumerate(ba):
            v |= (int(bit) & 1) << (7 - i)
        out.append(v)
    return out


# ---------------------------------------------------------------------------
# Backward-step guard
# ---------------------------------------------------------------------------
def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="seconds")


def read_rtc_epoch():
    """Epoch seconds from the hardware clock, or None if unreadable.

    util-linux prints ISO 8601 with a UTC offset, e.g.
    "2026-09-28 10:37:35.515533-05:00", which fromisoformat handles on 3.11+.
    The RTC is the strongest available floor: it keeps correct time across the
    very failure this guard exists for.
    """
    try:
        proc = subprocess.run(
            [HWCLOCK_BIN, "--show", "--utc"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("hwclock unavailable: %s", exc)
        return None
    if proc.returncode != 0:
        log.debug("hwclock failed (rc=%d): %s", proc.returncode, proc.stderr.strip())
        return None
    raw = proc.stdout.strip()
    try:
        return datetime.fromisoformat(raw).timestamp()
    except ValueError as exc:
        log.debug("Could not parse hwclock output %r: %s", raw, exc)
        return None


def load_high_water():
    try:
        with open(HIGH_WATER_FILE) as f:
            return float(f.read().strip())
    except (OSError, ValueError):
        return None


def record_high_water(epoch: float) -> None:
    """Persist the newest time we have trusted, so a reboot keeps the floor."""
    current = load_high_water()
    if current is not None and epoch <= current:
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = HIGH_WATER_FILE + ".tmp"
        with open(tmp, "w") as f:
            f.write("%d\n" % int(epoch))
        os.replace(tmp, HIGH_WATER_FILE)
    except OSError as exc:
        log.debug("Could not persist high-water mark: %s", exc)


def init_floor() -> None:
    """Establish the sanity floor once, at startup."""
    candidates = []
    rtc = read_rtc_epoch()
    if rtc:
        candidates.append(("RTC", rtc))
    hw = load_high_water()
    if hw:
        candidates.append(("high-water mark", hw))
    try:
        candidates.append(("script mtime", os.path.getmtime(os.path.abspath(__file__))))
    except OSError:
        pass

    if not candidates:
        log.warning(
            "No sanity floor available (no RTC, no high-water mark) — "
            "backward-step protection reduced to the repeat latch"
        )
        return

    label, value = max(candidates, key=lambda c: c[1])
    state["floor_epoch"] = value
    state["floor_monotonic"] = time.monotonic()
    log.info(
        "Sanity floor %s from %s (slack %.0fs)", _iso(value), label, FLOOR_SLACK_SEC
    )


def current_floor():
    """The floor advanced by elapsed monotonic time, less the slack allowance."""
    if not state["floor_epoch"]:
        return None
    elapsed = time.monotonic() - state["floor_monotonic"]
    return state["floor_epoch"] + elapsed - FLOOR_SLACK_SEC


def _reject_log_due() -> bool:
    now = time.monotonic()
    if (now - state["last_reject_log"]) < REJECT_LOG_INTERVAL_SEC:
        return False
    state["last_reject_log"] = now
    return True


# ---------------------------------------------------------------------------
# MQTT callbacks
# ---------------------------------------------------------------------------
def on_connect(client, _userdata, _flags, reason_code, _properties):
    if reason_code == 0:
        log.info("Connected to MQTT %s:%d", MQTT_HOST, MQTT_PORT)
        client.subscribe(MQTT_INBOUND_TOPIC)
    else:
        log.error("MQTT connect failed: %s", reason_code)


def on_disconnect(_client, _userdata, _flags, reason_code, _properties):
    if reason_code != 0:
        log.warning("MQTT disconnected (rc=%s), auto-reconnecting", reason_code)


def on_message(_client, _userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except Exception as exc:
        log.debug("Bad JSON payload: %s", exc)
        return

    ident = payload.get("identifier")
    if not ident:
        return

    try:
        data = bits_to_bytes(payload.get("data") or [])
    except Exception as exc:
        log.debug("Bad data field: %s", exc)
        return
    dlc = int(payload.get("data_length_code", len(data)))

    if ident == CAN_ID_NAVSTAT and dlc >= 6:
        # Byte 0 of 0x07 is satellites-in-use. Byte 5 is the configured
        # constellation mode (NOT a fix flag) so we ignore it for validity.
        state["satellites"] = data[0]
        state["fix_ts"] = time.time()
        return

    if ident == CAN_ID_DATETIME and dlc >= 7:
        now = time.time()
        if (now - state["fix_ts"]) > GNSS_VALIDITY_TIMEOUT_SEC:
            return  # no recent 0x07 frame — can't confirm fix state
        if state["satellites"] < MIN_SATELLITES:
            return  # too few satellites in-use, Bearing's clock isn't trustworthy
        year = (data[0] << 8) | data[1]
        month, day, hour, minute, second = data[2], data[3], data[4], data[5], data[6]
        if not (2025 <= year <= 2100):
            return
        try:
            dt = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
        except ValueError:
            return  # rejected invalid date components

        bearing_epoch = dt.timestamp()
        delta = bearing_epoch - now

        if abs(delta) < DRIFT_THRESHOLD_SEC:
            # The source agrees with the system clock: it is behaving. Clear any
            # backward streak / latch and let it raise the floor.
            if state["latched"] or state["backward_steps"]:
                log.info(
                    "Bearing time agrees with system clock again "
                    "(%+.3f s); re-enabling clock stepping", delta
                )
                state["latched"] = False
                state["backward_steps"] = 0
            record_high_water(bearing_epoch)
            return

        if (now - state["last_set_ts"]) < MIN_INTERVAL_SEC:
            return

        if state["latched"]:
            if _reject_log_due():
                log.error(
                    "Ignoring Bearing time %s (offset %+.1f s, sats=%d): source "
                    "latched off after %d consecutive backward steps. System "
                    "clock left to chronyd.",
                    dt.isoformat(timespec="seconds"), delta,
                    state["satellites"], MAX_BACKWARD_STEPS,
                )
            return

        floor = current_floor()
        if floor is not None and bearing_epoch < floor:
            if _reject_log_due():
                log.error(
                    "REFUSED Bearing time %s: %.2f days below sanity floor %s "
                    "(sats=%d). A fabricated satellite count cannot be "
                    "distinguished from a real fix, so the floor is the "
                    "backstop — check whether Cornerstone is running a mock "
                    "GNSS build. System clock left at %s for chronyd.",
                    dt.isoformat(timespec="seconds"),
                    (floor - bearing_epoch) / 86400.0,
                    _iso(floor), state["satellites"], _iso(now),
                )
            return

        if delta < 0:
            state["backward_steps"] += 1
            if state["backward_steps"] > MAX_BACKWARD_STEPS:
                log.error(
                    "Bearing asked to move the clock backward %d times in a row "
                    "(latest %+.3f s, sats=%d). A real correction happens once; "
                    "this is a broken time source. Latching off — chronyd now "
                    "owns the system clock.",
                    state["backward_steps"], delta, state["satellites"],
                )
                state["latched"] = True
                return
        else:
            state["backward_steps"] = 0

        log.warning(
            "System clock differs from Bearing GNSS by %+.3f s "
            "(system=%s, bearing=%s, sats=%d); stepping",
            delta,
            datetime.fromtimestamp(now, tz=timezone.utc).isoformat(timespec="seconds"),
            dt.isoformat(timespec="seconds"),
            state["satellites"],
        )
        try:
            set_system_clock(bearing_epoch)
            state["last_set_ts"] = time.time()
            record_high_water(bearing_epoch)
        except OSError as exc:
            log.error("clock_settime failed: %s", exc)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    init_floor()

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        protocol=mqtt.MQTTv311,
    )
    client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    if USE_TLS:
        client.tls_set(
            ca_certs=CA_CERT_PATH,
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLSv1_2,
        )
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    client.loop_start()
    try:
        while not shutdown_requested:
            time.sleep(1)
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    while not shutdown_requested:
        try:
            main()
            if shutdown_requested:
                break
            time.sleep(5)
        except Exception as exc:
            log.error("Main loop crashed: %s", exc)
            with open(os.path.join(SCRIPT_DIR, "time-from-bearing-crash.log"), "a") as f:
                f.write(f"\n---\nError: {exc}\n")
                f.write(traceback.format_exc())
            time.sleep(30)
