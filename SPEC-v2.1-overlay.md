# Sidebar v2.1 — sidebar over Chrome's vertical tabs

Supersedes the layout parts of SPEC-v2-overlay.md (transport, bridge, shim and helper relay stay as they are). Goal: it should look and behave like Chrome's own sidebar, not a separate app. Feedback from the first real run: the sidebar was a separate window outside Chrome, Chrome's vertical tab rail was still visible, the top cover hid Chrome's address bar, and the "SIDEBAR" header made it look like a separate panel.

## Layout

Chrome runs with **vertical tabs** (tab rail on the left, Chrome's toolbar across the top). Our sidebar covers **exactly Chrome's vertical tab rail** and nothing else. No top cover, no toolbar of our own. Chrome's toolbar, address bar and window buttons stay fully visible and untouched.

Three states:

- **Collapsed** (Chrome's rail collapsed, ~48–56 px wide): our sidebar covers the rail with a **compact strip** (icons only, see Web UI).
- **Peek**: hovering over the compact strip for 120 ms (or the left 4 px of the window when the rail isn't found) slides the full sidebar out *over the page* from the rail's left edge, width = the user's peek width (default 280, persisted). It slides back when the pointer has been outside it for 350 ms and the page isn't busy. Subtle shadow on the right edge only in this state.
- **Pinned**: the app expands **Chrome's own rail** (AXPress its expand/collapse button) so Chrome itself makes room and the page reflows inside Chrome. Our sidebar covers the expanded rail exactly (its width is whatever Chrome's rail is; if the user drags Chrome's rail edge… we cover the rail, so instead our panel provides its own 6 px right-edge resize handle that resizes Chrome's rail by dragging the rail's AX splitter if available; if not available, no resize in pinned mode). Unpinning collapses Chrome's rail again.
  - Fallback if the rail's expand button can't be found/pressed: "pinned" = floating over the page at peek width, plus a one-time note in the sidebar settings: "Couldn't control Chrome's tab rail; pinned sidebar will float over the page."
  - Remove the old push-by-resizing-the-window mode and the "When pinned" choice (only keep it as the fallback behaviour automatically).

If Chrome is in **horizontal tabs** mode (no rail found): don't cover anything; the left-edge hover still peeks the sidebar over the page; the sidebar shows a dismissible card at the top: "Turn on vertical tabs to get the full sidebar: right-click Chrome's tab bar → Show tabs vertically. Then collapse them." with a "Show me" that opens nothing (Chrome has no URL for it) — just text.

## Finding Chrome's rail (AX)

In each Chrome window's AX tree (breadth-first, cap 400 nodes, cache per window, re-scan on window resize, focus change, every 2 s while unmatched, and after any pin/unpin):
- The rail = the AX element containing the tab list: find the element with role `AXTabGroup` (Chrome's tab strip) whose frame is tall and narrow (height > 3× width) — then walk up parents while the parent's x == rail x and width ≤ 420 and height ≤ window height, taking the largest such ancestor that does **not** contain the toolbar (AX role `AXToolbar`). Its frame is the rail frame.
- Collapse/expand button: an `AXButton` inside the rail frame (or anywhere in the window if not found inside) whose `AXDescription`/`AXTitle`/`AXHelp` matches `/collapse|expand/i` together with `/tab/i`. Pressing it toggles; read the rail width after 250 ms to know the new state (collapsed if width < 120).
- Log the discovered tree path once per window (role/description/frame for each level, max depth 8) to `~/Library/Logs/Sidebar.log` so it can be debugged from a user log.

## Mac app changes

- **Delete** `TopCoverPanel` and everything about covering the tab strip (tab strip height, top cover drag/double-click).
- `SidebarPanel` frame = rail frame (collapsed/pinned) or peek frame. Ordered just above its Chrome window (unchanged rule). Non-activating, can become key (unchanged).
- Rounded corners: none in collapsed/pinned (it must look like part of Chrome's window: square, flush with the rail). In peek: 10 px on the right corners. The bottom-left corner of Chrome's window is rounded on macOS (10 px): clip the panel's bottom-left corner with the same radius when its frame touches the window's bottom-left.
- No menu bar icon, no Dock icon (`LSUIElement`). The only window the app may show on its own is the one-time Accessibility onboarding window, and it closes itself once permission is granted.
- New host messages from the page: `setPinned` (bool), `setPeekWidth` (number), `quitApp`, `setLaunchAtLogin` (bool), `openAccessibilitySettings`, `rescanRail`. App → page `__sidebarHostState({state: "collapsed"|"peek"|"pinned", railFound, railControllable, launchAtLogin, accessibility: true|false, appVersion})`.
- Keyboard: Control+Option+S still toggles pinned (global hotkey only while Chrome is frontmost).
- Keep: bridge server, window tracking/mapping, follow-during-move timer, Accessibility prompt, logging, build script, CI.

## Theme: match Chrome

- Helper: on hello/getProfiles also read each profile's `<chromeDataDir>/<profileDir>/Preferences` JSON and include `chromeTheme: { userColor: "#rrggbb" | null, colorScheme: "system"|"light"|"dark", variant: number|null, themeId: string|null }` in the Profile object. Sources: `browser.theme.user_color` (signed ARGB int), `browser.theme.color_scheme2` or `browser.theme.color_scheme` (0 system, 1 light, 2 dark), `browser.theme.color_variant`, `extensions.theme.id`. Missing → nulls. Cap file read at 5 MB.
- Web UI background (overlay mode) = Chrome's frame/rail colour: if `userColor` set, use a Material-like tonal surface from it — light: `color-mix(in oklab, userColor 22%, white)`, dark: `color-mix(in oklab, userColor 28%, #1f1f1f)`; otherwise Chrome's defaults — light `#e9eef6`, dark `#1f1f1f` (default grey theme) — and respect `colorScheme` (forced light/dark) over the OS setting. Active row = `color-mix(in oklab, userColor or #0b57d0 18%, page bg)` light / 30% dark. Text/icon colours as now. The profile colour tint from v1.1 is replaced by this in overlay mode (side-panel mode keeps the profile tint).
- Typography and density to match Chrome's vertical tabs: 13 px system font, 32 px rows, 8 px radius pills with no borders, favicons 16 px.

## Web UI (overlay mode)

- Remove the "SIDEBAR" overlay bar entirely. The pin toggle moves to the footer, left of the settings gear (`data-testid="pin-toggle"`, keep testid).
- **Compact strip** (`state === "collapsed"`, `html.compact`): vertical column, centred icons 16 px in 36 px squares with 8 px radius hover/active pills, 8 px gap: current profile icon (click → full profile switcher in peek), favourites (each tile as an icon), a thin divider, pinned items that are open (icons), then Today tabs' favicons (active highlighted, audible dot), then a "+" new tab at the bottom of the list, and at the very bottom the archive icon and the pin toggle. Tooltips = titles. Clicking works exactly like the full rows (activate/open). Drag and drop is disabled in compact. Overflow scrolls vertically without a visible scrollbar.
- Settings (overlay mode) gets an "App" section: Pinned sidebar (switch, mirrors state), Launch at login (switch), Accessibility status with "Open settings" when missing, "Find Chrome's tab rail again" (rescanRail), app version, and "Quit Sidebar" (confirm). Remove the "When pinned" select (`settings-pin-mode` can stay but hidden; tests won't use it).
- When `railFound` is false show the vertical-tabs card described above (`data-testid="vertical-tabs-hint"`).
- Everything else (favourites, pinned, Today, groups, boosts, archive, settings) unchanged.

## Tests

- Extend `tools/overlay-e2e.mjs`: compact mode renders icons only (no text rows) and clicking an icon activates the tab; hostState switching collapsed → peek → pinned re-renders; no "SIDEBAR" bar; pin toggle in footer posts `setPinned`; App settings section posts `setLaunchAtLogin`, `quitApp` (after confirm), `rescanRail`; vertical-tabs hint shows when `railFound:false`; theme colours: with a fake Preferences `browser.theme.user_color` the page background is not the default and differs between light and dark.
- Helper tests: `chromeTheme` parsed from a fake Preferences file (user colour conversion, scheme mapping, missing file → nulls).
- Screenshots (light, dark, compact, peek) to the scratchpad `overlay-shots/` folder.

---

## Merge the helper into the Mac app (replaces helper/ Perl)

The Perl helper goes away. `Sidebar.app` provides everything it did. The extension's native messaging protocol stays **exactly the same** (host name `com.sidebar.helper`, messages `hello`, `identify`, `getProfiles`, `switchProfile`, `setGlobalSettings`, `setProfileStyle`, replies and unsolicited `activate`/`settings`/`profiles`, plus the overlay relay: `bridgeResult`/`bridgeEvent` from the extension, `bridge`/`overlayStatus` to it). Profiles additionally carry `chromeTheme` (see Theme above).

### Connector mode

- The same executable (`Sidebar.app/Contents/MacOS/SidebarApp`) runs in **connector mode** when Chrome launches it as a native messaging host (Chrome passes the caller origin `chrome-extension://<id>/` as an argument; detect any argument starting with `chrome-extension://`). In connector mode it must NOT create any UI or touch NSApplication: it's a plain stdio pipe.
- Connector: connect to the app's socket `<APP_SUPPORT>/Sidebar/host.sock` (`~/Library/Application Support/Sidebar/`; override with env `SIDEBAR_APP_DIR`). If it isn't there, launch the app hidden (`/usr/bin/open -g -a <path of own .app bundle>`), then retry for up to 10 s. Then pump bytes both ways unchanged (stdin → socket, socket → stdout) until either side closes; exit. Write nothing else to stdout. Log to `~/Library/Logs/Sidebar-connector.log`.
- The socket carries native-messaging framing (4-byte native-endian length + JSON) in both directions, so the connector is a byte pipe and the app speaks the exact protocol the Perl helper spoke.

### App side (`HostServer`)

- Listens on `host.sock`; each connection = one Chrome profile's extension, handled like one Perl helper instance used to be (replaces the old `overlay.sock` + relay: bridge envelopes now flow straight over this connection — `bridge` messages are written to the connection, `bridgeResult`/`bridgeEvent` come back on it). `overlayStatus {connected:true}` is sent right after a connection is accepted and identified while the overlay feature is running.
- Implements: `hello` (profiles from `<chromeDataDir>/Local State` — same parsing rules as SPEC.md + pictures + styles + chromeTheme; settings), `identify` (associates the connection with a profileDir; a newer connection for the same profile replaces the older one), `getProfiles`, `switchProfile` (if the target profile has a live connection → send it `activate {bounds}`, reply `focused`; else launch Chrome with `--profile-directory=<dir>` via `Process` on `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (or the path from NSWorkspace for `com.google.Chrome`), remember a pending handoff (bounds, 60 s) delivered on that profile's identify, reply `launched`), `setGlobalSettings` (persist to `state.json` in the app dir; broadcast `settings` to all other connections), `setProfileStyle` (validate like the Perl helper; persist; broadcast `profiles` to all connections incl. reply).
- `state.json` keys and validation identical to the Perl helper (archiveDefaultMinutes default 720, profileStyles, allowed icons list, colour regex). On first launch, import an existing `~/Library/Application Support/SidebarHelper/state.json` if present.
- **Self-registration**: on every launch write `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sidebar.helper.json` → `{"name":"com.sidebar.helper","description":"Sidebar","path":"<absolute path to the app executable>","type":"stdio","allowed_origins":["chrome-extension://ffblekellgdmlecjablfojaaadpkmdgg/"]}` (rewrite if the path changed). If an old Perl helper manifest is there, it gets replaced (same file name). Remove `~/Library/Application Support/SidebarHelper/sidebar-helper.pl` if present (log it).

### Missing-extension check

- The app knows each Chrome profile (Local State) and which ones have connected. For profiles with open Chrome windows but no connection after 10 s, the sidebar panel for those windows shows a setup card instead of the UI: "Add the Sidebar extension to this profile" with steps (1 Open chrome://extensions — button that opens it in that window via `open -a "Google Chrome" --args --profile-directory=<dir> chrome://extensions`, 2 Turn on Developer mode, 3 Load unpacked → choose the `extension` folder — button "Show extension folder" that reveals `Sidebar.app/Contents/Resources/extension` in Finder). Ship the full extension folder inside the app bundle at `Contents/Resources/extension/` so the user always has a matching copy (build.sh copies it). Rendered natively or as a tiny local HTML page in the same WKWebView (served by the scheme handler at `sidebar://app/setup.html`) — your choice.

### Reference implementation for tests

`tools/fake-app/` (Node): a JavaScript implementation of `HostServer` (the full protocol above + the bridge relay) and of connector mode, used by the Linux test suites in place of the Swift app. The Chromium tests point the NativeMessagingHosts manifest at `tools/fake-app/connector.js` (with a `#!/usr/bin/env node` shebang, executable). The Swift `HostServer` must behave the same as this reference; port the Perl helper's test scenarios (tools/fake-app/test-host.mjs) against the Node reference so the protocol stays pinned down.
