# Building a Headwaters CM5 image

`CM5/image/` is TrailCurrent's wrapper around the upstream `rpi-image-gen` tool. It produces a **complete, self-contained** rootfs image for the Raspberry Pi Compute Module 5 — everything needed to boot, come up on the LAN, and serve the PWA is baked in. No `apt install`, no `docker pull`, no manual filesystem setup at first boot.

If you're following the top-level "Build a Headwaters machine from scratch" spine in the repo [README.md](../../README.md#build-a-headwaters-machine-from-scratch), this is step 3.

---

## What you get

Running `sudo ./build.sh` in this directory produces **two `.img` files** — one per CM5 carrier variant — in `work/deploy-<version>/`:

- `trailcurrent-cm5-base.img` — CM5 IO Base board + Waveshare RS485 CAN HAT (B). MCP2515 interrupt on GPIO25.
- `trailcurrent-cm5-wireless-base.img` — Waveshare CM5-IO-Wireless-Base carrier (onboard MCP2515). Interrupt on GPIO17.

Both variants share the same OS, same application stack, same setup portal, same systemd units. The only difference is the CAN overlay wiring in `config.txt`.

---

## Prerequisites

- **Build host:** Debian or Ubuntu, arm64 native OR x86_64 with `qemu-user-static` installed. Apple Silicon macOS works fine when run inside a Debian VM.
- **Root:** `rpi-image-gen` chroots the target rootfs, so `sudo` is required for the entire build.
- **`build-and-save-images.sh` has been run first** — the CM5 image bakes in the container image tarballs from `images/*.tar` so the CM5 has no need to `docker pull` from any registry at first boot. If those tarballs don't exist, this build fails early with a clear error.
- **Disk:** ~15 GB working space in `CM5/image/work/`. The final image compresses to ~2.5 GB per variant.

---

## Quick start

From the repo root:

```bash
# 1. Build the container tarballs (once per app version)
./build-and-save-images.sh

# 2. Build both CM5 variants (~30–45 min first time; caches speed later runs)
cd CM5/image
sudo ./build.sh
```

Output: two `.img.sparse` files (fast to flash) and two `.img` files (works with any imager) in `work/deploy-<git-describe>/`.

### Custom default credentials

Both variants get the same first-boot credentials. Defaults are `trailcurrent` / `trailcurrent`. To override:

```bash
sudo ./build.sh myuser MyStrongPassword
```

The captive-portal setup lets the user finish provisioning without ever typing these, but they're useful if you ever need HDMI console access for troubleshooting.

---

## What's baked into the image

Every category below is present after flash, verified by `verify-image.sh`. **If you flash and the network is unplugged, the device still boots to a healthy no-bundle state.**

| Category | Contents |
|---|---|
| OS + kernel | Debian bookworm-slim, `docker-ce`, `docker-compose-plugin`, `containerd.io`, Python 3 + venv, `jq`, `curl`, `unzip`, `avahi-daemon`, `chrony` |
| Python modules | Everything used by `local_code/*.py` — pre-installed in a baked venv, no `pip install` at first boot |
| Container image tarballs | `images/frontend.tar`, `backend.tar`, `mosquitto.tar`, `mongodb.tar`, `photon.tar`, `valhalla.tar` — loaded via `docker load` at first boot |
| systemd units | `cantomqtt.service`, `deployment-watcher.service`, `map-watcher.service`, `discovery-mdns.service`, `os-settings.service`, `time-from-bearing.service` (enabled at bake time — no manual `systemctl enable` needed) |
| Docker compose | `docker-compose.yml` at `~/`, all bind-mount targets pre-created (`data/maps/`, `data/deployments/`, `data/firmware/`, keys, mongo state) with correct `trailcurrent:trailcurrent` ownership. `data/maps/current` symlink does NOT pre-exist — created by `map-watcher` on first successful bundle upload. |
| Map data | **Deliberately absent.** Bundles are 90–130 GB per region and user-specific; installation is a documented user step. See [DOCS/UpdatingMaps.md](../../DOCS/UpdatingMaps.md). |
| Setup portal | `wifi-setup-portal.service` — a captive-portal AP (`Headwaters-XXXX`) that lets the user configure Wi-Fi with a phone. See [layer/files/wifi-setup-portal.py](layer/files/wifi-setup-portal.py). |
| Ownership invariant | Bake-time verification (`find` for non-`trailcurrent`-owned entries in `data/maps/`) fails the image build loudly if any directory is root-owned. Prevents the "docker autocreated a root-owned dir" pattern from ever escaping the build machine. |
| Hardware | CAN HAT device tree overlay enabled per variant; GPIO group memberships; kernel modules (`mcp2515`, USB/serial for Bearing) verified to load |

Every image is verified against a checklist by [verify-image.sh](verify-image.sh) before being deemed shippable. Look at that script if you want to understand the exact ownership + mode + membership assertions.

---

## Flashing

The `.img.sparse` files are the fastest option — they skip zero-filled regions during transfer:

```bash
# From the build host, with the CM5 in rpiboot mode:
sudo ./CM5/usbboot/rpiboot -d ./CM5/usbboot/mass-storage-gadget64
sudo dd if=work/deploy-<version>/trailcurrent-cm5-base.img.sparse of=/dev/sdX bs=4M status=progress
```

`/dev/sdX` is a placeholder — replace with the actual device from `lsblk`. For step-by-step (including the boot-switch position for Wireless-Base), see [../SETUP.md](../SETUP.md).

---

## Layers

`layer/*.yaml` files are declarative image specs consumed by `rpi-image-gen`. Reading them top-to-bottom is the fastest way to understand what's in the image.

- `trailcurrent-base.yaml` — CM5 IO Base + Waveshare HAT variant
- `trailcurrent-base-wireless.yaml` — Wireless-Base variant

Both files share ~95% content. The differences are the CAN overlay wiring in `/boot/firmware/config.txt` and one udev rule. When you fix a bug in one, mirror it to the other unless you specifically don't want it there.

`layer/files/` contains the on-device scripts baked into the image (setup portal, first-boot, systemd units) — kept as separate files rather than inline YAML so they can be edited with normal tooling.

---

## Common tweaks

- **Change a systemd unit** — edit `layer/files/<unit>.service`, rebuild.
- **Add a Python module to the baked venv** — add to `local_code/requirements.txt`, rebuild (the layer YAML runs `pip install -r` at bake time).
- **Change which container images are baked in** — edit `SERVICES=(...)` in `../../build-and-save-images.sh` and re-run it before the image build.
- **Change hostname / mDNS default** — `layer/files/trailcurrent-firstboot.sh`.
- **Change the setup-AP SSID prefix or portal branding** — `layer/files/wifi-setup-portal.py`.

---

## Troubleshooting

- **`build.sh` fails immediately with `images/*.tar missing`.** Run `./build-and-save-images.sh` from the repo root first.
- **rpi-image-gen fails during the customize-hook with "non-trailcurrent ownership".** The bake-time invariant check caught a directory that ended up root-owned. Look at the `find` output in the failure — the fix is in whichever YAML section created that directory (usually a missing `-o 1000 -g 1000` on an `install` command).
- **The image boots but the captive-portal AP never comes up.** Check `journalctl -u wifi-setup-portal` on the device (via HDMI console). The portal skips itself if Wi-Fi is already configured — if the previous boot got as far as saving credentials, the AP won't reappear on the next boot. Factory-reset via the PWA to clear.
- **Everything else** — [../SETUP.md](../SETUP.md) covers device-side troubleshooting for a flashed device.
