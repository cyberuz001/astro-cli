#!/usr/bin/env bash
#
# astro installer for Linux
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.sh | bash
#

set -euo pipefail

VORTEX='\033[38;2;255;74;28m'
AMBER='\033[38;2;255;174;25m'
MUTED='\033[38;2;142;124;119m'
DIM='\033[38;2;75;60;55m'
WHITE='\033[38;2;247;235;232m'
RESET='\033[0m'

# The astro binary itself is unchanged by this release; every fix here lives
# in install.sh, install.ps1 and cli/astro-proxy.mjs, all of which are fetched
# from the main branch at install time. So this still points at the existing
# v1.0.6 asset - pinning a tag that does not exist would make every install
# pay a failed request before falling back.
VERSION="1.0.6"
REPO="cyberuz001/astro-cli"

echo ""
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo -e "  ${VORTEX}* astro${RESET} ${DIM}//${RESET} ${AMBER}autonomous ai engine${RESET}"
echo -e "  ${MUTED}https://www.astroai.uz${RESET}"
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo ""

fail() {
    echo ""
    echo -e "  ${VORTEX}install failed:${RESET} ${WHITE}$1${RESET}"
    shift
    for line in "$@"; do echo -e "  ${MUTED}${line}${RESET}"; done
    echo ""
    exit 1
}

ASTRO_DIR="$HOME/.astro"
INSTALL_DIR="$ASTRO_DIR/bin"
mkdir -p "$INSTALL_DIR"

# Clean stale locks left by a crashed proxy.
#
# auth.json.lock is excluded on purpose. It backs the CLI's own file lock, and
# the CLI re-validates it by inode before persisting a refreshed token: if the
# file has been unlinked it concludes it lost the lock and abandons the write.
# The refreshed token never lands, and the next launch asks for a new login.
# The old blanket `rm -f "$ASTRO_DIR"/*.lock` was a direct cause of that loop.
find "$ASTRO_DIR" -maxdepth 1 -name '*.lock' ! -name 'auth.json.lock' -delete 2>/dev/null || true

CORE_BIN="$INSTALL_DIR/astro-core"
WRAPPER_BIN="$INSTALL_DIR/astro"
PROXY_SCRIPT="$INSTALL_DIR/astro-proxy.mjs"
CONFIG_FILE="$ASTRO_DIR/config.toml"

echo -e "  ${AMBER}>${RESET} ${WHITE}[1/5] checking system...${RESET}"

# Architecture. Only x86_64 is published; downloading it on arm64 used to
# "succeed" and then fail with a bare "Exec format error".
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64 | amd64) ;;
    aarch64 | arm64) fail "no $ARCH build is published yet (x86_64 only)." \
                          "Track it at https://github.com/$REPO/issues" ;;
    *) fail "unsupported architecture: $ARCH (x86_64 required)." ;;
esac

OS="$(uname -s)"
[ "$OS" = "Linux" ] || fail "this installer is for Linux; detected $OS." \
                            "macOS builds are not published yet."

# glibc. The binary is dynamically linked, so an older host than the build
# machine fails at exec with "GLIBC_2.xx not found" - a confusing error to hit
# after a 140 MB download. musl (Alpine) has no glibc at all.
if command -v ldd >/dev/null 2>&1; then
    GLIBC_VER="$(ldd --version 2>&1 | head -n1 | grep -oE '[0-9]+\.[0-9]+$' || true)"
    if [ -z "$GLIBC_VER" ]; then
        if ldd --version 2>&1 | grep -qi musl; then
            fail "musl libc detected (Alpine?); astro needs glibc >= 2.31." \
                 "Use a glibc distro, or install the 'gcompat' package."
        fi
    else
        G_MAJ="${GLIBC_VER%%.*}"; G_MIN="${GLIBC_VER##*.}"
        if [ "$G_MAJ" -lt 2 ] || { [ "$G_MAJ" -eq 2 ] && [ "$G_MIN" -lt 31 ]; }; then
            fail "glibc $GLIBC_VER is too old; astro needs >= 2.31." \
                 "Upgrade your distribution (Ubuntu 20.04+, Debian 11+, RHEL 9+)."
        fi
        echo -e "        ${MUTED}glibc $GLIBC_VER${RESET}"
    fi
fi

# Minimal images ship only one of curl / wget.
if command -v curl >/dev/null 2>&1; then
    DL=curl
elif command -v wget >/dev/null 2>&1; then
    DL=wget
else
    fail "neither curl nor wget is installed." \
         "Debian/Ubuntu: sudo apt-get install -y curl" \
         "Fedora/RHEL:   sudo dnf install -y curl"
fi

# The proxy needs a JavaScript runtime. Checked up front: the old launcher
# silently did nothing when node was absent, so the CLI started against a
# dead port and looked like it had hung after login.
if ! command -v node >/dev/null 2>&1; then
    fail "Node.js is required for the astro proxy but was not found." \
         "Install Node.js 18 or newer, then re-run this installer:" \
         "  Debian/Ubuntu: sudo apt-get install -y nodejs" \
         "  Or use nvm:    https://github.com/nvm-sh/nvm"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js 18 or newer is required (found $(node -v 2>/dev/null))." \
         "Upgrade Node.js and re-run this installer."
fi
echo -e "        ${MUTED}node $(node -v)${RESET}"

fetch() {  # fetch <url> <out>
    if [ "$DL" = curl ]; then
        curl -fL --retry 2 --connect-timeout 20 --progress-bar "$1" -o "$2"
    else
        wget -q --show-progress --tries=3 --timeout=20 -O "$2" "$1"
    fi
}

DOWNLOAD_URL="https://github.com/$REPO/releases/download/v$VERSION/astro-$VERSION-linux-x86_64"
FALLBACK_URL="https://github.com/$REPO/releases/latest/download/astro-$VERSION-linux-x86_64"
PROXY_URL="https://raw.githubusercontent.com/$REPO/main/cli/astro-proxy.mjs"
PROXY_MIRROR="https://www.astroai.uz/cli/astro-proxy.mjs"

echo -e "  ${AMBER}>${RESET} ${WHITE}[2/5] downloading astro binary...${RESET}"

if fetch "$DOWNLOAD_URL" "$CORE_BIN"; then
    echo -e "        ${MUTED}download complete.${RESET}"
else
    echo -e "        ${AMBER}v$VERSION unavailable, falling back...${RESET}"
    # Deliberately another raw binary, never the .run self-extractor: the old
    # fallback saved the *installer* as astro-core and chmod +x'd it, so
    # running `astro` re-ran the installer instead of starting the CLI.
    fetch "$FALLBACK_URL" "$CORE_BIN" || fail "could not download the astro binary." \
        "Check your connection, or download manually:" "  $FALLBACK_URL"
fi

# Verify before trusting it as an executable. A truncated download or an HTML
# error page otherwise installs "successfully" and fails much later.
SIZE="$(wc -c < "$CORE_BIN" | tr -d ' ')"
[ "$SIZE" -ge 20000000 ] || fail "downloaded binary is only $((SIZE / 1024 / 1024)) MB; expected 100 MB+." \
    "The release asset may be missing, or the download was truncated."
if [ "$(head -c 4 "$CORE_BIN" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
    fail "the downloaded file is not a Linux executable (no ELF header)." \
         "A proxy or captive portal may have replaced the download."
fi
chmod +x "$CORE_BIN"

echo -e "  ${AMBER}>${RESET} ${WHITE}[3/5] downloading background proxy engine...${RESET}"
# Failure here used to be swallowed with `|| true`, leaving an install with no
# proxy at all - which presents as "it logs in and then never answers".
fetch "$PROXY_URL" "$PROXY_SCRIPT" >/dev/null 2>&1 \
  || fetch "$PROXY_MIRROR" "$PROXY_SCRIPT" >/dev/null 2>&1 \
  || fail "could not download astro-proxy.mjs." "Tried:" "  $PROXY_URL" "  $PROXY_MIRROR"

PSIZE="$(wc -c < "$PROXY_SCRIPT" | tr -d ' ')"
[ "$PSIZE" -ge 10240 ] || fail "astro-proxy.mjs is only $PSIZE bytes; it is truncated."
grep -q 'astro-proxy' "$PROXY_SCRIPT" || fail "astro-proxy.mjs does not look like the proxy." \
    "A proxy or captive portal may have replaced the download."
node --check "$PROXY_SCRIPT" 2>/dev/null || fail "astro-proxy.mjs failed a syntax check." \
    "The download is corrupt; please retry."
echo -e "        ${MUTED}proxy verified.${RESET}"

echo -e "  ${AMBER}>${RESET} ${WHITE}[4/5] generating launcher & configuration...${RESET}"

cat << 'EOF' > "$WRAPPER_BIN"
#!/usr/bin/env bash
# astro CLI launcher
ASTRO_DIR="${GROK_HOME:-$HOME/.astro}"
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${ASTRO_PROXY_PORT:-5544}"
LOG="$ASTRO_DIR/proxy.log"

# Readiness, not just "is the port bound".
#
# The old check was `! command -v nc || ! nc -z 127.0.0.1 5544`, which is true
# whenever nc is absent - so it restarted the proxy on every run - and a bare
# port probe cannot tell our proxy from an unrelated process holding 5544.
# /health confirms both that it is ours and that it can serve.
proxy_ready() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 2 -O /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && exec 3>&- 2>/dev/null
  fi
}

if ! proxy_ready; then
  if ! command -v node >/dev/null 2>&1; then
    echo "[astro] Node.js 18+ is required for the proxy but was not found." >&2
    exit 1
  fi
  if [ ! -f "$BIN_DIR/astro-proxy.mjs" ]; then
    echo "[astro] $BIN_DIR/astro-proxy.mjs is missing - reinstall astro." >&2
    exit 1
  fi
  mkdir -p "$ASTRO_DIR"
  # setsid/nohup so the proxy outlives the terminal; a plain background job
  # was killed by SIGHUP when the window closed.
  if command -v setsid >/dev/null 2>&1; then
    setsid node "$BIN_DIR/astro-proxy.mjs" >"$LOG" 2>&1 < /dev/null &
  else
    nohup node "$BIN_DIR/astro-proxy.mjs" >"$LOG" 2>&1 < /dev/null &
  fi
  disown 2>/dev/null || true

  # Poll instead of `sleep 2`: too short on slow or loaded machines, and the
  # CLI then started against a port nothing was listening on yet.
  ready=0
  for _ in $(seq 1 60); do
    if proxy_ready; then ready=1; break; fi
    sleep 0.5
  done
  if [ "$ready" -ne 1 ]; then
    echo "[astro] Proxy did not become ready within 30s." >&2
    echo "[astro] Log: $LOG" >&2
    [ -f "$LOG" ] && tail -n 15 "$LOG" >&2
    exit 1
  fi
fi

exec "$BIN_DIR/astro-core" "$@"
EOF

chmod +x "$WRAPPER_BIN"

# Create config.toml if missing
if [ ! -f "$CONFIG_FILE" ]; then
    cat << 'EOF' > "$CONFIG_FILE"
[marketplace]
default_skills_installs_purged = true

[cli]
installer = "internal"
auto_update = false

[ui]
max_thoughts_width = 120
fork_secondary_model = "nebula"
yolo = false
compact_mode = false
vim_mode = false
permission_mode = "always-approve"
theme = "oscura-midnight"

[models]
default = "vortex"
# Available models are discovered from the local proxy at runtime.

[endpoints]
# 127.0.0.1, not localhost: on most current systems `localhost` resolves to
# ::1 first, and a proxy bound only to the IPv4 loopback is then unreachable.
# That presented as a CLI which authenticated fine and then never answered.
cli_chat_proxy_base_url = "http://127.0.0.1:5544/v1"
xai_api_base_url = "http://127.0.0.1:5544/v1"
EOF
fi

echo -e "  ${AMBER}>${RESET} ${WHITE}[5/5] configuring environment path...${RESET}"

PATH_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""

# Prepended, not appended: an older astro elsewhere on PATH would otherwise
# keep winning after an upgrade.
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [ -f "$rc" ] && ! grep -q '\.astro/bin' "$rc" 2>/dev/null; then
        printf '\n# astro CLI\n%s\n' "$PATH_LINE" >> "$rc"
        echo -e "        ${MUTED}updated $(basename "$rc")${RESET}"
    fi
done

# A bare account may have none of those files yet, which left astro off PATH
# entirely - the usual cause of "astro: command not found" after a clean run.
if ! grep -qs '\.astro/bin' "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" 2>/dev/null; then
    printf '\n# astro CLI\n%s\n' "$PATH_LINE" >> "$HOME/.profile"
    echo -e "        ${MUTED}created .profile entry${RESET}"
fi

# No sudo symlink into /usr/local/bin.
#
# This script is normally run as `curl ... | bash`, where stdin is the script
# itself. A sudo password prompt there cannot be answered: it either hangs or
# silently eats the remaining script. ~/.astro/bin on PATH needs no elevation.
if [ -w "/usr/local/bin" ]; then
    ln -sf "$WRAPPER_BIN" /usr/local/bin/astro 2>/dev/null || true
fi

# Final check. "installed successfully" used to print unconditionally, so a
# missing component only surfaced later when astro did nothing.
MISSING=""
for f in astro astro-core astro-proxy.mjs; do
    [ -e "$INSTALL_DIR/$f" ] || MISSING="$MISSING $f"
done
[ -z "$MISSING" ] || fail "installation incomplete; missing from $INSTALL_DIR:$MISSING"
[ -x "$WRAPPER_BIN" ] || fail "$WRAPPER_BIN is not executable."
[ -x "$CORE_BIN" ] || fail "$CORE_BIN is not executable."

echo ""
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo -e "  ${VORTEX}* astro installed successfully!${RESET}"
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo ""
echo -e "  ${MUTED}Open a NEW terminal (or run: source ~/.bashrc) and type:${RESET}"
echo -e "    ${AMBER}astro${RESET}"
echo ""
echo -e "  ${MUTED}Or use it right now:${RESET}"
echo -e "    ${AMBER}export PATH=\"\$HOME/.astro/bin:\$PATH\"${RESET}"
echo ""
echo -e "  ${MUTED}Documentation & Models:${RESET} ${VORTEX}https://www.astroai.uz${RESET}"
echo ""
