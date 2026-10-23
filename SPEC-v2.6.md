# Sidebar v2.6 — lock tabs, incognito

## 1. Lock tabs (extension)

- Context menu on Today rows (and split halves): "Lock tab" / "Unlock tab" (`data-action="lock"` / `"unlock"`). Also in the native overlay menu.
- Locked tab: small lock icon after the title in expanded rows (`data-testid="lock-icon"`); in the compact strip, a tiny lock badge at the icon's bottom-right inside the pill. Same vertical positions as always (2.4 rules).
- SW storage: `storage.local.lockedTabs = { [tabId]: { url } }`, SW-owned via the existing write queue. Dropped when the tab closes. After a browser restart, re-attach by exact URL (first unclaimed match), same as `tabNames`. SW command `setTabLock {tabId, locked}`.
- Effects: auto-archive never archives a locked tab; `clearToday` skips locked tabs; `closeTabs` with `others` / `all` / `above` / `below` skips locked tabs (and the confirm count excludes them); Tidy still groups them. Closing the tab itself (×, Cmd+W, "Close tab") still works. Merging/moving windows keeps the lock (tab id unchanged). If a locked tab is in a window being merged-back-from-snapshot (recreated), carry the lock to the new tab.
- `debugState` includes `lockedTabs`.

## 2. Incognito (extension + Mac app)

- Manifest: keep the default `"incognito": "spanning"` (explicitly set it). Chrome only runs the extension in incognito if the user enables "Allow in Incognito".
- Extension, when incognito is allowed (`chrome.extension.isAllowedIncognitoAccess()`), treats incognito as a separate world:
  - A panel/overlay in a normal window lists only normal windows' tabs; a panel/overlay in an incognito window lists only incognito windows' tabs (filter by `tab.incognito` / `window.incognito`).
  - Incognito tabs are never archived (auto-archive skips them; Clear in an incognito window closes instead of archiving, with Undo disabled and a note "Incognito tabs aren't archived"), never added to window snapshots / merge-back-on-close, `tabNames`/`lockedTabs` for incognito tabs are kept in `storage.session` only (not `storage.local`), and favicons cache skips incognito.
  - Main window / pop-out logic and merging only ever consider windows of the same incognito-ness; a normal tab is never moved into an incognito window or vice versa (bringTab across the boundary is not offered).
  - Favourites/Pinned clicked from an incognito window open in that incognito window (bookmarks are shared — that's Chrome's behaviour too).
- Mac app:
  - A Chrome window that no connected profile reports in `windows.getAll` (after mapping retries, ~3 s) while at least one profile *is* connected is treated as **unsupported** (typically incognito with the extension not allowed): no sidebar, no setup card, no close interception — leave Chrome's own UI fully visible. Re-check when windows/connection state changes (if the extension later reports it, map it normally).
  - Also detect incognito explicitly where possible: AX window title ends with "(Incognito)" or the window's `AXRoleDescription`/`AXDescription` mentions incognito → treat as unsupported unless the window is mapped.
  - The setup card ("Add the Sidebar extension to this profile") only appears when NO connection exists for any profile that has open windows, or when the window's profile can be positively identified as lacking the extension.
  - Close interception (2.5 §6) never applies to unsupported/unmapped windows.
- Tests (overlay-e2e / e2e, extension side): with incognito access allowed in the test browser (Playwright: launch with the extension and enable incognito via `chrome.extension.isAllowedIncognitoAccess` — if enabling isn't possible in the harness, unit-test the filtering by injecting `incognito:true` tabs/windows through the overlay bridgeHttp fake like the split hook), assert separation of lists, no archive entries for incognito, no snapshot. Lock tests: lock/unlock via menu, lock icon, auto-archive skips locked, Clear skips locked, close-others skips locked, lock survives `runArchiveNow`, restart rematch by URL (simulate by clearing session and re-running the startup rematch).
- All suites green.
