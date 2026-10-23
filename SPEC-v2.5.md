# Sidebar v2.5 — colour setting, hotkeys, new tab, hidden empty sections, split reorder

Builds on SPEC-v2.4-collapsed.md and earlier.

## 1. Sidebar colour setting (web)

- Per profile: `chrome.storage.sync.sidebarColor = { mode: "auto" | "custom", color: "#rrggbb" }`, default `{mode:"auto"}`.
- Effective background:
  - custom → the chosen colour as-is, with hover/active derived (6% / 12% toward the text colour) and text colour by luminance.
  - auto, overlay mode → hostState `chromeColor` (exact sample) if present; else the current profile's `chromeTheme.userColor` (existing estimate); else the current profile's style colour (as the profile switcher resolves it) used as a seed. Seeds give light `color-mix(in oklab, seed 22%, white)`, dark `color-mix(in oklab, seed 28%, #1f1f1f)`. Never fall back to neutral grey when any seed exists.
  - auto, side-panel mode → today's profile tint.
- Settings: "Sidebar colour" section near the top: segmented Automatic / Custom (`data-testid="sidebar-color-mode"`); Custom shows 14 swatches (PROFILE_COLORS + #e9eef6, #f3e8ff, #e6f4ea, #fff4e5) as round buttons (`sidebar-color-swatch`, `data-color`) and `<input type="color">` (`sidebar-color-picker`), applied live; Automatic shows one line on the current source ("Matching Chrome exactly" / "From your Chrome theme colour" / "From your profile colour").
- Applies live in all open panels of the profile (storage.onChanged).

## 2. Hotkeys pass through to Chrome (web + Mac)

- Web (overlay mode): post host message `editing` (bool) whenever focus enters/leaves an editable element (input, textarea, select, contenteditable) inside the sidebar — focusin/focusout on document, debounced to the final state, also false on window blur.
- Mac: in `SidebarPanel.sendEvent(_:)`, for `.keyDown`, `.keyUp` and `.flagsChanged` events: if the page is not editing, don't deliver the event to the web view; instead forward it to Chrome: `event.cgEvent?.copy()` then `postToPid(chromePid)`. When editing, deliver normally, except keep forwarding Cmd-shortcuts the web view doesn't use: forward Cmd+T, Cmd+N, Cmd+W, Cmd+Shift+T, Cmd+L, Cmd+R, Cmd+1…9, Cmd+Option+Left/Right, Cmd+Shift+[ / ], Cmd+, Cmd+Q is NOT forwarded (would quit Chrome from our panel unexpectedly? — actually forward it too, the user expects Cmd+Q to quit Chrome when Chrome looks focused). Keep Cmd+A/C/V/X/Z/Shift+Z local while editing. Escape while editing goes to the page.
- After the sidebar handles a click that isn't on an editable element, also tell Chrome's window to become main/focused again via AX (`AXMain` = true on the Chrome window element) so Chrome's window keeps its active appearance; keyboard continues to be forwarded either way.
- The global Control+Option+S hotkey stays.

## 3. New tab (web)

- "+ New tab" row always present at the top of Today (already), also shown when Today is empty, and in compact as the "+" pill (already). Make it more visible: the row uses the same pill style as tab rows, label "New tab", with a faint `⌘T` hint on the right in expanded mode.
- Clicking it opens Chrome's new tab in this window (existing behaviour).

## 4. Hide empty sections until needed (web, both modes)

- Favourites area and the Pinned section (header + placeholder) are not rendered when they have no items. They appear (with the existing dashed drop placeholders, 32 px) as soon as a drag of a tab starts inside the sidebar (dragstart of a Today row / split row / group), and disappear again on dragend if still empty. Animate height/opacity (160 ms) so the list doesn't snap.
- The "+ new folder" button for Pinned lives in the Pinned header, so it's only visible when Pinned exists; additionally offer "New pinned folder" in the Today section's right-click menu.
- Tests that relied on the empty placeholders being present must start a drag first (or pin something) — update tools/e2e.mjs and tools/overlay-e2e.mjs accordingly.

## 5. Split view reorder (web)

- Expanded split row: each half is draggable; dropping one half onto the other half swaps them (SW command `swapSplit {splitViewId}` — move the right tab before the left with `tabs.move`; if Chrome breaks the split as a result and `SPLIT_OK`, recreate it with `createSplit([newLeft, newRight])`). Show a swap indicator while dragging over the other half.
- Dragging a half out of the split row onto Today rows: unsplit, then place the tab there (existing reorder logic).
- Top/bottom (horizontal) split is not supported by Chrome; don't add it.

## Tests

- overlay-e2e / e2e: colour setting cases (auto → profile colour not grey; custom swatch exact; picker; back to auto; chromeColor wins in auto); `editing` host messages on focusing the address field / rename input and false on blur; empty Favourites/Pinned hidden and shown during a drag; new tab row visible with an empty Today; swap halves (with the test split hook) calls swapSplit and the order flips.
- All suites green: test-host, e2e, boost-e2e, overlay-e2e. Screenshots of settings (colour section) and a custom-coloured panel to the scratchpad overlay-shots folder.

## 6. Closing a pop-out window moves its live tabs (Mac app + extension)

Problem: merge-back-on-close (SPEC-v1.2) reopens tabs from a snapshot, losing page state (forms, scroll, media). With the Mac app we can intercept the close before it happens and *move* the live tabs instead (moving tabs between windows keeps their state).

- Mac app: a listen-and-modify `CGEventTap` (session tap, head insert, `.defaultTap`) for `leftMouseDown`, `leftMouseUp` and `keyDown`, created after Accessibility is granted (re-create if the tap gets disabled: handle `tapDisabledByTimeout`/`tapDisabledByUserInput` by re-enabling).
  - Mouse: if Chrome is frontmost and the mouse-down point is inside the AX close button (`AXCloseButton` frame) of a Chrome window that is mapped to a profile with a live connection and is NOT that profile's main window (main window id comes from the extension, see below) and merge-on-close is on → swallow the mouse-down and the matching mouse-up (return nil), and send the extension `mergeWindow` for that window via the bridge (`sidebar.cmd` with `{cmd:"mergeWindow", windowId}`).
  - Keyboard: Cmd+Shift+W (keyCode 13 with command+shift, no other modifiers) while Chrome is frontmost and its focused window qualifies as above → swallow and merge.
  - Never intercept when Chrome is not frontmost, when the window is the main window, when the setting is off, when there is no live connection for that profile, or when the window has a single tab (let it close; existing single-tab rule archives it).
  - Event tap callbacks are C functions on the main run loop: keep the decision fast (cached close-button frames per window, refreshed on rescan/following end; cached main-window ids). Use `Unmanaged` refcon like the existing AXObserver code.
- Extension: expose main-window and settings info to the app: include `mainWindowId` and `mergeOnClose` in the existing bridge events stream by adding a `sidebar.windowRoles` bridge call returning `{ mainWindowId, mergeOnClose }`, and emit a `bridgeEvent` named `sidebar.windowRolesChanged` with the same payload whenever either changes. The app caches it per profile.
- `mergeWindow` already moves tabs live (groups via tabGroups.move, splits kept) and lets the emptied window close; make sure it also works when called while the source window is focused (focus the main window afterwards) and that the snapshot logic doesn't additionally reopen anything when the emptied window closes (snapshot must be empty/removed for windows emptied by a merge).
- Fallback unchanged: closes the app didn't intercept (File → Close Window menu, app not running) still use the snapshot reopen.
- Tests (overlay-e2e via the fake app): `sidebar.windowRoles` returns the right ids; the event fires on main-window change and setting change; calling `sidebar.cmd mergeWindow` for a pop-out moves tabs with their ids preserved (same tab ids = live move, not recreated) and does not trigger the snapshot reopen.
