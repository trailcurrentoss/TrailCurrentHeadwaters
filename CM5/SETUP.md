# CM5 Setup Guide

This guide covers everything needed to go from bare Compute Module 5 boards to
running TrailCurrent Headwaters units. It is designed for mass flashing — follow
the steps in order with no gaps.

## Carrier Board Variants

Two supported carrier boards, two image variants. Pick one — the flashing
procedure and application stack are identical from Step 2 onward.

| Variant | Carrier | CAN wiring | Image name |
|---------|---------|-----------|------------|
| Base | Any CM5 IO board + Waveshare **RS485 CAN HAT (B)** | MCP2515, SPI0/CE0, 16 MHz xtal, INT=**GPIO25** | `trailcurrent-cm5-base.img` |
| Wireless-Base | Waveshare **CM5-IO-Wireless-Base** (all-in-one) | Onboard isolated MCP2515, SPI0/CE0, 16 MHz xtal, INT=**GPIO17** | `trailcurrent-cm5-wireless-base.img` |

Both variants are built by a single `build.sh` invocation so they can
never drift out of sync -- see [Reproducible Builds](#reproducible-builds-what-the-build-does-and-how-to-verify)
below. End users receive both `.img` files and flash whichever matches
their carrier board.

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
provisioning, TLS, mDNS, deployment watcher, active-cooler thermal ramp — is
identical.

## Hardware Requirements

### Compute Module

Raspberry Pi Compute Module 5 with **4 GB RAM** and **onboard WiFi**
(both required).

| Variant | Works? | Notes |
|---------|--------|-------|
| CM5 (with eMMC) | Yes | eMMC is present but unused — boots from NVMe only |
| CM5 Lite (no eMMC) | Yes | Enters USB boot automatically — no jumper needed for flashing |
| **With WiFi** | **Required** | The out-of-box setup runs a captive-portal WiFi access point so the user can configure the device from a phone. No SSH, keyboard, or monitor is used or supported for initial setup. |
| Without WiFi | **Not supported** | The setup access point cannot come up, and there is no fallback interactive setup path |
| 2 GB RAM | No | Insufficient for Docker image loading and container runtime |
| 8 GB RAM | Yes | Works but unnecessary — typical runtime uses ~730 MB |

**Recommended SKU:** CM5 or CM5 Lite, 4 GB, **with WiFi** — the WiFi radio
is used only during first-boot setup, then powered down at the software
level for the remainder of the device's life. There is no cost-savings
path that omits WiFi.

### NVMe SSD

Map data drives the sizing. Map bundles ship separately from the OS image
(uploaded via the PWA Maps page after first boot) and are large — a North
America bundle is ~130 GB, Europe ~135 GB, single US states ~92 GB. The
device retains one previous version for rollback, so plan for **two** bundles
on disk plus working state during an upload.

| Capacity | Status | Notes |
|----------|--------|-------|
| 512 GB | **Recommended** | Comfortable: NA bundle + previous rollback version + OS + Docker + working state during upload, with ~150 GB free for logs and long-term growth |
| 1 TB | Ideal | Multi-region flexibility (swap between bundles without losing rollback), plenty of headroom for years of logs/state |

Rough disk budget on a 512 GB drive with a NA bundle installed:

- OS + system packages + Docker engine: ~10 GB
- Docker container images (frontend, backend, mongo, mosquitto, photon, valhalla): ~5 GB
- Map bundle current (`data/maps/versions/<current>/`): ~130 GB
- Map bundle previous / rollback (`data/maps/versions/<previous>/`): ~130 GB
- Working state peak during upload (staging zip + extraction): ~150 GB (transient — reclaimed after apply)
- MongoDB, mosquitto, deployments, firmware, logs: ~5 GB
- Free headroom: ~80 GB

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
~/data/keys          TLS certificates (generated on first boot)
~/data/maps/         Map bundles (uploaded via PWA Maps page after first boot)
                     ├── versions/<version>/  applied bundles (current + one previous for rollback)
                     ├── staging/             upload landing zone (transient)
                     └── current              symlink to the active version
~/data/firmware      Peripheral firmware payloads
~/data/deployments   OTA deployment package staging
~/local_code         Python venv, CAN-to-MQTT scripts
```

Map bundles are user data, not system data. The image ships with the
`data/maps/` directories present but empty; users upload their region's
bundle via the PWA Maps page after the setup portal completes.

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
# From the repo root — everything below stays at repo root thanks to the
# subshell around the build commands.
git clone https://github.com/raspberrypi/usbboot CM5/usbboot
( cd CM5/usbboot && git submodule init && git submodule update && make )
```

This produces the `rpiboot` binary in `CM5/usbboot/`. The submodule step
fetches the EEPROM firmware files needed for both flashing and EEPROM
configuration.

### 2. Build the EEPROM Image

The EEPROM must be configured to boot from NVMe before a board will work.
Build the EEPROM image once — it is reused for every board:

```bash
# From the repo root
( cd CM5/usbboot/recovery5 && ./update-pieeprom.sh )
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

This cross-compiles the local service images (frontend, backend, mosquitto)
for `linux/arm64` plus `mongo:7`, saving them as tar files in `images/`.
Takes ~10 minutes on the first run.

> **Requires:** Docker Engine with `buildx`. The script creates a
> dedicated builder (`trailcurrent-arm64`) automatically.

> **Note on map data:** No map bundle is baked into the CM5 image. Map
> bundles are large (~130 GB for North America) and region-specific;
> baking one would either force a NA default onto non-NA users or require
> per-region image variants. Instead, users upload their region's bundle
> via the PWA Maps page after first boot. See
> [PLANS/Offline-Maps-Migration.md](../PLANS/Offline-Maps-Migration.md) for
> the full architectural reasoning, and [build/maps/README.md](../build/maps/README.md)
> for how to build a bundle for a specific region.

### 4. Build the CM5 Image

The image includes everything needed to boot the device to a healthy
map-less state: the OS, Docker, CAN bus configuration, power optimizations,
all Docker container images, the Python local code, and configuration files.
After flashing, the only manual step is completing the captive-portal setup
from a phone over the device's built-in setup access point — no SSH,
keyboard, or monitor required. Then users install a map bundle via the
PWA Maps page whenever they're ready.

**Prerequisites (build.sh will verify these exist):**

| File | Source | Purpose |
|------|--------|---------|
| `images/*.tar` | Step 3 (`build-and-save-images.sh`) | Docker container images |
| `docker-compose.yml` | In repo | Service orchestration |
| `config/` | In repo | Mosquitto configuration |
| `local_code/` | In repo | Python CAN-to-MQTT bridge and helpers |
| `scripts/` | In repo | Certificate generation scripts |

**Both variants build from a single command:**

```bash
# From the repo root
( cd CM5/image && sudo ./build.sh myuser mypassword )
```

This produces **both** `.img` files serially — Base first, then
Wireless-Base — and verifies each against source before continuing.
Building both from one script prevents the two variants from silently
drifting: fixing a bug in the setup portal but forgetting to rebuild
the wireless image is impossible now.

Arguments:
- First argument: login username (default: `trailcurrent`)
- Second argument: login password (default: `trailcurrent`)

Both variants receive the same credentials. The password is hashed
with `openssl passwd -6` before being passed to rpi-image-gen, so
there are no complexity restrictions — use whatever password you want.

The build configures **passwordless sudo** for the chosen user. This is
required for unattended cloud deployments — `deploy.sh` uses `sudo` to
manage systemd services, and the deployment-watcher runs
non-interactively.

For each variant the script will:
1. Verify Docker image tars exist (once, before either variant builds)
2. Clone `rpi-image-gen` from GitHub (first run only)
3. Install build dependencies (first run only)
4. Clean this variant's chroot + image dir (self-cleaning; no manual `rm` needed)
5. Build the image (baking in all deployment artifacts)
6. Run [verify-image.sh](image/verify-image.sh) against the produced `.img`
7. Fail loudly with a per-item report if anything's off

If either variant's verification fails, the whole script exits non-zero
and the operator has to fix the layer YAML / source and re-run. Both
variants must succeed together or neither ships.

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

> **Working directory convention:** Every command in this section assumes
> you are running it **from the repo root** (wherever you cloned this
> repository — e.g., `~/TrailCurrentHeadwaters/`). Steps that need to run
> in a subdirectory use the subshell pattern `( cd subdir && command )`,
> which changes directory *inside the parentheses only* and returns you
> to the repo root the moment the command finishes. You never need to
> `cd` back between steps.
>
> If you get confused about where you are, run `pwd` — if it doesn't end
> in `TrailCurrentHeadwaters`, run `cd ~/TrailCurrentHeadwaters` (or
> whatever your clone path is) before the next command.

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
# From the repo root
( cd CM5/usbboot/recovery5 && sudo ../rpiboot -d . )
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
# From the repo root
( cd CM5/usbboot && sudo ./rpiboot -d mass-storage-gadget64 )
```

Wait for `Second stage boot server done`, then check what appeared:

```bash
lsblk
```

- **CM5 Lite:** One new `sd*` device appears — that's the NVMe.
- **CM5 with eMMC:** Two new `sd*` devices appear. The NVMe is the **larger**
  one (e.g., 128+ GB vs 16/32 GB for eMMC).

> **⚠ Substitute the actual letter for `sdX` before running these commands.**
> Look at your `lsblk` output above — the CM5's device will be `sda`, `sdb`,
> `sdc`, or similar. **Never run these commands with `sdX` literally** —
> `/dev/sdX` doesn't exist as a block device, so `dd` will silently create
> it as a regular file in tmpfs, appearing to succeed while writing nothing
> to the NVMe.

Unmount any auto-mounted partitions, then zero both devices (or just the NVMe
if CM5 Lite):

```bash
# From the repo root — replace sdX with the actual letter from lsblk

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
# From the repo root
( cd CM5/usbboot && sudo ./rpiboot -d mass-storage-gadget64 )
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
>
> **⚠ Substitute the actual letter for `sdX`.** Never run the dd commands
> below with `sdX` literally. `/dev/sdX` doesn't exist as a block device,
> so dd will silently create it as a regular file in tmpfs, appearing to
> succeed at multi-GB/s speeds while writing nothing to the NVMe. If you
> accidentally do this: `sudo rm /dev/sdX` and re-run with the real letter.

**NOTE!!!** This can take a really long time depending on NVME speed. Wait for it to complete and exit back to shell. Otherwise you will corrupt the NVME and have to start over **IMPORTANT**

#### 4a. Pick your carrier variant

**Flash exactly one of the following — do not run both.** Choose the block that matches the carrier board you built for:

> **Flashing the wrong image on the wrong carrier will boot, but `can0` will
> never come up** — the MCP2515 interrupt line is wired to GPIO25 on the CAN
> HAT (B) and GPIO17 on the CM5-IO-Wireless-Base, and only the interrupt in
> the flashed device tree will fire.

**Option A — Base variant** (CM5 IO board + Waveshare RS485 CAN HAT (B), INT=GPIO25):

```bash
# From the repo root — replace sdX with the actual letter from lsblk
sudo umount /dev/sdX* 2>/dev/null
sudo dd if=CM5/rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img \
    of=/dev/sdX bs=4M status=progress conv=fsync
```

**Option B — Wireless-Base variant** (Waveshare CM5-IO-Wireless-Base, INT=GPIO17):

```bash
# From the repo root — replace sdX with the actual letter from lsblk
sudo umount /dev/sdX* 2>/dev/null
sudo dd if=CM5/rpi-image-gen/work/image-trailcurrent-cm5-wireless-base/trailcurrent-cm5-wireless-base.img \
    of=/dev/sdX bs=4M status=progress conv=fsync
```

> **Check the image is fresh before flashing.** Run `ls -la` on the image
> file first — if its date is older than your most recent `sudo ./build.sh`
> run, the image is stale and reflects an older codebase. Rebuild before
> flashing.

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

### Step 6: First Boot (Fully Automatic)

The CM5 boots from NVMe. On the first boot, the following services run
automatically — **no login, no keyboard, no monitor, and no SSH are used
or required at any point**.

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

**`trailcurrent-setup-ap`** (runs when no `.env` exists):

6. **Setup access point** — Brings up a WPA2 WiFi access point named
   `Headwaters-XXXX` (where `XXXX` is the last 4 hex digits of the CM5's
   WiFi MAC address, printed on the device label), along with a DHCP
   server and a small branded web app on `10.0.0.1`. The web app is the
   setup portal used in Step 7.

First boot takes 3-5 minutes. Progress is not user-visible — the customer
simply waits for the `Headwaters-XXXX` access point to appear in their
phone's WiFi list. That is the signal that the device is ready.

### Step 7: Setup Portal (From Your Phone)

**All initial configuration happens over the setup access point. No SSH,
keyboard, monitor, or serial console is used, offered, or supported.**

1. On your phone (or any device with WiFi and a browser), open the WiFi
   settings and join the network **`Headwaters-XXXX`**. The SSID and
   WPA2 password are printed on the label affixed to the device
   enclosure.

2. Your phone will detect a captive portal and automatically open the
   branded TrailCurrent setup page. If it does not (some corporate
   phone profiles suppress captive-portal auto-open), open a browser
   and go to `http://10.0.0.1` or `http://headwaters.local`.

3. Complete the setup form:
   - **MQTT username and password** — used by the local MQTT broker
   - **Admin password** — used to sign into the web UI
   - The `ENCRYPTION_KEY` is auto-generated and never displayed.

4. **Install the CA certificate.** The portal offers one-tap installers
   for each platform:
   - **iOS:** downloads a `.mobileconfig` profile. Follow the on-screen
     prompt — the profile installs into **Settings > General > VPN &
     Device Management** and Safari trusts the cert immediately.
   - **Android:** downloads `ca.crt` and triggers the system
     "Install certificate" dialog.
   - **Desktop:** downloads `ca.pem` with per-OS install instructions.

5. Tap **Complete Setup**. The device writes `.env`, starts all Docker
   containers and systemd services, tears down the access point, and
   powers down the WiFi radio via `rfkill`.

6. The final page instructs you to reconnect your phone to the
   vehicle's normal network and open `https://headwaters.local`.

Once complete, the WiFi radio is powered down and the setup access point
never comes back on its own. See the [Recovery / Re-entering Setup
Mode](#recovery--re-entering-setup-mode) section below for how to
re-enter setup mode if a customer forgets their admin password or wants
to re-pair the device.

### Step 8: Verify the Application (No SSH Required)

Open `https://headwaters.local` from a device on the same network as
Headwaters. If you installed the CA in Step 7, the connection is trusted
with no warnings. You should see the TrailCurrent PWA load and, once the
map tiles finish initializing (a few seconds), an interactive vehicle
dashboard.

**Advanced diagnostics** — SSH is available on the standard port for
developer diagnostics using the username and password baked into the
image at build time, but is **not part of the normal setup or operation
of the device.** End customers never need to SSH into a Headwaters unit.
Field diagnostics for customers are performed via the PWA and the
Farwatch cloud dashboard.

### When Something Goes Wrong During Setup

The setup portal is the customer's only interface during initial setup,
so every failure mode must surface an actionable, human-readable message
in the portal itself — not a stack trace or an opaque HTTP code. The
portal follows the same "detailed instructions for how to fix it"
convention used by the map-build pipeline (`build/maps/` — see the
`fix()` helper in [build.sh](../build/maps/build.sh) for the reference
implementation), adapted for a customer-facing web UI.

| Failure | What the portal shows | Recovery |
|---|---|---|
| Customer can't see `Headwaters-XXXX` in their WiFi list | (this is pre-portal) The device's setup access point never came up. Wait 4 minutes after first power-on; if still not visible, the WiFi radio is dead or `trailcurrent-setup-ap` failed. Ethernet is still up — a technician with SSH access can check `journalctl -u trailcurrent-setup-ap` for the fix. | Advertised on the customer-facing quick-start card: "If you don't see `Headwaters-XXXX` after 4 minutes, please contact support." |
| MQTT / admin password fields left blank | Portal blocks form submit with an inline "This field is required" message under the empty field. No round-trip to the server. | Customer fills the field. |
| CA cert install fails on iOS (profile install rejected) | Portal shows: **"iOS did not install the profile. This usually means an older TrailCurrent-CA profile is already installed."** Followed by exact steps: Settings → General → VPN & Device Management → remove existing TrailCurrent-CA → return here → tap Install again. | Customer follows the printed steps. |
| Docker fails to bring up services after form submit | Portal shows: **"Setup failed while starting services."** Followed by: what stage failed (image load, container start, systemd restart), the last 10 lines of the relevant log, and the exact `journalctl -u <unit>` command a technician can run over SSH. `.env` is left in place so re-running the form is not required — a service restart is enough. | Technician diagnoses; customer retries via a "Try again" button once fixed. |
| Customer forgets admin password after setup | Portal is no longer accessible (AP is torn down). The PWA on the vehicle network exposes a **Factory Reset** action in Settings that wipes `.env` + MongoDB and reboots. On next boot the setup AP comes back and the customer redoes Step 7. | PWA action is the primary path. Requires the customer to have typed `FACTORY RESET` in a confirmation modal — see the handler in [os-settings.py](../local_code/os-settings.py). |

Failure messages in the portal are written in customer-facing language
(no jargon, no exit codes, no filesystem paths). Failure messages in the
underlying shell scripts (`trailcurrent-setup-ap.sh` and the setup-portal
backend) follow the shell convention from `build/maps/` — platform-aware
hints via a `fix()` helper, multi-line `printf … >&2` blocks that state
what was expected and give copy-pasteable follow-up commands, and
`journalctl -u <unit>` pointers so a technician has one place to look.

### Recovery / Re-entering Setup Mode

**From the PWA (primary path):** Settings → Factory Reset. The customer
types `FACTORY RESET` in the confirmation modal and taps **Reset
Device**. The device stops all containers, drops the `mongodb-data`
Docker volume (so PWA wizard state is a clean slate), deletes `~/.env`
and `~/local_code/.env`, then reboots. On next boot the setup access
point comes back up because `.env` is absent — the customer redoes Step 7
exactly as they did out of the box. Uploaded map bundles and the TLS CA
are preserved (map bundles are large and user-specific, so wiping them
on factory reset would be user-hostile).

**From SSH (technician path):** delete `~/.env` and reboot. The
setup-ap service picks up on next boot the same way. `docker compose
down -v` first if you want to also wipe MongoDB (recommended — otherwise
the PWA wizard sees `wizard_completed: true` from the old state and
skips).

Both paths are the same code path as first boot — there is no separate
"recovery mode."

See [PI_DEPLOYMENT.md](../PI_DEPLOYMENT.md) for subsequent update
procedures and troubleshooting.

---

## Reproducible Builds: What the Build Does and How to Verify

Every invocation of `build.sh` runs each variant through three stages
serially, and fails loudly if any of them misbehave:

1. **Hardened clean.** Enumerates every mount inside `rpi-image-gen/work/`
   and unmounts them (deepest-first, lazy fallback), then removes the
   `chroot-v*` trees. If the `rm -rf` fails (typically: not running with
   `sudo`, or a mount is still held open), the script **stops** with a
   clear error rather than silently continuing on top of a stale chroot.
   This is what previously produced "I edited the source but the image
   still has the old script baked in" bakes.

2. **Fresh mmdebstrap.** With no `chroot-v*` present, `rpi-image-gen`
   rebuilds the entire rootfs from Debian packages. Every layer YAML
   customize hook (including every `install -m 755 "$SRCROOT/layer/files/…"`)
   runs against the fresh chroot, guaranteeing the current source of
   every file lands in the image.

3. **Post-build verify** — [verify-image.sh](image/verify-image.sh)
   loop-mounts the produced `.img`, `diff -q`s every critical script
   against the source under `layer/files/`, confirms each required
   package (`hostapd`, `dnsmasq`, `rfkill`, `iw`) is installed,
   confirms each expected systemd unit is present AND enabled at
   `multi-user.target.wants/`, confirms `config.txt` does NOT have
   `dtoverlay=disable-wifi`, and confirms Debian's default `hostapd` /
   `dnsmasq` services are masked. If anything is off, the build fails
   with a per-item report — the operator sees exactly what's wrong
   before ever flashing.

**Expected output on a good build:**
```
================================================
  Verifying image against source
================================================
  Image:  .../trailcurrent-cm5-wireless-base.img
  Source: .../CM5/image/layer/files/

  OK:   usr/local/bin/trailcurrent-setup-ap.sh matches source
  OK:   usr/local/bin/trailcurrent-firstboot.sh matches source
  OK:   usr/local/bin/trailcurrent-first-login.sh matches source
  OK:   usr/local/bin/trailcurrent-load-images.sh matches source
  OK:   package present: hostapd
  OK:   package present: dnsmasq
  …
  OK:   unit enabled: trailcurrent-setup-ap.service
  OK:   config.txt does not disable WiFi
  OK:   default hostapd.service is masked
  OK:   default dnsmasq.service is masked

================================================
  IMAGE VERIFIED
================================================
```

**If verification fails**, the output lists each failed check and
common fixes. Most common:
- **"baked … does not match source"** → a stale chroot survived cleanup.
  Fix: `sudo rm -rf CM5/rpi-image-gen/work/chroot-v*` then rebuild.
- **"package missing"** → the package name isn't in the layer YAML
  `mmdebstrap.packages` list. Fix: add it.
- **"unit installed but not enabled"** → the unit name is missing from
  the trailing `enable-units` line in the layer YAML. Fix: append it.
- **"config.txt has 'dtoverlay=disable-wifi'"** → the WiFi radio is
  disabled at the kernel level, so the setup AP cannot come up. Fix:
  remove that overlay line from the layer YAML's `config.txt` block.

---

## Per-Device Quick Reference

For experienced operators who have done this before. Refer to the full
procedure above if anything is unclear.

All commands below are run **from the repo root**. Subshells `( … )` keep
your working directory at the repo root the whole time.

```
One-time (build host):
  1. ./build-and-save-images.sh                                                       # Build ARM64 Docker container images
  2. ( cd CM5/image && sudo ./build.sh myuser mypassword )                             # Builds BOTH variants (base + wireless-base) sequentially, verifies each
  (No map data step — bundles are uploaded via PWA after first boot.)

For each board (all commands from the repo root; substitute the real sdX letter from lsblk):
  1. Install NVMe, fit EMMC_DISABLE jumper (if eMMC), connect USB, power on
  2. ( cd CM5/usbboot/recovery5 && sudo ../rpiboot -d . )                              # Flash EEPROM
  3. Power cycle
  4. ( cd CM5/usbboot && sudo ./rpiboot -d mass-storage-gadget64 )                     # Expose storage
  5. lsblk                                                                             # Identify NVMe (larger sd* device — note the letter!)
  6. Flash the image matching the variant you built (replace sdX with real letter):
     sudo dd if=CM5/rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img \
             of=/dev/sdX bs=4M status=progress conv=fsync                              # Base variant
     sudo dd if=CM5/rpi-image-gen/work/image-trailcurrent-cm5-wireless-base/trailcurrent-cm5-wireless-base.img \
             of=/dev/sdX bs=4M status=progress conv=fsync                              # Wireless-Base variant
  7. Remove jumper (or set Wireless-Base BOOT switch to OFF), disconnect USB, connect Ethernet, power cycle
  8. Wait for the `Headwaters-XXXX` WiFi network to appear (~3-5 min)
  9. From a phone: join `Headwaters-XXXX`, complete the captive-portal setup
 10. Reconnect phone to normal network, open https://headwaters.local to verify
```

**No SSH, keyboard, monitor, or serial console is used in the per-device
flow. The full setup path is: flash → wait → phone.**

---

## What's in the Image

The CM5 image is a self-contained deployment. After flashing, the only
manual step is completing the setup portal from a phone (Step 7 above).

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
| `~/data/maps/` | — (empty skeleton) | Map bundle target: `versions/`, `staging/` subdirs pre-created empty and `trailcurrent`-owned. First upload lands here via the PWA Maps page. |

### Boot Configuration (config.txt)

| Setting | Value | Purpose |
|---------|-------|---------|
| `dtparam=spi=on` **or** `dtoverlay=spi0-1cs,cs0_pin=8` | enabled | Base variant enables SPI via `dtparam=spi=on`; wireless-base variant uses `spi0-1cs,cs0_pin=8` per Waveshare's docs |
| `dtoverlay=mcp2515-can0` (base) / `dtoverlay=mcp2515,spi0-0` (wireless-base) | 16 MHz xtal, GPIO25 INT (base) / GPIO17 INT (wireless-base), 1 MHz SPI | CAN bus hardware |
| `dtoverlay=disable-bt` | disabled | Power savings |
| `dtoverlay=disable-wifi` | *not set* | WiFi is required for the setup access point. The radio is powered down via `rfkill block wifi` at the end of the setup portal — so the runtime power cost is equivalent to a fully disabled radio, but the module must be able to bring it back up if a factory reset is triggered. |
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
| `trailcurrent-setup-ap` | Runs hostapd + dnsmasq + captive-portal web app when `.env` does not exist. Tears itself down and blocks the WiFi radio once setup completes. | Yes (when `.env` is absent) |
| `can0` | Brings up CAN bus at 500 kbps | Yes (when can0 device exists) |
| `disable-usb` | Unbinds USB hub to save power | Yes |
| `docker` | Container runtime | Yes |
| `cantomqtt` | CAN-to-MQTT bridge | Yes (after `.env` written by setup portal) |
| `discovery-mdns` | mDNS device discovery browser | Yes (after `.env` written by setup portal) |
| `deployment-watcher` | Watches for OTA deployment updates | Yes (after `.env` written by setup portal) |

### Setup Scripts

| File | Purpose |
|------|---------|
| `/usr/local/bin/trailcurrent-firstboot.sh` | Automatic first-boot hardware setup (partition, EEPROM, TLS, venv). Runs once. |
| `/usr/local/bin/trailcurrent-load-images.sh` | Loads Docker images from tarballs, deletes tars to free space. Runs once. |
| `/usr/local/bin/trailcurrent-setup-ap.sh` | Brings up the captive-portal WiFi access point (`Headwaters-XXXX`) and the setup web app. Guarded by `ConditionPathExists=!/home/<user>/.env` so it only runs while the device is unconfigured. |

There is no interactive shell-based setup script. All device configuration
is collected through the setup portal web app served over the captive-portal
access point — never through SSH.

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
│   ├── build.sh             <- Single script that builds BOTH variants serially
│   ├── verify-image.sh      <- Called by build.sh once per variant; diffs image vs source
│   ├── config/
│   │   ├── trailcurrent-cm5-base.yaml           <- Base variant build configuration
│   │   └── trailcurrent-cm5-wireless-base.yaml  <- Wireless-Base variant build configuration
│   └── layer/
│       ├── trailcurrent-base.yaml           <- Base variant layer (packages, services, baked artifacts)
│       ├── trailcurrent-base-wireless.yaml  <- Wireless-Base variant layer (identical minus CAN overlay)
│       └── files/
│           ├── trailcurrent-firstboot.sh    <- First-boot hardware setup
│           ├── trailcurrent-load-images.sh  <- Docker image loader (first boot)
│           ├── trailcurrent-setup-ap.sh     <- Captive-portal setup access point
│           ├── setup-portal/                <- Branded setup web app (served by trailcurrent-setup-ap)
│           └── motd                         <- Console banner (SSH is developer-only)
└── rpi-image-gen/            <- Cloned automatically by build.sh (not committed)
```

Files referenced by the image build but located elsewhere in the repo:

```
(repo root)
├── images/*.tar              <- Docker image tarballs (from build-and-save-images.sh)
├── docker-compose.yml        <- Baked into image at ~/docker-compose.yml
├── config/                   <- Baked into image at ~/config/
├── local_code/               <- Baked into image at ~/local_code/
├── scripts/                  <- Baked into image at ~/scripts/
├── deploy.sh                 <- Baked into image at ~/deploy.sh
└── .env.example              <- Baked into image at ~/.env.example
```

Map bundles are NOT part of the image build. They're built separately (see
[build/maps/README.md](../build/maps/README.md)) and uploaded via the PWA
Maps page after first boot.

### On the CM5 Device (After Flashing)

Paths below use `~` for the chosen user's home directory (e.g.,
`/home/trailcurrent/` if the default username was used).

```
~/
├── .env                      <- Created by the captive-portal setup web app (not baked in)
├── .env.example              <- Reference template
├── docker-compose.yml        <- Service orchestration
├── deploy.sh                 <- For future OTA updates
├── config/                   <- Mosquitto configuration
├── scripts/                  <- Certificate generation
├── local_code/               <- Python scripts, systemd units
│   ├── .env                  <- Created by the setup web app (host-facing MQTT URL)
│   └── cantomqtt/            <- Python virtual environment (created by firstboot)
├── images/                   <- Docker tarballs (deleted after first-boot loading)
└── data/
    ├── keys/                 <- TLS certificates (generated by firstboot)
    ├── firmware/             <- Peripheral firmware payloads (OTA)
    ├── deployments/          <- OTA deployment package staging
    └── maps/                 <- Map data (uploaded via PWA after first boot)
        ├── versions/         <- Applied bundles (current + one previous for rollback)
        ├── staging/          <- Upload landing zone (transient)
        └── current           <- Symlink to the active version (created by map-watcher on first upload)
```
