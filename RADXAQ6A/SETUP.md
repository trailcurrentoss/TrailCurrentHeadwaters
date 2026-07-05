# TrailCurrent Headwaters — Q6A Operator Setup Guide

Flashing a Radxa Dragon Q6A with a freshly built Headwaters image. This
is the Q6A equivalent of [`../CM5/SETUP.md`](../CM5/SETUP.md).

## 0. What you need

- A Radxa Dragon Q6A board — the 4 GB SKU is the default target and
  has on-board NVMe, so no separate M.2 drive or NVMe-capable carrier
  is required
- **Waveshare RS485 CAN HAT (B)** — the isolated, 16 MHz variant. The
  plain Waveshare RS485 CAN HAT (12 MHz, non-isolated) is **not**
  supported — see [`README.md`](README.md#can-bus-waveshare-rs485-can-hat-b)
  for the rationale
- USB-C cable, laptop running Linux
- 12 V DC power supply for the Q6A
- Ethernet cable (WiFi is disabled by default)
- The built image at `RADXAQ6A/image/output/headwaters-q6a-vX.Y.Z.img`

If you don't have the image yet, see [`README.md`](README.md) for the
build procedure.

### ⚠ Power wiring — read this before applying 12 V

**On the Q6A, 12 V goes to the Radxa's on-board 3-pin power header
only.** The Q6A produces 5 V internally and sources it out through pins 2
and 4 of the 40-pin header, which powers the CAN HAT.

**Do NOT wire 12 V (or any external DC supply) to the CAN HAT's own
power input terminal.** The HAT's DC input must be left disconnected on
the Q6A build. If the HAT's on-board buck is fed while the Q6A is also
powered, the HAT will back-feed 5 V onto the 40-pin header's 5 V rail
and can damage the Q6A's power stage — Radxa's docs explicitly warn
against driving that rail from an external source.

Correct wiring (one direction only):

```
   12 V ──▶ Radxa 3-pin header ──▶ (internal 5 V) ──▶ HAT via 40-pin header
                                                      HAT DC input: OPEN
```

This is different from the CM5 `Base` build, where wiring the HAT's own
DC input is an option. On the Q6A it is not — the Radxa is the sole
power source for the whole stack.

## 1. Enter EDL (Emergency Download) mode

The Q6A boots from its on-board SPI NOR flash, which must contain the
EDK2 UEFI bootloader. When EDL mode is active, the board enumerates
as a USB device in **Emergency Download** mode and accepts raw writes
to SPI NOR and NVMe via the Firehose protocol.

1. Disconnect 12 V power from the Q6A
2. Plug the USB-C cable from the Q6A into your laptop
3. Hold the **EDL** button on the board
4. While holding EDL, apply 12 V power
5. Release EDL after ~2 seconds
6. Verify detection on your laptop:
   ```bash
   lsusb | grep 9008
   # Expect: Bus 00X Device 00Y: ID 05c6:9008 Qualcomm, Inc. ...
   ```

If `05c6:9008` does not appear, try the EDL entry again (timing matters).

## 2. Flash SPI NOR firmware (first time only)

Only required the **first time** a board is flashed, or when upgrading
the bootloader. If the board has been flashed before and you're just
replacing the OS, skip to step 3.

```bash
cd /path/to/TrailCurrentHeadwaters
sudo ./RADXAQ6A/image/flash.sh --firmware
```

The script prompts before writing; type `y` to continue. Takes ~1 minute.

## 3. Flash the OS image to NVMe

```bash
sudo ./RADXAQ6A/image/flash.sh --os RADXAQ6A/image/output/headwaters-q6a-vX.Y.Z.img
```

Takes ~10–20 minutes depending on image size (map tiles dominate).
The image includes:
- Ubuntu Noble 24.04 minimal (CLI, no desktop)
- Docker CE + Compose
- All Headwaters Docker images (backend, frontend, mongodb, mosquitto, tileserver)
- Map tiles (`map.mbtiles`)
- Host-side Python scripts (CAN-to-MQTT, discovery-mdns, deployment-watcher)
- Branded boot splash + MOTD

## 4. First boot

1. **Disconnect the USB-C cable** from the Q6A
2. Connect Ethernet to the Q6A
3. Apply 12 V power **to the Radxa's 3-pin power header** (see the
   ⚠ Power wiring callout in section 0 — never wire 12 V to the CAN
   HAT itself). The image boots with or without the CAN HAT installed;
   both are supported from first boot.
4. Wait ~3 minutes — first boot runs two services in sequence:

   **`headwaters-firstboot.service`** (early, runs before networking):
   - Expands the root partition to fill the NVMe
   - Regenerates `machine-id` and SSH host keys
   - Re-asserts SSH service enable / socket masking
   - Creates Docker bind-mount target directories
   - Generates per-device TLS/SSL certificates for `headwaters.local`

   **`headwaters-firstboot-network.service`** (deferred, after `network-online.target`):
   - Waits for DNS to resolve `pypi.org`
   - Creates the Python venv at `/home/trailcurrent/local_code/cantomqtt`
   - `pip install -r requirements.txt` with up to 5 retries on transient
     PyPI failures
   - Verifies every dependent module imports cleanly
   - Restarts the Python services (cantomqtt, discovery-mdns,
     deployment-watcher) so they pick up the populated venv

   Plus `headwaters-load-images.service` loads the baked-in Docker
   image tarballs.

Each service writes its own sentinel (`/var/lib/headwaters/.firstboot-done`,
`.firstboot-network-done`) only after every step succeeds, so a partial
failure simply re-runs on the next boot rather than leaving the board
in a half-configured state.

Monitor progress (optional) with a serial console if you have one wired
up, or just wait and try to SSH.

## 5. First login (setup wizard)

```bash
ssh trailcurrent@headwaters.local
# Password: trailcurrent
```

On the first interactive session, the wizard runs and asks for:
- MQTT username (default `trailcurrent`)
- MQTT password
- System admin password (for the web UI)

It then:
1. Generates the `ENCRYPTION_KEY` (32-byte hex)
2. Writes `~/.env` and `~/local_code/.env`
3. Installs the TrailCurrent CA certificate to the system trust store
4. Runs `docker compose up -d` to start the application stack
5. Restarts the host-side systemd services (cantomqtt, discovery-mdns,
   deployment-watcher)
6. Prints the CA certificate PEM for you to install in your browser

The wizard writes `~/.headwaters-setup-complete` when done so it never
re-runs on subsequent logins.

## 6. Access the web UI

```
https://headwaters.local/
```

You'll see a certificate warning the first time unless you installed
the CA certificate the wizard printed. Follow the instructions on-screen
to trust it (Chrome/Firefox/macOS/Windows all have one-click options).

## 7. Verify everything is running

```bash
docker compose ps       # 5 containers should be "Up"
systemctl status cantomqtt discovery-mdns deployment-watcher --no-pager
sudo journalctl -u headwaters-firstboot -b           # early first-boot log
sudo journalctl -u headwaters-firstboot-network -b   # network first-boot log
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Boot menu appears, requires keypress | Board was flashed with an image built before the patched embloader landed; the old `BOOTAA64.EFI` is still on the ESP | Rebuild the OS image and re-flash. The patched embloader lives at `/EFI/BOOT/BOOTAA64.EFI` and `/EFI/systemd/systemd-bootaa64.efi` and matches the sha256 in `RADXAQ6A/image/embloader/output/embloader.efi.sha256`. |
| No `headwaters.local` on the network | early firstboot never completed | SSH by IP and `journalctl -b -u headwaters-firstboot` |
| SSH refused | early firstboot still running | wait 3 min; first-boot regens host keys |
| Python services (`cantomqtt`/`discovery-mdns`/`deployment-watcher`) crash-looping with `ModuleNotFoundError` | `headwaters-firstboot-network.service` failed (no DNS, PyPI outage, etc.) — the venv is empty or partial | `journalctl -b -u headwaters-firstboot-network`. If it failed cleanly the sentinel is absent and a reboot retries. To force a re-run without rebooting: `sudo rm /var/lib/headwaters/.firstboot-network-done && sudo systemctl start headwaters-firstboot-network.service` |
| `docker compose ps` empty | images not loaded | `systemctl status headwaters-load-images` |
| Tileserver container restarting | `map.mbtiles` missing in image | rebuild with `data/tileserver/map.mbtiles` present |
| `can0` netdev not appearing | MCP2515 overlay didn't merge at boot, or HAT not seated | `grep devicetree /boot/efi/loader/entries/*.conf` — both `devicetree` and `devicetree-overlay` lines must exist. Check `dmesg \| grep -iE 'mcp251x\|spi12'` for probe errors (wrong CS, missing HAT). |
| `can0` netdev exists but interface stays down | `headwaters-can0-up.sh` exited cleanly because the deadline expired before the MCP2515 driver bound — rare race on extremely slow first boots | `sudo systemctl restart can0.service` brings it up. If this is recurring, check `journalctl -b -u can0` for the "did not appear within 30s" log line and consider widening `DEADLINE_SEC` in the script. |

For anything else, attach the output of the commands in step 7.
