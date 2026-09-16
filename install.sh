#!/usr/bin/env bash
#
# Astro CLI installer for Linux & macOS
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.sh | bash
#

set -e

VERSION="${1:-1.0.6}"
REPO="${ASTRO_RELEASE_REPO:-cyberuz001/astro-cli}"

echo ""
echo "  ========================================"
echo "       Astro CLI - Installing..."
echo "       Agentic AI Coding Assistant"
echo "  ========================================"
echo ""

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64|amd64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
    linux*) OS="linux" ;;
    darwin*) OS="macos" ;;
    *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

PLATFORM="${OS}-${ARCH}"
BINARY_NAME="astro-${VERSION}-${PLATFORM}"
ASTRO_DIR="$HOME/.astro"
BIN_DIR="$ASTRO_DIR/bin"

mkdir -p "$BIN_DIR"

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${BINARY_NAME}"
FALLBACK_URL="https://github.com/${REPO}/releases/latest/download/${BINARY_NAME}"

echo "  [1/3] Downloading Astro CLI v${VERSION} (${PLATFORM})..."

if curl -fsSL "$DOWNLOAD_URL" -o "$BIN_DIR/astro" 2>/dev/null; then
    echo "        Download complete."
else
    echo "        Retrying from latest release..."
    curl -fsSL "$FALLBACK_URL" -o "$BIN_DIR/astro"
fi

chmod +x "$BIN_DIR/astro"

echo "  [2/3] Configuring environment (PATH)..."

SHELL_RC=""
if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
    if ! grep -q '\.astro/bin' "$SHELL_RC" 2>/dev/null; then
        echo 'export PATH="$HOME/.astro/bin:$PATH"' >> "$SHELL_RC"
        echo "        Added to $SHELL_RC"
    fi
fi

echo "  [3/3] Setting up configuration..."

CONF_FILE="$ASTRO_DIR/config.toml"
if [ ! -f "$CONF_FILE" ]; then
    cat << 'EOF' > "$CONF_FILE"
[cli]
installer = "gh-release"
auto_update = true

[ui]
permission_mode = "always-approve"
theme = "auto"

[models]
default = "photon-3.7"

[endpoints]
cli_chat_proxy_base_url = "http://localhost:5544/v1"
EOF
fi

echo ""
echo "  ========================================"
echo "       Astro CLI installed successfully!"
echo "  ========================================"
echo ""
echo "  Open a NEW terminal and type:"
echo "    astro"
echo ""
