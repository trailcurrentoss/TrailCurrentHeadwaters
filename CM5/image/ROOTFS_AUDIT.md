# Rootfs completeness audit

Phase 7 requires that a freshly flashed CM5 image is **fully self-contained** — a device that gets flashed and powered on with no network, and never receives an OTA, must reach a healthy no-bundle PWA state on its own.

This audit walks each row of the plan's Phase 7 rootfs table and cites where in the layer YAMLs that row is satisfied — plus what verifies it, plus what still needs manual QA.

Auditor: Phase 7 closeout, 2026-07-14.

---

## Findings

**One real gap surfaced during this audit and was fixed:**

- **`map-watcher.service` was not installed at image bake time.** Only `deploy.sh` Step 6.2 installed it on first OTA. A device that was flashed and never received a deploy could accept a bundle upload via the PWA (backend saved the zip) but nothing would apply it (MQTT `MAPS_AVAILABLE` fired into an empty subscriber set). Fix landed in both [`layer/trailcurrent-base.yaml`](layer/trailcurrent-base.yaml) and [`layer/trailcurrent-base-wireless.yaml`](layer/trailcurrent-base-wireless.yaml) — `map-watcher.service` is now written into `/etc/systemd/system/` at bake time (mirroring the deployment-watcher pattern) and added to the `enable-units` list.

All other categories were already satisfied.

---

## Row-by-row

Line numbers below are `trailcurrent-base.yaml`; wireless variant lives at the same relative offsets, adjusted for the CAN overlay differences at the top of the file.

### OS packages

Baked in via `packages:` list at the top of the YAML — `bdebstrap` installs these into the chroot before any customize hook runs.

- `jq` — L12
- `python3`, `python3-venv`, `python3-pip` — L14–16
- `avahi-daemon`, `avahi-utils` — L19–20
- `curl`, `unzip` — L22–23
- `hostapd`, `dnsmasq` — L30–31 (for the captive-portal setup AP)
- `chrony` — installed in the customize-hook at L49 (deferred because it conflicts with `systemd-timesyncd` at install time)
- `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-compose-plugin` — installed by [`layer/files/install-docker.sh`](layer/files/install-docker.sh) inside a customize-hook

**Verified by:** `verify-image.sh` section 2 asserts `hostapd`, `dnsmasq`, `rfkill`, `iw` binaries are present in the produced image.

### Python modules

- `local_code/requirements.txt` is copied into `/home/trailcurrent/local_code/` at L222 by the glob that grabs `*.py`, `*.service`, and `requirements.txt`.
- The `cantomqtt` venv is created at first-boot time by `trailcurrent-firstboot.service` (installed at L279), which runs `python3 -m venv` + `pip install -r local_code/requirements.txt`.

**Why first-boot instead of bake:** the CM5's native arm64 Python + pip is used, and the venv path bakes in `/home/trailcurrent/` — deferring to first-boot avoids any host/target arch mismatch during build.

### Container image tarballs

- `images/*.tar` copied into `/home/trailcurrent/images/` at L232–233.
- `trailcurrent-load-images.service` (L303) runs `docker load < images/*.tar` at first boot, after `docker.service` is up.
- Then `trailcurrent-compose-up.service` (L332) runs `docker compose up -d --no-build` to bring all services up.

Six tarballs must be present: frontend, backend, mosquitto, mongodb, photon, valhalla. Their generation is [`build-and-save-images.sh`](../../build-and-save-images.sh). If any are missing, `trailcurrent-load-images.service` fails and compose-up doesn't proceed — the image would still boot but no containers would start.

**Verified by:** the layer YAML at L235 checks `ls images/*.tar` at bake time and emits a WARNING (not a hard error) if none are present. Bake-time hard-fail would be an improvement; today the operator is expected to have run `build-and-save-images.sh` first (documented in [`build.sh`](build.sh) header comments).

### Systemd units enabled at bake time

Enabled via `bdebstrap`'s `enable-units` hook at L570:

```
can0 disable-usb cpu-performance docker trailcurrent-firstboot
trailcurrent-load-images trailcurrent-compose-up cantomqtt
discovery-mdns deployment-watcher map-watcher os-settings
trailcurrent-setup-ap chrony time-from-bearing
```

Each unit is installed via a `cat > /etc/systemd/system/<name>.service << SVCEOF ... SVCEOF` block earlier in the file:

| Unit | Line | Purpose |
|---|---|---|
| `can0` | L118 | CAN interface up/down |
| `disable-usb` | L149 | Disable USB bus for RV power draw |
| `cpu-performance` | L172 | CPU governor to `performance` |
| `trailcurrent-firstboot` | L279 | First-boot setup (NVMe, EEPROM, TLS, venv) |
| `trailcurrent-load-images` | L303 | `docker load < images/*.tar` |
| `trailcurrent-compose-up` | L332 | `docker compose up -d` |
| `cantomqtt` | L356 | CAN-to-MQTT bridge |
| `deployment-watcher` | L379 | OTA deployment package apply |
| `map-watcher` | (new, added in this Phase 7 sweep) | Map bundle apply |
| `os-settings` | L508 | Host OS settings via MQTT |
| `trailcurrent-setup-ap` | L473 | Captive-portal WiFi AP |
| `chrony` | (installed at L49; enabled via list) | NTP server + client |
| `time-from-bearing` | L414 | GNSS-derived time sync |
| `discovery-mdns` | L438 | mDNS device discovery |

**Verified by:** `verify-image.sh` section 3 does `debugfs -R "ls /etc/systemd/system/multi-user.target.wants/"` and asserts each expected unit's symlink exists.

**Drift risk:** each service is defined inline in the YAML AND has a canonical `.service` file in `local_code/` (deployment-watcher, map-watcher, time-from-bearing, os-settings) or is unique to the image (`can0`, `disable-usb`, etc.). The inline copy and the `local_code/` copy can drift silently. Long-term fix: install-from-source pattern (like [`trailcurrent-first-login.sh`](layer/files/trailcurrent-first-login.sh) uses at L264). Not urgent — pattern is consistent so drift is visible in code review.

### Docker compose

- `docker-compose.yml` copied to `/home/trailcurrent/docker-compose.yml` at L206–207 by `install -m 644 -o 1000 -g 1000`.
- Bind-mount targets pre-created with correct ownership:
  - `data/maps/`, `versions/`, `staging/` — L245–247 (`chown -R 1000:1000`, `chmod 0755`)
  - `data/keys/`, `data/firmware/`, `data/deployments/` — L259+ (see layer YAML)
- **`data/maps/current` symlink deliberately NOT pre-created** — created by `map-watcher` on first successful bundle upload.

**Verified by:** L253–256 runs `find` at bake time for any non-`trailcurrent`-owned entry under `data/maps/` and fails the build loudly if any is found.

### Map bundle

**Deliberately absent** per Confirmed Decisions → Initial Payload in the migration plan. Rationale: bundles are region-specific and 90–130 GB each; baking any one default would either force a region on non-users or require per-region image variants. First-time upload via PWA is the documented user step.

### Nginx config

The `containers/frontend/nginx.conf` gets baked into the frontend container image at container-build time (`build-and-save-images.sh`). The container tarball then lands in `images/frontend.tar` and is loaded at first-boot. So the nginx config that runs on the CM5 is exactly what was in the repo at package-build time.

### User accounts

`trailcurrent` user is defined via `rpi-image-gen`'s `IGconf_device_user1` config — see `config/*.yaml`. Groups: `docker`, `dialout` (CAN), `gpio`. Passwordless-sudo whitelist for the specific commands the PWA needs (timezone set, factory reset) is installed by [`layer/files/install-docker.sh`](layer/files/install-docker.sh) or a companion hook.

### Hardware config

- CAN HAT overlay per variant: Base HAT (B) writes `dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25,spimaxfrequency=2000000` to `/boot/firmware/config.txt`; Wireless-Base uses `interrupt=17`. Both variants baked at image time.
- GPIO group memberships: `trailcurrent` user is added to `gpio` group at L578+.
- Kernel modules `mcp2515`, USB serial: verified to load on first boot by `can0.service` (L118).

**Verified by:** `verify-image.sh` section 4 asserts the correct CAN overlay is present in the produced image's `config.txt`.

### Firmware artifacts

`data/firmware/` is pre-created empty. Firmware binaries (module OTA payloads) ship as part of deployment packages via `create-deployment-package.sh` — they're not baked into the CM5 image because they can be updated independently.

### Bootloader

Standard `rpiboot`-flashable layout. Boot partition (FAT), root partition (ext4 with **16 KB block size** for CM5 page-size alignment — see [`verify-image.sh`](verify-image.sh) header for why loop-mount doesn't work). Boot-switch position per variant documented in [`../SETUP.md`](../SETUP.md).

### Kernel modules

- `mcp2515` (CAN) — kernel-shipped, loaded via device tree overlay
- USB/serial (`cdc_acm`, `usbserial`, `ftdi_sio`, etc.) — kernel-shipped, loaded on-demand
- `avahi` — not a kernel module but ships as user-space daemon

**Verified by:** if a kernel module is missing at runtime, the corresponding service fails to start — visible in `journalctl` and would be caught during Test A (airgap flash test).

---

## Manual QA that this audit does not automate

Rows above cover the STATIC content of the image. The full acceptance test still requires:

- **Boot the image on real hardware** — no build-time check can prove a device actually reaches a healthy PWA state after flash + power-on. That's Test A (airgap flash) in [ACCEPTANCE_TESTS.md](../../DOCS/ACCEPTANCE_TESTS.md).
- **Run through the setup portal** — `Headwaters-XXXX` AP appears, phone joins, portal accepts Wi-Fi credentials, device reboots and lands on the configured network.
- **First-time bundle upload works end-to-end** — with the map-watcher fix from this audit, this should now succeed on a fresh flash without any OTA. Previously it would have failed silently.

See [DOCS/ACCEPTANCE_TESTS.md](../../DOCS/ACCEPTANCE_TESTS.md) for the runnable Test A / B / C checklists.
