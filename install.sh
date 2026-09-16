#!/usr/bin/env bash
#
# astro installer for Linux & macOS
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.sh | bash
#

set -e

VORTEX='\033[38;2;255;74;28m'
AMBER='\033[38;2;255;174;25m'
MUTED='\033[38;2;142;124;119m'
DIM='\033[38;2;75;60;55m'
WHITE='\033[38;2;247;235;232m'
RESET='\033[0m'

echo ""
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo -e "  ${VORTEX}* astro${RESET} ${DIM}//${RESET} ${AMBER}autonomous ai engine${RESET}"
echo -e "  ${MUTED}https://astro-cli.vercel.app${RESET}"
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo ""

INSTALL_DIR="$HOME/.astro/bin"
mkdir -p "$INSTALL_DIR"

TARGET_BIN="$INSTALL_DIR/astro"
DOWNLOAD_URL="https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-1.0.6-linux-x86_64"
FALLBACK_URL="https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-cli-linux-x64.run"

echo -e "  ${AMBER}>${RESET} ${WHITE}[1/3] downloading astro binary...${RESET}"

if curl -fL --progress-bar "$DOWNLOAD_URL" -o "$TARGET_BIN"; then
    echo -e "        ${MUTED}download complete.${RESET}"
else
    echo -e "        ${AMBER}retrying fallback binary...${RESET}"
    curl -fL --progress-bar "$FALLBACK_URL" -o "$TARGET_BIN"
fi

chmod +x "$TARGET_BIN"

echo -e "  ${AMBER}>${RESET} ${WHITE}[2/3] configuring environment path...${RESET}"

# Configure PATH in shell configs
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [ -f "$rc" ]; then
        if ! grep -q "$INSTALL_DIR" "$rc"; then
            echo "export PATH=\"\$PATH:$INSTALL_DIR\"" >> "$rc"
        fi
    fi
done

# Try system-wide symlink if permissions allow
if [ -w "/usr/local/bin" ]; then
    ln -sf "$TARGET_BIN" /usr/local/bin/astro 2>/dev/null || true
elif command -v sudo >/dev/null 2>&1; then
    sudo ln -sf "$TARGET_BIN" /usr/local/bin/astro 2>/dev/null || true
fi

echo -e "  ${AMBER}>${RESET} ${WHITE}[3/3] installation complete!${RESET}"

echo ""
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo -e "  ${VORTEX}* astro installed successfully!${RESET}"
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo ""
echo -e "  ${MUTED}Open a NEW terminal (or run: source ~/.bashrc) and type:${RESET}"
echo -e "    ${AMBER}astro${RESET}"
echo ""
