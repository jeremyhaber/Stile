# Sidebar v3.3 — presentation mode

Request (HANDOFF §7.3, agreed design): "Start presenting" opens a dedicated presentation window whose sidebar shows only the tabs added to it; other windows, profiles, Temporary and downloads are hidden so Jeremy can share that window in Zoom/Meet. "Stop presenting" merges its tabs back. macOS does not tell other apps which window is shared, so the role is explicit, never detected.

## State
- `chrome.storage.session.presentation = { windowId, startedAt }` (absent = not presenting). Session storage is the same home as `mainWindowId` / `littleWindows`; every command reads it fresh (MV3 worker may have restarted) and writes go through the command queue. It is cleared when that window is removed, and checked against live windows at boot.
- The presentation window is an ordinary Chrome window that the extension treats specially: it is never the main window, never a merge candidate (`liveNormalIds` excludes it, like little windows), its tabs are never auto-archived, and it is not listed as "Window" in other sidebars' Today (it appears as a "Presentation" section instead).
- Only one presentation at a time. Incognito windows can't present (the menu items are hidden there).

## Commands (service worker)
- `startPresenting {tabId?}`: if already presenting, focus that window (and add `tabId`). Otherwise create a focused normal window (new tab page, or the given tab moved into it) and store the state.
- `addToPresentation {tabId | groupId | splitViewId}`: move the tab (its split pair, or the whole group via `tabGroups.move`) to the end of the presentation window; a lone blank new-tab page left from start is closed. Starts presenting first when needed (used by "Start presenting with this tab").
- `removeFromPresentation {tabId}`: move the tab to the main window.
- `stopPresenting`: close the blank new-tab page if other tabs exist; merge the remaining tabs into the main window with the existing `mergeIntoMain` (live moves, groups and splits kept, active tab restored, window closed); clear the state; `lastMerge` set so the main window shows "Merged N tabs into the main window". If no other window exists, the presentation window simply becomes a normal window.
- `mergeWindow` on the presentation window is `stopPresenting` (so the close-button interception in the Mac app, which asks for `mergeWindow`, ends the presentation rather than failing).
- Closing the presentation window by other means clears the state; its tabs follow the normal pop-out close rule (merge on close, if enabled).
- State is not part of `sidebar.windowRoles`: the Mac app does not need it (the close interceptor works through `mergeWindow`).

## Web (sidebar page)
- Window-level actions live in the context menu of the empty Today area ("Start presenting" / "Stop presenting", beside "New pinned folder"), in the window-section menu of other windows ("Stop presenting" on the presentation section), and in the presentation bar. Tab menu: "Add to presentation" (or "Start presenting with this tab" when none is active) and, in the presentation window, "Remove from presentation". Group menu: "Add group to presentation". While a presentation runs, dragging a tab/group/split also shows a "Drop to add to presentation" zone (not in the presentation window itself).
- In the presentation window (`body.presenting`): a bar "Presenting" + "Stop presenting" (`present-bar`, `present-stop`) replaces the profile switcher and pop-out bar; Favourites, Pinned, Temporary, other-window sections, "Merge all" and the downloads popover are hidden; the Today list shows all tabs of the window (pinned bindings do not hide a tab there). Tab menus drop Favourite / Pin / Temporary entries.
- In other windows a presentation section ("Presentation · N tabs", menu: Stop presenting, Go to window) lists the added tabs; clicking one brings it back to this window.

## Tests
- e2e: start, add via menu and via command, presenting window sidebar content (only its tabs, hidden sections and profiles), other windows' sections, main window shows the presentation section, auto-archive skips it, stop merges back and closes the window, closing the window clears the state, windowRoles unchanged.
- overlay-e2e: the same through the bridge (`sidebar.cmd`), native menu entries.

## Decisions to confirm
- A new presentation starts with a blank new tab; the active tab is not pulled in automatically.
- Favourites and Pinned are hidden in the presentation window too ("only tabs added"). Archive stays (it is only a count).
- The presentation window is excluded from auto-archive; "Merge all" in the main window does not include it.
- Closing the presentation window by hand follows merge-on-close (tabs reopen in main; a single tab goes to the Archive), as for pop-outs. In the Mac app the red button instead ends the presentation and moves the tabs live.
- Presenting is per Chrome profile (storage is per profile); two profiles can present at the same time.
