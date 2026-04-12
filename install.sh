#!/bin/bash
# ──────────────────────────────────────────────────────────
# Mr. Krabs 🦀 One-Click Installer / Updater
#
# Usage (paste this in your terminal or Claude Code):
#   curl -fsSL https://raw.githubusercontent.com/melisaliao502-debug/mr-krabs/main/install.sh | bash
#
# What it does:
#   1. Detects your OS and CPU architecture
#   2. Downloads the latest release from GitHub
#   3. Quits any running Mr. Krabs instance (update mode)
#   4. Installs / updates Mr. Krabs to /Applications (macOS)
#   5. Launches the new version
# ──────────────────────────────────────────────────────────

set -e

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[Mr. Krabs]${NC} $1"; }
ok()    { echo -e "${GREEN}[Mr. Krabs]${NC} $1"; }
warn()  { echo -e "${YELLOW}[Mr. Krabs]${NC} $1"; }
err()   { echo -e "${RED}[Mr. Krabs]${NC} $1"; exit 1; }

echo ""
echo -e "${BOLD}  🦀  Mr. Krabs — One-Click Installer${NC}"
echo -e "  ─────────────────────────────────────"
echo ""

# ── Step 1: Detect OS & Architecture ──
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    PLATFORM="macOS"
    case "$ARCH" in
        arm64)
          info "Detected: macOS Apple Silicon (${ARCH})"
          ;;
        x86_64)
          info "Detected: macOS Intel (${ARCH})"
          ;;
      *)
        err "Unsupported architecture: ${ARCH}"
        ;;
    esac
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM="Windows"
    ASSET_PATTERN=".exe"
    info "Detected: Windows (${ARCH})"
    ;;
  *)
    err "Unsupported OS: ${OS}. Mr. Krabs supports macOS and Windows."
    ;;
esac

# ── Step 2: Fetch latest release info from GitHub ──
REPO="melisaliao502-debug/mr-krabs"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
# Fallback version if GitHub API is unreachable (e.g. corporate network / GFW)
FALLBACK_VERSION="v0.6.8"

info "Fetching latest release from GitHub..."

RELEASE_JSON=$(curl -fsSL --connect-timeout 8 "$API_URL" 2>/dev/null) || true

# Parse version — fall back to hardcoded if API unreachable
VERSION=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
if [ -z "$VERSION" ]; then
  warn "GitHub API unreachable, using fallback version ${FALLBACK_VERSION}..."
  VERSION="$FALLBACK_VERSION"
fi
ok "Version: ${BOLD}${VERSION}${NC}"

# Build download URL directly from version tag (no API needed)
VERSION_NUM="${VERSION#v}"  # strip leading 'v'
BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"

if [ "$PLATFORM" = "macOS" ]; then
  if [ "$ARCH" = "arm64" ]; then
    DOWNLOAD_URL="${BASE_URL}/Mr.Krabs-${VERSION_NUM}-arm64.dmg"
  else
    DOWNLOAD_URL="${BASE_URL}/Mr.Krabs-${VERSION_NUM}.dmg"
  fi
else
  DOWNLOAD_URL="${BASE_URL}/MrKrabs-Setup-${VERSION_NUM}.exe"
fi

if [ -z "$DOWNLOAD_URL" ]; then
  err "Could not build download URL for your platform. Visit: https://github.com/${REPO}/releases/latest"
fi

# Extract filename from URL
FILENAME=$(basename "$DOWNLOAD_URL")
info "Downloading: ${BOLD}${FILENAME}${NC}"

# ── Step 3: Download ──
TMPDIR_DL=$(mktemp -d)
DOWNLOAD_PATH="${TMPDIR_DL}/${FILENAME}"

curl -fSL --progress-bar "$DOWNLOAD_URL" -o "$DOWNLOAD_PATH" || err "Download failed."
ok "Download complete! ($(du -h "$DOWNLOAD_PATH" | cut -f1 | xargs))"

# ── Step 4: Install ──
if [ "$PLATFORM" = "macOS" ]; then

  # ── Quit running instance if updating ──
  INSTALL_CHECK="/Applications/Mr. Krabs.app"
  if [ -d "$INSTALL_CHECK" ]; then
    INSTALLED_VER=$(defaults read "${INSTALL_CHECK}/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown")
    if [ "$INSTALLED_VER" != "unknown" ] && [ "$INSTALLED_VER" != "$VERSION_NUM" ]; then
      info "Updating from v${INSTALLED_VER} → ${VERSION}..."
    else
      info "Reinstalling ${VERSION}..."
    fi
    # Quit the running app gracefully
    if pgrep -x "Mr. Krabs" > /dev/null 2>&1 || pgrep -f "Mr. Krabs.app" > /dev/null 2>&1; then
      info "Quitting running Mr. Krabs..."
      osascript -e 'tell application "Mr. Krabs" to quit' 2>/dev/null || \
        pkill -f "Mr. Krabs.app" 2>/dev/null || true
      sleep 2
    fi
  else
    info "Fresh install of ${VERSION}..."
  fi

  info "Mounting DMG..."

  # Mount the DMG
  MOUNT_OUTPUT=$(hdiutil attach "$DOWNLOAD_PATH" -nobrowse -quiet 2>&1) || err "Failed to mount DMG: ${MOUNT_OUTPUT}"
  
  # Find the mount point
  MOUNT_POINT=$(echo "$MOUNT_OUTPUT" | grep '/Volumes/' | sed 's/.*\(\/Volumes\/.*\)/\1/' | head -1)
  if [ -z "$MOUNT_POINT" ]; then
    # Fallback: find by listing /Volumes
    MOUNT_POINT=$(ls -dt /Volumes/Mr*Krabs* 2>/dev/null | head -1)
  fi
  
  if [ -z "$MOUNT_POINT" ]; then
    warn "Could not find mount point. Trying to find the app..."
    MOUNT_POINT=$(ls -dt /Volumes/*Krabs* /Volumes/*krabs* 2>/dev/null | head -1)
  fi
  
  if [ -z "$MOUNT_POINT" ]; then
    err "Could not find mounted DMG. Please install manually: open ${DOWNLOAD_PATH}"
  fi
  
  # Find the .app inside
  APP_PATH=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -type d | head -1)
  if [ -z "$APP_PATH" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
    err "Could not find .app in DMG. Please install manually."
  fi
  
  APP_NAME=$(basename "$APP_PATH")
  INSTALL_PATH="/Applications/${APP_NAME}"
  
  # Remove old version if exists
  if [ -d "$INSTALL_PATH" ]; then
    warn "Removing previous installation..."
    rm -rf "$INSTALL_PATH"
  fi
  
  info "Installing to /Applications/..."
  cp -R "$APP_PATH" /Applications/ || err "Failed to copy to /Applications. Try: sudo cp -R \"${APP_PATH}\" /Applications/"
  
  # Unmount
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  
  ok "Installed: ${BOLD}/Applications/${APP_NAME}${NC}"
  
  # Remove quarantine attribute (bypass Gatekeeper for unsigned app)
  info "Removing macOS quarantine flag..."
  xattr -rd com.apple.quarantine "/Applications/${APP_NAME}" 2>/dev/null || true
  
  # ── Step 5: Launch ──
  echo ""
  info "Launching Mr. Krabs... 🦀"
  open "/Applications/${APP_NAME}"
  
  echo ""
  echo -e "${GREEN}  ✅  Mr. Krabs ${VERSION} installed successfully!${NC}"
  echo ""
  echo -e "  ${BOLD}Look for the crab 🦀 on your desktop.${NC}"
  echo -e "  Right-click it to access the menu."
  echo ""
  echo -e "  ${CYAN}Auto-update:${NC}"
  echo -e "    • From ${VERSION} onwards, Mr. Krabs checks for updates automatically"
  echo -e "    • You'll get a prompt when a new version is available"
  echo -e "    • Or right-click the crab → 检查更新 / Check for Updates"
  echo ""
  echo -e "  ${CYAN}Prerequisites:${NC}"
  echo -e "    • Claude Code must be installed (https://docs.anthropic.com/en/docs/claude-code)"
  echo -e "    • Mr. Krabs will auto-detect your Claude Code sessions"
  echo ""
  echo -e "  ${CYAN}Quick Start:${NC}"
  echo -e "    • Ctrl+Space  → Quick task input"
  echo -e "    • Ctrl+Enter  → Chat / text selection window"
  echo -e "    • Right-click  → Full menu (Task Panel, Sessions, etc.)"
  echo ""

elif [ "$PLATFORM" = "Windows" ]; then
  info "Launching installer..."
  start "$DOWNLOAD_PATH" 2>/dev/null || cmd.exe /c start "" "$DOWNLOAD_PATH" 2>/dev/null || {
    ok "Downloaded to: ${DOWNLOAD_PATH}"
    info "Please double-click the installer to complete installation."
  }
  
  echo ""
  echo -e "${GREEN}  ✅  Mr. Krabs ${VERSION} installer launched!${NC}"
  echo -e "  Follow the installer wizard to complete setup."
  echo ""
fi

# Cleanup temp files
rm -rf "$TMPDIR_DL" 2>/dev/null || true

echo -e "  ${CYAN}GitHub:${NC} https://github.com/${REPO}"
echo -e "  ${CYAN}Issues:${NC} https://github.com/${REPO}/issues"
echo ""
