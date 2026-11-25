#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$DIR/TokenHUD.app"
BIN_DIR="$APP_DIR/Contents/MacOS"

mkdir -p "$BIN_DIR"

SDK_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk"
if [[ ! -d "$SDK_PATH" ]]; then
  SDK_PATH="$(xcrun --show-sdk-path)"
fi

echo "正在编译 TokenHUD..."
swiftc -O \
  -sdk "$SDK_PATH" \
  -module-cache-path /tmp/swift-module-cache \
  -framework AppKit \
  "$DIR/hud/TokenHUD.swift" \
  -o "$BIN_DIR/TokenHUD"

cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>TokenHUD</string>
  <key>CFBundleIdentifier</key>
  <string>com.local.antigravity-token-hud</string>
  <key>CFBundleName</key>
  <string>TokenHUD</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity Token 顶部外挂</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

echo "编译完成：$APP_DIR"
if [[ "${1:-}" == "--run" ]]; then
  open "$APP_DIR"
fi
