#!/usr/bin/env bash
# One-shot system dependency installer for the maps build pipeline.
#
# Detects the host platform (Ubuntu/Debian apt, Fedora dnf, macOS brew) and
# installs the small things automatically: python3, PyYAML, curl, tar, zip,
# unzip, jsonschema. Prints clear manual-install instructions for anything
# it cannot install (mainly Docker — Docker Desktop on macOS is a GUI
# install, and adding a user to the docker group on Linux needs a re-login).
#
# Idempotent: safe to re-run. Anything already installed is skipped.
#
# Cross-platform: Linux (apt-based / dnf-based) and macOS. Windows contributors:
# use WSL2 with an Ubuntu distro and run this from inside WSL.
#
# Usage:
#   ./bootstrap.sh              install what's missing
#   ./bootstrap.sh --check      report what's missing, install nothing
#   ./bootstrap.sh --help
#
# Next step after this succeeds: ./build.sh --region <name>

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

CHECK_ONLY=0
case "${1:-}" in
    --check) CHECK_ONLY=1 ;;
    -h|--help)
        sed -n 's/^# \{0,1\}//p' "$0" | sed '/^!\/usr\/bin\/env/d; /^$/q'
        exit 0
        ;;
    "") ;;
    *)
        printf 'unknown argument: %s\n\n' "$1" >&2
        printf 'Usage:\n' >&2
        printf '  ./bootstrap.sh              install what is missing\n' >&2
        printf '  ./bootstrap.sh --check      report what is missing, install nothing\n' >&2
        printf '  ./bootstrap.sh --help       show this help\n' >&2
        exit 2
        ;;
esac

# -----------------------------------------------------------------------------
# Terminal styling (best effort — plain text if not a TTY)
# -----------------------------------------------------------------------------
if [ -t 1 ]; then
    G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'
else
    G=""; Y=""; R=""; B=""; N=""
fi

section() { printf '\n%s== %s ==%s\n' "$B" "$*" "$N"; }
ok()      { printf '  %sOK%s   %s\n' "$G" "$N" "$*"; }
warn()    { printf '  %sWARN%s %s\n' "$Y" "$N" "$*"; }
miss()    { printf '  %sMISS%s %s\n' "$R" "$N" "$*"; }
info()    { printf '  %s\n' "$*"; }

# -----------------------------------------------------------------------------
# Platform detection
# -----------------------------------------------------------------------------
OS="unknown"
PKG=""
INSTALL_CMD=""

if [ "$(uname -s)" = "Darwin" ]; then
    OS="macos"
    if command -v brew >/dev/null 2>&1; then
        PKG="brew"
        INSTALL_CMD="brew install"
    fi
elif [ "$(uname -s)" = "Linux" ]; then
    OS="linux"
    if command -v apt-get >/dev/null 2>&1; then
        PKG="apt"
        INSTALL_CMD="sudo apt-get install -y"
    elif command -v dnf >/dev/null 2>&1; then
        PKG="dnf"
        INSTALL_CMD="sudo dnf install -y"
    elif command -v pacman >/dev/null 2>&1; then
        PKG="pacman"
        INSTALL_CMD="sudo pacman -S --noconfirm"
    fi
fi

section "Platform detection"
info "OS:              $OS"
info "package manager: ${PKG:-<none detected>}"
if [ "$OS" = "unknown" ]; then
    miss "unsupported platform (need Linux or macOS)"
    exit 1
fi
if [ -z "$PKG" ]; then
    if [ "$OS" = "macos" ]; then
        miss "Homebrew not installed"
        info "  Install it from https://brew.sh then re-run this script."
    else
        miss "no supported package manager found (need apt-get, dnf, or pacman)"
        info "  You'll have to install dependencies manually — see README.md Prerequisites."
    fi
    exit 1
fi

# -----------------------------------------------------------------------------
# Package name maps (varies by distro)
# -----------------------------------------------------------------------------
# Each row: <check-tool>  <apt pkg>  <dnf pkg>  <brew pkg>  <human name>
# Delimiter is |. We install by looking up the right column.
DEPS='
python3   |python3          |python3          |python@3         |Python 3
python3-yaml|python3-yaml   |python3-pyyaml  |__pip__pyyaml    |PyYAML (Python)
python3-jsonschema|python3-jsonschema|python3-jsonschema|__pip__jsonschema|jsonschema (Python)
curl      |curl             |curl             |curl             |curl
tar       |tar              |tar              |gnu-tar          |tar
zip       |zip              |zip              |zip              |zip
unzip     |unzip            |unzip            |unzip            |unzip
'

col_for_pkg() {
    case "$PKG" in
        apt)    echo 2 ;;
        dnf)    echo 3 ;;
        pacman) echo 3 ;;  # pacman names are close-enough to dnf's for these deps
        brew)   echo 4 ;;
    esac
}
COL=$(col_for_pkg)

is_installed() {
    key="$1"
    case "$key" in
        python3)             command -v python3 >/dev/null 2>&1 ;;
        python3-yaml)        python3 -c 'import yaml' 2>/dev/null ;;
        python3-jsonschema)  python3 -c 'import jsonschema' 2>/dev/null ;;
        curl|tar|zip|unzip)  command -v "$key" >/dev/null 2>&1 ;;
    esac
}

install_pkg() {
    key="$1"
    pkg_name=$(printf '%s\n' "$DEPS" \
               | awk -F'|' -v k="$key" -v c="$COL" '
                     $1 == k { gsub(/^ +| +$/, "", $c); print $c }')
    if [ -z "$pkg_name" ]; then
        miss "no package name mapped for $key on $PKG"
        return 1
    fi
    # Pip-fallback marker for PyYAML / jsonschema on brew (brew has no
    # first-class package for these).
    case "$pkg_name" in
        __pip__*)
            pip_pkg="${pkg_name#__pip__}"
            info "installing $pip_pkg via pip3"
            if pip3 install --user --break-system-packages "$pip_pkg" 2>/dev/null \
            || pip3 install --user "$pip_pkg"; then
                return 0
            fi
            return 1
            ;;
        *)
            info "installing $pkg_name via $PKG"
            # shellcheck disable=SC2086
            $INSTALL_CMD "$pkg_name"
            ;;
    esac
}

# -----------------------------------------------------------------------------
# Small deps loop
# -----------------------------------------------------------------------------
section "Small dependencies"

any_installed=0
any_missing=0

for key in python3 python3-yaml python3-jsonschema curl tar zip unzip; do
    if is_installed "$key"; then
        ok "$key already present"
    else
        miss "$key missing"
        if [ "$CHECK_ONLY" -eq 1 ]; then
            any_missing=1
            continue
        fi
        if install_pkg "$key" && is_installed "$key"; then
            ok "$key installed"
            any_installed=1
        else
            miss "failed to install $key"
            pkg_name=$(printf '%s\n' "$DEPS" \
                       | awk -F'|' -v k="$key" -v c="$COL" '
                             $1 == k { gsub(/^ +| +$/, "", $c); print $c }')
            case "$pkg_name" in
                __pip__*)
                    info "  Manual install: pip3 install --user ${pkg_name#__pip__}"
                    ;;
                *)
                    info "  Manual install: $INSTALL_CMD $pkg_name"
                    ;;
            esac
            info "  Then re-run: ./bootstrap.sh"
            any_missing=1
        fi
    fi
done

# -----------------------------------------------------------------------------
# Docker (manual — too many caveats to script safely)
# -----------------------------------------------------------------------------
section "Docker"

docker_present=0
if command -v docker >/dev/null 2>&1; then
    docker_present=1
    ok "docker CLI on PATH"
    if docker info >/dev/null 2>&1; then
        ok "docker daemon reachable"
    else
        warn "docker daemon not reachable"
        if [ "$OS" = "macos" ]; then
            info "  Start Docker Desktop from Launchpad and wait for the whale icon."
        else
            info "  Try: sudo systemctl start docker"
            info "  Or restart your session if you were just added to the docker group."
        fi
    fi
    if docker compose version >/dev/null 2>&1; then
        ok "docker compose v2 plugin present"
    elif command -v docker-compose >/dev/null 2>&1; then
        ok "docker-compose v1 binary present"
    else
        miss "no docker compose v2 plugin or docker-compose v1 binary"
        info "  On Docker Desktop this comes bundled. On Linux server installs:"
        info "  apt:  sudo apt-get install docker-compose-plugin"
        info "  dnf:  sudo dnf install docker-compose-plugin"
    fi
else
    miss "docker not installed"
    if [ "$OS" = "macos" ]; then
        info "  Install Docker Desktop for Mac: https://www.docker.com/products/docker-desktop/"
        info "  Apple Silicon and Intel builds are both available."
    else
        info "  Recommended: install Docker Engine + Compose plugin per your distro."
        info "  Ubuntu/Debian: https://docs.docker.com/engine/install/ubuntu/"
        info "  Fedora:        https://docs.docker.com/engine/install/fedora/"
        info "  After install:"
        info "    sudo usermod -aG docker \$USER"
        info "    Log out and back in so the group takes effect."
    fi
    any_missing=1
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
section "Summary"

if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ "$any_missing" -eq 1 ]; then
        info "Missing dependencies detected — re-run without --check to install."
        exit 1
    fi
    ok "all dependencies present"
    exit 0
fi

if [ "$any_missing" -eq 1 ] || [ "$docker_present" -eq 0 ]; then
    miss "some dependencies could not be installed automatically"
    info "Fix the items marked MISS above, then re-run this script."
    exit 1
fi

if [ "$any_installed" -eq 1 ]; then
    ok "installed missing dependencies"
else
    ok "nothing to install — system was already set up"
fi

info ""
info "Next: ./build.sh --region <name>"
info "      (build.sh runs its own environment checks first; use --list-regions to see options)"
