# Sidebar v1.1 — changes on top of SPEC.md

Bump `manifest.json` version to `1.1.0`. Add permission `tabGroups`. Everything in SPEC.md still applies unless changed here. Keep all existing `data-testid`s working.

## 1. Today shows every tab in the profile

The Today list now covers all normal windows in the profile, not just the panel's window.

- **This window first:** the panel's own window's tabs (and groups, see §3) come first, with no header, exactly as now.
- **Then one section per other window:** header row "Window · N tabs" (use the active tab's title as a subtitle, truncated), collapsible (collapse state in `storage.local.collapsedWindows`, keyed by windowId; prune stale ids). `data-testid="window-section"` with `data-window-id`.
- **Clicking a tab from another window MOVES it into the panel's window** (append at the end, or right after the active tab) and activates it. Moving a tab that is in a split (§4) moves both halves together; a tab in a group moves out of its group (Chrome can't move a single tab with its group). Implement as SW command `bringTab {tabId, windowId}`.
- Context menu on a tab in another window also offers "Go to its window" (focus that window and activate the tab, no move).
- Bound (favourite/pinned) tabs stay hidden from Today in every window, as now.
- Every panel instance re-renders on `windows.onCreated/onRemoved/onFocusChanged` and `tabs.onAttached/onDetached` too.

## 2. Break out into a new window

- While dragging a Today row, a group header (§3), or a split row (§4), show a drop zone pinned to the bottom of the panel: "Drop to open in a new window" (`data-testid="new-window-drop"`). Drop → SW `moveToNewWindow {tabId}` / `{groupId}` / `{splitViewId}`: `chrome.windows.create({tabId, focused:true})`; for groups, create the window with the first tab then `chrome.tabGroups.move(groupId, {windowId, index:-1})`; for splits move both tabs.
- Same action in context menus: "Move to new window" on tabs, groups, splits.
- After the new window is created, the panel that handled the drop calls `chrome.sidePanel.open({windowId: newId})` (wrapped in try/catch — it needs a user gesture and may fail; that's fine).
- Also add a "New window" item to the footer (icon button, `data-testid="new-window-button"`) that opens an empty window and tries `sidePanel.open` for it.

## 3. Tab groups

Render Chrome tab groups inside Today (in both "this window" and other-window sections), in tab-index order:

- **Group header row** (`data-testid="group-row"`, `data-group-id`): coloured dot (map Chrome colours grey/blue/red/yellow/green/pink/purple/cyan/orange to tasteful hex values in both themes), title (or "Unnamed group"), tab count when collapsed, chevron. Click toggles collapse via `chrome.tabGroups.update(groupId, {collapsed})` so it matches Chrome's own strip. Its tabs render indented beneath with a thin coloured left rule.
- **Group header context menu:** Rename (inline, `rename-input`), Colour (submenu or inline swatches of the 9 colours, `data-testid="group-color"` with `data-color`), New tab in group, Move to new window, Move group to this window (only for other windows), Ungroup (`chrome.tabs.ungroup`), Archive group (archives all its tabs), Close group.
- **Tab context menu:** "Add to new group" (`chrome.tabs.group({tabIds:[id]})`, then start inline rename of the new group), "Add to group" with the groups in that tab's window listed, "Remove from group" when grouped.
- **Drag and drop:** dropping a tab onto a group header, or between tabs inside a group, adds it to that group at that position (move to that window first if needed). Dropping a grouped tab between ungrouped tabs ungroups it there. Dragging a group header reorders the group (`chrome.tabGroups.move`), or moves it to another window section, or to the new-window zone.
- **Auto-archive:** tabs inside groups are NOT archived by default. Add a settings checkbox "Also archive tabs in groups" (`storage.sync.archiveGrouped`, default false, `data-testid="settings-archive-grouped"`). "Clear" in Today also skips grouped tabs unless that setting is on.

## 4. Split view (drag a tab onto a tab)

Chrome 155+ exposes `chrome.tabs.createSplit(tabIds)`, `chrome.tabs.create({splitWithTabId})`, `chrome.tabs.unsplit(splitViewId)` and `tab.splitViewId` (-1 or absent when not split). Feature-detect: `const SPLIT_OK = typeof chrome.tabs.createSplit === 'function'`. Read `splitViewId` whenever present, even if creating isn't supported.

- **Display:** two tabs sharing a `splitViewId` (≥ 0) render as ONE row (`data-testid="split-row"`, `data-split-id`) with two halves side by side, each with favicon + title, separated by a thin divider; each half is independently clickable (activates that tab) and has its own × on hover. A small split icon at the left of the row.
- **Create by drag:** when `SPLIT_OK`, dragging a Today row over the *middle 50%* of another Today row (or a split-able pinned/favourite item onto a Today row) highlights the target with a split indicator (`.split-target`) instead of the insertion line; drop → SW `splitTabs {tabId, targetTabId}`. The top/bottom 25% still means reorder.
  - SW `splitTabs`: if the dragged item is a bookmark (pinned/favourite), first open it in the target's window via the openItem logic. Then make the two tabs compatible: same window (move dragged next to target), same pinned state (match target), same group (add to target's group or ungroup to match), adjacent (dragged at `target.index + 1`). Then `await chrome.tabs.createSplit([targetTabId, tabId])` and activate the dragged tab. If either tab is already in a split, `unsplit` it first. Return `{ok:false, error}` on failure; panel shows a brief toast (`data-testid="toast"`).
- **Context menu:** on tabs "Split with…" listing up to 8 other tabs from the same window (when `SPLIT_OK`); on split rows "Separate split view" (`chrome.tabs.unsplit`), "Swap sides" (move the right tab before the left), "Move to new window".
- **When not supported:** dropping in the middle just reorders; context menu shows a disabled item "Split view needs Chrome 155+" (only on tab rows).
- Bound tabs inside a split stay shown in their pinned/favourite place; if one half is bound and the other isn't, show the unbound half as a normal Today row with the split icon.

## 5. Pinned reset, more discoverable

Keep the existing ↶ button. Additionally:
- Context menu on an open favourite/pinned item that has navigated away: "Go back to pinned page" (`data-action="reset"`), placed first.
- Clicking the *favicon* of the ACTIVE pinned/favourite item that has navigated away resets it (Arc behaviour); clicking the title just keeps it active. Tooltip on the favicon in that state: "Back to pinned page".
- When the pinned URL and current URL differ, show the current page's host in a faint second line or after a thin "/" separator in the row (Arc-style), e.g. `Delta page / example.com`.

## 6. Panel position

Extensions can't move the side panel. In Settings → Tips, keep the existing text but make it a clear button "Show panel on the left" that opens `chrome://settings/appearance` in a new tab, with the hint "Set Side panel to Left". Also show a one-time dismissible hint card at the top of the main view on first run with the same button (`data-testid="left-hint"`, dismissal in `storage.local.leftHintDismissed`).

## Testing hooks

Keep `debugState`; add `windows` (array of `{id, focused, tabs:[{id,url,groupId,splitViewId,index}]}`) and `groups` (from `chrome.tabGroups.query({})`) to it.

## 7. Profile icons and stronger profile colour (extension + helper)

The switcher becomes a row of round icons (no names); the name shows as a tooltip and in `aria-label`. The current profile's icon has a ring in its colour. Each profile has a **style**: `{ icon, color }`, chosen by the user and shared across all profiles through the helper.

- `icon` is one of: `"picture"` (the Google account photo, when available), `"initial"` (first letter on the colour), or a built-in glyph name from this set (draw them as clean inline SVG, 18px, stroke style): `home, briefcase, code, star, heart, book, music, camera, palette, rocket, leaf, coffee, game, globe, bolt, moon`.
- `color` is a `#rrggbb` from this palette (vivid, Arc-like): `#ff5f57` coral, `#ff9f0a` orange, `#ffd60a` yellow, `#32d74b` green, `#30b0c7` teal, `#0a84ff` blue, `#5e5ce6` indigo, `#bf5af2` purple, `#ff375f` pink, `#8e8e93` graphite.
- **Defaults** when no style is saved: icon `"picture"` if the profile has a picture, else `"initial"`; colour = Chrome's profile colour if it is saturated enough (HSL saturation > 25% and lightness between 25% and 80%), otherwise a palette colour picked deterministically from the profile dir (hash) so profiles always differ.
- **Editing:** in Settings, a "Profiles" section lists every profile with its icon; clicking one opens an inline editor: the 16 glyphs + picture (if available) + initial as a grid, and the 10 colour swatches (`data-testid="style-icon"` with `data-icon`, `data-testid="style-color"` with `data-color`). Changes save immediately via SW `setProfileStyle {dir, style}`. Also right-click a profile icon in the switcher → "Change icon and colour…" opens the same editor. Without the helper: the current profile's style is stored in `storage.sync.ownStyle` and only that profile is editable.
- **Panel theme from the current profile's colour** (make it clearly visible, not grey): panel background = colour mixed into the base at ~12% (light) / ~16% (dark) using `color-mix(in oklab, …)`; active row fill uses the colour at ~22%; focus rings, the address field focus border, drag insertion line, folder hover and the switcher ring use the colour itself; group/split indicators keep their own colours. Expose as CSS vars `--profile`, `--profile-bg`, `--profile-active`. Fall back to the neutral theme only when the current profile is unknown.

### Helper changes

- `Profile` gains `picture: "data:image/png;base64,…" | null` and `style: {icon, color} | null`.
  - picture: read `<chromeDataDir>/<profileDir>/Google Profile Picture.png` (chromeDataDir = directory containing the Local State file; also honour `info_cache[dir].gaia_picture_file_name` if set). Only if the file exists and is ≤ 150 KB; base64 encode with `MIME::Base64` (core).
  - style: from `state.json` key `profileStyles: { [dir]: {icon, color} }`.
  - Keep the total hello/profiles reply under 900 KB: if over, drop pictures largest-first.
- New request `{type:"setProfileStyle", dir, style}` → validate (icon in the allowed list, color matches `^#[0-9a-fA-F]{6}$`), save under flock, reply `{type:"profiles", profiles}` (fresh list), and broadcast `{type:"profiles", profiles}` to every other live profile socket (helper-to-helper message type `profiles`; the receiving helper re-reads and forwards to its extension as `{type:"profiles", profiles}`).
- Extension handles unsolicited `{type:"profiles"}` by updating `storage.session.helper.profiles`.
- Extend `test-helper.pl`: fake profile picture file for one profile → `picture` is a data URL, absent for others; oversized picture skipped; `setProfileStyle` saves, rejects bad icon/colour, and broadcasts to the other helper.
