#!/usr/bin/env bash
# Build Sidebar.app (release), bundle the web UI and the extension folder, ad-hoc sign, zip to mac/dist/Sidebar.zip.
# Set UNIVERSAL=1 for an arm64+x86_64 binary. Set VERSION=x.y.z to override the version string.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$(cd "$HERE/../extension" && pwd)"
DIST="$HERE/dist"
APP="$DIST/Sidebar.app"
VERSION="${VERSION:-2.1.0}"
BUILD="${GITHUB_RUN_NUMBER:-1}"

# Files that must exist in extension/ (the web UI copied to Contents/Resources/web is every top-level
# *.js, *.css, *.html and *.png plus icons/, so new UI files are picked up automatically).
WEB_FILES=(sidepanel.html sidepanel.css sidepanel.js shared.js icons.js boost-view.js boost.css bridge-shim.js)

missing=0
for f in "${WEB_FILES[@]}"; do
  if [ ! -f "$EXT/$f" ]; then
    echo "error: required web UI file missing: extension/$f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "error: cannot assemble Sidebar.app without the files above" >&2
  exit 1
fi

cd "$HERE"
ARCHS=()
if [ "${UNIVERSAL:-0}" = "1" ]; then ARCHS=(--arch arm64 --arch x86_64); fi
swift build -c release ${ARCHS[@]+"${ARCHS[@]}"}
BIN_DIR="$(swift build -c release ${ARCHS[@]+"${ARCHS[@]}"} --show-bin-path)"
if [ ! -x "$BIN_DIR/SidebarApp" ]; then
  echo "error: built executable not found at $BIN_DIR/SidebarApp" >&2
  exit 1
fi

rm -rf "$APP" "$DIST/Sidebar.zip"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp "$BIN_DIR/SidebarApp" "$APP/Contents/MacOS/SidebarApp"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD/g" "$HERE/Resources/Info.plist" > "$APP/Contents/Info.plist"
# Web UI for the sidebar's web view: every top-level *.js, *.css, *.html, *.png of the extension, plus icons/.
shopt -s nullglob
for f in "$EXT"/*.js "$EXT"/*.css "$EXT"/*.html "$EXT"/*.png; do
  cp "$f" "$APP/Contents/Resources/web/$(basename "$f")"
done
shopt -u nullglob
if [ -d "$EXT/icons" ]; then cp -R "$EXT/icons" "$APP/Contents/Resources/web/icons"; fi
# The whole extension folder, so the user can "Load unpacked" a copy that always matches this app.
rm -rf "$APP/Contents/Resources/extension"
cp -R "$EXT" "$APP/Contents/Resources/extension"
printf 'APPL????' > "$APP/Contents/PkgInfo"

codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP"

(cd "$DIST" && ditto -c -k --keepParent Sidebar.app Sidebar.zip)
echo "Built $APP"
echo "Zip:   $DIST/Sidebar.zip"
