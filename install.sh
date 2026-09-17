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

ASTRO_DIR="$HOME/.astro"
INSTALL_DIR="$ASTRO_DIR/bin"
mkdir -p "$INSTALL_DIR"

# Clean stale locks
rm -f "$ASTRO_DIR"/*.lock 2>/dev/null || true

CORE_BIN="$INSTALL_DIR/astro-core"
WRAPPER_BIN="$INSTALL_DIR/astro"
PROXY_SCRIPT="$INSTALL_DIR/astro-proxy.mjs"
CONFIG_FILE="$ASTRO_DIR/config.toml"

DOWNLOAD_URL="https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-1.0.6-linux-x86_64"
FALLBACK_URL="https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-cli-linux-x64.run"
PROXY_URL="https://raw.githubusercontent.com/cyberuz001/astro-cli/main/cli/astro-proxy.mjs"

echo -e "  ${AMBER}>${RESET} ${WHITE}[1/4] downloading astro binary...${RESET}"

if curl -fL --progress-bar "$DOWNLOAD_URL" -o "$CORE_BIN"; then
    echo -e "        ${MUTED}download complete.${RESET}"
else
    echo -e "        ${AMBER}retrying fallback binary...${RESET}"
    curl -fL --progress-bar "$FALLBACK_URL" -o "$CORE_BIN"
fi

chmod +x "$CORE_BIN"

echo -e "  ${AMBER}>${RESET} ${WHITE}[2/4] downloading background proxy engine...${RESET}"
curl -fsSL "$PROXY_URL" -o "$PROXY_SCRIPT" 2>/dev/null || curl -fsSL "https://astro-cli.vercel.app/cli/astro-proxy.mjs" -o "$PROXY_SCRIPT" 2>/dev/null || true

echo -e "  ${AMBER}>${RESET} ${WHITE}[3/4] generating launcher & configuration...${RESET}"

# Create wrapper launcher script
cat << 'EOF' > "$WRAPPER_BIN"
#!/usr/bin/env bash
# astro CLI launcher
ASTRO_DIR="$HOME/.astro"
BIN_DIR="$ASTRO_DIR/bin"

# Check if proxy is listening on port 5544
if ! command -v nc >/dev/null 2>&1 || ! nc -z 127.0.0.1 5544 2>/dev/null; then
    if command -v node >/dev/null 2>&1; then
        nohup node "$BIN_DIR/astro-proxy.mjs" >/dev/null 2>&1 &
        sleep 2
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
allowed_models = [
    "vortex",
    "nebula-high",
    "nebula",
    "photon-3.8",
    "photon-3.7",
]

[model.vortex]
model = "vortex"
name = "vortex"
context_window = 1000000

[model.nebula-high]
model = "nebula-high"
name = "nebula-high"
context_window = 200000

[model.nebula]
model = "nebula"
name = "nebula"
context_window = 200000

[model.photon-3.8]
model = "photon-3.8"
name = "photon-3.8"
context_window = 128000

[model.photon-3.7]
model = "photon-3.7"
name = "photon-3.7"
context_window = 128000

[endpoints]
cli_chat_proxy_base_url = "http://localhost:5544/v1"
xai_api_base_url = "http://localhost:5544/v1"
EOF
fi

echo -e "  ${AMBER}>${RESET} ${WHITE}[4/4] configuring environment path...${RESET}"

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
    ln -sf "$WRAPPER_BIN" /usr/local/bin/astro 2>/dev/null || true
elif command -v sudo >/dev/null 2>&1; then
    sudo ln -sf "$WRAPPER_BIN" /usr/local/bin/astro 2>/dev/null || true
fi

echo -e "  ${AMBER}>${RESET} ${WHITE}installation complete!${RESET}"

echo ""
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo -e "  ${VORTEX}* astro installed successfully!${RESET}"
echo -e "  ${DIM}--------------------------------------------------${RESET}"
echo ""
echo -e "  ${MUTED}Open a NEW terminal (or run: source ~/.bashrc) and type:${RESET}"
echo -e "    ${AMBER}astro${RESET}"
echo ""
echo -e "  ${MUTED}Documentation & Models:${RESET} ${VORTEX}https://astro-cli.vercel.app${RESET}"
echo ""
