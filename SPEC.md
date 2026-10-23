# Sidebar — Arc-style side panel for Chrome (Mac)

Two parts:

1. `extension/` — a Manifest V3 Chrome extension. All UI lives in Chrome's side panel. No content scripts, no host permissions.
2. `helper/` — a small native messaging host (Perl, core modules only, runs with the macOS system `/usr/bin/perl`) plus `install.sh` / `uninstall.sh`. Handles anything that crosses Chrome profiles: profile list, profile switching, and a shared "archive default" setting.

The extension must work fully without the helper; the profile switcher and the cross-profile default simply show as unavailable with a short setup hint.

Fixed identifiers (do not change):

- Extension ID: `ffblekellgdmlecjablfojaaadpkmdgg`
- Manifest `key` (gives that ID):
  `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzdeEuaIu2+SMvOlZh8DQoCr4pR8Jqxi5Ln/5JnEf3shuxpT+EdRPi3Gefw25R09s1Vh/aE70n5eA4lilqf18su5+7lQ+wvJc/kCeNFwsrhyi9XK/sbbCEoPN/x+ssSuht2wCCcEZ9Z4EmQ/j9S7Mr+tm8ci/6KErXUbjNS4/EzHrj41TMpbjx/CbGb4L7Bvf4oIvoTKoYBCzQ3czmGrcFQ8q3+tuY75yUatLeZukQXPAz6nohLTncAJF4OuUSCwBVs3Y9juRbFuvmD4owNkSGCG6jEjtUgIW2SFYUqtgYiitpfAMBJb95oy4PiqBxub8zWGQZEM9zkbdyQ+HYN0yZQIDAQAB`
- Native host name: `com.sidebar.helper`

---

## Native messaging protocol (extension ⇄ helper)

Transport: standard Chrome native messaging (4-byte native-endian uint32 length prefix + UTF-8 JSON). The extension's service worker opens ONE long-lived port with `chrome.runtime.connectNative("com.sidebar.helper")` (this also keeps the service worker alive while connected). Chrome starts one helper process per profile.

### Extension → helper

| Message | Helper does | Reply |
|---|---|---|
| `{type:"hello", extVersion}` | Reads Chrome's `Local State`, reads shared state file | `{type:"hello", hostVersion, profiles:[Profile], settings:{archiveDefaultMinutes}}` |
| `{type:"identify", profileDir}` | Remembers which profile it serves. Binds its Unix socket for that profile (see below). If a pending handoff file exists for this profile and is < 60 s old, sends `{type:"activate", bounds}` and deletes the file. | `{type:"identified", profileDir}` |
| `{type:"getProfiles"}` | Re-reads `Local State` | `{type:"profiles", profiles:[Profile]}` |
| `{type:"switchProfile", targetDir, bounds}` | If the target profile's socket accepts a connection: send it `{type:"activate", bounds}`. Otherwise write a pending handoff file for the target and launch Chrome with `--profile-directory=<targetDir>` (detached). | `{type:"switchResult", ok, method:"focused"\|"launched", error?}` |
| `{type:"setGlobalSettings", settings:{archiveDefaultMinutes}}` | Writes shared state file (with `flock`), then notifies every other live profile socket with `{type:"settings", settings}` | `{type:"settings", settings}` |

Every reply also echoes `requestId` if the request had one.

### Helper → extension (unsolicited)

- `{type:"activate", bounds}` — bring this profile's window forward (see extension behaviour).
- `{type:"settings", settings}` — shared settings changed.

### Types

```
Profile = { dir: "Default" | "Profile 1" | ..., name: string, email: string (may be ""), color: "#rrggbb" | null }
bounds  = { left, top, width, height, state: "normal" | "maximized" | "fullscreen" } | null
```

Profiles come from `Local State` → `profile.info_cache` (`name`, `user_name` → email, `profile_highlight_color` or `default_avatar_fill_color`, both signed 32-bit ARGB ints → convert to `#rrggbb`). Order: `profile.profiles_order` if present, else `Default` first then by name. Skip entries whose dir starts with `Guest` or `System`.

### Helper-to-helper

Each helper that has been told its profile listens on a Unix domain socket `<HELPER_DIR>/sock/<safe>.sock` where `<safe>` is profileDir with every char outside `[A-Za-z0-9._-]` replaced by `_`. Protocol: connect, write one line of JSON + `\n`, close. Messages: `{type:"activate", bounds}`, `{type:"settings", settings}`, `{type:"shutdown"}`.

On `identify`: if the socket path exists and a connection succeeds, send `{type:"shutdown"}` (an older helper for the same profile), wait briefly; then unlink and bind. A helper exits (removing its socket) when stdin hits EOF or it receives `shutdown`.

### Paths (all overridable by env var for testing)

- `SIDEBAR_HELPER_DIR` — default `~/Library/Application Support/SidebarHelper` (contains `state.json`, `sock/`, `pending/`, `helper.log`)
- `SIDEBAR_LOCAL_STATE` — default `~/Library/Application Support/Google/Chrome/Local State`
- `SIDEBAR_CHROME_BIN` — default `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Launch by executing this binary directly (NOT `open`), args `--profile-directory=<dir>`; when Chrome is already running this hands off to the running instance and opens a window in that profile.

`state.json`: `{ "archiveDefaultMinutes": 720 }` (default 720 = 12 h; 0 = never).
Pending handoff file: `pending/<safe>.json` = `{ bounds, ts }` (ts in epoch seconds).

---

## Extension behaviour

### Manifest

MV3, name "Sidebar", the `key` above, `side_panel.default_path: "sidepanel.html"`, background service worker `background.js` (type module), an `action` (clicking it opens the panel via `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`), command `_execute_action` with suggested key `Alt+S` (default and mac). Permissions: `sidePanel, tabs, bookmarks, storage, unlimitedStorage, alarms, nativeMessaging, search, favicon, identity, identity.email`. No `host_permissions`, no content scripts. Icons 16/32/48/128 PNG.

Favicons: `chrome-extension://<id>/_favicon/?pageUrl=<url>&size=32` (the `favicon` permission), fallback to a generic globe.

### Data

- Bookmarks are the source of truth for favourites and pinned items. Root: a folder titled `Sidebar` inside "Other bookmarks" (find via `chrome.bookmarks.getTree()`; prefer the child with `folderType === "other"`, else the second child). Inside it: `Favourites` (flat list of bookmarks) and `Pinned` (tree of bookmarks and folders). Find by title before creating, so sync never creates duplicates; cache ids in `storage.local` and re-resolve if invalid.
- `storage.session.bindings`: `{ [tabId]: bookmarkId }` — which open tab "is" a favourite/pinned item. A bookmark can be bound to at most one tab per window. Rebuilt after browser restart: on startup, for each window, bind the first tab whose URL exactly equals an unbound sidebar bookmark URL.
- `storage.local.lastActive`: `{ [tabId]: epochMs }`. On `runtime.onStartup` and `onInstalled`, reset every existing tab to now.
- `storage.local.archive`: array, newest first, cap 1000: `{ id, url, title, favIconUrl, archivedAt }`.
- `storage.sync.archiveMinutes`: this profile's setting; `null` means "use the default for all profiles".
- `storage.local.globalDefaultMinutes`: cached copy of the helper's `archiveDefaultMinutes` (720 if helper never connected). If the helper is not available, editing the "default for all profiles" control is disabled with a hint.
- `storage.local.profileDir`: manual override for which profile this is.
- `storage.local.collapsed`: `{ [folderBookmarkId]: true }`.
- `storage.session.helper`: `{ status: "connected"|"not_installed"|"error", error?, profiles, currentProfileDir }` for the panel to render.

The service worker is the single writer of `bindings`, `lastActive`, `archive`, `helper`. The panel sends it commands with `chrome.runtime.sendMessage({cmd, ...})` and listens to `chrome.storage.onChanged`, `chrome.tabs.*`, `chrome.bookmarks.*` to re-render (debounced ~50 ms). The panel may edit bookmark structure (rename, move, new folder, delete) directly with `chrome.bookmarks`.

### Service worker commands (`{cmd}` → `sendResponse({ok, ...})`)

`openItem {bookmarkId, windowId}` — activate the bound tab in that window, or create a tab there with the bookmark URL and bind it.
`closeItem {bookmarkId, windowId}` — close the bound tab in that window (item goes back to "not open" look).
`resetItem {bookmarkId, windowId}` — navigate the bound tab back to the bookmark URL.
`pinTab {tabId, target:"favourites"|"pinned", parentId?, index?}` — create a bookmark from the tab (title + url) in the given place and bind the tab to it.
`unpin {bookmarkId}` — remove the bookmark; any bound tabs stay open and become ordinary "Today" tabs.
`archiveTab {tabId}` — save to archive and close.
`clearToday {windowId}` — archive every Today tab in the window except the active one.
`restoreArchived {id, windowId}` — open it in that window (active) and remove from archive.
`deleteArchived {id}`, `clearArchive {}`.
`switchProfile {targetDir, windowId}` — send `switchProfile` with the window's bounds; if ok, minimise the source window after ~350 ms (try/catch; if the window is fullscreen, skip minimising).
`setProfileArchive {minutes|null}`, `setGlobalArchive {minutes}`, `setProfileDir {dir}`, `retryHelper {}`, `runArchiveNow {}` (runs the archive sweep immediately; used by tests).

### Auto-archive

Alarm `archive-sweep` every 1 minute. Effective threshold = `storage.sync.archiveMinutes ?? storage.local.globalDefaultMinutes`; `0` = never. A tab is archived when `now - lastActive[tabId] >= threshold` AND it is not: active in its window, Chrome-pinned, bound to a sidebar item, audible, or in a non-normal window. Tabs with no `lastActive` entry get one set to now instead. Blank new-tab pages (`chrome://newtab/`, `about:blank`) are closed without an archive entry.

"Last used" tracking: `tabs.onCreated` → now. `tabs.onActivated` → now for the new tab AND for the tab that was previously active in that window (keep `storage.session.activeByWindow`). `windows.onFocusChanged` → now for the active tab of the newly focused window and the previously focused one. `tabs.onRemoved` → delete entry and any binding. `bookmarks.onRemoved` → drop bindings pointing at removed ids (including children of removed folders).

### `activate` from helper

Pick `chrome.windows.getLastFocused({windowTypes:["normal"]})`; if none, create a window. If it is minimised set `state:"normal"` first. If bounds: for `maximized`/`fullscreen` apply that state; otherwise apply `left/top/width/height` with `state:"normal"`. Then `focused:true`.

### Profile identity

After `hello`, determine this profile's dir: `storage.local.profileDir` if set; else `chrome.identity.getProfileUserInfo({accountStatus:"ANY"})` email matched case-insensitively against `profiles[].email` (only if exactly one match). Then send `identify`. If unknown, the panel asks once ("Which profile is this?") with a small inline picker.

### Panel UI (`sidepanel.html` / `.css` / `.js`)

Per window (`chrome.windows.getCurrent()`). Visual direction: Arc-like, calm and compact. System font (`-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`), 13 px, rows 30 px tall with 8 px radius, soft hover fill, active row a stronger fill with a subtle ring. Light and dark via `prefers-color-scheme`, defined as CSS custom properties. Gentle tint from the current profile's colour on the panel background (very low alpha) if known. No heavy borders, no shadows except small menus. Smooth but quick transitions (≤120 ms). All icons inline SVG (no external fonts or CDNs — extension CSP).

Top to bottom:

1. **Profile switcher** (only when helper connected and ≥ 2 profiles): horizontal row of pills — colour dot + name; current one filled. Click another → `switchProfile`. If current profile unknown, show a one-line inline picker instead.
2. **Address field**: placeholder "Search or enter address". Enter → if it looks like a URL (has a scheme, or a dot and no spaces, or `localhost`) open it in a new active tab in this window (prepend `https://` if no scheme); otherwise `chrome.search.query({text, disposition:"NEW_TAB"})`. `Escape` clears.
3. **Favourites**: grid of square tiles (4 per row at default width, `repeat(auto-fill, minmax(52px,1fr))`), each the site favicon. Tooltip = title. Bound+open tiles show a small dot; the active tab's tile is highlighted. Empty state: a dashed drop zone "Drag tabs here for favourites".
4. **Pinned**: header "Pinned" with a "+" (new folder) button. Tree of folders (chevron, collapsible, collapse state remembered) and items (favicon + bookmark title). Not-open items are slightly dimmed; open items normal; active item highlighted. When a bound tab's current URL differs from the bookmark URL, show a small "back" arrow button (title "Back to pinned page") → `resetItem`. Hover shows an × that closes the bound tab (`closeItem`) — only when open. Right-click menu: items → Rename, Replace with current page URL (only if open), Unpin; folders → Rename, New folder inside, Delete folder (confirm if it has children). Rename is inline editing.
5. **Today**: header "Today" with "Clear" (→ `clearToday`) and a "+ New tab" row at the top of the list. Lists this window's tabs that are not bound, in tab index order. Favicon + title, × on hover (closes tab), active highlighted, audible tabs show a small speaker icon. If time until archive < 60 min, show a faint clock icon whose tooltip says "Archives in N min". Click → activate tab.
6. **Footer**: "Archive" button (with count) and a settings gear.

**Drag and drop** (HTML5 DnD inside the panel): reorder Today tabs (`tabs.move`); drag a Today tab onto Favourites or into Pinned (between items or onto a folder) → `pinTab`; reorder/move favourites and pinned items/folders (`bookmarks.move`); drag a favourite/pinned item onto Today → `unpin`; drag a pinned item onto Favourites and vice versa → `bookmarks.move`. Show a thin insertion line and folder hover highlight.

**Archive view** (replaces the main list, back button at top): search box filtering title/url; entries grouped by day ("Today", "Yesterday", date); click → `restoreArchived`; × → `deleteArchived`; "Clear archive" at the bottom with confirm.

**Settings view** (replaces the main list, back button):
- "Archive tabs after" for this profile: select with "Default for all profiles (12 hours)", 1 hour, 6 hours, 12 hours, 24 hours, 3 days, 7 days, 30 days, Never.
- "Default for all profiles": same choices minus the first. Enabled only when helper connected.
- "This profile": picker of helper profiles (shown when helper connected).
- Profile helper status line: "Connected" / "Not installed — run helper/install.sh, then Retry" with a Retry button / error text.
- Tips: "Put this panel on the left: Chrome Settings → Appearance → Side panel position" and a button "Change keyboard shortcut" that opens `chrome://extensions/shortcuts` in a new tab.

Accessibility: buttons are real `<button>`s with `aria-label`s, list rows are focusable, Enter activates, Delete/Backspace on a focused Today row closes it.

---

## Helper deliverables

- `helper/sidebar-helper.pl` — the host. `#!/usr/bin/perl`, `use strict; use warnings;`, only core modules (`JSON::PP`, `IO::Socket::UNIX`, `IO::Select`, `Fcntl`, `POSIX`, `File::Path`). Single-threaded `IO::Select` loop over STDIN (binary, buffered, framed) and the listening socket. Logs to `helper.log` (rotate/truncate at 1 MB). Never writes anything to STDOUT except framed messages. Robust to malformed input (log and continue).
- `helper/com.sidebar.helper.json.template` — host manifest with `__HELPER_PATH__` placeholder, `"type":"stdio"`, `allowed_origins: ["chrome-extension://ffblekellgdmlecjablfojaaadpkmdgg/"]`.
- `helper/install.sh` — copies the helper to `~/Library/Application Support/SidebarHelper/sidebar-helper.pl`, `chmod +x`, removes quarantine attr (`xattr -d com.apple.quarantine` ignore errors), writes the manifest into `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sidebar.helper.json`, checks `/usr/bin/perl` exists, prints next steps. Idempotent.
- `helper/uninstall.sh` — removes both.
- `helper/test-helper.pl` (or `.sh`) — a test driver usable on Linux: sets the env overrides to a temp dir with a fake `Local State` and a fake chrome binary (shell script that records its args), spawns two helper processes speaking the framed protocol, and checks: hello → profiles parsed with colours; identify; switchProfile to an identified profile → that helper emits `activate` with the same bounds; switchProfile to an unidentified profile → fake chrome launched with `--profile-directory`, pending file written; a helper then identifying as that profile emits `activate`; setGlobalSettings → persisted and broadcast to the other helper; stdin EOF → socket removed.
