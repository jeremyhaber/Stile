# Sidebar.app (macOS)

A background app that puts the Sidebar extension's UI exactly over Chrome's **vertical tab rail**, so it
looks and behaves like Chrome's own sidebar. Chrome's toolbar, address bar and window buttons stay
untouched. The app also *is* the extension's native messaging host: there is no separate helper to
install and no Dock icon. A small menu bar icon (SF Symbol `sidebar.left`) gives quick access to
the sidebar on/off switch (Control+Option+Shift+S), keeping it open (Control+Option+S), moving Chrome and the
sidebar together, Settings, the permissions window and Quit. Turn it off with "Show menu bar icon" in the
extension's settings (App section).

## Setup

1. **Load the extension unpacked in each Chrome profile.** The extension folder ships inside the app:
   `Sidebar.app/Contents/Resources/extension`. In Chrome open `chrome://extensions`, turn on
   *Developer mode*, click *Load unpacked* and choose that folder. (If a profile has no extension the
   sidebar shows a setup card with buttons for exactly this, including *Show extension folder*.)
2. **Open Sidebar.app and allow Accessibility** (System Settings > Privacy & Security > Accessibility).
   The first-run window closes by itself once access is granted. Open it once; after that Chrome starts it
   hidden whenever the extension needs it.
3. **In Chrome, right-click the tab bar and choose "Show tabs vertically", then collapse the tabs.**
   The sidebar now covers the collapsed rail as a compact icon strip.

Quit from the sidebar's Settings (App section). Launch at login is a switch in the same place.

Requires macOS 13 or later. The app is ad-hoc signed, not notarized: first launch via right-click >
**Open**, or `xattr -dr com.apple.quarantine /Applications/Sidebar.app`.

### Build from source

```
cd mac
bash build.sh            # native arch; UNIVERSAL=1 bash build.sh for arm64 + x86_64
```

Needs Xcode command line tools. `build.sh` builds the executable, assembles `dist/Sidebar.app`,
copies the web UI (every top-level `*.js`, `*.css`, `*.html`, `*.png` of `../extension` plus `icons/`) to
`Contents/Resources/web`, copies the whole `../extension` folder to `Contents/Resources/extension`,
ad-hoc signs it and writes `dist/Sidebar.zip`.

## Using it

- **Collapsed**: Chrome's rail is collapsed; the sidebar covers it with a compact strip of icons.
- **Peek**: rest the pointer on the strip for a moment (or, with horizontal tabs, on the left edge of
  the window). The full sidebar slides out over the page, and slides back shortly after the pointer
  leaves, unless a menu, rename field, drag or dialog is open. Drag its right edge to change the peek
  width (220 to 420 pt, remembered).
- **Pinned**: the pin button in the sidebar footer (or Control+Option+S while Chrome is frontmost)
  presses Chrome's own expand button, so Chrome makes room and the page reflows. Unpinning collapses the
  rail again. If Chrome's button can't be found or has no effect, a pinned sidebar floats over the page
  instead, and Settings says so.
- With horizontal tabs the sidebar covers nothing; hover the left edge to peek, and the sidebar shows a
  card explaining how to turn on vertical tabs.

## How it works

```
Chrome extension  <-- native messaging -->  SidebarApp (connector mode)  <-- host.sock -->  Sidebar.app
```

- Chrome starts `Sidebar.app/Contents/MacOS/SidebarApp chrome-extension://<id>/` as the native messaging
  host. The same executable detects that argument and runs as a **connector**: a plain byte pipe between
  stdio and `~/Library/Application Support/Sidebar/host.sock` (override the folder with
  `SIDEBAR_APP_DIR`). If the socket is missing it launches the app hidden (`open -g -a`) and retries for
  10 s. Connector log: `~/Library/Logs/Sidebar-connector.log`.
- The app's `HostServer` listens on `host.sock`; each connection is one profile's extension and speaks
  the same protocol the old Perl helper did (`hello`, `identify`, `getProfiles`, `switchProfile`,
  `setGlobalSettings`, `setProfileStyle`; unsolicited `activate`, `settings`, `profiles`), plus the bridge
  (`bridge`/`overlayStatus` to the extension, `bridgeResult`/`bridgeEvent` back) which now flows over the
  same connection. Profiles carry picture, style and `chromeTheme` (from each profile's `Preferences`).
- Settings shared between profiles live in `~/Library/Application Support/Sidebar/state.json`. On first
  launch an existing `SidebarHelper/state.json` is imported and the old `sidebar-helper.pl` is removed.
- On every launch the app writes the native messaging manifest
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sidebar.helper.json` pointing at
  its own executable (rewritten if you move the app). Move the app, relaunch it once.
- The sidebar is the extension's `sidepanel.html` in a web view (`?mode=overlay`); the page controls the
  app through host messages (`setPinned`, `setPeekWidth`, `quitApp`, `setLaunchAtLogin`,
  `openAccessibilitySettings`, `rescanRail`) and receives `__sidebarHostState({state, railFound,
  railControllable, launchAtLogin, accessibility, appVersion})`.
- Chrome windows are matched to extension windows by comparing bounds. A window that stays unmatched
  for 10 s gets the setup card (a profile that is open but has no connected extension).

### How the rail is found

Per Chrome window the app walks the accessibility tree breadth-first (400 nodes max) looking for an
`AXTabGroup` that is tall and narrow (height more than 3x width), then widens it to its largest ancestor
with the same left edge, at most 420 wide, no taller than the window and not containing the toolbar. That
frame is the rail. The collapse/expand button is an `AXButton` whose description, title or help mentions
both "tab" and "collapse"/"expand". The window is re-scanned when it is resized, when focus changes, after
pinning or unpinning, and every 2 s while no rail is found. The first scan of each window writes the
discovered path (role, description, frame per level) to the log, which is the thing to look at if the
sidebar doesn't line up with the rail.

Log: `~/Library/Logs/Sidebar.log` (search for `rail[window`).

## Known limits

- Chrome only (`com.google.Chrome`); Chrome Beta/Canary/Brave/Edge are not tracked.
- Rail detection depends on Chrome's accessibility tree, which can change between Chrome versions; the
  log shows what was found. The fallback is a floating sidebar.
- Resizing the pinned sidebar only works if Chrome exposes the rail's splitter to accessibility.
- Windows are matched by bounds. Two windows from different profiles at exactly the same position and
  size can be matched the wrong way round until one is moved.
- Overlays sit directly above their Chrome window, so another app's window raised above Chrome hides them
  with it. Fullscreen and minimized Chrome windows get no overlay; windows on other Spaces are skipped.
- Clicking the sidebar makes its panel the key window (needed for typing) without activating Sidebar.app,
  so Chrome's own keyboard shortcuts stop working until you click back into the page.
- The web view runs on a custom `sidebar://` scheme (not a secure context): no clipboard API, no service workers.
- Not notarized; Gatekeeper needs the right-click Open step once.
