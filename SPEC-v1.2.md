# Sidebar v1.2 — main window and pop-out windows

Builds on SPEC.md and SPEC-v1.1.md. Bump version to `1.2.0`. Keep every existing behaviour and `data-testid`.

## Concepts

- **Main window**: one normal window per profile that everything merges back into. All other normal windows are **pop-outs**.
- Choosing the main window: the first normal window of the session. Keep `storage.session.windowOrder` (array of normal window ids in creation order; on `runtime.onStartup`/`onInstalled`/SW start, seed it from `chrome.windows.getAll({windowTypes:['normal']})` sorted by id if it is empty or stale). `storage.session.mainWindowId` = the user's explicit choice if that window still exists, else the first id in `windowOrder` that still exists. When the main window closes, the next oldest becomes main automatically (no tabs move).
- The user can override from the panel: right-click a window section header → "Make this the main window" (SW `setMainWindow {windowId}`).

## Merging (manual, live tabs — never reload)

SW `mergeWindow {windowId}` moves every tab of that window into the main window at the end, keeping state:
- Tab groups: `chrome.tabGroups.move(groupId, {windowId: main, index: -1})` for each group (preserves title/colour/collapsed); ungrouped tabs via `chrome.tabs.move(ids, {windowId: main, index: -1})`, preserving relative order. Process in the source window's index order so the overall order is kept.
- Splits (when `splitViewId` ≥ 0): move both tabs together; if the split is lost after moving and `SPLIT_OK`, recreate it with `createSplit`.
- Chrome-pinned tabs: move them too (Chrome keeps them pinned).
- Bound sidebar tabs: rely on the existing `onAttached` rule (if the main window already has a tab bound to the same bookmark, the arriving one becomes a normal Today tab).
- The emptied window closes by itself; if it doesn't within 500 ms, close it.
- Focus the main window and activate the tab that was active in the merged window.

SW `mergeAll {}` merges every pop-out into the main window, oldest first.

## Merge back on close (automatic)

Setting: "When you close a pop-out window, move its tabs back to the main window" — `storage.sync.mergeOnClose`, default `true`, checkbox `data-testid="settings-merge-on-close"`.

Because a window's tabs are gone by the time `windows.onRemoved` fires, keep a snapshot:
- `storage.session.windowSnapshots`: `{ [windowId]: [{ url, title, pinned, favIconUrl, groupKey, splitKey, active }] , groups: {[groupKey]: {title, color, collapsed}} }` for every normal window, kept up to date (debounced ~300 ms) from `tabs.onCreated/onUpdated (url/title/pinned/groupId changes)/onMoved/onAttached/onDetached/onRemoved` and `tabGroups.onUpdated`. A tab closed individually (`tabs.onRemoved` with `isWindowClosing === false`) leaves the snapshot. Skip `chrome://newtab/` and `about:blank` entries.
- On `windows.onRemoved(windowId)` for a pop-out (not the main window) with `mergeOnClose` on:
  1. Take its snapshot and delete it from storage.
  2. Wait 1500 ms, then check that the main window (re-resolved) still exists and at least one normal window exists. If not, Chrome is quitting — do nothing.
  3. If the snapshot has **one** tab, don't reopen it (closing the only tab of a window is almost always deliberate); add it to the Archive instead.
  4. Otherwise reopen every tab in the main window, inactive, at the end, in order, restoring Chrome-pinned state, recreating groups (`chrome.tabs.group` + `tabGroups.update` title/colour), and splits (if `SPLIT_OK`). Rebind sidebar items by URL using the startup re-binding rule (only if the main window has no tab bound to that bookmark yet).
  5. Record `storage.session.lastMerge = { count, at, fromClose: true }` so the panel shows a toast "Moved N tabs back to the main window" (`data-testid="toast"`).
- If the main window itself is closed, nothing reopens (the next window simply becomes main).

## Panel UI

- In the window sections, the main window's section (when the panel is in a pop-out) is titled "Main window"; pop-out sections stay "Window". Each pop-out section header gets a small "Merge" button (`data-testid="window-merge"`, `aria-label="Merge into main window"`), visible on hover and always visible when focused.
- Today header: "Merge all" button (`data-testid="merge-all"`) next to "Clear", shown only when there is more than one normal window.
- When the panel is open in a pop-out window, show a compact bar under the profile switcher: "Pop-out window" + "Merge back" button (`data-testid="popout-bar"`, button `data-testid="popout-merge"`) that merges this window into the main one.
- Window section header context menu: "Merge into main window" (pop-outs), "Make this the main window", "Go to window".
- Toasts for merges ("Merged N tabs into the main window").
- In Settings add the `mergeOnClose` checkbox under a "Windows" heading.

## Testing hooks

`debugState` adds `mainWindowId`, `windowOrder`, and `snapshots` (window id → tab count).

## Bringing a tab from another window (change to v1.1 §1)

When a tab clicked in another window's section is moved here (`bringTab`) and it was the **active** tab of its source window, first activate the source window's next tab (the right-hand neighbour, else the left-hand one) so that window shows the next tab rather than whatever Chrome picks. If it was the source window's only tab, the source window closes as usual — this must NOT trigger merge-back-on-close (the tab was detached, so the snapshot is empty; make sure the snapshot is updated on `onDetached` before `windows.onRemoved` is handled, and treat an empty snapshot as nothing to do).

## Tab actions

Tab row context menu (Today rows in any section, and split halves where it makes sense) gets, in this order after the existing items, separated by a divider:
- **Duplicate tab** — `chrome.tabs.duplicate(tabId)` (opens next to it). `data-action="duplicate"`.
- **Close tab** (existing), **Close tabs above** (`close-above`), **Close tabs below** (`close-below`), **Close other tabs** (`close-others`), **Close all tabs** (`close-all`).
  - Scope: tabs in the same window, ordered by tab index. Never touch tabs bound to Favourites/Pinned or Chrome-pinned tabs. They close outright (no archive). Disable "above"/"below" when there's nothing to close.
  - "Close all tabs" asks for confirmation when it would close more than 5 tabs (existing confirm dialog), and if the window would be left with no tabs, open a new tab first so the window stays.
  - SW command `closeTabs {windowId, tabId, which: "above"|"below"|"others"|"all"}` returning `{ok, closed}`.

## Clear (change)

"Clear" now archives **every** Today tab in this window — including the active one and tabs in groups (the "Also archive tabs in groups" setting only affects auto-archive). Bound Favourites/Pinned tabs and Chrome-pinned tabs stay. Before archiving, if nothing would remain in the window, create a new tab and activate it. Show a toast "Archived N tabs" with an **Undo** button (`data-testid="toast-undo"`) that restores those archived tabs into the window in their original order (and removes them from the archive). Undo is available for 8 seconds.

## Tidy (by website)

A "Tidy" button in the Today header (`data-testid="tidy-button"`, next to Clear and Merge all) — SW `tidyWindow {windowId}`:
- Considers only ungrouped, unbound, non-Chrome-pinned tabs with http(s) URLs in that window.
- Site key = hostname without a leading `www.`; additionally collapse to the last two labels for hosts with 3+ labels (e.g. `docs.github.com` → `github.com`), except for common two-part public suffixes (`co.uk`, `com.au`, `co.jp`, `com.br`, `co.nz`, `org.uk`, `ac.uk`, `gov.uk`) where you keep three labels.
- Sites with 2 or more tabs become a group; single tabs are left alone. If the window already has a group whose title equals that site's group title, add the tabs to it instead of making a new one.
- Group title = site name from the key: first label, capitalised (`github.com` → "GitHub" only if you special-case; otherwise "Github" is fine; `nytimes.com` → "Nytimes"). Keep a small map of nicer names for very common sites (GitHub, YouTube, Google Docs for docs.google.com BEFORE collapsing, Gmail for mail.google.com BEFORE collapsing, Google Drive, Notion, Figma, Slack, Linear, Jira/Atlassian, Stack Overflow, Reddit, Wikipedia, LinkedIn, X/Twitter, Amazon) — match on the full hostname first, then the collapsed key.
- Colour: deterministic from the site key across Chrome's 9 group colours.
- Groups are placed in order of each site's first tab; leave non-grouped tabs where they are.
- Toast "Tidied N tabs into M groups" with Undo (ungroups exactly the tabs it grouped, restores original indexes).
- If nothing to tidy, toast "Nothing to tidy".

## Testing hooks (additions)

SW also answers `{cmd:"lastUndo"}` → `{kind, ...}` for tests (optional).

## Rename tabs (Arc-style)

- Today tabs (in any section) and split halves can be renamed: double-click the row title, or right-click → "Rename tab" (`data-action="rename-tab"`). Inline editing uses the existing `rename-input`. Enter saves, Escape cancels, an empty name resets.
- Right-click → "Reset name" (`data-action="reset-name"`) when a custom name is set.
- Storage (SW-owned): `storage.local.tabNames = { [tabId]: { name, url } }`. Dropped when the tab closes. After a browser restart, re-attach names to tabs by exact URL (first unclaimed match). Commands `renameTab {tabId, name}` (empty name = reset).
- The custom name shows in the panel instead of the page title (with the real title in the row tooltip). It is ALSO applied to the actual page title so Chrome's tab strip and window title match: the boosts content script (below) sets `document.title` to the custom name and keeps it there with a MutationObserver on `<title>` while a name is set. It gets the name by asking the SW (`{cmd:"getTabName"}` from the content script; the SW answers using `sender.tab.id`) and listens for `chrome.storage.onChanged` on `tabNames`.
- Favourites and pinned items keep their existing Rename (bookmark title). Also allow double-click on a pinned row's title to rename it.

## Boosts: Zap and Code (per exact hostname)

A boost belongs to one exact hostname (`location.hostname`). `youtube.com`, `www.youtube.com` and `music.youtube.com` are three different boosts — never apply a boost to subdomains.

### Manifest / permissions

Add `host_permissions: ["<all_urls>"]` and permissions `scripting`, `userScripts`. Add a static content script `boost-content.js`: `matches: ["<all_urls>"]`, `run_at: "document_start"`, `all_frames: false`.

### Data (SW-owned, `storage.local.boosts`)

```
boosts = { [hostname]: { enabled: true, zaps: [{ id, selector, label, createdAt }], css: "", js: "", updatedAt } }
```

### Applying

- **CSS + zaps**: `boost-content.js` reads `boosts[location.hostname]` at document_start and injects/updates a single `<style id="__sidebar_boost__">` (append to `document.documentElement` as early as possible) containing every zap as `<selector> { display: none !important; }` followed by the custom CSS. Updates live on `chrome.storage.onChanged`. Removes the style when the boost is disabled or deleted. It also handles the tab-title override above.
- **JS**: use `chrome.userScripts.register` with id `boost-<hostname>`, `matches: ["*://<hostname>/*"]` (exact host), `js: [{code}]`, `world: "MAIN"`, `runAt: "document_idle"`. Keep registrations in sync with `boosts` on SW startup and on every change (update/unregister). JS takes effect on next page load; the panel offers "Reload page".
- **User scripts availability**: detect with `try { await chrome.userScripts.getScripts(); ok = true } catch { ok = false }` (also false if `chrome.userScripts` is undefined). When unavailable, the JS tab shows: "To run custom JavaScript, turn on Allow User Scripts for Sidebar" + a button that opens `chrome://extensions/?id=<extension id>`; CSS and Zap still work. Re-check when the panel's Boost view opens.
- Pages where extensions can't run (`chrome://`, `chrome-extension://`, the Chrome Web Store, `about:`, `file:` unless allowed) → the Boost view says "Boosts aren't available on this page".

### Zap (element picker)

- SW `startZap {tabId}`: `chrome.scripting.executeScript({target:{tabId}, files:["zap-picker.js"]})`, then focus that tab's window.
- `zap-picker.js` (idempotent if injected twice): full-page overlay that never blocks the page visually; hovering outlines the element under the cursor (use `elementsFromPoint`, ignore the picker's own nodes) with a small label showing tag/id/class; **ArrowUp** selects the parent, **ArrowDown** goes back toward the original element; **click** zaps it: hide immediately, compute a selector and send `{cmd:"addZap", hostname, selector, label}` to the SW, keep picking; **Escape** or the floating "Done" pill ends zap mode. A floating pill at the bottom centre shows "Zap — click elements to hide · Esc to finish" and an "Undo" for the last zap in this session. Must not break page scrolling; use `pointer-events` carefully and capture-phase listeners that `preventDefault` + `stopPropagation` only while picking.
- Selector generation: prefer `#id` if the id looks stable (not mostly digits/hex, length < 40) and is unique; otherwise build the shortest unique path from the nearest stable-id ancestor (or body) using `tag`, stable-looking classes (skip classes with digits-heavy hashes like `css-1x2y3z`, `sc-…`, or `_abc123`), and `:nth-of-type()` only when needed. Verify `document.querySelectorAll(sel).length === 1` at the moment of zapping (it's fine if a stable class selector matches several similar elements only when the user zapped one of them — keep it unique).
- `label`: short human text — e.g. `div.sidebar` or the element's aria-label/text snippet (≤ 40 chars).

### Panel UI

- A **Boost** icon button (paint-brush/sparkles icon) at the right end of the address field row (`data-testid="boost-button"`). It shows a filled/coloured state when the active tab's hostname has an enabled boost. Click → Boost view for the active tab of the panel's window.
- **Boost view** (replaces main list like Archive/Settings, back button `back-button`), `data-testid="boost-view"`:
  - Header: hostname, and an on/off switch for the boost (`data-testid="boost-enabled"`).
  - **Zap** card button with a bolt icon (`data-testid="zap-button"`), styled like the user's Arc screenshot: large rounded card, label left, icon right. Below it, the list of zapped elements (`data-testid="zap-row"`), each with its label/selector and a × to unhide (`data-testid="zap-remove"`); "Unhide all" when 2+.
  - **Code** card button with `{}` icon (`data-testid="code-button"`) that expands an editor: two tabs CSS / JS (`data-testid="code-tab-css"`, `code-tab-js`), a monospace `<textarea>` (`data-testid="code-editor"`, tab key inserts two spaces, ⌘S saves), Save button (`data-testid="code-save"`), saved/unsaved state indicator, "Reload page" button. CSS saves apply live; JS saves note "Runs on next load".
  - "Delete boost" at the bottom (confirm).
- **Settings** gets a "Boosts" section listing boosted hostnames (`data-testid="boost-site-row"`) with on/off and delete.
- Visual style consistent with the rest of the panel (profile tint etc.), with the card buttons resembling the screenshot (rounded 14px, soft fill, bold label left, icon right).

### SW commands

`getBoost {hostname}`, `saveBoost {hostname, patch}` (merge `enabled|css|js`), `addZap {hostname, selector, label}`, `removeZap {hostname, id}`, `clearZaps {hostname}`, `deleteBoost {hostname}`, `startZap {tabId}`, `stopZap {tabId}` (sends a message to the picker to end), `userScriptsStatus {}` → `{available}`, `getTabName {}` (from content script).

## Favicons for favourites and pinned items (fix)

Pinned items and favourite tiles currently often show the generic globe, because `_favicon/?pageUrl=` only knows icons for exact URLs Chrome has cached. Fix, in this priority order:
1. If the item is open (bound tab in this window or any window), use that tab's `favIconUrl`.
2. `storage.local.faviconCache`: SW-owned map `{ [hostname]: favIconUrl }`, updated whenever any tab reports a `favIconUrl` (`tabs.onUpdated` with `changeInfo.favIconUrl`, and on startup from all tabs). Skip `chrome://` and empty values; keep `data:` URLs only if < 20 KB. Cap 1000 hosts (drop oldest).
3. `_favicon/?pageUrl=<bookmark url>&size=32`, and if that image comes back as Chrome's default (detect: load it into an offscreen canvas and compare its pixel data hash against the hash of `_favicon/?pageUrl=https://example.invalid/&size=32`, computed once per panel load), try `_favicon/?pageUrl=<origin>/&size=32`.
4. Fallback: a letter tile (first letter of the hostname on a soft colour derived from the hostname) instead of the globe — favourites tiles and pinned rows both.
Apply the same chain to Today rows when `tab.favIconUrl` is empty, and to archive rows (store `favIconUrl` at archive time; it already is).
