#!/bin/bash
set -e

# Firmware Fetcher for TrailCurrent MCU Projects
# Downloads firmware binaries from public GitHub releases using curl
#
# Usage:
#   ./fetch-firmware.sh --version=v0.0.17 [--org=trailcurrentoss]
#
# The version must match a release tag in GitHub (e.g., v0.0.17)
#
# Requirements:
#   - curl

GITHUB_ORG="trailcurrentoss"
FIRMWARE_DIR="firmware/wired"

# Parse parameters
VERSION=""
for arg in "$@"; do
    if [[ $arg == --version=* ]]; then
        VERSION="${arg#--version=}"
    elif [[ $arg == --org=* ]]; then
        GITHUB_ORG="${arg#--org=}"
    fi
done

# Require version parameter
if [ -z "$VERSION" ]; then
    echo "ERROR: --version parameter is required"
    echo "Usage: ./fetch-firmware.sh --version=v0.0.17 [--org=trailcurrentoss]"
    exit 1
fi

# Ensure version starts with 'v'
if [[ ! $VERSION == v* ]]; then
    VERSION="v$VERSION"
fi

# Device mappings: REPO_NAME|DEVICE_TYPE|BINARY_NAME
# Binary names match the ESP-IDF project() name (or PlatformIO PROGNAME)
DEVICES=(
    "TrailCurrentBorealis|borealis|borealis.bin"
    "TrailCurrentPicket|picket|picket.bin"
    "TrailCurrentTapper|tapper|tapper.bin"
    "TrailCurrentTherma|therma_controller|therma_controller.bin"
    "TrailCurrentTherma|therma_heater_relay|therma_heater_relay.bin"
    "TrailCurrentTherma|therma_cooler_relay|therma_cooler_relay.bin"
    "TrailCurrentBearing|bearing|bearing.bin"
    "TrailCurrentSolstice|solstice|solstice.bin"
    "TrailCurrentTorrent|torrent|torrent.bin"
    "TrailCurrentAftline|aftline|aftline.bin"
    "TrailCurrentAmpline|ampline|ampline.bin"
    "TrailCurrentPlateau|plateau|plateau.bin"
    "TrailCurrentMilepost|milepost|milepost.bin"
    "TrailCurrentReservoir|reservoir|reservoir.bin"
    "TrailCurrentSwitchback|switchback|switchback.bin"
)

# Multi-address modules: TYPE|MAX_ADDRESS
# These download {type}_addr0.bin .. {type}_addr{max}.bin instead of a single binary
MULTI_ADDR=(
    "torrent|2"
    "picket|7"
    "switchback|2"
)

# Multi-target-address modules: TYPE|TARGET1,TARGET2,...|MAX_ADDRESS
# These download {type}_{target}_addr0.bin .. {type}_{target}_addr{max}.bin
# for each target device (e.g. tapper_torrent_addr0.bin, tapper_switchback_addr1.bin)
MULTI_TARGET_ADDR=(
    "tapper|torrent,switchback|2"
)

echo "=========================================="
echo "Fetching MCU Firmware from GitHub"
echo "=========================================="
echo "Organization: $GITHUB_ORG"
echo "Target version: $VERSION"
echo ""

# Create firmware directory if it doesn't exist
mkdir -p "$FIRMWARE_DIR"

# Track what we found
FETCHED=0
SKIPPED=0
FAILED=0

for device_info in "${DEVICES[@]}"; do
    IFS='|' read -r repo_name device_type binary_name <<< "$device_info"

    device_dir="$FIRMWARE_DIR/$device_type"

    # Check if this is a multi-target-address module (e.g. Tapper)
    mta_targets=""
    mta_max=""
    for mta in "${MULTI_TARGET_ADDR[@]}"; do
        IFS='|' read -r mta_type mta_tgts mta_mx <<< "$mta"
        if [ "$device_type" = "$mta_type" ]; then
            mta_targets=$mta_tgts
            mta_max=$mta_mx
            break
        fi
    done

    # Check if this is a multi-address module
    max_addr=""
    for ma in "${MULTI_ADDR[@]}"; do
        IFS='|' read -r ma_type ma_max <<< "$ma"
        if [ "$device_type" = "$ma_type" ]; then
            max_addr=$ma_max
            break
        fi
    done

    mkdir -p "$device_dir"

    if [ -n "$mta_targets" ]; then
        # Multi-target-address: download {type}_{target}_addr{N}.bin for each target+address
        echo "Checking $repo_name ($VERSION) [targets: $mta_targets, addresses 0-$mta_max]..."
        mta_fetched=0
        IFS=',' read -ra targets_arr <<< "$mta_targets"
        for target in "${targets_arr[@]}"; do
            for addr in $(seq 0 "$mta_max"); do
                variant_binary="${device_type}_${target}_addr${addr}.bin"
                download_url="https://github.com/$GITHUB_ORG/$repo_name/releases/download/$VERSION/$variant_binary"
                temp_file=$(mktemp)

                if curl -s -L -f --connect-timeout 15 --max-time 60 --retry 2 --retry-delay 3 --retry-connrefused -o "$temp_file" "$download_url" 2>/dev/null; then
                    mv "$temp_file" "$device_dir/$variant_binary"
                    file_size=$(du -h "$device_dir/$variant_binary" | cut -f1)
                    echo "  ${target} addr $addr: Downloaded ($file_size)"
                    FETCHED=$((FETCHED + 1))
                    mta_fetched=$((mta_fetched + 1))
                else
                    rm -f "$temp_file"
                    echo "  ${target} addr $addr: Not found (skipping)"
                    SKIPPED=$((SKIPPED + 1))
                fi
            done
        done
        if [ $mta_fetched -eq 0 ]; then
            rmdir "$device_dir" 2>/dev/null || true
        fi
    elif [ -n "$max_addr" ]; then
        # Multi-address: download {type}_addr0.bin .. {type}_addr{max}.bin
        echo "Checking $repo_name ($VERSION) [addresses 0-$max_addr]..."
        addr_fetched=0
        for addr in $(seq 0 "$max_addr"); do
            addr_binary="${device_type}_addr${addr}.bin"
            download_url="https://github.com/$GITHUB_ORG/$repo_name/releases/download/$VERSION/$addr_binary"
            temp_file=$(mktemp)

            if curl -s -L -f --connect-timeout 15 --max-time 60 --retry 2 --retry-delay 3 --retry-connrefused -o "$temp_file" "$download_url" 2>/dev/null; then
                mv "$temp_file" "$device_dir/$addr_binary"
                file_size=$(du -h "$device_dir/$addr_binary" | cut -f1)
                echo "  addr $addr: Downloaded ($file_size)"
                FETCHED=$((FETCHED + 1))
                addr_fetched=$((addr_fetched + 1))
            else
                rm -f "$temp_file"
                echo "  addr $addr: Not found (skipping)"
                SKIPPED=$((SKIPPED + 1))
            fi
        done
        if [ $addr_fetched -eq 0 ]; then
            rmdir "$device_dir" 2>/dev/null || true
        fi
    else
        # Single binary (unchanged)
        echo -n "Checking $repo_name ($VERSION)... "
        temp_file=$(mktemp)
        download_url="https://github.com/$GITHUB_ORG/$repo_name/releases/download/$VERSION/$binary_name"

        if curl -s -L -f --connect-timeout 15 --max-time 60 --retry 2 --retry-delay 3 --retry-connrefused -o "$temp_file" "$download_url" 2>/dev/null; then
            mv "$temp_file" "$device_dir/$binary_name"
            file_size=$(du -h "$device_dir/$binary_name" | cut -f1)
            echo "Downloaded ($file_size)"
            FETCHED=$((FETCHED + 1))
        else
            rm -f "$temp_file"
            rmdir "$device_dir" 2>/dev/null || true
            echo "Not found (skipping)"
            SKIPPED=$((SKIPPED + 1))
        fi
    fi
done

echo ""
echo "=========================================="
echo "Firmware Fetch Summary"
echo "=========================================="
echo "Version:    $VERSION"
echo "Downloaded: $FETCHED device(s)"
echo "Skipped:    $SKIPPED device(s) (no release at this version)"
echo "Failed:     $FAILED device(s)"
echo ""

if [ $FETCHED -gt 0 ]; then
    echo "Firmware structure:"
    find "$FIRMWARE_DIR" -type f 2>/dev/null | sort | sed 's/^/  /'
    echo ""
fi

if [ $FETCHED -eq 0 ]; then
    # Clean up empty firmware directory so it doesn't get packaged
    rm -rf "$FIRMWARE_DIR"
    rmdir firmware 2>/dev/null || true
    if [ $SKIPPED -eq ${#DEVICES[@]} ]; then
        echo "No firmware found for version $VERSION. This is normal if MCU repos"
        echo "haven't published a release at this version yet."
        echo ""
    fi
fi
