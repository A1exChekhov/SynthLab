#!/usr/bin/env bash
# Builds ChannelSplitter.app without Xcode (Command Line Tools only).
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP="ChannelSplitter.app"
BIN_NAME="ChannelSplitter"

echo "==> swift build ($CONFIG)"
swift build -c "$CONFIG"

BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/$BIN_NAME"
echo "==> binary: $BIN_PATH"

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_PATH" "$APP/Contents/MacOS/$BIN_NAME"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

echo "==> staging web UI (app_web)"
rm -rf "$APP/Contents/Resources/app_web"
cp -R Resources/app_web "$APP/Contents/Resources/app_web"

echo "==> ad-hoc codesign (with microphone entitlement)"
codesign --force --deep --sign - \
    --entitlements Resources/ChannelSplitter.entitlements \
    --options runtime "$APP" 2>/dev/null || \
codesign --force --deep --sign - \
    --entitlements Resources/ChannelSplitter.entitlements "$APP"

echo "==> done: $(pwd)/$APP"
echo "Run:  open $APP    (or ./$APP/Contents/MacOS/$BIN_NAME for console logs)"
