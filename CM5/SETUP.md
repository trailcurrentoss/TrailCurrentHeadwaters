# CM5 Setup Guide

This guide covers everything needed to go from bare Compute Module 5 boards to
running TrailCurrent Headwaters units. It is designed for mass flashing — follow
the steps in order with no gaps.

## Carrier Board Variants

Two supported carrier boards, two image variants. Pick one — the flashing
procedure and application stack are identical from Step 2 onward.

| Variant | Carrier | CAN wiring | Build script | Image name |
|---------|---------|-----------|--------------|------------|
| Base | Any CM5 IO board + Waveshare **RS485 CAN HAT (B)** | MCP2515, SPI0/CE0, 16 MHz xtal, INT=**GPIO25** | `build.sh` | `trailcurrent-cm5-base.img` |
| Wireless-Base | Waveshare **CM5-IO-Wireless-Base** (all-in-one) | Onboard isolated MCP2515, SPI0/CE0, 16 MHz xtal, INT=**GPIO17** | `build-wireless.sh` | `trailcurrent-cm5-wireless-base.img` |

The **Wireless-Base** variant targets the Waveshare CM5-IO-Wireless-Base
carrier board, which folds several parts of the stack onto one PCB:

- Onboard **isolated CAN** with 120 Ω terminator jumper (no HAT, no CAN wiring
  harness beyond the screw terminal)
- **7 – 36 V DC** input (vehicle-native — no external buck converter needed)
- **NVMe M.2 M-Key** slot (same as before)
- **Waveshare-provided enclosure** available for this carrier — no 3D print
  required
- Also carries M.2 B-Key + miniPCIe (4G / 5G / LoRa) and 2× isolated RS485.
  **These are deliberately unused in the current image** — the wireless-base
  variant is only about swapping the CAN wiring today. Router / cellular
  work-out is future.

The only functional difference between the two images is the MCP2515 interrupt
GPIO (25 vs 17) and the overlay syntax used to declare it. Both use the same
MCP2515 controller, the same 16 MHz crystal, the same SPI0/CE0 chip select,
and the same 500 kbit/s bit timing. Everything else — Docker images, first-boot
provisioning, TLS, mDNS, deployment watcher, tileserver, active-cooler
thermal ramp — is identical.

## Hardware Requirements

### Compute Module

Raspberry Pi Compute Module 5 with **4 GB RAM** (required — Docker images
alone use ~3.8 GB during first-boot loading).

| Variant | Works? | Notes |
|---------|--------|-------|
| CM5 (with eMMC) | Yes | eMMC is present but unused — boots from NVMe only |
| CM5 Lite (no eMMC) | Yes | Enters USB boot automatically — no jumper needed for flashing |
| With WiFi | Yes | WiFi is disabled in config.txt for power savings, but the module works |
| Without WiFi | Yes | Recommended — saves cost since WiFi is not used (Ethernet only) |
| 2 GB RAM | No | Insufficient for Docker image loading and container runtime |
| 8 GB RAM | Yes | Works but unnecessary — typical runtime uses ~730 MB |

**Recommended SKU:** CM5 Lite, 4 GB, without WiFi — lowest cost for this
workload. Any 4 GB variant will work identically.

### NVMe SSD

| Capacity | Status | Notes |
|----------|--------|-------|
| 128 GB | Minimum | ~30 GB used by OS + Docker images + map tiles. Leaves limited headroom for logs and data growth |
| 256 GB | Recommended | Comfortable headroom for long-term deployments |

The NVMe must be M.2 form factor matching the carrier board slot (typically
2230 or 2242). For high-temperature deployments (enclosed trailers), consider
an industrial-grade NVMe rated to 85 C (e.g., Transcend MTE552T, ATP N600Ri).

### Other Components

- CM5 carrier board — one of:
  - **Base variant:** any CM5 IO board (Raspberry Pi CM5 IO Board, Waveshare
    CM5-IO-Base-A/B, etc.) plus the **Waveshare RS485 CAN HAT (B)**
    (MCP2515, SPI0/CE0, 16 MHz crystal, GPIO25 interrupt)
  - **Wireless-Base variant:** **Waveshare CM5-IO-Wireless-Base** — CAN,
    NVMe slot, 7–36 V DC input, and optional matching enclosure all on
    one board
  Whichever carrier is chosen, it must have:
  - USB-C port for flashing
  - EMMC_DISABLE jumper (sometimes labelled "nRPIBOOT" or "Disable eMMC Boot")
    — only needed for CM5 with eMMC; CM5 Lite enters USB boot automatically
  - NVMe M.2 slot (M-key or B+M-key)
  - Dedicated FAN connector (PWM-capable, for active cooler)
- Waveshare CM5 Active Cooler (recommended for enclosed deployments)
- Ethernet connection
- A Linux computer for building and flashing (Debian/Ubuntu, arm64 or x86_64)

## Storage Architecture

Everything lives on the NVMe drive. The root partition is automatically
expanded to fill the entire drive on first boot.

| Drive | Mount | Contents |
|-------|-------|----------|
| NVMe  | `/`   | OS, system packages, Docker (engine + images + volumes), app data, Python venv |

Application data directories:

```
~/data           (keys, tileserver, nominatim)
~/local_code     (Python venv, CAN-to-MQTT scripts)
```

Docker uses the default data-root (`/var/lib/docker`) since everything is on
the NVMe.

> **CM5 with eMMC:** The eMMC is present but unused. The EEPROM is configured
> to boot exclusively from NVMe (`BOOT_ORDER=0xfe6`).

## One-Time Setup (Build Host)

These steps only need to be done once on the computer you use for flashing.

### 1. Build the rpiboot Tool

The `rpiboot` tool loads a payload onto the CM5 over USB. The `-d` flag
selects which payload directory to use — different directories do different
things:

| Command | Payload | What it does |
|---------|---------|-------------|
| `rpiboot -d recovery5` | EEPROM updater | Programs the CM5's EEPROM (boot order, power settings). No storage is exposed. |
| `rpiboot -d mass-storage-gadget64` | Minimal Linux | Boots Linux on the CM5 which exposes its storage (eMMC, NVMe) as USB mass storage devices for flashing. |

The `rpiboot` binary is the same in both cases. **You must power cycle the
carrier board between consecutive rpiboot operations.**

The version from APT has known issues with CM5, so we build from source:

```bash
git clone https://github.com/raspberrypi/usbboot CM5/usbboot
cd CM5/usbboot
git submodule init && git submodule update
make
```

This produces the `rpiboot` binary in `CM5/usbboot/`. The submodule step
fetches the EEPROM firmware files needed for both flashing and EEPROM
configuration.

### 2. Build the EEPROM Image

The EEPROM must be configured to boot from NVMe before a board will work.
Build the EEPROM image once — it is reused for every board:

```bash
cd CM5/usbboot/recovery5
./update-pieeprom.sh
```

This bakes `boot.conf` (which sets `BOOT_ORDER=0xfe6` — NVMe only) into an
EEPROM image. The output is used in the per-device procedure below.

### 3. Build the Docker Images (ARM64)

The CM5 image includes all Docker containers and map tiles baked in, so
they must exist before you build the OS image. Build the ARM64 Docker
images first:

```bash
# From the repo root
./build-and-save-images.sh
```

This cross-compiles all 5 local service images for `linux/arm64` (plus
`mongo:7` and `mediagis/nominatim:4.5`) and saves them as tar files in
`images/`. Takes ~10 minutes on the first run.

> **Requires:** Docker Engine with `buildx`. The script creates a
> dedicated builder (`trailcurrent-arm64`) automatically.

### 4. Obtain Map Tiles

The tileserver requires a pre-generated `.mbtiles` file (~25 GB for the
US). This file is baked into the CM5 image so devices are ready to run
immediately after flashing.

```bash
mkdir -p data/tileserver
# Place your tiles file at: data/tileserver/map.mbtiles
```

**How to get tiles:**
- Copy from an existing team member's machine
- Generate from OpenStreetMap data using the **PbfTileConverter** utility
  (see [DOCS/UpdatingMapTiles.md](../DOCS/UpdatingMapTiles.md))

### 5. Obtain the Search Dataset (Nominatim PBF)

The nominatim service imports a raw OSM `.osm.pbf` extract to power the
map's search box. Like the tiles, this file is baked into the CM5 image
so a fresh flash is ready to run — no manual transfer to the device.

```bash
mkdir -p data/nominatim
# Place your PBF file at: data/nominatim/map.osm.pbf
```

**How to get the PBF:**
- Copy from an existing team member's machine
- Reuse the cached PBF produced by PbfTileConverter (same file — copy or
  symlink it to `data/nominatim/map.osm.pbf`)
- Download directly from [Geofabrik](https://download.geofabrik.de/)
  (see [DOCS/UpdatingNominatim.md](../DOCS/UpdatingNominatim.md))

Nominatim does its own import on the device — no conversion is needed
here. The first-boot import into PostgreSQL runs in the background and
takes hours (US-scale) to days (continent-scale).

### 6. Build the CM5 Image

The image includes everything needed to run TrailCurrent: the OS, Docker,
CAN bus configuration, power optimizations, all Docker container images,
the Python local code, map tiles, and configuration files. After flashing,
the only manual step is the first-login setup wizard (which sets passwords
and generates encryption keys).

**Prerequisites (build.sh will verify these exist):**

| File | Source | Purpose |
|------|--------|---------|
| `images/*.tar` | Step 3 (`build-and-save-images.sh`) | Docker container images |
| `data/tileserver/map.mbtiles` | Step 4 | Map tile data (~25 GB) |
| `data/nominatim/map.osm.pbf` | Step 5 | OSM extract for the search service (~18 GB) |
| `docker-compose.yml` | In repo | Service orchestration |
| `config/` | In repo | Mosquitto configuration |
| `local_code/` | In repo | Python CAN-to-MQTT bridge and helpers |
| `scripts/` | In repo | Certificate generation scripts |

```bash
cd CM5/image

# Base variant (CM5 IO board + Waveshare RS485 CAN HAT (B), INT=GPIO25)
sudo ./build.sh myuser mypassword

# Wireless-Base variant (Waveshare CM5-IO-Wireless-Base, INT=GPIO17)
sudo ./build-wireless.sh myuser mypassword
```

Arguments (same for both scripts):
- First argument: login username (default: `trailcurrent`)
- Second argument: login password (default: `trailcurrent`)

The password is hashed with `openssl passwd -6` before being passed to
rpi-image-gen, so there are no complexity restrictions — use whatever
password you want.

The build configures **passwordless sudo** for the chosen user. This is
required for unattended cloud deployments — `deploy.sh` uses `sudo` to
manage systemd services, and the deployment-watcher runs
non-interactively.

The script will:
1. Verify Docker image tars and map tiles exist
2. Clone `rpi-image-gen` from GitHub (first run only)
3. Install build dependencies (first run only)
4. Build the image (baking in all deployment artifacts)

Output (base variant):
`CM5/rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img`

Output (wireless-base variant):
`CM5/rpi-image-gen/work/image-trailcurrent-cm5-wireless-base/trailcurrent-cm5-wireless-base.img`

> **Image size:** The output image is ~28 GB due to the baked-in map
> tiles. Flashing to NVMe via `dd` takes longer than a minimal image
> but eliminates the need to transfer tiles separately.

> **Build host requirements:** Debian or Ubuntu (Bookworm/Trixie/Noble).
> On x86_64 hosts, QEMU user-mode emulation is used automatically (slower
> but works). Native arm64 builds are faster.

---

## Per-Device Flashing Procedure

Repeat these steps for each CM5 board. The order matters — do not skip steps.

### Step 1: Prepare the Hardware

1. Install the NVMe SSD into the carrier board's M.2 slot
2. **Force the CM5 into USB boot / rpiboot mode.** The mechanism differs by
   carrier:

   | Carrier | Action |
   |---------|--------|
   | **Wireless-Base** (any CM5) | Set the **BOOT** slide switch on the carrier to **ON**. This forces USB rpiboot mode regardless of what is on the NVMe or eMMC. |
   | Base carrier + **CM5 with eMMC** | Fit the **EMMC_DISABLE** jumper on the carrier board. |
   | Base carrier + **CM5 Lite** | No action needed — Lite has no eMMC and enters USB boot automatically when the NVMe is blank. |

   > **Wireless-Base BOOT switch meaning:**
   > - **ON** = USB image-loading mode (rpiboot works, CM5 does not touch the NVMe)
   > - **OFF** = normal boot from NVMe (production runtime)
   >
   > If the switch is left OFF and the NVMe contains any bootable image, the
   > CM5 will boot from the NVMe and never enumerate as a USB device — the
   > green STAT LED will light and `lsusb` will show nothing.
3. Connect the carrier board's USB-C to your computer
4. Apply power to the carrier board
5. Verify the CM5 is detected:
   ```bash
   lsusb | grep -i broadcom
   ```
   You should see `BCM2712D0 Boot`.

### Step 2: Flash the EEPROM (Required for Every New Board)

Fresh CM5 boards ship with a factory boot order (`BOOT_ORDER=0xf2461`) that
tries eMMC/SD before NVMe. **The board will not boot from NVMe until the
EEPROM is updated.** This step must be done before flashing the NVMe image.

```bash
cd CM5/usbboot/recovery5
sudo ../rpiboot -d .
```

Wait for the tool to complete (you'll see `Second stage boot server done`
followed by EEPROM write messages).

**Power cycle the carrier board** — unplug power, wait a few seconds, plug
back in. rpiboot will not work for the next step without a power cycle.

### Step 3: Wipe Old Storage (Recommended)

This step ensures no leftover partitions or boot data cause issues. Skip this
only if you are certain the board has never been flashed before.

Put the CM5 back into USB mass storage mode:

```bash
cd CM5/usbboot
sudo ./rpiboot -d mass-storage-gadget64
```

Wait for `Second stage boot server done`, then check what appeared:

```bash
lsblk
```

- **CM5 Lite:** One new `sd*` device appears — that's the NVMe.
- **CM5 with eMMC:** Two new `sd*` devices appear. The NVMe is the **larger**
  one (e.g., 128+ GB vs 16/32 GB for eMMC).

Unmount any auto-mounted partitions, then zero both devices (or just the NVMe
if CM5 Lite):

```bash
# Unmount anything that auto-mounted
sudo umount /dev/sdX* 2>/dev/null

# Wipe the NVMe (replace sdX with the larger device)
sudo dd if=/dev/zero of=/dev/sdX bs=4M count=100 status=progress conv=fsync

# Wipe the eMMC too if present (replace sdY with the smaller device)
sudo dd if=/dev/zero of=/dev/sdY bs=4M count=100 status=progress conv=fsync
```

This zeros the first 400 MB, which destroys partition tables, boot sectors,
and filesystem headers.

**Power cycle the carrier board** before the next step.

### Step 4: Flash the NVMe

Put the CM5 back into USB mass storage mode:

```bash
cd CM5/usbboot
sudo ./rpiboot -d mass-storage-gadget64
```

Wait for `Second stage boot server done`, then identify the NVMe:

```bash
lsblk
```

- **CM5 Lite:** One new `sd*` device (no partitions) — that's the NVMe.
- **CM5 with eMMC:** Two `sd*` devices with no partitions. The NVMe is the
  **larger** one.

> **Be absolutely sure you have the right device.** `dd` will overwrite
> whatever you point it at. Your host's NVMe drives show up as `nvme*`, not
> `sd*`, so there is no risk of confusion with local drives.

Unmount any auto-mounted partitions, then write the image:

**NOTE!!!** This can take a really long time depending on NVME speed. Wait for it to complete and exit back to shell. Otherwise you will corrupt the NVME and have to start over **IMPORTANT**

Pick the image that matches the carrier board you built for:

```bash
# Change to the root of the repository before these commands
sudo umount /dev/sdX* 2>/dev/null

# Base variant (CM5 IO board + Waveshare RS485 CAN HAT (B), INT=GPIO25)
sudo dd if=CM5/rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img \
    of=/dev/sdX bs=4M status=progress conv=fsync

# -- or --

# Wireless-Base variant (Waveshare CM5-IO-Wireless-Base, INT=GPIO17)
sudo dd if=CM5/rpi-image-gen/work/image-trailcurrent-cm5-wireless-base/trailcurrent-cm5-wireless-base.img \
    of=/dev/sdX bs=4M status=progress conv=fsync
```

Replace `/dev/sdX` with the NVMe device.

> **Flashing the wrong image on the wrong carrier will boot, but `can0` will
> never come up** — the MCP2515 interrupt line is wired to GPIO25 on the CAN
> HAT (B) and GPIO17 on the CM5-IO-Wireless-Base, and only the interrupt in
> the flashed device tree will fire.

> **Always use `conv=fsync`.** Without it, `dd` may return before data is
> physically written, resulting in a corrupted image.

### Step 5: Prepare for First Boot

1. Return the CM5 to normal-boot mode (reverse of Step 1):
   - **Wireless-Base carrier:** Flip the **BOOT** slide switch to **OFF**.
   - **Base carrier + CM5 with eMMC:** Remove the EMMC_DISABLE jumper.
   - **Base carrier + CM5 Lite:** No action needed.
2. Disconnect the USB cable
3. Connect Ethernet
4. Power cycle the carrier board

### Step 6: First Boot

The CM5 boots from NVMe. On the first boot, two services run automatically:

**`trailcurrent-firstboot`** (runs before Docker starts):

1. **Partition expansion** — Expands the root partition to fill the entire
   NVMe drive using `growpart` and `resize2fs`.

2. **EEPROM configuration** — Sets `BOOT_ORDER=0xfe6` (NVMe only, then
   stop), `WAKE_ON_GPIO=0`, and `POWER_OFF_ON_HALT=1` so the CM5 boots
   exclusively from NVMe and starts automatically when power is applied
   (no power button needed in a vehicle install).

3. **TLS certificates** — Generates a self-signed CA and server certificate
   for `headwaters.local` (valid 10 years). Used by Mosquitto and the
   frontend.

4. **Python virtual environment** — Creates the venv at
   `~/local_code/cantomqtt/` and installs Python dependencies.

**`trailcurrent-load-images`** (runs after Docker starts):

5. **Docker image loading** — Loads all baked-in Docker image tarballs
   into the Docker daemon, then deletes the tar files to reclaim ~1 GB
   of disk space.

First boot takes 3-5 minutes. You can monitor progress via:

```bash
ssh myuser@headwaters.local
journalctl -u trailcurrent-firstboot -f
journalctl -u trailcurrent-load-images -f
```

Replace `myuser` with the username you chose when building the image.

After first boot completes, **reboot once** for the EEPROM changes to take
effect:

```bash
sudo reboot
```

### Step 7: First Login (Interactive Setup Wizard)

After reboot, SSH into the device. The first-login setup wizard runs
automatically when no `.env` file exists:

```bash
ssh myuser@headwaters.local
```

Replace `myuser` with the username you chose when building the image.

The wizard will prompt you for:
- **MQTT username and password** (default username: `trailcurrent`)
- **Admin password** (for the web UI)

The wizard **automatically generates** cryptographic secrets:
- `ENCRYPTION_KEY` (WiFi credential encryption, 32 bytes)

After collecting your inputs, the wizard:
1. Writes `.env` and `local_code/.env`
2. Installs the CA certificate to the system trust store
3. Starts all Docker containers
4. Restarts systemd services (CAN-to-MQTT, deployment watcher, mDNS discovery)

> **To re-run the wizard** (e.g., after deleting `.env` to start fresh):
> ```bash
> rm ~/.env
> /usr/local/bin/trailcurrent-first-login.sh
> ```

### Step 8: Verify the Application

```bash
# All containers running
docker compose ps

# No errors in logs
docker compose logs --tail=20

# API responding
curl -k https://localhost/api/health

# Web UI accessible
curl -k -o /dev/null -s -w "%{http_code}" https://localhost/
```

Access the web UI at `https://headwaters.local`.

### Step 9: Install CA Certificate on Client Devices (Optional)

TrailCurrent uses a self-signed TLS certificate. Browsers will let you
tap through the certificate warning, but iOS requires the CA to be
trusted at the OS level for the PWA "Add to Home Screen" icon to work.

See [PI_DEPLOYMENT.md](../PI_DEPLOYMENT.md#install-the-ca-certificate)
for instructions on installing the CA on iOS, Android, macOS, and Windows.

See [PI_DEPLOYMENT.md](../PI_DEPLOYMENT.md) for subsequent update
procedures and troubleshooting.

---

## Per-Device Quick Reference

For experienced operators who have done this before. Refer to the full
procedure above if anything is unclear.

```
One-time (build host):
  1. ./build-and-save-images.sh                              # Build ARM64 Docker images
  2. Place map.mbtiles in data/tileserver/                   # Obtain map tiles
  3. Place map.osm.pbf in data/nominatim/                    # Obtain search dataset
  4. cd CM5/image && sudo ./build.sh myuser mypassword       # Base variant (RS485 CAN HAT B, GPIO25)
     # -- or --
     cd CM5/image && sudo ./build-wireless.sh myuser mypassword  # Wireless-Base variant (onboard CAN, GPIO17)

For each board:
  1. Install NVMe, fit EMMC_DISABLE jumper (if eMMC), connect USB, power on
  2. cd CM5/usbboot/recovery5 && sudo ../rpiboot -d .       # Flash EEPROM
  3. Power cycle
  4. cd CM5/usbboot && sudo ./rpiboot -d mass-storage-gadget64  # Expose storage
  5. lsblk                                                   # Identify NVMe (larger sd* device)
  6. sudo dd if=...img of=/dev/sdX bs=4M status=progress conv=fsync  # Flash NVMe (~28GB)
  7. Remove jumper, disconnect USB, connect Ethernet, power cycle
  8. Wait for first boot (~3-5 min), then: sudo reboot
  9. SSH in (ssh myuser@headwaters.local) — first-login wizard runs, set passwords
 10. Verify: docker compose ps && curl -k https://localhost/api/health
```

---

## What's in the Image

The CM5 image is a self-contained deployment. After flashing, the only
manual step is the first-login setup wizard.

### System Packages

`jq`, `openssl`, `python3`, `python3-venv`, `python3-pip`, `iproute2`,
`can-utils`, `avahi-daemon`, `avahi-utils`, `curl`, `unzip`, `nvme-cli`,
`parted`, `cloud-guest-utils`

### Docker

Docker CE and Docker Compose plugin, installed from Docker's official
repository. Uses the default data root (`/var/lib/docker`) on the NVMe root
filesystem.

### Baked-In Application Artifacts

These are copied into the chosen user's home directory during the image build:

| Path | Source | Purpose |
|------|--------|---------|
| `~/docker-compose.yml` | Repo root | Service orchestration |
| `~/config/` | `config/` | Mosquitto configuration |
| `~/local_code/` | `local_code/` | Python scripts, systemd units, requirements |
| `~/scripts/` | `scripts/` | Certificate generation |
| `~/deploy.sh` | Repo root | For future OTA deployments |
| `~/.env.example` | Repo root | Environment variable template (reference) |
| `~/images/*.tar` | `images/` | Docker image tarballs (loaded on first boot, then deleted) |
| `~/data/tileserver/map.mbtiles` | `data/tileserver/` | Map tile data (~25 GB) |
| `~/data/nominatim/map.osm.pbf` | `data/nominatim/` | OSM extract for the search service (~18 GB) |

### Boot Configuration (config.txt)

| Setting | Value | Purpose |
|---------|-------|---------|
| `dtparam=spi=on` **or** `dtoverlay=spi0-1cs,cs0_pin=8` | enabled | Base variant enables SPI via `dtparam=spi=on`; wireless-base variant uses `spi0-1cs,cs0_pin=8` per Waveshare's docs |
| `dtoverlay=mcp2515-can0` (base) / `dtoverlay=mcp2515,spi0-0` (wireless-base) | 16 MHz xtal, GPIO25 INT (base) / GPIO17 INT (wireless-base), 1 MHz SPI | CAN bus hardware |
| `dtoverlay=disable-bt` | disabled | Power savings |
| `dtoverlay=disable-wifi` | disabled | Power savings (uses Ethernet) |
| `dtoverlay=disable-hdmi0` | disabled | Power savings (headless) |
| `dtoverlay=disable-hdmi1` | disabled | Power savings (headless) |
| `dtparam=audio=off` | disabled | Power savings |
| `gpu_mem=16` | 16 MB | Minimum GPU allocation (headless) |
| `arm_freq=600` | 600 MHz | Underclocked — workload uses ~15% at 1.7 GHz |
| `dtparam=i2c_arm=on` | enabled | Required for Waveshare CM5 active cooler fan controller |
| `dtparam=cooling_fan` | enabled | Activates the CM5 PWM fan cooling driver |
| `dtparam=fan_temp0=45000,...` | 45 C / 5 C hyst / speed 75 | Fan low speed (~30%) — light cooling |
| `dtparam=fan_temp1=55000,...` | 55 C / 5 C hyst / speed 150 | Fan medium (~60%) — warm ambient |
| `dtparam=fan_temp2=65000,...` | 65 C / 5 C hyst / speed 255 | Fan full blast — prevents thermal throttle |

> **Do not add `over_voltage` settings.** CM5 silicon varies between chips —
> undervolting (e.g., `over_voltage=-4`) can prevent some boards from booting
> entirely (3-blink "firmware not found" error) while working fine on others.
> The firmware manages voltage automatically at the configured `arm_freq`.

### Systemd Services

| Service | Purpose | Auto-starts? |
|---------|---------|-------------|
| `trailcurrent-firstboot` | One-time partition expansion/EEPROM/TLS/venv setup | Once (first boot only) |
| `trailcurrent-load-images` | Loads Docker images from baked-in tarballs | Once (first boot, after Docker starts) |
| `can0` | Brings up CAN bus at 500 kbps | Yes (when can0 device exists) |
| `disable-usb` | Unbinds USB hub to save power | Yes |
| `docker` | Container runtime | Yes |
| `cantomqtt` | CAN-to-MQTT bridge | Yes (after .env exists via first-login) |
| `discovery-mdns` | mDNS device discovery browser | Yes (after .env exists via first-login) |
| `deployment-watcher` | Watches for OTA deployment updates | Yes (after .env exists via first-login) |

### First-Login Setup Scripts

| File | Purpose |
|------|---------|
| `/usr/local/bin/trailcurrent-first-login.sh` | Interactive wizard — prompts for passwords, generates secrets, writes `.env`, starts services |
| `/usr/local/bin/trailcurrent-firstboot.sh` | Automatic first-boot hardware setup (partition, EEPROM, TLS, venv) |
| `/usr/local/bin/trailcurrent-load-images.sh` | Loads Docker images from tarballs, deletes tars to free space |

The first-login script is triggered from `~/.bash_profile` when `.env`
does not exist. It runs once — subsequent logins skip it.

## Troubleshooting

### rpiboot doesn't detect the CM5

- **Wireless-Base carrier:** Verify the **BOOT** slide switch is set to **ON**.
  Symptom of the switch being OFF with a flashed NVMe: green STAT LED lights,
  M.2 LED blinks at a steady heartbeat, but `lsusb` shows no BCM2712D0 Boot
  device — the CM5 has booted from the NVMe instead of entering rpiboot mode.
- **Base carrier + CM5 with eMMC:** Verify the EMMC_DISABLE jumper is fitted
- **Base carrier + CM5 Lite:** Should enter USB boot automatically — if not, check power
- Check USB connection: `lsusb | grep -i broadcom` should show `BCM2712D0 Boot`
- Try a different USB cable or port
- Power cycle the carrier board with USB already connected
- If `lsusb` shows `Raspberry Pi multi-function USB device` instead of
  `BCM2712D0 Boot`, the CM5 is already in mass storage mode from a previous
  rpiboot session. Power cycle the carrier board (unplug power, wait a few
  seconds, plug back in) and run `rpiboot` again immediately
- **Between consecutive rpiboot operations** (e.g., EEPROM recovery followed by
  flashing), you must power cycle the carrier board. Without a power cycle,
  `rpiboot` will hang at "Waiting for BCM..."

### NVMe not detected by rpiboot

- Check the NVMe SSD is seated properly in the M.2 slot
- After running `rpiboot -d mass-storage-gadget64`, run `lsblk` to confirm
  the NVMe appears as a block device
- Try a different NVMe drive

### Docker won't start

- Check Docker service status: `systemctl status docker`
- Check logs: `journalctl -u docker`

### CAN bus not working

- Confirm you flashed the image that matches your carrier board:
  - `trailcurrent-cm5-base.img` for the RS485 CAN HAT (B) (INT=GPIO25)
  - `trailcurrent-cm5-wireless-base.img` for the CM5-IO-Wireless-Base (INT=GPIO17)
  Booting the wrong image on either carrier will make `can0` fail to
  appear because the MCP2515 interrupt line will never fire.
- Base variant: verify the CAN hat is connected and the SPI ribbon cable is seated
- Wireless-Base variant: verify the CAN screw-terminal wiring and that the
  120 Ω terminator jumper is fitted if this device is at an end of the bus
- Check kernel messages: `dmesg | grep -i mcp2515`
- Check the can0 service: `systemctl status can0`
- The MCP2515 needs ~15 seconds after power-on to stabilize (the service
  handles this with a sleep)

### Fan not spinning (Waveshare CM5 Active Cooler)

The Waveshare CM5 active cooler uses PWM fan control. The fan spins briefly
on power-on (raw 5V before Linux loads), then the kernel's thermal governor
takes over and controls speed based on CPU temperature. The fan requires
**I2C enabled** and the **`cooling_fan` dtparam** to function.

> **Note:** The image build configures both I2C and the fan automatically.
> These steps are only needed if troubleshooting a device that was set up
> manually or with an older image.

1. **Enable I2C** — the fan controller requires I2C:
   ```bash
   sudo raspi-config
   ```
   Navigate to **Interfacing Options > I2C** and enable it, then reboot.

2. **Add fan configuration** to `/boot/firmware/config.txt`:
   ```
   dtparam=i2c_arm=on
   dtparam=cooling_fan
   dtparam=fan_temp0=45000,fan_temp0_hyst=5000,fan_temp0_speed=75
   dtparam=fan_temp1=55000,fan_temp1_hyst=5000,fan_temp1_speed=150
   dtparam=fan_temp2=65000,fan_temp2_hyst=5000,fan_temp2_speed=255
   ```
   Reboot for changes to take effect.

3. **Verify the fan controller is loaded:**
   ```bash
   ls /sys/devices/platform/cooling_fan/
   cat /sys/class/thermal/cooling_device0/type    # should say "pwm-fan"
   ```

4. **Check current state:**
   ```bash
   cat /sys/class/thermal/thermal_zone0/temp       # CPU temp (millidegrees)
   cat /sys/class/hwmon/hwmon*/pwm1                 # PWM duty (0-255)
   cat /sys/class/hwmon/hwmon*/fan1_input            # RPM (0 = not spinning)
   ```
   At low temperatures the fan runs at low PWM duty and may be inaudible.
   This is normal — the thermal governor adjusts speed automatically.

5. **Force full speed for testing** (temporarily disables thermal governor):
   ```bash
   echo 1 | sudo tee /sys/class/hwmon/hwmon*/pwm1_enable
   echo 255 | sudo tee /sys/class/hwmon/hwmon*/pwm1
   ```
   The fan should spin at full speed. Reboot to restore automatic control.

> **Connector note:** Ensure the fan is plugged into the dedicated **FAN
> connector** on the carrier board, not a general-purpose GPIO header. The
> fan only spins under kernel control — it will not run continuously during
> boot or when powered off (the brief spin on power-on is normal).

### CM5 won't boot / "Firmware not found" error

If the CM5 won't boot, connect HDMI to **HDMI0** (the primary output) to see
boot diagnostics. Despite the `disable-hdmi` overlays in config.txt, HDMI
output works during boot and at the Linux console.

**Check the boot screen and LEDs for clues:**

| Symptom | Likely cause |
|---------|-------------|
| `Boot mode: STOP` appears immediately | Bad `BOOT_ORDER` in EEPROM — redo Step 2 |
| 3 LED blinks (repeating) | Bootloader can't find firmware — corrupted flash or EEPROM issue |
| Tries eMMC/SD/USB but not NVMe | EEPROM boot order doesn't include NVMe — redo Step 2 |
| Black screen, no LED activity | Check power supply and EMMC_DISABLE jumper is removed (CM5 with eMMC) |
| `no image found` | NVMe is blank or not flashed — do Step 4 |

**If the NVMe flash is corrupted**, reflash using Steps 3-4 of the per-device
procedure. Always use `conv=fsync` with `dd` to ensure data is fully written
before the command returns.

### EEPROM recovery

If the EEPROM is in an unknown state, redo Step 2 of the per-device procedure:

1. Fit the **EMMC_DISABLE** jumper (CM5 with eMMC) or just connect USB (CM5 Lite)
2. Connect USB-C to your computer
3. Power on the carrier board
4. Run:
   ```bash
   cd CM5/usbboot/recovery5
   sudo ../rpiboot -d .
   ```
5. Power cycle, then continue with Step 3 or Step 4

> **Note:** If `update-pieeprom.sh` reports missing files, ensure the usbboot
> submodule is initialized: `cd CM5/usbboot && git submodule init && git submodule update`

### Checking first-boot logs

```bash
journalctl -u trailcurrent-firstboot --no-pager
journalctl -u trailcurrent-load-images --no-pager
```

### Docker images not loaded

If `docker images` shows no TrailCurrent images after first boot:

```bash
# Check if the loader ran
systemctl status trailcurrent-load-images

# If the tarballs still exist, load manually
for f in ~/images/*.tar; do docker load -i "$f"; done
```

## File Layout Reference

### Build Host (Repository)

```
CM5/
├── SETUP.md                  <- This file
├── usbboot/                  <- rpiboot tool (built from source)
│   ├── rpiboot              <- Binary for USB boot mode
│   └── recovery5/           <- EEPROM configuration
│       ├── boot.conf        <- Boot order settings (BOOT_ORDER=0xfe6)
│       └── update-pieeprom.sh <- Builds EEPROM image from boot.conf
├── image/                    <- Image build system
│   ├── build.sh             <- Base variant build wrapper (RS485 CAN HAT B, INT=GPIO25)
│   ├── build-wireless.sh    <- Wireless-Base variant build wrapper (onboard CAN, INT=GPIO17)
│   ├── config/
│   │   ├── trailcurrent-cm5-base.yaml           <- Base variant build configuration
│   │   └── trailcurrent-cm5-wireless-base.yaml  <- Wireless-Base variant build configuration
│   └── layer/
│       ├── trailcurrent-base.yaml           <- Base variant layer (packages, services, baked artifacts)
│       ├── trailcurrent-base-wireless.yaml  <- Wireless-Base variant layer (identical minus CAN overlay)
│       └── files/
│           ├── trailcurrent-firstboot.sh    <- First-boot hardware setup
│           ├── trailcurrent-load-images.sh  <- Docker image loader (first boot)
│           ├── trailcurrent-first-login.sh  <- Interactive setup wizard (first login)
│           └── motd                         <- Console login banner
└── rpi-image-gen/            <- Cloned automatically by build.sh (not committed)
```

Files referenced by the image build but located elsewhere in the repo:

```
(repo root)
├── images/*.tar              <- Docker image tarballs (from build-and-save-images.sh)
├── data/tileserver/map.mbtiles <- Map tiles (~25 GB, not in repo)
├── data/nominatim/map.osm.pbf <- OSM extract for search service (~18 GB, not in repo)
├── docker-compose.yml        <- Baked into image at ~/docker-compose.yml
├── config/                   <- Baked into image at ~/config/
├── local_code/               <- Baked into image at ~/local_code/
├── scripts/                  <- Baked into image at ~/scripts/
├── deploy.sh                 <- Baked into image at ~/deploy.sh
└── .env.example              <- Baked into image at ~/.env.example
```

### On the CM5 Device (After Flashing)

Paths below use `~` for the chosen user's home directory (e.g.,
`/home/trailcurrent/` if the default username was used).

```
~/
├── .env                      <- Created by first-login wizard (not baked in)
├── .env.example              <- Reference template
├── docker-compose.yml        <- Service orchestration
├── deploy.sh                 <- For future OTA updates
├── config/                   <- Mosquitto configuration
├── scripts/                  <- Certificate generation
├── local_code/               <- Python scripts, systemd units
│   ├── .env                  <- Created by first-login wizard (host-facing MQTT URL)
│   └── cantomqtt/            <- Python virtual environment (created by firstboot)
├── images/                   <- Docker tarballs (deleted after first-boot loading)
└── data/
    ├── keys/                 <- TLS certificates (generated by firstboot)
    ├── tileserver/map.mbtiles <- Map tiles (baked into image)
    └── nominatim/map.osm.pbf <- Search dataset (baked into image, imported on first boot)
```
