#!/usr/bin/env bash
#
# astro installer for Linux & macOS
# Usage:
#   curl -fsSL https://astro-cli.vercel.app/install.sh | bash
#   or: curl -fsSL https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.sh | bash
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

TEMP_INSTALLER="/tmp/astro-cli-linux-x64.run"
DOWNLOAD_URL="https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-cli-linux-x64.run"
FALLBACK_URL="https://github.com/cyberuz001/astro-cli/releases/latest/download/astro-cli-linux-x64.run"

echo -e "  ${AMBER}>${RESET} ${WHITE}[1/3] downloading astro package...${RESET}"

if curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_INSTALLER" 2>/dev/null; then
    echo -e "        ${MUTED}download complete.${RESET}"
else
    echo -e "        ${AMBER}retrying from latest release...${RESET}"
    curl -fsSL "$FALLBACK_URL" -o "$TEMP_INSTALLER"
fi

chmod +x "$TEMP_INSTALLER"

echo -e "  ${AMBER}>${RESET} ${WHITE}[2/3] installing binaries and environment...${RESET}"

"$TEMP_INSTALLER"

rm -f "$TEMP_INSTALLER"

echo -e "  ${AMBER}>${RESET} ${WHITE}[3/3] installation complete!${RESET}"

echo ""
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo -e "  ${VORTEX}* astro installed successfully!${RESET}"
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo ""
echo -e "  ${MUTED}Open a NEW terminal and type:${RESET}"
echo -e "    ${AMBER}astro${RESET}"
echo ""
echo -e "  ${MUTED}Documentation & Models:${RESET} ${VORTEX}https://astro-cli.vercel.app${RESET}"
echo ""
