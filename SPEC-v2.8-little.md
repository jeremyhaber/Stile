# Sidebar v2.8 — Little windows and the Temporary list

Arc reference: links clicked in other apps open in a small "Little Arc" window; "Open In" (⌘O) promotes the link to a real tab; Little Arc windows archive automatically (default every 6 h); ⌘⌥N opens a quick search from anywhere. Our version adds a **Temporary** list so little links never pile up as windows.

## Concepts

- **Little window**: a small Chrome window holding exactly one temporary tab. Style is a user setting:
  - `minimal` (default): `chrome.windows.create({type: "popup"})` — just the page and Chrome's slim read-only address bar. Promotion to a full tab *reopens* the URL in the main window (Chrome can't move tabs out of popup windows); we carry the scroll position.
  - `regular`: `type: "normal"`, same size — shows Chrome's toolbar and tabs, but promotion moves the live tab (`tabs.move`), keeping all page state.
- **Temporary entry**: one link in the Temporary list, whether or not its little window is currently open.

## Extension

### Data (SW-owned, write queue, per profile; never for incognito)
`storage.local.temporary = [{ id, url, title, favIconUrl, createdAt, lastUsedAt, tabId|null, windowId|null, scrollY }]`, newest first, cap 200. Settings in `storage.sync`: `littleStyle: "minimal"|"regular"` (default minimal), `littleMaxOpen` (default 3), `temporaryMinutes` (default 360; 0 = never).

### SW commands
- `openLittle { url|null, bounds?, entryId? }` → creates a little window (style per setting). `url: null` opens `littlesearch.html` (below). `bounds {left, top, width, height}` from the app; default 760×620 centred on the last-focused normal window. Records/updates the entry (tabId, windowId, lastUsedAt) and focuses the window. If more than `littleMaxOpen` little windows are open, close the least recently used ones (their entries stay in the list with tabId/windowId null). Returns `{ok, windowId, tabId, entryId}`.
- `promoteLittle { entryId }` → target = main window (2.5 rules; if none, last-focused normal window, else create one).
  - regular style (or any normal-type little window): `tabs.move(tabId, {windowId: main, index: -1})`, activate, focus main window; little window closes by itself (close it if still open).
  - popup: read scrollY via `chrome.scripting.executeScript` (ignore failures), create the tab in main window (active) with the entry URL, after `status === "complete"` restore scroll with executeScript, then close the popup.
  - Remove the entry. The promoted tab is an ordinary Today tab.
- `reopenLittle { entryId }` → if its window is open, focus it; else `openLittle` with the entry's URL and id.
- `removeTemporary { entryId }` → archive the entry (Archive item with `source: "temporary"`), close its window if open.
- `moveToTemporary { tabId }` → create an entry from the tab (URL, title, favicon, scrollY) and close the tab (not opened in a little window — it's parked). Not for incognito or bound/locked tabs (locked: allowed, lock dropped? → disallow for locked; menu item hidden).
- `temporaryAction` helpers as needed for the panel.
- Window close: `windows.onRemoved` for a little window → its entry keeps url/title, tabId/windowId set to null (stays in the list). Tab navigation inside a little window updates the entry's url/title/favicon.
- Expiry (in the existing archive sweep): entries whose `lastUsedAt` is older than `temporaryMinutes` → archived with `source:"temporary"` and their window closed.
- Little windows are excluded everywhere else: Today window sections, main/pop-out logic, merge-on-close, snapshots, auto-archive of tabs, close interception (`sidebar.windowRoles` gains `littleWindowIds: number[]`; `sidebar.windowRolesChanged` fires when it changes).

### `littlesearch.html` (extension page)
Minimal page in the panel's visual style: a large search/address field focused on load, Enter → if URL-like navigate this tab (`location.href`), else `chrome.search.query({text, tabId: thisTab})`. Escape closes the window. Title "New little window".

### Panel UI
- **Temporary section** above Today, hidden when empty (2.5 empty-section rules), header "Temporary" with a count and a "Clear" that archives all entries. Rows: favicon, title, a small dot when its little window is open; hover actions: "Make full tab" (icon arrow-up-right, `data-testid="temp-promote"`), × (`temp-remove`). Click row → `reopenLittle`. Right-click: Make full tab, Open in little window, Copy link, Remove. `data-testid`s: `temp-section`, `temp-row`. Compact strip: follows 2.4 rules (icons in the column, dividers).
- Today row menu: "Move to Temporary" (`data-action="to-temporary"`).
- Archive view: entries with `source:"temporary"` show a small "Temporary" tag.
- Settings → "Little windows": 
  - switch "Open links from other apps in little windows" (`data-testid="little-default-browser"`) — sends native message `setDefaultBrowser {enabled}` to the app; disabled with a hint when the app isn't connected; reflects `settings.defaultBrowser` from the app (hello/broadcast).
  - Window style: Minimal / Regular (`little-style`), with one-line explanation of the trade-off.
  - Keep open at most: 1–5 (`little-max-open`).
  - Move temporary links to Archive after: 1 h / 6 h / 12 h / 24 h / Never (`temporary-expiry`).
  - Hint: "Control+Option+N opens a little window from anywhere."

## Host protocol (Swift HostServer + Node reference)
- extension → app `setDefaultBrowser { enabled, requestId }` → app attempts the change (Swift: real; Node: just store), replies `{ type: "defaultBrowser", enabled, ok, error?, requestId }`, broadcasts `{ type: "defaultBrowser", enabled }`; `hello.settings.defaultBrowser` (bool, the app's view of whether it is currently the default http handler AND the feature is on).
- app → extension: uses the existing bridge (`sidebar.cmd` → `openLittle` / `promoteLittle`).

## Mac app
- **Default browser**: Info.plist gains `CFBundleURLTypes` (http, https; `CFBundleURLName` "Web site URL", role Viewer) and `CFBundleDocumentTypes` for `public.html` / `public.xhtml` (role Viewer, rank Alternate) so macOS offers it as a browser. Enabling: `NSWorkspace.shared.setDefaultApplication(at: Bundle.main.bundleURL, toOpenURLsWithScheme: "http")` then `"https"` (completion handler; macOS shows its confirmation). Disabling: set Chrome (`NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome")`) back for both schemes. Current state: `NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com")!)` equals our bundle URL. Persist `littleLinksEnabled` in state.json; `settings.defaultBrowser` = enabled && actually default.
- **Receiving links**: `application(_:open urls: [URL])` in the AppDelegate (and make sure the connector-mode path is untouched). For each http(s) URL: if `littleLinksEnabled` and a live connection exists → pick the profile = the profile of Chrome's most recently focused mapped window, else the main/first connected profile → bring Chrome to the front (`NSRunningApplication.activate`), compute bounds (760×620 pt, centred on the screen containing the mouse, converted to Chrome's top-left screen coordinates) → bridge `sidebar.cmd {cmd:"openLittle", url, bounds}`. Otherwise (feature off, no connection, Chrome not running) → open the URL in Chrome: `NSWorkspace.shared.open([url], withApplicationAt: chromeURL, configuration: NSWorkspace.OpenConfiguration())`. Non-http(s) URLs → hand to Chrome the same way. Queue URLs received while connections are still starting (wait up to 5 s for a connection, then fall back to Chrome).
- **Hotkey Control+Option+N** (global, any frontmost app): `openLittle {url: null, bounds}` on the chosen profile; fallback when not connected: open Chrome.
- **Little window bar**: for windows listed in `littleWindowIds`, show a small native pill at the top-right inside the window (below Chrome's title area, ~8 pt from the right edge; same style as the 2.7 setup pill): "Open as tab ⌘O" → `promoteLittle`. ⌘O while a little window is Chrome's focused window → `promoteLittle` (event tap, swallow). Little windows never get the sidebar overlay or the setup pill, and the close interceptor ignores them.
- `windowRoles` cache already exists (2.5); extend it with `littleWindowIds`.

## Tests
- Node host (test-host.mjs): setDefaultBrowser reply/persist/broadcast, hello default false.
- e2e / overlay-e2e (extension): openLittle creates a popup window (minimal) with an entry; regular style creates a normal window; max-open closes the oldest but keeps its entry; closing a little window keeps the entry; reopen; promote minimal → new tab in main window with the URL and the popup closed and the entry removed; promote regular → same tab id moved into the main window; moveToTemporary parks the tab (tab closed, entry present); removeTemporary archives with source temporary; expiry via runArchiveNow with an aged entry; little windows absent from Today/window sections and not merged/snapshotted; windowRoles includes littleWindowIds and fires the change event; littlesearch.html navigates on Enter; settings controls present and stored; incognito never creates entries.
- All suites green.

## Pinned tabs reset on Chrome restart (extension)

User request: when Chrome reopens, pinned tabs (Favourites and Pinned items that were open) must come back at their original pinned location.

- Today, after a restart, bindings are rebuilt only for tabs whose URL exactly equals the bookmark URL, so a pinned tab that had navigated away comes back as an ordinary Today tab at the wandered-off URL.
- Fix: keep a persistent record `storage.local.boundTabs = [{ bookmarkId, url /* current URL of the bound tab */, windowIndex, index }]` (SW-owned, updated on bind/unbind, tabs.onUpdated url changes of bound tabs, tabs.onMoved/onAttached/onRemoved; debounced). `windowIndex` = position of the tab's window in `windows.getAll({windowTypes:['normal']})` ordered by id.
- On `runtime.onStartup` (and the existing delayed re-binding passes at 3 s / 10 s): for each record, find an unbound restored tab whose URL equals the record's current URL (prefer same windowIndex and nearest index); bind it to the bookmark; then if its URL differs from the bookmark URL, navigate it back (`tabs.update(tabId, {url: bookmark.url})`) — for discarded/unloaded restored tabs use `tabs.update` too (it loads only the target URL). Records that found no tab are dropped after the 10 s pass. Then also run the existing exact-URL matching for anything left.
- This reset happens only at browser startup, never during a session (the ↶ button remains for manual resets).
- Setting (Settings → Pinned): "Reset pinned tabs when Chrome restarts" (`data-testid="pinned-reset-on-restart"`, default on, `storage.sync.pinnedResetOnRestart`).
- Tests (e2e): bind a pinned tab, navigate it away, simulate restart (clear session bindings, call the startup rebinding path via a debug command, e.g. `debugRematch {mode:"startup"}`) → the tab is rebound to its bookmark and navigated back to the bookmark URL; with the setting off it's rebound but not navigated.
