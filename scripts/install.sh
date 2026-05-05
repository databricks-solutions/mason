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
MOUNT_OUTPUT="$(hdiutil attach -nobrowse -readonly "$DMG_PATH")"
MOUNT_POINT="$(printf '%s' "$MOUNT_OUTPUT" | awk -F'\t' '/\/Volumes\// { sub(/^ +/, "", $NF); print $NF; exit }')"
[[ -d "$MOUNT_POINT" ]] || err "Could not determine mount point from hdiutil output."

cleanup_mount() {
  if [[ -n "${MOUNT_POINT:-}" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup_mount EXIT

SRC_APP="$MOUNT_POINT/$APP_NAME.app"
[[ -d "$SRC_APP" ]] || err "Expected $APP_NAME.app inside the DMG, didn't find it."

DEST_APP="$INSTALL_DIR/$APP_NAME.app"
if [[ -d "$DEST_APP" ]]; then
  log "Removing existing $DEST_APP..."
  rm -rf "$DEST_APP" 2>/dev/null || sudo rm -rf "$DEST_APP"
fi

log "Copying $APP_NAME.app to $INSTALL_DIR..."
if ! cp -R "$SRC_APP" "$INSTALL_DIR/" 2>/dev/null; then
  log "Permission denied — retrying with sudo (you may be prompted for your password)."
  sudo cp -R "$SRC_APP" "$INSTALL_DIR/"
fi

# Strip Gatekeeper quarantine xattr from the freshly-installed copy. Optional —
# the app is signed and notarized, but quarantine adds a "downloaded from
# internet" prompt on first launch. Removing makes first launch silent.
xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true

ok "Installed $APP_NAME.app to $INSTALL_DIR"
ok "Launch with: open -a $APP_NAME"
