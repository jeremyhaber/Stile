#!/usr/bin/env bash
# Zip extension/ for the Chrome Web Store: dist/stile-extension-<version>.zip (zips are gitignored).
# The store rejects a manifest "key" field, so it is dropped from the packaged copy only; extension/manifest.json keeps
# it so the unpacked dev copy keeps its fixed ID. The TypeScript sources are left out (pages load capture/dist).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

rsync -a --exclude capture/src --exclude capture/tsconfig.json --exclude .DS_Store "$ROOT/extension/" "$STAGE/pkg/"
VERSION="$(python3 -I - "$STAGE/pkg/manifest.json" <<'EOF'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m.pop("key", None)
json.dump(m, open(p, "w"), indent=2)
print(m["version"])
EOF
)"

mkdir -p "$OUT"
ZIP="$OUT/stile-extension-$VERSION.zip"
rm -f "$ZIP"
(cd "$STAGE/pkg" && zip -qr "$ZIP" .)
echo "$ZIP"
