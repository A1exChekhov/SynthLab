#!/usr/bin/env bash
# Builds a distributable ChannelSplitter.dmg (no Xcode required — uses hdiutil).
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP="ChannelSplitter.app"
VOL="Channel Splitter"
DMG="ChannelSplitter.dmg"
STAGE=".dmg_stage"

# 1. Make sure we have a fresh app bundle.
./build.sh "$CONFIG"

# 2. Stage the app + a shortcut to /Applications for drag-install.
echo "==> staging"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# 3. Build a compressed read-only DMG.
echo "==> hdiutil create"
hdiutil create \
    -volname "$VOL" \
    -srcfolder "$STAGE" \
    -fs HFS+ \
    -format UDZO \
    -ov "$DMG" >/dev/null

rm -rf "$STAGE"
echo "==> done: $(pwd)/$DMG"
echo "Install: open $DMG  →  drag Channel Splitter onto Applications"
