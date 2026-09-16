#!/usr/bin/env bash
#
# astro installer for Linux & macOS
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.sh | bash
#

set -e

echo ""
echo "  ========================================"
echo "       astro - installing..."
echo "       autonomous ai coding assistant"
echo "  ========================================"
echo ""

TEMP_INSTALLER="/tmp/astro-cli-linux-x64.run"
DOWNLOAD_URL="https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-cli-linux-x64.run"
FALLBACK_URL="https://github.com/cyberuz001/astro-cli/releases/latest/download/astro-cli-linux-x64.run"

echo "  [1/3] downloading astro package..."

if curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_INSTALLER" 2>/dev/null; then
    echo "        download complete."
else
    echo "        retrying from latest release..."
    curl -fsSL "$FALLBACK_URL" -o "$TEMP_INSTALLER"
fi

chmod +x "$TEMP_INSTALLER"

echo "  [2/3] installing binaries and environment..."

"$TEMP_INSTALLER"

rm -f "$TEMP_INSTALLER"

echo "  [3/3] installation complete!"

echo ""
echo "  ========================================"
echo "       astro installed successfully!"
echo "  ========================================"
echo ""
echo "  Open a NEW terminal and type:"
echo "    astro"
echo ""
