#!/usr/bin/env bash
# Mason installer — downloads the latest release DMG from GitHub and installs
# Mason.app to /Applications.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/databricks-solutions/mason/main/scripts/install.sh | bash
#
# Or install a specific version:
#   curl -fsSL https://raw.githubusercontent.com/databricks-solutions/mason/main/scripts/install.sh | bash -s v1.0.0

set -euo pipefail

REPO="databricks-solutions/mason"
VERSION="${1:-latest}"
APP_NAME="Mason"
INSTALL_DIR="/Applications"

err() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[34m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }

# --- Preflight ---
[[ "$(uname -s)" == "Darwin" ]] || err "Mason currently only ships a macOS build. Detected: $(uname -s)"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ASSET_PATTERN="arm64.dmg" ;;
  x86_64) err "Intel macOS builds are not yet published. Apple Silicon (arm64) only." ;;
  *) err "Unsupported architecture: $ARCH" ;;
esac

for cmd in curl hdiutil cp rm mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || err "Required command not found: $cmd"
done

# --- Resolve the release ---
if [[ "$VERSION" == "latest" ]]; then
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
fi

log "Fetching release metadata ($VERSION)..."
META="$(curl -fsSL "$API_URL")" || err "Could not fetch release metadata. Is the network up?"

# Pull the .dmg URL matching our arch. Avoid jq dep — use grep/sed.
DMG_URL="$(printf '%s' "$META" \
  | grep -o '"browser_download_url": *"[^"]*'"$ASSET_PATTERN"'"' \
  | head -n1 \
  | sed -E 's/.*"(https:[^"]+)"$/\1/')"

[[ -n "$DMG_URL" ]] || err "No matching .dmg asset found for $ARCH in release $VERSION."

DMG_NAME="$(basename "$DMG_URL")"
log "Found: $DMG_NAME"

# --- Download ---
TMP_DIR="$(mktemp -d -t mason-install)"
trap 'rm -rf "$TMP_DIR"' EXIT

DMG_PATH="$TMP_DIR/$DMG_NAME"
log "Downloading to $DMG_PATH..."
curl -fL --progress-bar -o "$DMG_PATH" "$DMG_URL" || err "Download failed."

# --- Mount, copy, unmount ---
log "Mounting DMG..."
# Use plist output for robust parsing regardless of whitespace in volume name.
PLIST_OUT="$(hdiutil attach -nobrowse -readonly -plist "$DMG_PATH")"
# Capture the device entry (e.g. /dev/disk4) and the mount point (/Volumes/...).
DEV_NODE="$(printf '%s' "$PLIST_OUT" | /usr/libexec/PlistBuddy -c 'Print :system-entities:0:dev-entry' /dev/stdin 2>/dev/null || true)"
# The mount point lives on a later index; iterate to find the one with mount-point set.
MOUNT_POINT=""
for i in 0 1 2 3 4 5; do
  MP="$(printf '%s' "$PLIST_OUT" | /usr/libexec/PlistBuddy -c "Print :system-entities:$i:mount-point" /dev/stdin 2>/dev/null || true)"
  if [[ -n "$MP" && -d "$MP" ]]; then MOUNT_POINT="$MP"; break; fi
done

[[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]] || err "Could not determine mount point from hdiutil output."

cleanup_mount() {
  # Detach by device node first (most reliable). Fall back to mount path. Force
  # if anything's still holding the volume open.
  if [[ -n "${DEV_NODE:-}" ]]; then
    hdiutil detach "$DEV_NODE" -quiet 2>/dev/null \
      || hdiutil detach "$DEV_NODE" -force -quiet 2>/dev/null \
      || true
  elif [[ -n "${MOUNT_POINT:-}" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null \
      || hdiutil detach "$MOUNT_POINT" -force -quiet 2>/dev/null \
      || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup_mount EXIT

SRC_APP="$MOUNT_POINT/$APP_NAME.app"
[[ -d "$SRC_APP" ]] || err "Expected $APP_NAME.app inside the DMG, didn't find it."

DEST_APP="$INSTALL_DIR/$APP_NAME.app"
STAGING_APP="$INSTALL_DIR/.${APP_NAME}.app.new"

# Atomic install: copy to a staging path first, then mv over the existing
# bundle. Without this, there's a 30–60s window between rm and cp where the
# bundle is missing, and clicking the dock icon during that window causes
# Launch Services to fall back to any other registered Mason.app (e.g. a dev
# checkout's node_modules/electron/dist/Mason.app).
log "Staging $APP_NAME.app at $STAGING_APP..."
rm -rf "$STAGING_APP" 2>/dev/null || sudo rm -rf "$STAGING_APP"
if ! cp -R "$SRC_APP" "$STAGING_APP" 2>/dev/null; then
  log "Permission denied — retrying with sudo (you may be prompted for your password)."
  sudo cp -R "$SRC_APP" "$STAGING_APP"
fi

log "Swapping into place at $DEST_APP..."
if [[ -d "$DEST_APP" ]]; then
  rm -rf "$DEST_APP" 2>/dev/null || sudo rm -rf "$DEST_APP"
fi
mv "$STAGING_APP" "$DEST_APP" 2>/dev/null || sudo mv "$STAGING_APP" "$DEST_APP"

# Strip Gatekeeper quarantine xattr from the freshly-installed copy. Optional —
# the app is signed and notarized, but quarantine adds a "downloaded from
# internet" prompt on first launch. Removing makes first launch silent.
xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true

# Touch the bundle so Finder/Launchpad re-index its icon. macOS aggressively
# caches icons per-bundle-id; without this, freshly installed apps that share
# a bundle id with a prior install can render with a generic placeholder.
touch "$DEST_APP"

ok "Installed $APP_NAME.app to $INSTALL_DIR"

# --- Optional: install Databricks CLI to ~/.mason/bin ---
# Mason can talk to the AI Gateway only with the Databricks CLI present (it uses
# the CLI to mint OAuth tokens). If a system CLI is already on PATH, leave it
# alone — brew/winget installs are easier to keep up to date that way.
MASON_BIN="$HOME/.mason/bin"
if command -v databricks >/dev/null 2>&1; then
  ok "Databricks CLI already installed at $(command -v databricks)"
else
  log "Databricks CLI not found — installing to $MASON_BIN"
  case "$ARCH" in
    arm64) CLI_ARCH="arm64" ;;
    x86_64) CLI_ARCH="amd64" ;;
    *) err "Unsupported architecture for Databricks CLI: $ARCH" ;;
  esac
  CLI_META="$(curl -fsSL "https://api.github.com/repos/databricks/cli/releases/latest")" || err "Failed to fetch Databricks CLI release metadata."
  CLI_VER="$(printf '%s' "$CLI_META" | grep -o '"tag_name": *"v[^"]*"' | head -n1 | sed -E 's/.*"v([^"]+)"/\1/')"
  [[ -n "$CLI_VER" ]] || err "Could not parse Databricks CLI version."
  CLI_ASSET="databricks_cli_${CLI_VER}_darwin_${CLI_ARCH}.zip"
  CLI_URL="$(printf '%s' "$CLI_META" \
    | grep -o '"browser_download_url": *"[^"]*'"$CLI_ASSET"'"' \
    | head -n1 \
    | sed -E 's/.*"(https:[^"]+)"$/\1/')"
  [[ -n "$CLI_URL" ]] || err "No Databricks CLI asset for darwin_${CLI_ARCH} in v${CLI_VER}."

  CLI_TMP="$(mktemp -d -t mason-cli)"
  CLI_ZIP="$CLI_TMP/$CLI_ASSET"
  log "Downloading $CLI_ASSET..."
  curl -fL --progress-bar -o "$CLI_ZIP" "$CLI_URL" || err "Databricks CLI download failed."
  unzip -oq "$CLI_ZIP" -d "$CLI_TMP" || err "Failed to extract Databricks CLI."

  mkdir -p "$MASON_BIN"
  if [[ -f "$CLI_TMP/databricks" ]]; then
    mv "$CLI_TMP/databricks" "$MASON_BIN/databricks"
  else
    # Some archives nest the binary one level deeper.
    NESTED="$(find "$CLI_TMP" -maxdepth 2 -name databricks -type f | head -n1)"
    [[ -n "$NESTED" ]] || err "Databricks binary not found in archive."
    mv "$NESTED" "$MASON_BIN/databricks"
  fi
  chmod +x "$MASON_BIN/databricks"
  rm -rf "$CLI_TMP"

  # Save the path so Mason's main.js resolver finds it directly.
  mkdir -p "$HOME/.mason/config"
  printf '{"path":"%s","version":"%s"}\n' "$MASON_BIN/databricks" "$CLI_VER" > "$HOME/.mason/config/cli_path.json"

  ok "Databricks CLI v${CLI_VER} installed at $MASON_BIN/databricks"
  case ":$PATH:" in
    *":$MASON_BIN:"*) ;;
    *) log "(Optional) Add $MASON_BIN to your PATH if you want to use 'databricks' from the terminal." ;;
  esac
fi

# --- Optional: Databricks AI Dev Kit (MCP server + skills) ---
# Wires Mason up to the ai-dev-kit MCP for richer Databricks tooling
# (jobs, dashboards, UC, model serving, etc.). Opt-in.
DEVKIT_DIR="$HOME/.ai-dev-kit"
MASON_CONFIG_DIR="$HOME/.mason/config"
MCP_SERVERS_FILE="$MASON_CONFIG_DIR/mcp_servers.json"

install_uv_if_needed() {
  if command -v uv >/dev/null 2>&1; then
    ok "uv already installed at $(command -v uv)"
    return 0
  fi
  log "Installing uv (Python package manager) to ~/.local/bin..."
  curl -fsSL https://astral.sh/uv/install.sh | sh || err "uv install failed."
}

register_devkit_with_mason() {
  # Idempotently append/replace the ai-dev-kit stdio entry in Mason's global
  # MCP config so it auto-connects on next launch. Uses node (already installed
  # alongside Mason) for safe JSON manipulation; falls back to a manual write
  # if node isn't on PATH for some reason.
  mkdir -p "$MASON_CONFIG_DIR"
  local venv_python="$DEVKIT_DIR/.venv/bin/python"
  local mcp_entry="$DEVKIT_DIR/repo/databricks-mcp-server/run_server.py"
  # Pull Mason's version from the just-installed app bundle (CFBundleShortVersionString)
  # so DATABRICKS_SDK_UPSTREAM_VERSION matches the running app.
  local mason_version="unknown"
  if [[ -f "$DEST_APP/Contents/Info.plist" ]]; then
    mason_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST_APP/Contents/Info.plist" 2>/dev/null || echo unknown)"
  fi
  local profile="${DEVKIT_PROFILE:-DEFAULT}"

  if command -v node >/dev/null 2>&1; then
    node - "$MCP_SERVERS_FILE" "$venv_python" "$mcp_entry" "$mason_version" "$profile" <<'NODEEOF' || warn "Could not register MCP entry with Mason."
const fs = require("fs");
const [, , file, command, mcpEntry, masonVersion, profile] = process.argv;
let cfg = { http: [], stdio: [] };
if (fs.existsSync(file)) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(data)) cfg = { http: data, stdio: [] };
    else cfg = { http: data.http || [], stdio: data.stdio || [] };
  } catch (_) {}
}
const others = (cfg.stdio || []).filter((s) => s.name !== "ai-dev-kit");
cfg.stdio = [...others, {
  name: "ai-dev-kit",
  command,
  args: [mcpEntry],
  // Pin the profile so the Databricks SDK auth chain resolves deterministically
  // (auth_type=databricks-cli profiles need an explicit profile name to find
  // their host). DATABRICKS_SDK_UPSTREAM[_VERSION] tags the User-Agent for
  // Mason attribution in warehouse audit logs.
  env: {
    DATABRICKS_CONFIG_PROFILE: profile,
    DATABRICKS_SDK_UPSTREAM: "mason",
    DATABRICKS_SDK_UPSTREAM_VERSION: masonVersion,
  },
  enabledByDefault: true,
}];
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log("Registered ai-dev-kit MCP with Mason at " + file);
NODEEOF
    ok "AI Dev Kit MCP registered with Mason (profile=${profile}, upstream=mason/${mason_version})"
  else
    warn "node not found — couldn't auto-register MCP. Add it manually in Settings → MCP."
  fi
}

if [[ "${MASON_NO_DEVKIT:-0}" == "1" ]]; then
  log "Skipping Databricks AI Dev Kit (MASON_NO_DEVKIT=1)"
elif [[ -d "$DEVKIT_DIR/repo" ]]; then
  ok "Databricks AI Dev Kit already installed at $DEVKIT_DIR"
  register_devkit_with_mason
else
  if [[ -t 0 ]]; then
    printf '  \033[34m›\033[0m Install Databricks AI Dev Kit MCP for richer Databricks tooling? [y/N] '
    read -r ans
  else
    ans="${MASON_INSTALL_DEVKIT:-n}"
  fi
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    install_uv_if_needed
    log "Installing Databricks AI Dev Kit (~30s)..."
    if bash <(curl -fsSL https://raw.githubusercontent.com/databricks-solutions/ai-dev-kit/main/install.sh) \
         --global --silent --tools ""; then
      register_devkit_with_mason
    else
      warn "AI Dev Kit install hit an issue; you can retry from Mason → Settings."
    fi
  fi
fi

ok "Launch with: open -a $APP_NAME"
