#!/bin/bash
# Removes the Sidebar native messaging helper. Safe to run repeatedly.
# Pass --purge to also delete saved shared settings (state.json) and logs.
set -euo pipefail

HELPER_DIR="${SIDEBAR_HELPER_DIR:-$HOME/Library/Application Support/SidebarHelper}"
NMH_DIR="${SIDEBAR_NMH_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

say() { printf '%s\n' "$*"; }

say "Sidebar helper uninstaller"
say "--------------------------"

removed=0
rm_if() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    rm -rf "$1"
    say "Removed $1"
    removed=1
  fi
}

rm_if "$NMH_DIR/com.sidebar.helper.json"
rm_if "$HELPER_DIR/sidebar-helper.pl"
rm_if "$HELPER_DIR/sidebar-helper.pl.new"
rm_if "$HELPER_DIR/sock"
rm_if "$HELPER_DIR/pending"
if [ "$PURGE" = 1 ]; then
  rm_if "$HELPER_DIR/state.json"
  rm_if "$HELPER_DIR/helper.log"
  rm_if "$HELPER_DIR/helper.log.1"
fi
rmdir "$HELPER_DIR" 2>/dev/null || true

if [ "$removed" = 0 ]; then
  say "Nothing to remove; the helper was not installed."
else
  say "Done. Helper processes already running exit when Chrome closes the extension port."
  [ "$PURGE" = 1 ] || say "Settings and logs were kept in $HELPER_DIR (use --purge to delete them)."
fi
