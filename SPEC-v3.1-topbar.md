# Sidebar v3.1 — our own header over Chrome's rail header (traffic lights, sidebar toggle), full screen

User request: cover the part of Chrome above our sidebar (Chrome's vertical-tabs header: traffic lights, Chrome's "≡<" collapse button and the tab-search grid button), Arc-style. Decided with the user: draw our OWN traffic lights (no cut-out); no back/forward/reload; try to keep the sidebar over Chrome's full-screen Space.

## Mac app

### Header region (TopBarPanel, native)
- A new non-activating panel per mapped, visible, non-little Chrome window (same ordering rules as the sidebar panel: just above its Chrome window; floating while Chrome is frontmost and this is the focused window — see `orderAbove`).
- Frame (AX coords): x from window.minX; y from window.minY; height = rail top − window top (from the rail scan; fallback: bottom of Chrome's traffic-light buttons + 8); width = max(rail width, right edge of Chrome's traffic-light cluster + 8 + toggle button (28) + 8) when that doesn't reach Chrome's first toolbar control; clamp the right edge to (first AX toolbar control left of the address field — e.g. the Back button — minX − 4) so we never cover Chrome's toolbar. If the rail is collapsed and the cluster doesn't fit before the Back button, drop the toggle button (width = cluster right + 8).
- Log once per window (with the rail scan log) the measured cluster frame, the rail header frame, the first toolbar control and the resulting header rect.
- Follows the window exactly like the sidebar panel (lockstep / prediction / window-server bounds); moves with peek? No — the header doesn't change with peek; it stays the header width. When pinned (rail expanded) width grows with the rail.
- Remove the old `trafficLightsBottom()` clamp for the sidebar panel: the sidebar panel now starts at the rail top as Chrome reports it (the header panel covers above it). Keep the bottom-left corner clip rule.
- Colours: background = the sidebar's current background colour (page sends `theme {color, dark, bg}` — use `bg` (#rrggbb, the exact computed `--overlay-bg`); text/icon colour from `dark`). No seam with the sidebar panel below (same colour, abutting frames).

### Traffic lights (native drawing in TopBarPanel)
- Three 12 pt circles drawn at the exact AX frames of Chrome's close / minimize / zoom buttons (read when scanning; positions relative to the window). Colours: close #FF5F57 (border #E0443E), minimize #FEBC2E (#DEA123), zoom #28C840 (#1AAB29); inactive window (not Chrome's focused window, or Chrome not frontmost): #DDDDDD (light) / #4D4D4D (dark) fills with subtle borders. Hovering anywhere over the three shows the glyphs (×, −, and the two diagonal arrows for zoom; when the window is in our Fill state show the inward arrows) in dark grey at 60% opacity. Pressed state darkens 15%.
- Actions:
  - Close: same decision as the close interceptor — pop-out with merge-on-close → `mergeWindow`; otherwise press Chrome's real `AXCloseButton` (Chrome's own close flow, incl. its "close N tabs?" prompt).
  - Minimize: `AXMinimized = true`.
  - Zoom: click = toggle macOS full screen (`AXFullScreen` = true/false; fallback press `AXFullScreenButton`). Option-click = Fill (below). Hover for 0.6 s or click-and-hold opens a small NSMenu under the button: "Fill Screen", "Tile Left", "Tile Right", separator, "Enter Full Screen" / "Exit Full Screen", "Restore Size" (only when filled/tiled).
  - Fill / Tile: set the window frame (AX position + size) to the visible frame of its screen (menu bar and Dock excluded) / its left or right half; remember the previous frame per window; "Restore Size" or a second Fill returns to it.
- Keyboard: Cmd+Ctrl+F is left to Chrome (Chrome's real full screen).

### Sidebar toggle button
- An SF Symbol `sidebar.left` button (16 pt, 28×28 hit area, rounded 6 hover background) right of the traffic lights, vertically centred with them; toggles pinned (same as ⌃⌥S). Tooltip "Keep sidebar open (⌃⌥S)" / "Collapse sidebar". Hidden when the header has no room (see above).

### Drag and double-click
- Empty header space: mouse-down starts a lockstep move (reuse DragController panel session from 3.0, regardless of the lockstep setting); double-click = title-bar double-click action.

### Full screen
- When Chrome's window is in full screen (`AXFullScreen` true), keep showing the header and sidebar: give both panels `collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace? no → .canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]` and level `.floating` while the window is full screen, positioned at the full-screen window's frame (window-server bounds). Show them only while Chrome's full-screen window is on screen (CGWindowList onScreen for its window id), so they don't appear on other Spaces. During the enter/exit animation (fullscreen flag flipped in the last 0.8 s, or bounds changing rapidly) hide both panels and show them once bounds settle.
- If after 1.5 s in full screen our panel isn't on the active Space (`panel.isOnActiveSpace == false`) while Chrome's window is on screen, log "fullscreen: overlay can't join Chrome's full-screen Space" and fall back: next time the user presses our zoom button, use Fill instead (setting `greenButtonAction` = "fill"); show a one-time note in the sidebar ("Full screen hides the sidebar on this Mac, so the green button now fills the screen instead. Change it in Settings → Windows.").
- Setting (Settings → Windows, relayed via appSetting `setGreenButtonAction`): "Green button" = Full screen (default) / Fill screen.

### Host state / messages
- Host state gains `topBar: true` when the header panel is showing for this window (the page hides its footer pin toggle then), `greenButtonAction`.
- Host message from page `theme` gains `bg` (exact background) — the app uses it for the header.

## Web (extension)
- `theme` host message includes `bg` (computed `--overlay-bg`, `#rrggbb`) and is re-posted whenever it changes.
- When hostState `topBar` is true, hide the footer pin toggle (keep `pin-toggle` testid element in DOM but hidden; tests adjust).
- Settings → Windows: "Green button" select (`data-testid="green-button-action"`: Full screen / Fill screen) relayed via `appSetting {name:"setGreenButtonAction", value}`; appState `greenButtonAction`.
- Node reference host: accept `setGreenButtonAction`; tests.
- Tests: theme bg posted and updates on colour change; footer pin hidden with topBar; green-button setting relay. All suites green.
