#!/bin/bash
# Installs the Sidebar native messaging helper for Google Chrome on macOS.
# Safe to run repeatedly.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="${SIDEBAR_HELPER_DIR:-$HOME/Library/Application Support/SidebarHelper}"
NMH_DIR="${SIDEBAR_NMH_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
HELPER_DEST="$HELPER_DIR/sidebar-helper.pl"
MANIFEST="$NMH_DIR/com.sidebar.helper.json"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

say "Sidebar helper installer"
say "------------------------"

[ -x /usr/bin/perl ] || die "/usr/bin/perl not found. The helper needs the system Perl that ships with macOS."
[ -f "$SRC_DIR/sidebar-helper.pl" ] || die "sidebar-helper.pl not found next to install.sh."
[ -f "$SRC_DIR/com.sidebar.helper.json.template" ] || die "com.sidebar.helper.json.template not found next to install.sh."

/usr/bin/perl -c "$SRC_DIR/sidebar-helper.pl" >/dev/null 2>&1 || die "sidebar-helper.pl failed a syntax check with /usr/bin/perl."

mkdir -p "$HELPER_DIR" "$HELPER_DIR/sock" "$HELPER_DIR/pending" "$NMH_DIR"
chmod 700 "$HELPER_DIR/sock"

# Copy (via temp + rename so a running helper is not disturbed).
cp "$SRC_DIR/sidebar-helper.pl" "$HELPER_DEST.new"
chmod +x "$HELPER_DEST.new"
mv -f "$HELPER_DEST.new" "$HELPER_DEST"
xattr -d com.apple.quarantine "$HELPER_DEST" 2>/dev/null || true
say "Installed helper:  $HELPER_DEST"

# Manifest: substitute the helper path (escaped for JSON).
esc_path="${HELPER_DEST//\\/\\\\}"
esc_path="${esc_path//\"/\\\"}"
template="$(cat "$SRC_DIR/com.sidebar.helper.json.template")"
printf '%s\n' "${template//__HELPER_PATH__/$esc_path}" > "$MANIFEST.new"
mv -f "$MANIFEST.new" "$MANIFEST"
say "Installed manifest: $MANIFEST"

say ""
say "Done. Next steps:"
say "  1. Load the Sidebar extension (chrome://extensions, Developer mode, Load unpacked)."
say "  2. Open the Sidebar panel, go to Settings and press Retry next to the helper status."
say "  3. Repeat step 1 in each Chrome profile you want to switch between."
say ""
say "Logs: $HELPER_DIR/helper.log"
