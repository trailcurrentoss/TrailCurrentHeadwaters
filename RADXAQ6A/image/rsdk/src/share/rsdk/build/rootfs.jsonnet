// ============================================================================
// TrailCurrent Headwaters — Radxa Dragon Q6A rootfs.jsonnet
//
// Builds a minimal Ubuntu Noble (24.04) image with the Headwaters in-vehicle
// compute stack baked in: Docker + Compose, CAN-to-MQTT Python bridge,
// baked-in application containers, map tiles, branding, and the trailcurrent
// default user.
//
// Unlike the Peregrine image, this one does NOT install any NPU packages
// (fastrpc, libcdsprpc1), does NOT bake an LLM / TTS model, and actively
// blacklists the NPU / display / camera / audio kernel modules at boot for
// power savings. The goal is to approximate the power envelope of a CM5
// running the same Docker workload.
//
// All Headwaters-specific files are staged into $HEADWATERS_STAGING by
// RADXAQ6A/image/build.sh before rsdk-build runs. The customize-hooks below
// copy them from there into the chroot rootfs.
// ============================================================================

local distro = import "mod/distro.libjsonnet";
local additional_repos = import "mod/additional_repos.libjsonnet";
local packages = import "mod/packages.libjsonnet";
local cleanup = import "mod/cleanup.libjsonnet";

function(
    architecture = "arm64",
    mode = "root",
    rootfs = "rootfs.tar",
    variant = "apt",

    temp_dir,
    output_dir,
    rsdk_rev = "",

    distro_mirror = "",
    snapshot_timestamp = "",

    radxa_mirror = "",
    radxa_repo_suffix = "",

    product,
    suite,
    edition,
    build_date,

    vendor_packages = true,
    linux_override = "",
    firmware_override = "",
    install_vscodium = false,
    use_pkgs_json = true,
) distro(suite, distro_mirror, architecture, snapshot_timestamp)
+ additional_repos(suite, radxa_mirror, radxa_repo_suffix, product, temp_dir, install_vscodium, use_pkgs_json)
+ packages(suite, edition, product, temp_dir, vendor_packages, linux_override, firmware_override)
+ cleanup()
+ {
    mmdebstrap+: {
        architectures: [
            architecture
        ],
        keyrings: [
            "%(temp_dir)s/keyrings/" % { temp_dir: temp_dir },
        ],
        mode: mode,
        target: rootfs,
        variant: variant,
        hostname: "headwaters",
        packages+:
        [
            // ── Core system tooling ──
            "ca-certificates",
            "curl",
            "wget",
            "gnupg",
            "lsb-release",
            "apt-transport-https",
            "sudo",
            "openssh-server",
            "avahi-daemon",
            "avahi-utils",
            "libnss-mdns",
            "rfkill",
            "cloud-guest-utils",
            "parted",
            "nvme-cli",
            "htop",
            "nano",
            "less",
            "jq",
            "unzip",

            // ── Python for CAN-to-MQTT / deployment-watcher / discovery-mdns ──
            "python3",
            "python3-venv",
            "python3-pip",

            // ── CAN bus tooling (Waveshare RS485 CAN HAT via MCP2515) ──
            "can-utils",
            "iproute2",

            // ── Boot splash ──
            "plymouth",
            "plymouth-themes",
            "initramfs-tools",

            // ── OpenSSL for firstboot TLS cert generation ──
            "openssl",
        ],
        "customize-hooks"+:
        [
            // ════════════════════════════════════════════════════════════════
            // Hook 0: rsdk standard hooks (hostname, fingerprint, initramfs)
            // ════════════════════════════════════════════════════════════════
            'echo "127.0.1.1\theadwaters" >> "$1/etc/hosts"',
            'cp "%(output_dir)s/config.yaml" "$1/etc/rsdk/"' % { output_dir: output_dir },
            'echo "FINGERPRINT_VERSION=\'2\'" > "$1/etc/radxa_image_fingerprint"',
            'echo "RSDK_BUILD_DATE=\'$(date -R)\'" >> "$1/etc/radxa_image_fingerprint"',
            'echo "RSDK_REVISION=\'%(rsdk_rev)s\'" >> "$1/etc/radxa_image_fingerprint"' % { rsdk_rev: rsdk_rev },
            'echo "RSDK_CONFIG=\'/etc/rsdk/config.yaml\'" >> "$1/etc/radxa_image_fingerprint"',
            'chroot "$1" sh -c "SYSTEMD_RELAX_ESP_CHECKS=1 update-initramfs -c -k all"',
            'chroot "$1" sh -c "u-boot-update"',
            |||
                cp -aR "$1/boot/efi" "$1/boot/efi2"
                chmod 0755 "$1/boot/efi2"
                umount "$1/boot/efi"
                rmdir "$1/boot/efi"
                mv "$1/boot/efi2" "$1/boot/efi"
            |||,
            |||
                mkdir -p "%(output_dir)s/seed"
                cp "$1/etc/radxa_image_fingerprint" "%(output_dir)s/seed"
                cp "$1/etc/rsdk/"* "%(output_dir)s/seed"
                tar Jvcf "%(output_dir)s/seed.tar.xz" -C "%(output_dir)s/seed" .
                rm -rf "%(output_dir)s/seed"
            ||| % { output_dir: output_dir },

            // ════════════════════════════════════════════════════════════════
            // Hook 1: Set hostname
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 1] hostname"
                echo "headwaters" > "$1/etc/hostname"
                grep -q "127.0.1.1.*headwaters" "$1/etc/hosts" || \
                    echo "127.0.1.1   headwaters" >> "$1/etc/hosts"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 2: Remove rsetup-config-first-boot
            //
            // This is ONLY HALF the fix. The `rsetup-config-first-boot` package
            // ships /config/before.txt, but /config is a SEPARATE auto-mounted
            // partition, so purging the package does not delete before.txt.
            //
            // The runtime executor — `rsetup.service`, shipped by the separate
            // main `rsetup` package (which we keep, because it is pulled in by
            // core Radxa packages and removing it has other side effects) —
            // still auto-mounts /config on first boot, finds before.txt, and
            // runs it. before.txt calls `disable_service ssh`.
            //
            // See hook 14 (masks rsetup.service + config.automount — the real
            // fix) and headwaters-firstboot.sh (belt-and-suspenders re-enable).
            // We STILL purge the package here to remove its own state, prevent
            // future re-invocation if it is somehow pulled back in, and to
            // keep the final checkpoint's dpkg -l assertion happy.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 2] removing rsetup-config-first-boot (Headwaters manages first-boot itself)"
                chroot "$1" apt-get remove -y --purge rsetup-config-first-boot 2>/dev/null || true
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 3: Install Docker CE from the official Debian/Ubuntu repo
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 3] installing Docker CE"
                mkdir -p "$1/etc/apt/keyrings"
                curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
                    | gpg --dearmor -o "$1/etc/apt/keyrings/docker.gpg"
                chmod a+r "$1/etc/apt/keyrings/docker.gpg"
                echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" \
                    > "$1/etc/apt/sources.list.d/docker.list"
                chroot "$1" apt-get update
                chroot "$1" apt-get install -y --no-install-recommends \
                    docker-ce docker-ce-cli containerd.io docker-compose-plugin
                mkdir -p "$1/etc/docker"
                cat > "$1/etc/docker/daemon.json" <<'EOF'
                {
                  "log-driver": "json-file",
                  "log-opts": {
                    "max-size": "10m",
                    "max-file": "3"
                  }
                }
                EOF
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 4: Create trailcurrent user (default password: trailcurrent)
            //
            // The NOPASSWD sudoers drop-in matches what the CM5 build does via
            // `IGconf_device_user1sudo=nopasswd`. Without it, the first-login
            // wizard's `sudo systemctl restart cantomqtt.service` lines prompt
            // for a password on stderr, and because the wizard `2>/dev/null`s
            // those prompts, the session silently hangs waiting for input that
            // will never come.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 4] creating trailcurrent user"
                if ! chroot "$1" id trailcurrent >/dev/null 2>&1; then
                    chroot "$1" useradd -m -s /bin/bash -G sudo,plugdev,systemd-journal,adm,dialout trailcurrent
                else
                    chroot "$1" usermod -aG sudo,plugdev,systemd-journal,adm,dialout trailcurrent
                fi
                echo "trailcurrent:trailcurrent" | chroot "$1" chpasswd
                chroot "$1" chage -d "$(date +%Y-%m-%d)" trailcurrent
                chroot "$1" passwd -l root || true
                chroot "$1" usermod -aG docker trailcurrent

                # Passwordless sudo for trailcurrent — required by the first-login
                # wizard and by host-side service management after deploy.
                echo "trailcurrent ALL=(ALL) NOPASSWD: ALL" \
                    > "$1/etc/sudoers.d/010_trailcurrent-nopasswd"
                chmod 440 "$1/etc/sudoers.d/010_trailcurrent-nopasswd"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 5: Stage Headwaters application deployment artifacts
            //
            // This is the Q6A equivalent of the CM5 layer bake step: ship the
            // docker-compose stack, map tiles, Docker image tarballs, host-side
            // Python scripts, and the deploy.sh for future OTAs.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 5] staging Headwaters deployment artifacts"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                TC_HOME="$1/home/trailcurrent"
                REPO="$STAGING/repo"

                if [ ! -f "$REPO/docker-compose.yml" ]; then
                    echo "ERROR: staged repo missing $REPO/docker-compose.yml"
                    exit 1
                fi

                install -m 644 "$REPO/docker-compose.yml"  "$TC_HOME/docker-compose.yml"
                install -m 644 "$REPO/.env.example"        "$TC_HOME/.env.example"
                install -m 755 "$REPO/deploy.sh"           "$TC_HOME/deploy.sh"

                mkdir -p "$TC_HOME/config"
                cp -r "$REPO/config/mosquitto" "$TC_HOME/config/"

                mkdir -p "$TC_HOME/scripts"
                install -m 755 "$REPO/scripts/generate-certs.sh" "$TC_HOME/scripts/generate-certs.sh"
                install -m 644 "$REPO/scripts/openssl.cnf"       "$TC_HOME/scripts/openssl.cnf"

                mkdir -p "$TC_HOME/local_code"
                for f in "$REPO"/local_code/*.py "$REPO"/local_code/*.service "$REPO"/local_code/requirements.txt; do
                    [ -f "$f" ] && install -m 644 "$f" "$TC_HOME/local_code/"
                done

                mkdir -p "$TC_HOME/images"
                if ls "$REPO"/images/*.tar 1>/dev/null 2>&1; then
                    cp "$REPO"/images/*.tar "$TC_HOME/images/"
                    echo "  staged $(ls "$TC_HOME/images"/*.tar | wc -l) image tarballs"
                else
                    echo "  WARNING: no Docker image tarballs — tileserver/backend etc. will not start"
                fi

                mkdir -p "$TC_HOME/data/tileserver"
                if [ -f "$REPO/data/tileserver/map.mbtiles" ]; then
                    cp "$REPO/data/tileserver/map.mbtiles" "$TC_HOME/data/tileserver/map.mbtiles"
                    echo "  staged map.mbtiles ($(du -h "$TC_HOME/data/tileserver/map.mbtiles" | cut -f1))"
                else
                    echo "  WARNING: map.mbtiles missing — tileserver container will not start"
                fi

                mkdir -p "$TC_HOME/data/keys"
                mkdir -p "$TC_HOME/data/firmware"
                mkdir -p "$TC_HOME/data/deployments"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 6: Install systemd units (firstboot, power-save, services)
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 6] installing systemd unit files"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                FILES="$STAGING/files"

                for unit in \
                    headwaters-firstboot.service \
                    headwaters-firstboot-network.service \
                    headwaters-load-images.service \
                    cpu-powersave.service \
                    power-save-hw.service \
                    can0.service \
                    cantomqtt.service \
                    discovery-mdns.service \
                    deployment-watcher.service; do
                    install -m 644 "$FILES/systemd/$unit" \
                        "$1/etc/systemd/system/$unit"
                done

                mkdir -p "$1/etc/systemd/system.conf.d"
                install -m 644 "$FILES/systemd/system.conf.d/timeout.conf" \
                    "$1/etc/systemd/system.conf.d/timeout.conf"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 7: Install scripts to /usr/local/{bin,sbin}
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 7] installing scripts"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                FILES="$STAGING/files"
                install -m 755 "$FILES/scripts/headwaters-firstboot.sh" \
                    "$1/usr/local/sbin/headwaters-firstboot.sh"
                install -m 755 "$FILES/scripts/headwaters-firstboot-network.sh" \
                    "$1/usr/local/sbin/headwaters-firstboot-network.sh"
                install -m 755 "$FILES/scripts/headwaters-can0-up.sh" \
                    "$1/usr/local/sbin/headwaters-can0-up.sh"
                install -m 755 "$FILES/scripts/headwaters-first-login.sh" \
                    "$1/usr/local/bin/headwaters-first-login.sh"
                install -m 755 "$FILES/scripts/headwaters-load-images.sh" \
                    "$1/usr/local/sbin/headwaters-load-images.sh"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 8: Enable services
            //
            // Fix Ubuntu 24.04 socket activation so ssh.service owns port 22.
            //
            // Problem: openssh-server postinst runs `deb-systemd-helper enable
            // ssh.socket`, which creates:
            //     /etc/systemd/system/ssh.service.requires/ssh.socket
            // (because ssh.socket's [Install] has RequiredBy=ssh.service)
            //
            // `systemctl mask` creates /etc/systemd/system/ssh.socket -> /dev/null
            // but does NOT remove the .requires/ symlink. At boot, systemd sees
            // ssh.service Requires=ssh.socket (via .requires/), finds ssh.socket
            // masked, and refuses to start ssh.service entirely — SSH is then
            // unreachable on first boot and the only way in is a serial console.
            //
            // Fix: disable (removes .wants/.requires symlinks) → mask (blocks
            // re-enable) → rm the .requires/ symlink as belt-and-suspenders in
            // case disable missed it. This was iterated to death on Peregrine;
            // do NOT collapse these three steps or drop any of them.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 8] enabling services"
                chroot "$1" systemctl disable ssh.socket 2>/dev/null || true
                chroot "$1" systemctl mask    ssh.socket 2>/dev/null || true
                rm -f "$1/etc/systemd/system/ssh.service.requires/ssh.socket"

                chroot "$1" systemctl enable \
                    ssh.service \
                    avahi-daemon.service \
                    docker.service \
                    headwaters-firstboot.service \
                    headwaters-firstboot-network.service \
                    headwaters-load-images.service \
                    cpu-powersave.service \
                    power-save-hw.service \
                    can0.service \
                    cantomqtt.service \
                    discovery-mdns.service \
                    deployment-watcher.service
                chroot "$1" systemctl set-default multi-user.target
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 9: Install Plymouth theme
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 9] installing Plymouth theme"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                FILES="$STAGING/files"
                THEME_DIR="$1/usr/share/plymouth/themes/trailcurrent"
                mkdir -p "$THEME_DIR"
                cp "$FILES/plymouth/trailcurrent.plymouth" "$THEME_DIR/"
                cp "$FILES/plymouth/trailcurrent.script"   "$THEME_DIR/"
                cp "$FILES/plymouth/logo.png"              "$THEME_DIR/"
                cp "$FILES/plymouth/background.png"        "$THEME_DIR/"
                chroot "$1" update-alternatives --install \
                    /usr/share/plymouth/themes/default.plymouth \
                    default.plymouth \
                    /usr/share/plymouth/themes/trailcurrent/trailcurrent.plymouth 200
                chroot "$1" update-alternatives --set default.plymouth \
                    /usr/share/plymouth/themes/trailcurrent/trailcurrent.plymouth
                chroot "$1" update-initramfs -u -k all 2>/dev/null || \
                    echo "  WARNING: update-initramfs failed (non-fatal under qemu)"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 10: Install MOTD + console issue
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 10] installing MOTD and console issue"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                FILES="$STAGING/files"
                rm -f "$1"/etc/update-motd.d/*
                install -m 755 "$FILES/motd/10-trailcurrent" \
                    "$1/etc/update-motd.d/10-trailcurrent"
                install -m 644 "$FILES/motd/issue-trailcurrent" "$1/etc/issue"
                install -m 644 "$FILES/motd/issue-trailcurrent" "$1/etc/issue.net"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 11: Install profile.d shell branding + first-login hook
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 11] installing branded shell prompt"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                FILES="$STAGING/files"
                install -m 644 "$FILES/profile/trailcurrent-prompt.sh" \
                    "$1/etc/profile.d/trailcurrent-prompt.sh"
                install -m 644 "$FILES/profile/first-login-hook.bash" \
                    "$1/etc/profile.d/first-login-hook.sh"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 12: Install sysctl tuning
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 12] installing sysctl tuning"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                FILES="$STAGING/files"
                install -m 644 "$FILES/sysctl/90-headwaters.conf" \
                    "$1/etc/sysctl.d/90-headwaters.conf"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 13: Disable WiFi / Bluetooth / NPU / display / camera / audio
            //
            // Every subsystem we do NOT use is blacklisted so its driver never
            // loads. Combined with hook 16 (power-save-hw.service) this is the
            // main power-saving lever on the Q6A. The goal is to approximate
            // CM5 idle power draw for the same Docker workload.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 13] disabling unused subsystems (NPU, WiFi, BT, display, camera, audio)"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                FILES="$STAGING/files"
                install -m 644 "$FILES/modprobe/disable-unused.conf" \
                    "$1/etc/modprobe.d/disable-unused.conf"
                chroot "$1" systemctl mask wpa_supplicant.service 2>/dev/null || true
                chroot "$1" systemctl mask bluetooth.service      2>/dev/null || true
                mkdir -p "$1/etc/pulse"
                echo "autospawn = no" > "$1/etc/pulse/client.conf"
                for svc in pulseaudio pipewire pipewire-pulse wireplumber; do
                    chroot "$1" systemctl --global disable "$svc.service" 2>/dev/null || true
                    chroot "$1" systemctl --global disable "$svc.socket"  2>/dev/null || true
                done
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 14: Mask unnecessary services
            //
            // CRITICAL: rsetup.service + config.automount must be masked.
            // rsetup.service is shipped by the `rsetup` package (separate from
            // rsetup-config-first-boot which we purge in hook 2). On first boot
            // it auto-mounts /config (a separate partition we don't control),
            // reads /config/before.txt, and executes a Radxa setup script that:
            //   - calls `disable_service ssh` (leaving the board unreachable)
            //   - conditionally re-enables SSH based on DRM connector state
            //     (unreliable on headless boards)
            //   - creates an unexpected `radxa` user (UID 1001)
            //   - changes the hostname if it looks "generic"
            //
            // Masking rsetup.service is the single-point fix. We also mask
            // config.automount so the Radxa /config partition is never pulled
            // in; nothing else in the Headwaters stack touches it.
            //
            // headwaters-firstboot.sh ALSO re-enables ssh.service defensively
            // on every first boot, so if a future rsetup package ever finds
            // another way to disable ssh, first boot will undo it.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 14] masking unnecessary services"
                MASK="rsetup.service config.automount \
                      snapd snapd.socket snapd.seeded.service \
                      cups cups-browsed bluetooth ModemManager fwupd packagekit \
                      accounts-daemon colord switcheroo-control power-profiles-daemon \
                      udisks2 NetworkManager-wait-online unattended-upgrades \
                      systemd-networkd-wait-online \
                      apt-daily.timer apt-daily-upgrade.timer motd-news.timer \
                      man-db.timer e2scrub_all.timer fstrim.timer \
                      systemd-sysupdate.timer systemd-sysupdate-reboot.timer \
                      whoopsie apport \
                      gdm3 gdm lightdm sddm"
                for svc in $MASK; do
                    chroot "$1" systemctl mask "$svc" 2>/dev/null || true
                done
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 15: Install SSH config drop-in
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 15] installing SSH config"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                FILES="$STAGING/files"
                mkdir -p "$1/etc/ssh/sshd_config.d"
                install -m 644 "$FILES/ssh/sshd_config.d/10-trailcurrent.conf" \
                    "$1/etc/ssh/sshd_config.d/10-trailcurrent.conf"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 16: Validate sudoers
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 16] validating /etc/sudoers"
                chroot "$1" visudo -c
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 17: Write /etc/headwaters-release
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 17] writing /etc/headwaters-release"
                {
                    echo "HEADWATERS_VERSION=\"${HEADWATERS_VERSION:-dev}\""
                    echo "HEADWATERS_BUILD_DATE=\"$(date -R)\""
                    echo "HEADWATERS_BUILD_HOST=\"$(hostname)\""
                    echo "HEADWATERS_TARGET=\"radxa-dragon-q6a\""
                    echo "HEADWATERS_BUILD_MODE=\"${HEADWATERS_BUILD_MODE:-full}\""
                } > "$1/etc/headwaters-release"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 18: Fix ownership of /home/trailcurrent
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 18] fixing ownership of /home/trailcurrent"
                chroot "$1" chown -R trailcurrent:trailcurrent /home/trailcurrent
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 19: Kernel cmdline — usbcore autosuspend
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 19] patching kernel cmdline for power savings"
                CMDLINE="$1/etc/kernel/cmdline"
                if [ -f "$CMDLINE" ] && ! grep -q "usbcore.autosuspend" "$CMDLINE"; then
                    sed -i 's/$/ usbcore.autosuspend=-1/' "$CMDLINE"
                fi
                EXTLINUX="$1/boot/extlinux/extlinux.conf"
                if [ -f "$EXTLINUX" ] && ! grep -q "usbcore.autosuspend" "$EXTLINUX"; then
                    sed -i '/^[[:space:]]*append/ s/$/ usbcore.autosuspend=-1/' "$EXTLINUX"
                fi
                for entry in "$1"/boot/efi/loader/entries/*.conf; do
                    [ -f "$entry" ] || continue
                    if ! grep -q "usbcore.autosuspend" "$entry"; then
                        sed -i '/^options / s/$/ usbcore.autosuspend=-1/' "$entry"
                    fi
                done
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 19b: Enable MCP2515 SPI CAN overlay
            //
            // The Waveshare RS485 CAN HAT sits on the 40-pin header at:
            //   pin 19 MOSI → GPIO_49 → SPI12_MOSI
            //   pin 21 MISO → GPIO_48 → SPI12_MISO
            //   pin 23 SCLK → GPIO_50 → SPI12_SCLK
            //   pin 24 CE0  → GPIO_51 → SPI12_CS_0
            //   pin 22 INT  → GPIO_57 (MCP2515 interrupt)
            //   16 MHz external crystal on the HAT (RS485 CAN HAT (B) — the
            //   plain HAT's 12 MHz crystal cannot hit sample-point 0.875 at
            //   500 kbit/s and is not supported).
            //
            // The overlay source (qcs6490-radxa-dragon-q6a-spi12-cs0-mcp2515-16mhz.dts)
            // is vendored at RADXAQ6A/image/overlays/ and compiled on the build
            // host by build.sh into $STAGING/files/dtbo/*.dtbo BEFORE this hook
            // runs. That means this hook just copies the pre-built dtbo into the
            // EFI entry dir and rewrites the systemd-boot loader entry to merge
            // the overlay into the fdt at boot. No DKMS, no chroot qemu surprises.
            //
            // Loader layout (matches what rsetup would produce at runtime):
            //   /boot/efi/<entry-token>/<kernel-ver>/<base>.dtb
            //   /boot/efi/<entry-token>/<kernel-ver>/dtbo/<overlay>.dtbo
            //   /boot/efi/loader/entries/<entry-token>-<kver>.conf
            //     ... with `devicetree` and `devicetree-overlay` lines added.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 19b] installing device-tree overlays (CAN HAT + unused-pins disable)"

                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"

                # All overlays we ship. They were compiled from overlays/*.dts
                # by build.sh into $STAGING/files/dtbo/*.dtbo before this hook
                # runs. Order here is also the order applied at boot — list
                # the unused-pins-disable LAST so its gpio-hog claims happen
                # after the active drivers (MCP2515) have taken their pins.
                OVERLAYS="
                    qcs6490-radxa-dragon-q6a-spi12-cs0-mcp2515-16mhz.dtbo
                    qcs6490-radxa-dragon-q6a-headwaters-unused-pins-disable.dtbo
                "
                for OVR in $OVERLAYS; do
                    if [ ! -f "$STAGING/files/dtbo/$OVR" ]; then
                        echo "  ERROR: overlay $OVR missing from staging at $STAGING/files/dtbo/" >&2
                        echo "         build.sh should have compiled overlays/*.dts with dtc." >&2
                        exit 1
                    fi
                done

                # Identify installed kernel (the one whose base DTB we'll reference)
                KVER=""
                for d in "$1"/usr/lib/linux-image-*; do
                    [ -d "$d" ] || continue
                    KVER="${d##*/linux-image-}"
                    break
                done
                if [ -z "$KVER" ]; then
                    echo "  ERROR: no /usr/lib/linux-image-*/ in chroot — no kernel installed?" >&2
                    exit 1
                fi
                echo "  kernel: $KVER"

                # entry-token is written by kernel-install during mmdebstrap
                ENTRY_TOKEN=$(cat "$1/etc/kernel/entry-token" 2>/dev/null || echo "")
                if [ -z "$ENTRY_TOKEN" ]; then
                    echo "  ERROR: /etc/kernel/entry-token missing (kernel-install did not run)" >&2
                    exit 1
                fi
                echo "  entry token: $ENTRY_TOKEN"

                EFI_ENTRY="$1/boot/efi/$ENTRY_TOKEN/$KVER"
                mkdir -p "$EFI_ENTRY/dtbo"

                # Install all pre-compiled overlays
                for OVR in $OVERLAYS; do
                    install -m 644 "$STAGING/files/dtbo/$OVR" "$EFI_ENTRY/dtbo/$OVR"
                done

                # Copy the base DTB into the entry dir so the loader entry can
                # reference it with a path inside the ESP
                BASE_DTB=$(find "$1/usr/lib/linux-image-$KVER/" -type f -name "*radxa-dragon-q6a.dtb" 2>/dev/null | head -1)
                if [ -z "$BASE_DTB" ]; then
                    echo "  ERROR: base DTB *radxa-dragon-q6a.dtb not found under /usr/lib/linux-image-$KVER/" >&2
                    exit 1
                fi
                install -m 644 "$BASE_DTB" "$EFI_ENTRY/"
                BASE_NAME=$(basename "$BASE_DTB")

                # Locate systemd-boot loader entry (handles boot-counting filenames)
                LOADER="$1/boot/efi/loader/entries/${ENTRY_TOKEN}-${KVER}.conf"
                if [ ! -f "$LOADER" ]; then
                    LOADER=$(ls "$1"/boot/efi/loader/entries/${ENTRY_TOKEN}-${KVER}*.conf 2>/dev/null | head -1)
                fi
                if [ ! -f "$LOADER" ]; then
                    echo "  ERROR: systemd-boot loader entry not found for $KVER" >&2
                    ls "$1/boot/efi/loader/entries/" >&2 || true
                    exit 1
                fi

                # Rewrite devicetree + devicetree-overlay lines (idempotent).
                # systemd-boot accepts multiple devicetree-overlay lines and
                # applies them in the order they appear.
                sed -i '/^devicetree /d; /^devicetree-overlay /d' "$LOADER"
                {
                    echo "devicetree /$ENTRY_TOKEN/$KVER/$BASE_NAME"
                    for OVR in $OVERLAYS; do
                        echo "devicetree-overlay /$ENTRY_TOKEN/$KVER/dtbo/$OVR"
                    done
                } >> "$LOADER"

                echo "  enabled overlays:"
                for OVR in $OVERLAYS; do
                    echo "    $OVR"
                done
                echo "  loader:  $(basename "$LOADER")"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 19c: Harden systemd-boot loader.conf for unattended boot
            //
            // The default loader.conf written by `bootctl install` (then
            // un-commented by core.libjsonnet) ships `timeout 3`, which makes
            // sd-boot show the menu for 3 seconds AND freeze autoboot on any
            // keypress. On Q6A first boots we observed phantom serial input
            // arriving on the EFI conin (suspected RS485 HAT or floating
            // debug-UART RX), which trapped the board at the menu indefinitely
            // and required keyboard intervention to proceed.
            //
            // `timeout 0` boots immediately; `editor no` disables the boot
            // entry editor (also keypress-triggered). Together these make
            // first boot fully unattended even with a noisy serial line.
            // To enter the menu for recovery, hold space during the brief
            // autoboot window.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 19c] writing hardened loader.conf for unattended boot"
                LOADER_CONF="$1/boot/efi/loader/loader.conf"
                if [ ! -f "$LOADER_CONF" ]; then
                    echo "  ERROR: $LOADER_CONF missing — bootctl install did not run?" >&2
                    exit 1
                fi
                {
                    printf 'default RadxaOS-*\n'
                    printf 'timeout 0\n'
                    printf 'console-mode keep\n'
                    printf 'editor no\n'
                    # auto-firmware no: suppress the synthetic "Reboot Into
                    # Firmware Interface" entry. With our patched embloader,
                    # timeout=0 already skips the menu; this is just one
                    # fewer entry for the menu code to enumerate.
                    printf 'auto-firmware no\n'
                } > "$LOADER_CONF"
                echo "  wrote $LOADER_CONF:"
                sed 's/^/    /' "$LOADER_CONF"
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 19d: Install patched embloader.efi over Radxa's stock build
            //
            // Radxa's `sdboot-is-embloader` package installs an unpatched
            // upstream embloader 0.4 binary at /EFI/systemd/systemd-bootaa64.efi
            // and /EFI/BOOT/BOOTAA64.EFI. That binary's text-menu code in
            // src/menu/menus/text_menu.c always pumps gST->ConIn during the
            // autoboot timeout window, even when timeout=0. Phantom serial
            // bytes from the floating debug-UART RX pin (gpio23 / header
            // pin 10) capacitively-coupled to adjacent SPI clocks on a HAT
            // get decoded as keystrokes and trap the user at the menu.
            //
            // We rebuild embloader from upstream tag 0.4 (commit 9f8e74b)
            // with a one-block patch (RADXAQ6A/image/embloader/patches/
            // 0001-headwaters-autoboot-on-timeout-zero.patch) that returns
            // the default loader immediately when timeout==0, never touching
            // ConIn. build.sh runs the build before this hook and stages the
            // resulting embloader.efi at $STAGING/files/embloader/.
            //
            // We overwrite both EFI binary names because some firmware boots
            // /EFI/BOOT/BOOTAA64.EFI directly while others use the named
            // /EFI/systemd/systemd-bootaa64.efi (set as the default loader
            // by `bootctl install --no-variables`).
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 19d] installing patched embloader.efi"
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                SRC="$STAGING/files/embloader/embloader.efi"
                if [ ! -f "$SRC" ]; then
                    echo "  ERROR: $SRC missing — build.sh should have built it" >&2
                    exit 1
                fi
                EXPECTED_SHA=$(cut -d' ' -f1 "$STAGING/files/embloader/embloader.efi.sha256")
                ACTUAL_SHA=$(sha256sum "$SRC" | cut -d' ' -f1)
                if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
                    echo "  ERROR: embloader.efi sha256 mismatch ($EXPECTED_SHA vs $ACTUAL_SHA)" >&2
                    exit 1
                fi
                echo "  patched embloader.efi sha256: $ACTUAL_SHA"
                # Both copies. Install over Radxa's stock binary if present;
                # write fresh otherwise.
                for dest in \
                    "$1/boot/efi/EFI/BOOT/BOOTAA64.EFI" \
                    "$1/boot/efi/EFI/systemd/systemd-bootaa64.efi"
                do
                    mkdir -p "$(dirname "$dest")"
                    install -m 644 "$SRC" "$dest"
                    echo "  installed: ${dest#$1}"
                done
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 20: Golden image cleanup
            //
            // NOTE: do NOT wipe /tmp — bdebstrap needs /tmp/bdebstrap-output/.
            //
            // NOTE: do NOT delete SSH host keys. They were generated during
            // package install inside THIS chroot (hook 21 regenerates any
            // missing ones before the image is sealed), so every build ships
            // a unique set. Deleting them here means sshd won't start on first
            // boot until firstboot regenerates + reboots, and that reboot cycle
            // proved fragile on Peregrine — boards ended up unreachable via SSH
            // until someone plugged in a serial console. Pre-generated keys
            // baked into the chroot are the reliable path: each reflash gets a
            // fresh build's keys, and sshd starts immediately on first boot.
            //
            // If you add a "reproducibility" cleanup pass later, the keys must
            // stay. This is load-bearing.
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 20] golden image cleanup"
                : > "$1/etc/machine-id"
                rm -f "$1/var/lib/dbus/machine-id"
                # SSH host keys intentionally preserved — see comment above.
                chroot "$1" apt-get clean
                rm -rf "$1"/var/lib/apt/lists/*
                rm -rf "$1"/root/.cache/pip
                rm -rf "$1"/home/trailcurrent/.cache/pip
                find "$1"/var/log -type f -name '*.log' -delete 2>/dev/null || true
                : > "$1"/root/.bash_history              2>/dev/null || true
                : > "$1"/home/trailcurrent/.bash_history 2>/dev/null || true
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 21: SSH readiness verification
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 21] verifying SSH readiness"
                KEY_COUNT=$(ls "$1"/etc/ssh/ssh_host_*_key 2>/dev/null | wc -l)
                if [ "$KEY_COUNT" -lt 3 ]; then
                    for type in rsa ecdsa ed25519; do
                        chroot "$1" ssh-keygen -t "$type" \
                            -f "/etc/ssh/ssh_host_${type}_key" -N "" -q
                    done
                fi
                chroot "$1" sshd -t 2>&1 || {
                    echo "  WARNING: sshd -t failed — removing drop-ins"
                    rm -f "$1"/etc/ssh/sshd_config.d/*.conf
                }
                chroot "$1" systemctl is-enabled ssh.service >/dev/null 2>&1 \
                    || chroot "$1" systemctl enable ssh.service
            |||,

            // ════════════════════════════════════════════════════════════════
            // Hook 22: FINAL CHECKPOINT — fail-fast artifact verification
            // ════════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 22] CHECKPOINT — final artifact verification"
                FAIL=0
                check()   { [ -e "$1$2" ] && echo "  ✓ $2"              || { echo "  ✗ MISSING: $2";                FAIL=$((FAIL+1)); }; }
                check_x() { [ -x "$1$2" ] && echo "  ✓ $2 (executable)" || { echo "  ✗ NOT EXECUTABLE OR MISSING: $2"; FAIL=$((FAIL+1)); }; }

                check   "$1" /home/trailcurrent/docker-compose.yml
                check   "$1" /home/trailcurrent/.env.example
                check_x "$1" /home/trailcurrent/deploy.sh
                check   "$1" /home/trailcurrent/config/mosquitto
                check_x "$1" /home/trailcurrent/scripts/generate-certs.sh
                check_x "$1" /usr/local/sbin/headwaters-firstboot.sh
                check_x "$1" /usr/local/sbin/headwaters-firstboot-network.sh
                check_x "$1" /usr/local/sbin/headwaters-can0-up.sh
                check_x "$1" /usr/local/bin/headwaters-first-login.sh
                check_x "$1" /usr/local/sbin/headwaters-load-images.sh
                check   "$1" /etc/systemd/system/headwaters-firstboot.service
                check   "$1" /etc/systemd/system/headwaters-firstboot-network.service
                check   "$1" /etc/systemd/system/cpu-powersave.service
                check   "$1" /etc/systemd/system/power-save-hw.service
                check   "$1" /etc/systemd/system/can0.service
                check   "$1" /etc/systemd/system/cantomqtt.service
                check   "$1" /etc/systemd/system/discovery-mdns.service
                check   "$1" /etc/systemd/system/deployment-watcher.service
                check   "$1" /etc/systemd/system.conf.d/timeout.conf
                check   "$1" /etc/modprobe.d/disable-unused.conf
                check   "$1" /etc/sysctl.d/90-headwaters.conf
                check   "$1" /etc/docker/daemon.json
                check   "$1" /etc/headwaters-release
                check   "$1" /usr/share/plymouth/themes/trailcurrent/trailcurrent.plymouth
                check   "$1" /etc/profile.d/first-login-hook.sh
                check   "$1" /etc/ssh/ssh_host_ed25519_key

                if [ -L "$1/etc/systemd/system/ssh.socket" ] && \
                   [ "$(readlink "$1/etc/systemd/system/ssh.socket")" = "/dev/null" ]; then
                    echo "  ✓ ssh.socket masked → /dev/null"
                else
                    echo "  ✗ ssh.socket NOT masked (SSH will fail at boot)"
                    FAIL=$((FAIL+1))
                fi
                if [ ! -e "$1/etc/systemd/system/ssh.service.requires/ssh.socket" ]; then
                    echo "  ✓ ssh.service.requires/ssh.socket absent"
                else
                    echo "  ✗ ssh.service.requires/ssh.socket EXISTS (SSH will fail at boot)"
                    FAIL=$((FAIL+1))
                fi
                if ! chroot "$1" dpkg -l rsetup-config-first-boot >/dev/null 2>&1; then
                    echo "  ✓ rsetup-config-first-boot not installed"
                else
                    echo "  ✗ rsetup-config-first-boot still installed (will override SSH on first boot)"
                    FAIL=$((FAIL+1))
                fi

                # rsetup.service (separate from the purged package) must be masked.
                # Without this, first-boot reads /config/before.txt off the
                # auto-mounted /config partition and calls `disable_service ssh`,
                # leaving the board unreachable.
                if [ -L "$1/etc/systemd/system/rsetup.service" ] && \
                   [ "$(readlink "$1/etc/systemd/system/rsetup.service")" = "/dev/null" ]; then
                    echo "  ✓ rsetup.service masked → /dev/null"
                else
                    echo "  ✗ rsetup.service NOT masked (will disable SSH on first boot)"
                    FAIL=$((FAIL+1))
                fi
                if [ -L "$1/etc/systemd/system/config.automount" ] && \
                   [ "$(readlink "$1/etc/systemd/system/config.automount")" = "/dev/null" ]; then
                    echo "  ✓ config.automount masked → /dev/null"
                else
                    echo "  ✗ config.automount NOT masked (Radxa /config partition may still be pulled in)"
                    FAIL=$((FAIL+1))
                fi

                # NOPASSWD drop-in for trailcurrent — required by the first-login wizard
                if [ -f "$1/etc/sudoers.d/010_trailcurrent-nopasswd" ]; then
                    echo "  ✓ sudoers NOPASSWD drop-in for trailcurrent present"
                else
                    echo "  ✗ sudoers NOPASSWD drop-in missing (first-login wizard will hang)"
                    FAIL=$((FAIL+1))
                fi

                # Verify all expected device-tree overlays are staged AND
                # referenced by the systemd-boot loader entry (hook 19b).
                for OVR in \
                    "qcs6490-radxa-dragon-q6a-spi12-cs0-mcp2515-16mhz.dtbo" \
                    "qcs6490-radxa-dragon-q6a-headwaters-unused-pins-disable.dtbo"
                do
                    if ls "$1"/boot/efi/*/[0-9]*/dtbo/"$OVR" 1>/dev/null 2>&1; then
                        echo "  ✓ overlay staged: $OVR"
                    else
                        echo "  ✗ overlay NOT staged: $OVR"
                        FAIL=$((FAIL+1))
                    fi
                    if grep -r --include='*.conf' -l "devicetree-overlay .*$OVR" \
                       "$1/boot/efi/loader/entries/" >/dev/null 2>&1; then
                        echo "  ✓ loader entry references $OVR"
                    else
                        echo "  ✗ no loader entry references $OVR"
                        FAIL=$((FAIL+1))
                    fi
                done

                # Verify the patched embloader.efi is installed (hook 19d).
                # Without it, autoboot is interrupted by phantom UART input.
                STAGING="${HEADWATERS_STAGING:-/tmp/headwaters-staging}"
                EXPECTED_SHA=$(cut -d' ' -f1 "$STAGING/files/embloader/embloader.efi.sha256" 2>/dev/null || echo "")
                for dest in \
                    "$1/boot/efi/EFI/BOOT/BOOTAA64.EFI" \
                    "$1/boot/efi/EFI/systemd/systemd-bootaa64.efi"
                do
                    if [ ! -f "$dest" ]; then
                        echo "  ✗ embloader binary missing: ${dest#$1}"
                        FAIL=$((FAIL+1))
                        continue
                    fi
                    if [ -z "$EXPECTED_SHA" ]; then
                        echo "  ! cannot verify ${dest#$1}: build-side sha256 file missing"
                        continue
                    fi
                    GOT_SHA=$(sha256sum "$dest" | cut -d' ' -f1)
                    if [ "$GOT_SHA" = "$EXPECTED_SHA" ]; then
                        echo "  ✓ patched embloader installed: ${dest#$1}"
                    else
                        echo "  ✗ embloader sha256 mismatch at ${dest#$1}: got $GOT_SHA expected $EXPECTED_SHA"
                        FAIL=$((FAIL+1))
                    fi
                done

                for svc in ssh docker headwaters-firstboot headwaters-firstboot-network \
                           headwaters-load-images \
                           cpu-powersave power-save-hw can0 cantomqtt \
                           discovery-mdns deployment-watcher; do
                    if chroot "$1" systemctl is-enabled "$svc" >/dev/null 2>&1; then
                        echo "  ✓ $svc enabled"
                    else
                        echo "  ✗ NOT ENABLED: $svc"
                        FAIL=$((FAIL+1))
                    fi
                done
                if [ "$FAIL" -gt 0 ]; then
                    echo ""
                    echo "  ✗✗✗ Final checkpoint FAILED with $FAIL missing artifacts"
                    exit 1
                fi
                echo "  ✓ All artifacts present — image is ready"
            |||,
        ]
    },
    metadata: {
        architecture: architecture,
        mode: mode,
        rootfs: rootfs,
        variant: variant,

        temp_dir: temp_dir,
        output_dir: output_dir,
        rsdk_rev: rsdk_rev,

        distro_mirror: distro_mirror,

        radxa_mirror: radxa_mirror,
        radxa_repo_suffix: radxa_repo_suffix,

        product: product,
        suite: suite,
        edition: edition,
        build_date: build_date,

        vendor_packages: vendor_packages,
        linux_override: linux_override,
        firmware_override: firmware_override,
        install_vscodium: install_vscodium,
        use_pkgs_json: use_pkgs_json,
        sdboot: std.extVar("sdboot"),
    },
}
