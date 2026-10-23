#!/bin/bash
# Copy the sidebar's web UI (the whole extension folder, including subfolders such as capture/)
# into the app's web root. Used by build.sh and by tools/overlay-e2e.mjs, so the tests serve
# exactly what the app ships.
set -euo pipefail
SRC="$1"   # extension folder
DST="$2"   # destination web root
rm -rf "$DST"
mkdir -p "$DST"
cp -R "$SRC"/. "$DST"/
# Build-only sources aren't needed at runtime.
rm -rf "$DST/capture/src"
