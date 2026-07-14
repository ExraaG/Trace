#!/bin/sh
set -eu

REPOSITORY="ExraaG/Trace"
RELEASE_API="https://api.github.com/repos/$REPOSITORY/releases/latest"
ESP32_INDEX="https://espressif.github.io/arduino-esp32/package_esp32_index.json"
TRACE_HOME="$HOME/.trace"
CLI_DIR="$TRACE_HOME/bin"
ARDUINO_CLI="$CLI_DIR/arduino-cli"
TEMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t trace-install)"
MOUNT_DIR=""

cleanup() {
  if [ -n "$MOUNT_DIR" ] && mount | grep -Fq " on $MOUNT_DIR "; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

info() {
  printf '\nTrace: %s\n' "$1"
}

fail() {
  printf '\nTrace installer error: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required."

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) RELEASE_ARCH="x86_64|x64|amd64" ;;
  arm64|aarch64) RELEASE_ARCH="aarch64|arm64" ;;
  *) fail "Unsupported CPU architecture: $ARCH" ;;
esac

info "Finding the latest release"
if ! RELEASE_JSON="$(curl -fsSL --retry 3 -H "Accept: application/vnd.github+json" "$RELEASE_API")"; then
  fail "No public Trace release is available. Make the repository public and publish a version tag first."
fi

ASSET_URLS="$(printf '%s\n' "$RELEASE_JSON" | sed -n 's/.*"browser_download_url": "\([^"]*\)".*/\1/p')"

find_asset() {
  extension="$1"
  architecture="$2"
  printf '%s\n' "$ASSET_URLS" | grep -Ei "$architecture.*\\.$extension$" | head -n 1 || true
}

install_arduino() {
  mkdir -p "$CLI_DIR"
  if [ ! -x "$ARDUINO_CLI" ]; then
    info "Installing Arduino CLI"
    curl -fsSL --retry 3 https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | BINDIR="$CLI_DIR" sh
  else
    info "Arduino CLI is already installed"
  fi

  [ -x "$ARDUINO_CLI" ] || fail "Arduino CLI installation did not produce $ARDUINO_CLI"
  "$ARDUINO_CLI" config init >/dev/null 2>&1 || true
  if ! "$ARDUINO_CLI" config dump 2>/dev/null | grep -Fq "$ESP32_INDEX"; then
    "$ARDUINO_CLI" config add board_manager.additional_urls "$ESP32_INDEX"
  fi

  if "$ARDUINO_CLI" core list 2>/dev/null | grep -Eq '^esp32:esp32[[:space:]]'; then
    info "ESP32 Arduino core is already installed"
  else
    info "Installing the ESP32 Arduino core (this can take several minutes)"
    "$ARDUINO_CLI" core update-index
    "$ARDUINO_CLI" core install esp32:esp32
  fi
}

add_launcher_to_path() {
  launcher_dir="$1"
  case ":$PATH:" in
    *":$launcher_dir:"*) return ;;
  esac

  if [ "$OS" = "Darwin" ]; then
    profile="$HOME/.zprofile"
  else
    profile="$HOME/.profile"
  fi
  path_line="export PATH=\"$launcher_dir:\$PATH\""
  touch "$profile"
  grep -Fq "$path_line" "$profile" 2>/dev/null || printf '\n%s\n' "$path_line" >> "$profile"
}

install_linux() {
  [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ] \
    || fail "The first Linux release supports x86_64 only."
  asset_url="$(find_asset "AppImage" "$RELEASE_ARCH")"
  [ -n "$asset_url" ] || fail "The latest release does not contain an x86_64 Linux AppImage."

  app_dir="$HOME/.local/share/trace"
  launcher_dir="$HOME/.local/bin"
  appimage="$app_dir/Trace.AppImage"
  launcher="$launcher_dir/trace"
  icon_dir="$HOME/.local/share/icons/hicolor/512x512/apps"
  desktop_dir="$HOME/.local/share/applications"
  mkdir -p "$app_dir" "$launcher_dir" "$icon_dir" "$desktop_dir"

  info "Downloading Trace for Linux"
  curl -fL --retry 3 "$asset_url" -o "$TEMP_DIR/Trace.AppImage"
  install -m 0755 "$TEMP_DIR/Trace.AppImage" "$appimage"

  printf '%s\n' \
    '#!/bin/sh' \
    "export PATH=\"$CLI_DIR:\$PATH\"" \
    'export APPIMAGE_EXTRACT_AND_RUN=1' \
    "exec \"$appimage\" \"\$@\"" > "$launcher"
  chmod 0755 "$launcher"

  curl -fsSL --retry 3 \
    "https://raw.githubusercontent.com/$REPOSITORY/main/src-tauri/icons/icon.png" \
    -o "$icon_dir/trace.png" || true

  printf '%s\n' \
    '[Desktop Entry]' \
    'Type=Application' \
    'Name=Trace' \
    'Comment=ESP32 and Arduino IDE' \
    "Exec=$launcher" \
    'Icon=trace' \
    'Terminal=false' \
    'Categories=Development;IDE;' > "$desktop_dir/dev.trace.ide.desktop"
  command -v update-desktop-database >/dev/null 2>&1 \
    && update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true
  add_launcher_to_path "$launcher_dir"
}

install_macos() {
  asset_url="$(find_asset "dmg" "$RELEASE_ARCH")"
  [ -n "$asset_url" ] || fail "The latest release does not contain a macOS DMG for $RELEASE_ARCH."

  applications="$HOME/Applications"
  launcher_dir="$HOME/.local/bin"
  mkdir -p "$applications" "$launcher_dir"

  info "Downloading Trace for macOS"
  curl -fL --retry 3 "$asset_url" -o "$TEMP_DIR/Trace.dmg"
  MOUNT_DIR="$TEMP_DIR/mount"
  mkdir -p "$MOUNT_DIR"
  hdiutil attach "$TEMP_DIR/Trace.dmg" -nobrowse -readonly -mountpoint "$MOUNT_DIR" -quiet
  source_app="$MOUNT_DIR/Trace.app"
  [ -d "$source_app" ] || fail "Trace.app was not found in the downloaded DMG."
  rm -rf "$applications/Trace.app"
  cp -R "$source_app" "$applications/Trace.app"
  hdiutil detach "$MOUNT_DIR" -quiet
  MOUNT_DIR=""

  printf '%s\n' \
    '#!/bin/sh' \
    "export PATH=\"$CLI_DIR:\$PATH\"" \
    "open \"$applications/Trace.app\" --args \"\$@\"" > "$launcher_dir/trace"
  chmod 0755 "$launcher_dir/trace"
  add_launcher_to_path "$launcher_dir"
}

install_arduino
case "$OS" in
  Linux) install_linux ;;
  Darwin) install_macos ;;
  *) fail "Unsupported operating system: $OS. On Windows, run install.ps1 in PowerShell." ;;
esac

info "Installation complete"
printf '%s\n' "Open Trace from your application menu, or start a new terminal and run: trace"
