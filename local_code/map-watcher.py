#!/usr/bin/env python3
"""
TrailCurrent Map Watcher

Sibling of deployment-watcher, but for offline map bundles. Listens on
the local MQTT broker for `local/maps/available` notifications published
by the backend after a PWA upload completes, then:

  1. Verifies the staged zip's SHA256 against the record.
  2. Extracts to data/maps/versions/<version>-staging/.
  3. Validates each artifact SHA256 against the bundle's manifest.json.
  4. Renames staging -> data/maps/versions/<version>/ (atomic on same fs).
  5. Restarts photon + valhalla containers if compose knows about them.
  6. Atomically flips data/maps/current -> versions/<version>/.
  7. Prunes to N=2 versions (current + one previous).

Fail-closed on any precondition/verification failure: the existing
data/maps/current symlink is never touched unless the new bundle has
been fully staged and its symlink flip is the ONLY remaining step.

Runs as `trailcurrent`, not root — the Phase 6 bake hook makes every
directory under data/maps/ trailcurrent-owned, and the backend chowns
uploaded zips to the same user before publishing MAPS_AVAILABLE.
"""

import hashlib
import json
import os
import re
import shutil
import signal
import ssl
import subprocess
import sys
import threading
import time
import traceback
import zipfile

import paho.mqtt.client as mqtt


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

MQTT_BROKER_URL = os.environ.get('MQTT_BROKER_URL')
if not MQTT_BROKER_URL:
    print('ERROR: MQTT_BROKER_URL environment variable must be set', file=sys.stderr)
    sys.exit(1)

match = re.match(r'(mqtts?)://([^:]+):(\d+)', MQTT_BROKER_URL)
if not match:
    print(f'ERROR: Invalid MQTT_BROKER_URL format: {MQTT_BROKER_URL}', file=sys.stderr)
    sys.exit(1)

MQTT_PROTOCOL = match.group(1)
MQTT_BROKER = match.group(2)
MQTT_PORT = int(match.group(3))
MQTT_USE_TLS = (MQTT_PROTOCOL == 'mqtts')
MQTT_CA_CERT = os.path.join(SCRIPT_DIR, 'ca.pem')

MQTT_USERNAME = os.environ.get('MQTT_USERNAME')
MQTT_PASSWORD = os.environ.get('MQTT_PASSWORD')
if not MQTT_USERNAME or not MQTT_PASSWORD:
    print('ERROR: MQTT_USERNAME/MQTT_PASSWORD must be set', file=sys.stderr)
    sys.exit(1)

# Topics
MAPS_AVAILABLE_TOPIC = 'local/maps/available'
MAPS_STATUS_TOPIC = 'local/maps/status'
MAPS_ROLLBACK_TOPIC = 'local/maps/rollback'
MAPS_CONFIRM_TOPIC = 'local/maps/confirm'      # user OK'd a cross-region apply
MAPS_CANCEL_TOPIC = 'local/maps/cancel'        # user rejected a pending apply

# Paths
HOME_DIR = os.path.expanduser('~')
MAPS_ROOT = os.path.join(HOME_DIR, 'data', 'maps')
STAGING_DIR = os.path.join(MAPS_ROOT, 'staging')
VERSIONS_DIR = os.path.join(MAPS_ROOT, 'versions')
CURRENT_LINK = os.path.join(MAPS_ROOT, 'current')
LOCK_FILE = '/tmp/map-watcher.lock'

# How many versions to retain (current + N-1 previous). Kept at 2 per
# Overarching principle "one previous version for rollback".
RETAIN_VERSIONS = 2

# Services that map onto artifact directories the bundle drops. When a new
# version is applied they need to be restarted to re-read their data. If
# compose doesn't know about the service (Phases 3/4 not yet shipped),
# `docker compose restart` silently no-ops and we move on.
DATA_CONSUMER_SERVICES = ['photon', 'valhalla']

mqtt_client = None
shutting_down = False

# Pending cross-region-confirmation uploads. Keyed by upload_id; each entry
# is the original MAPS_AVAILABLE payload so we can resume the apply exactly
# where we paused when the user confirms. In-memory only — a watcher
# restart drops the pending set (user re-uploads or re-triggers).
pending_confirmations = {}


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] map-watcher: {msg}", flush=True)


def report_status(upload_id, status, reason=None, version=None, region=None):
    if not mqtt_client:
        log(f"Cannot report status '{status}' - MQTT not connected")
        return
    payload = {
        'id': upload_id,
        'status': status,
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    }
    if reason:  payload['reason']  = reason
    if version: payload['version'] = version
    if region:  payload['region']  = region
    try:
        mqtt_client.publish(MAPS_STATUS_TOPIC, json.dumps(payload), qos=1)
        log(f"Published status '{status}' for {upload_id}"
            + (f" ({reason})" if reason else ""))
    except Exception as e:
        log(f"Failed to publish status: {e}")


def acquire_lock():
    if os.path.isfile(LOCK_FILE):
        try:
            with open(LOCK_FILE) as f:
                pid = int(f.read().strip())
            os.kill(pid, 0)
            return False
        except (ValueError, ProcessLookupError, PermissionError):
            os.remove(LOCK_FILE)
    with open(LOCK_FILE, 'w') as f:
        f.write(str(os.getpid()))
    return True


def release_lock():
    try:
        if os.path.isfile(LOCK_FILE):
            os.remove(LOCK_FILE)
    except Exception:
        pass


def sha256_file(path, chunk=65536):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def next_available_version_dir(version):
    """If <version>/ already exists, append .2 / .3 / etc. so we never
    stomp a previous same-day upload. Mirrors the build.sh monotonic
    suffix behavior on the build side."""
    candidate = os.path.join(VERSIONS_DIR, version)
    if not os.path.exists(candidate):
        return version
    n = 2
    while True:
        alt = f"{version}.{n}"
        if not os.path.exists(os.path.join(VERSIONS_DIR, alt)):
            return alt
        n += 1


def atomic_symlink(target_rel, link_path):
    """ln -sfn target_rel link_new && mv -Tf link_new link_path — atomic
    on same filesystem. Works whether link_path already exists as a
    symlink or not (first-ever upload case)."""
    tmp = link_path + '.new'
    if os.path.islink(tmp) or os.path.exists(tmp):
        os.remove(tmp)
    os.symlink(target_rel, tmp)
    os.rename(tmp, link_path)


def restart_data_consumers():
    """Bring photon + valhalla up against the freshly-applied bundle.

    Both services are behind `profiles: [maps]` in docker-compose.yml so they
    don't start on virgin devices where data/maps/current is absent. This
    function is the single point in the codebase that owns their lifecycle:
    `up -d` starts them if they weren't running, then an explicit `restart`
    forces Photon/Valhalla to re-read their bind-mounted index (they cache
    at startup, so a bind-mount change alone isn't enough).

    Silently skips any service the current compose file doesn't define
    (e.g. Phase 3 shipped photon but Phase 4 valhalla hasn't landed yet).
    """
    try:
        cfg = subprocess.run(
            ['docker', 'compose', 'config', '--services'],
            capture_output=True, text=True, timeout=15,
            cwd=HOME_DIR
        )
        # `config --services` doesn't emit services that are behind an
        # inactive profile. Use `config --profiles` awareness: run with
        # every relevant profile so we see the full service catalog.
        cfg_all = subprocess.run(
            ['docker', 'compose', '--profile', 'maps', 'config', '--services'],
            capture_output=True, text=True, timeout=15,
            cwd=HOME_DIR
        )
        defined = set(cfg.stdout.split()) | set(cfg_all.stdout.split())
    except Exception as e:
        log(f"Warning: could not list compose services: {e}")
        defined = set()

    for svc in DATA_CONSUMER_SERVICES:
        if svc not in defined:
            log(f"Service '{svc}' not defined in compose; skipping")
            continue
        try:
            up = subprocess.run(
                ['docker', 'compose', '--profile', 'maps', 'up', '-d', '--no-deps', svc],
                capture_output=True, text=True, timeout=180,
                cwd=HOME_DIR
            )
            if up.returncode != 0:
                log(f"Warning: up '{svc}' exit {up.returncode}: {up.stderr.strip()}")
                continue
            rst = subprocess.run(
                ['docker', 'compose', 'restart', svc],
                capture_output=True, text=True, timeout=180,
                cwd=HOME_DIR
            )
            if rst.returncode == 0:
                log(f"Restarted service '{svc}'")
            else:
                log(f"Warning: restart '{svc}' exit {rst.returncode}: {rst.stderr.strip()}")
        except Exception as e:
            log(f"Warning: could not manage '{svc}': {e}")


def prune_versions():
    """Keep newest RETAIN_VERSIONS directories (always keeping the one
    'current' points at). Anything older is deleted."""
    if not os.path.isdir(VERSIONS_DIR):
        return
    entries = sorted(
        [e for e in os.listdir(VERSIONS_DIR)
         if os.path.isdir(os.path.join(VERSIONS_DIR, e)) and not e.endswith('-staging')],
        reverse=True
    )
    current_target = None
    try:
        current_target = os.path.basename(os.readlink(CURRENT_LINK))
    except OSError:
        pass

    keep = set(entries[:RETAIN_VERSIONS])
    if current_target:
        keep.add(current_target)

    for name in entries:
        if name in keep:
            continue
        path = os.path.join(VERSIONS_DIR, name)
        try:
            shutil.rmtree(path)
            log(f"Pruned old version {name}")
        except Exception as e:
            log(f"Warning: could not prune {name}: {e}")


def extract_tar_artifacts(target_dir):
    """Extract any .tar artifacts inside `target_dir` in place, verify the
    expected directory appeared (basename without .tar), and delete the
    tarball. Photon and Valhalla containers bind-mount the extracted
    directories directly; keeping tars around costs ~90 GB and blocks
    consumer startup.

    Returns (ok, error_message). Never raises.

    Convention: `photon_data.tar` MUST unpack a top-level `photon_data/`
    directory; `valhalla_tiles.tar` MUST unpack `valhalla_tiles/`. If the
    tar produces a different layout that's a build-side violation and we
    fail loudly rather than silently leaving broken state.
    """
    for name in sorted(os.listdir(target_dir)):
        if not name.endswith('.tar'):
            continue
        tar_path = os.path.join(target_dir, name)
        expected_dir = os.path.join(target_dir, name[:-len('.tar')])
        if os.path.isdir(expected_dir):
            # A previous run already extracted this tar. Idempotent: remove
            # the leftover tar and move on.
            log(f"{name}: extracted dir already exists, removing tar")
            try: os.remove(tar_path)
            except OSError as e: log(f"  warn: could not remove {tar_path}: {e}")
            continue
        log(f"Extracting {name} in place...")
        try:
            subprocess.run(
                ['tar', '--no-same-owner', '-xf', tar_path, '-C', target_dir],
                check=True, capture_output=True, text=True
            )
        except subprocess.CalledProcessError as e:
            return False, f'tar extract failed for {name}: {e.stderr.strip() or e.returncode}'
        except FileNotFoundError:
            return False, "tar binary not on PATH (should never happen on the CM5 rootfs)"
        if not os.path.isdir(expected_dir):
            return False, f'{name} did not produce expected directory {os.path.basename(expected_dir)}/'
        try:
            os.remove(tar_path)
            log(f"  removed {name} after successful extract")
        except OSError as e:
            # Non-fatal: extraction succeeded, leftover tar wastes space
            # but consumers can still start. Log and continue.
            log(f"  warn: could not remove {tar_path}: {e}")
    return True, None


def current_bundle_region():
    """Read data/maps/current/manifest.json's region field. Returns
    (region, display_name) or (None, None) if there's no current bundle
    or it's missing/corrupt."""
    try:
        target = os.path.realpath(CURRENT_LINK)
        if not os.path.isdir(target):
            return (None, None)
        manifest_path = os.path.join(target, 'manifest.json')
        if not os.path.isfile(manifest_path):
            return (None, None)
        with open(manifest_path) as f:
            m = json.load(f)
        return (m.get('region'), m.get('region_display_name') or m.get('region'))
    except Exception:
        return (None, None)


def migrate_current_bundle_tars():
    """One-shot self-healing on watcher start. If the currently-applied
    bundle still has .tar artifacts (i.e. it was applied by a pre-tar-
    extraction watcher build), extract them in place so Photon/Valhalla
    can consume the extracted directories on next start.

    Silent no-op when there's no current bundle or the tars are already
    extracted.
    """
    if not os.path.islink(CURRENT_LINK):
        return
    try:
        target = os.path.realpath(CURRENT_LINK)
    except OSError:
        return
    if not os.path.isdir(target):
        return
    leftover_tars = [n for n in os.listdir(target) if n.endswith('.tar')]
    if not leftover_tars:
        return
    log(f"Startup migration: extracting {len(leftover_tars)} leftover tar(s) in {target}")
    ok, err = extract_tar_artifacts(target)
    if ok:
        log("Startup migration complete; restarting data consumers")
        restart_data_consumers()
    else:
        log(f"Startup migration FAILED (non-fatal — device continues serving prior state): {err}")


def derive_version(original_name, manifest):
    """Return the target versions/<name>/ directory name (before same-day
    suffixing). Prefers the zip filename's date portion — matches
    build.sh's `maps-<date>.zip` convention — then falls back to a stripped
    manifest build_date, and only if both fail uses the raw build_date.

    Examples:
        maps-2026.07.12.zip         -> 2026.07.12
        maps-2026.07.12.2.zip       -> 2026.07.12.2
        build_date 2026-07-12T...   -> 2026.07.12  (fallback)
    """
    if original_name:
        m = re.match(r'maps-(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)\.zip$', original_name)
        if m:
            return m.group(1)
    bd = (manifest or {}).get('build_date') or ''
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', bd)
    if m:
        return '.'.join(m.groups())
    return bd or (manifest or {}).get('version') or 'unknown'


def handle_available(payload_bytes):
    try:
        data = json.loads(payload_bytes)
    except json.JSONDecodeError as e:
        log(f"Invalid MAPS_AVAILABLE payload: {e}")
        return

    upload_id = data.get('id')
    filename = data.get('filename')
    original_name = data.get('originalName') or ''
    sha256 = data.get('sha256')

    if not upload_id or not filename or not sha256:
        log("MAPS_AVAILABLE payload missing required fields (id, filename, sha256)")
        return

    zip_path = os.path.join(STAGING_DIR, filename)
    if not os.path.isfile(zip_path):
        log(f"Staged zip not found at {zip_path}")
        report_status(upload_id, 'failed', reason='staged zip missing')
        return

    if not acquire_lock():
        log("Another map-apply is in progress; will not overlap")
        report_status(upload_id, 'failed', reason='another apply in progress')
        return

    try:
        # --- Verify the whole zip's SHA256 ---
        report_status(upload_id, 'verifying')
        log(f"Verifying SHA256 of {zip_path}...")
        computed = sha256_file(zip_path)
        if computed != sha256:
            log(f"CHECKSUM MISMATCH! Expected {sha256}, got {computed}")
            try: os.remove(zip_path)
            except OSError: pass
            report_status(upload_id, 'failed', reason='zip checksum mismatch')
            return
        log("Zip checksum verified")

        # --- Read manifest.json out of the zip WITHOUT extracting first ---
        report_status(upload_id, 'extracting')
        try:
            with zipfile.ZipFile(zip_path, 'r') as zf:
                if 'manifest.json' not in zf.namelist():
                    log("Bundle missing manifest.json")
                    try: os.remove(zip_path)
                    except OSError: pass
                    report_status(upload_id, 'failed', reason='missing manifest')
                    return
                with zf.open('manifest.json') as mf:
                    manifest = json.load(mf)
        except zipfile.BadZipFile as e:
            log(f"Bundle is not a valid zip: {e}")
            try: os.remove(zip_path)
            except OSError: pass
            report_status(upload_id, 'failed', reason='not a valid zip')
            return

        raw_version = derive_version(original_name, manifest)
        if raw_version == 'unknown':
            log("Cannot derive version from zip filename or manifest.build_date")
            try: os.remove(zip_path)
            except OSError: pass
            report_status(upload_id, 'failed', reason='no derivable version')
            return

        # Cross-region confirmation gate. If a bundle is already installed
        # and the incoming bundle's region differs, pause the apply and
        # wait for an explicit MAPS_CONFIRM (or MAPS_CANCEL) from the PWA.
        # The `data` dict already includes the confirmation marker if the
        # user has previously confirmed, so we don't loop.
        if not data.get('confirmed'):
            new_region = manifest.get('region')
            new_region_display = manifest.get('region_display_name') or new_region
            cur_region, cur_region_display = current_bundle_region()
            if cur_region and new_region and cur_region != new_region:
                log(f"Region change detected: {cur_region} -> {new_region} — pausing apply, awaiting confirmation.")
                pending_confirmations[upload_id] = data  # remember payload for resume
                report_status(
                    upload_id, 'awaiting-confirmation',
                    reason=f'Region change: {cur_region_display} → {new_region_display}',
                    region=new_region
                )
                return

        version = next_available_version_dir(raw_version)
        staging_target = os.path.join(VERSIONS_DIR, f"{version}-staging")
        final_target = os.path.join(VERSIONS_DIR, version)

        # Wipe any leftover staging dir from a killed prior attempt.
        if os.path.exists(staging_target):
            shutil.rmtree(staging_target)
        os.makedirs(staging_target, exist_ok=True)

        # --- Extract to staging ---
        log(f"Extracting to {staging_target}...")
        try:
            with zipfile.ZipFile(zip_path, 'r') as zf:
                zf.extractall(staging_target)
        except Exception as e:
            log(f"Extract failed: {e}")
            shutil.rmtree(staging_target, ignore_errors=True)
            report_status(upload_id, 'failed', reason=f'extract failed: {e}')
            return

        # --- Verify each artifact's SHA256 against manifest ---
        artifacts = manifest.get('artifacts') or {}
        if not artifacts:
            # Backward-compat: some manifests use a flat map of filename->sha256
            # instead of an "artifacts" object.
            artifacts = {k: {'sha256': v} for k, v in manifest.items()
                         if k not in ('schema_version', 'region', 'display_name',
                                      'build_date', 'version', 'pbf_date',
                                      'odbl_notice', 'description')
                         and isinstance(v, str)}
        for artifact_name, meta in artifacts.items():
            artifact_path = os.path.join(staging_target, artifact_name)
            expected = meta.get('sha256') if isinstance(meta, dict) else meta
            if not expected:
                continue
            if not os.path.exists(artifact_path):
                log(f"Artifact missing after extract: {artifact_name}")
                shutil.rmtree(staging_target, ignore_errors=True)
                report_status(upload_id, 'failed',
                              reason=f'artifact missing: {artifact_name}')
                return
            # Directories are checksummed by tar-then-hash on the build
            # side; for the runtime we only verify files.
            if not os.path.isfile(artifact_path):
                continue
            log(f"Verifying {artifact_name}...")
            actual = sha256_file(artifact_path)
            if actual != expected:
                log(f"Artifact checksum mismatch for {artifact_name}")
                shutil.rmtree(staging_target, ignore_errors=True)
                report_status(upload_id, 'failed',
                              reason=f'artifact checksum mismatch: {artifact_name}')
                return
        log("All artifact checksums verified")

        # --- Extract .tar artifacts in place ---
        # Photon and Valhalla containers bind-mount the extracted directories
        # (photon_data/, valhalla_tiles/), not the tarballs. Extract now,
        # while we're still in staging — a failure here means we leave the
        # existing `current` symlink untouched and abort the apply.
        ok, err = extract_tar_artifacts(staging_target)
        if not ok:
            log(f"Tar extract failed: {err}")
            shutil.rmtree(staging_target, ignore_errors=True)
            report_status(upload_id, 'failed', reason=err)
            return

        # --- Atomically promote staging_target -> final_target ---
        # os.rename on same filesystem is atomic. If a prior attempt left
        # final_target around we already dodged it via next_available_version_dir.
        os.rename(staging_target, final_target)
        log(f"Promoted to versions/{version}")

        # --- Restart data consumers (if compose knows about them) ---
        restart_data_consumers()

        # --- Atomic symlink swap ---
        atomic_symlink(os.path.join('versions', version), CURRENT_LINK)
        log(f"Symlink current -> versions/{version}")

        # --- Prune old versions ---
        prune_versions()

        # --- Clean up staged zip (only after successful apply) ---
        try:
            os.remove(zip_path)
            log(f"Removed staged zip {zip_path}")
        except OSError as e:
            log(f"Warning: could not remove staged zip: {e}")

        region = manifest.get('region')
        report_status(upload_id, 'applied', version=version, region=region)
        log(f"Applied bundle {upload_id} (region={region}, version={version})")

    except Exception as e:
        log(f"Unexpected error applying bundle: {e}")
        log(traceback.format_exc())
        report_status(upload_id, 'failed', reason=f'internal error: {e}')
    finally:
        release_lock()


def handle_confirm(payload_bytes):
    """User confirmed a cross-region apply. Look up the paused payload
    and resume handle_available with a `confirmed` marker set so the
    region gate lets it through."""
    try:
        data = json.loads(payload_bytes)
    except json.JSONDecodeError as e:
        log(f"Invalid MAPS_CONFIRM payload: {e}")
        return
    upload_id = data.get('id')
    if not upload_id:
        log("MAPS_CONFIRM missing id")
        return
    original = pending_confirmations.pop(upload_id, None)
    if not original:
        log(f"MAPS_CONFIRM for {upload_id} but no pending state — ignoring")
        return
    log(f"User confirmed cross-region apply for {upload_id}, resuming.")
    original['confirmed'] = True
    handle_available(json.dumps(original).encode('utf-8'))


def handle_cancel(payload_bytes):
    """User rejected a pending cross-region apply. Delete the staged zip
    and drop from pending. Publishes 'failed' with a canceled-reason."""
    try:
        data = json.loads(payload_bytes)
    except json.JSONDecodeError as e:
        log(f"Invalid MAPS_CANCEL payload: {e}")
        return
    upload_id = data.get('id')
    if not upload_id:
        log("MAPS_CANCEL missing id")
        return
    original = pending_confirmations.pop(upload_id, None)
    if not original:
        log(f"MAPS_CANCEL for {upload_id} but no pending state — ignoring")
        return
    filename = original.get('filename')
    if filename:
        zip_path = os.path.join(STAGING_DIR, filename)
        try:
            if os.path.isfile(zip_path):
                os.remove(zip_path)
                log(f"Deleted staged zip {zip_path} (user canceled)")
        except OSError as e:
            log(f"Warning: could not delete {zip_path}: {e}")
    report_status(upload_id, 'failed', reason='canceled by user')


def handle_rollback(payload_bytes):
    try:
        data = json.loads(payload_bytes)
    except json.JSONDecodeError as e:
        log(f"Invalid MAPS_ROLLBACK payload: {e}")
        return

    target = data.get('targetVersion')
    if not target:
        log("MAPS_ROLLBACK payload missing targetVersion")
        return

    target_dir = os.path.join(VERSIONS_DIR, target)
    if not os.path.isdir(target_dir):
        log(f"Rollback target {target} does not exist")
        report_status(f"rollback-{target}", 'failed',
                      reason='target version not found')
        return

    if not acquire_lock():
        log("Another map-apply is in progress; cannot roll back now")
        return

    try:
        atomic_symlink(os.path.join('versions', target), CURRENT_LINK)
        restart_data_consumers()
        report_status(f"rollback-{target}", 'rolled-back', version=target)
        log(f"Rolled back to {target}")
    except Exception as e:
        log(f"Rollback failed: {e}")
        report_status(f"rollback-{target}", 'failed', reason=f'rollback: {e}')
    finally:
        release_lock()


def setup_mqtt():
    global mqtt_client

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        protocol=mqtt.MQTTv311,
        client_id=f'map-watcher-{int(time.time())}'
    )
    client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    if MQTT_USE_TLS:
        client.tls_set(
            ca_certs=MQTT_CA_CERT,
            certfile=None, keyfile=None,
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLSv1_2
        )

    def on_connect(client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            log("Connected to local MQTT broker")
            client.subscribe(MAPS_AVAILABLE_TOPIC, qos=1)
            log(f"Subscribed to {MAPS_AVAILABLE_TOPIC}")
            client.subscribe(MAPS_ROLLBACK_TOPIC, qos=1)
            log(f"Subscribed to {MAPS_ROLLBACK_TOPIC}")
            client.subscribe(MAPS_CONFIRM_TOPIC, qos=1)
            log(f"Subscribed to {MAPS_CONFIRM_TOPIC}")
            client.subscribe(MAPS_CANCEL_TOPIC, qos=1)
            log(f"Subscribed to {MAPS_CANCEL_TOPIC}")
        else:
            log(f"Failed to connect to local MQTT: {reason_code}")

    def on_message(client, userdata, msg):
        if msg.topic == MAPS_AVAILABLE_TOPIC:
            log(f"MAPS_AVAILABLE received ({len(msg.payload)} bytes)")
            threading.Thread(
                target=handle_available,
                args=(msg.payload,),
                daemon=True
            ).start()
        elif msg.topic == MAPS_ROLLBACK_TOPIC:
            log(f"MAPS_ROLLBACK received ({len(msg.payload)} bytes)")
            threading.Thread(
                target=handle_rollback,
                args=(msg.payload,),
                daemon=True
            ).start()
        elif msg.topic == MAPS_CONFIRM_TOPIC:
            log(f"MAPS_CONFIRM received ({len(msg.payload)} bytes)")
            threading.Thread(
                target=handle_confirm,
                args=(msg.payload,),
                daemon=True
            ).start()
        elif msg.topic == MAPS_CANCEL_TOPIC:
            log(f"MAPS_CANCEL received ({len(msg.payload)} bytes)")
            threading.Thread(
                target=handle_cancel,
                args=(msg.payload,),
                daemon=True
            ).start()

    def on_disconnect(client, userdata, flags, reason_code, properties):
        if not shutting_down:
            log(f"Disconnected from MQTT (reason: {reason_code}), will reconnect...")

    client.on_connect = on_connect
    client.on_message = on_message
    client.on_disconnect = on_disconnect

    client.connect(MQTT_BROKER, MQTT_PORT, 60)
    client.loop_start()
    mqtt_client = client


def shutdown(signum=None, frame=None):
    global shutting_down
    shutting_down = True
    log("Shutting down...")
    if mqtt_client:
        try:
            mqtt_client.loop_stop()
            mqtt_client.disconnect()
        except Exception:
            pass
    release_lock()
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    log("TrailCurrent Map Watcher starting...")

    # Belt-and-suspenders: if the Phase 6 bake hook was missed, refuse to
    # run rather than have `map-watcher` start creating things at runtime
    # (which would land them root-owned under some paths).
    for required in (MAPS_ROOT, STAGING_DIR, VERSIONS_DIR):
        if not os.path.isdir(required):
            log(f"ERROR: required directory {required} does not exist")
            log("Phase 6 bake hook did not run; refusing to start.")
            sys.exit(1)

    # Self-heal any currently-applied bundle that predates tar-extraction
    # support. Runs before MQTT connect so a fresh bundle arriving during
    # startup can't race with the migration.
    try:
        migrate_current_bundle_tars()
    except Exception as e:
        log(f"Startup tar migration raised (non-fatal, continuing): {e}")

    setup_mqtt()
    log("Map watcher running. Waiting for MAPS_AVAILABLE notifications...")
    while not shutting_down:
        time.sleep(1)


if __name__ == '__main__':
    retry_count = 0
    max_retries = 100
    while retry_count < max_retries:
        try:
            main()
            break
        except SystemExit:
            break
        except Exception as e:
            retry_count += 1
            log(f"Unexpected error: {e}")
            with open(os.path.join(SCRIPT_DIR, "map-watcher-crash.log"), "a") as f:
                f.write(f"\n---\nError: {e}\n")
                f.write(traceback.format_exc())
            if retry_count < max_retries:
                log(f"Restarting ({retry_count}/{max_retries})...")
                time.sleep(30)

    if retry_count >= max_retries:
        log(f"Failed after {max_retries} retries, exiting.")
        sys.exit(1)
