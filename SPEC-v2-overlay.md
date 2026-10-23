# Sidebar v2 — Mac overlay app

Goal: hide Chrome's horizontal tab bar behind our own interface and give the sidebar Arc-style hover-to-reveal / pin behaviour, while Chrome stays real Chrome. Builds on SPEC.md, SPEC-v1.1.md, SPEC-v1.2.md. Chrome's toolbar (address bar, extension buttons) stays visible; only the tab strip is covered.

Three parts:

1. **Extension** (existing) gains a *bridge*: it executes chrome.* calls and forwards chrome.* events for the Mac app.
2. **Perl helper** (existing native messaging host, one process per Chrome profile) gains a *relay* to the Mac app over a Unix socket.
3. **Mac app** `Sidebar.app` (new, Swift/AppKit): draws a cover over Chrome's tab strip and a hover/pinned sidebar next to each Chrome window. The sidebar is the existing side panel UI (sidepanel.html + modules) running in a WKWebView, with a shim that turns `chrome.*` calls into bridge calls.

The side panel keeps working inside Chrome when the app isn't running.

---

## 1. Transport

```
Sidebar.app  ⇄ (Unix socket, newline-delimited JSON) ⇄  helper (per profile)  ⇄ (native messaging) ⇄  extension service worker
```

- App listens on `<HELPER_DIR>/overlay.sock` (HELPER_DIR as in SPEC.md, default `~/Library/Application Support/SidebarHelper`; overridable by env `SIDEBAR_HELPER_DIR` for both helper and app). If the path exceeds 100 bytes use the same md5 fallback rule the helper already uses for its sockets (`<HELPER_DIR>/sock/<md5-12 of "overlay">.sock`, then `/tmp/sbh-<uid>-<md5-12>.sock`).
- One connection per helper. Each line is one JSON object.

### Helper ⇄ App lines

- Helper → app, right after connecting (and again after every `identify` / profile list change): `{type:"profileHello", profileDir, profiles}`.
- Helper → app: `{type:"fromExt", profileDir, msg}` — wraps every extension message whose `msg.type` is `bridgeResult` or `bridgeEvent`.
- App → helper: `{type:"toExt", msg}` — helper writes `msg` to the extension as a framed native message.
- Helper connects only after the extension has sent `identify`. If the socket is missing or the connection drops, retry every 3 s (non-blocking, inside the existing select loop; never block stdin handling). On connect send the extension `{type:"overlayStatus", connected:true}`; on disconnect `{type:"overlayStatus", connected:false}`.

### Bridge messages (extension side)

App → extension (inside `toExt`):
- `{type:"bridge", id, call, args}` — `call` is a dotted name. Allowed namespaces (reject anything else with an error): `tabs.*`, `windows.*`, `bookmarks.*`, `tabGroups.*`, `search.query`, `storage.local.*`, `storage.sync.*`, `storage.session.*` (get/set/remove/clear), `runtime.getManifest`. Special calls:
  - `sidebar.cmd` args `[msg]` → run the service worker's own command dispatcher with `msg` exactly as if the side panel had sent it via `chrome.runtime.sendMessage` (refactor the dispatcher into a callable function `dispatchCommand(msg, sender)`; `sender` = `{ bridge: true }`). Boost commands are included (they go through `handleBoostCommand`).
  - `sidebar.favicon` args `[url]` → fetch `chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(url) + '&size=32')` (also accept a full `chrome-extension://…/_favicon/…` URL) and return a `data:` URL (cache 500 entries in memory).
  - `sidebar.hello` → `{extensionId, version, profileDir}`.
- Extension → app: `{type:"bridgeResult", id, ok:true, result}` or `{…, ok:false, error}`.

Events: while `overlayStatus.connected` is true, the extension forwards `{type:"bridgeEvent", name, args}` for: `tabs.onCreated/onUpdated/onRemoved/onActivated/onMoved/onAttached/onDetached/onHighlighted`, `windows.onCreated/onRemoved/onFocusChanged/onBoundsChanged`, `bookmarks.onCreated/onRemoved/onChanged/onMoved/onChildrenReordered`, `tabGroups.onCreated/onUpdated/onRemoved/onMoved`, `storage.onChanged`. Listeners are registered synchronously at top level and check a flag (persist the flag in `storage.session.overlayConnected` so a restarted worker keeps forwarding). Args must be JSON-safe.

## 2. Web UI shim (`extension/bridge-shim.js`)

Classic script, loaded first by `sidepanel.html` (before the module scripts). If `globalThis.chrome?.tabs` exists (real extension context) it does nothing. Otherwise it installs a `chrome` object:

- **Transport**: if `window.webkit?.messageHandlers?.sidebarBridge` exists, send with `postMessage(jsonString)`, and the app delivers incoming messages by calling `window.__sidebarBridgeReceive(jsonString)`. Otherwise, if the page URL has `?bridgeHttp=<base>`, use a test transport: `POST <base>/send` (body = JSON) and `EventSource(<base>/events)` for incoming. Incoming messages are the extension's `bridgeResult` / `bridgeEvent` objects, plus host messages (below).
- Outgoing bridge envelope from the page: `{type:"bridge", id, call, args}` — the app/test server wraps it in `toExt` for the right profile.
- `chrome.<ns>.<fn>(...args)` returns a Promise resolving to the result (also supports a trailing callback). Implement namespaces explicitly (tabs, windows, bookmarks, tabGroups, search, storage.local/sync/session, runtime) so `typeof chrome.tabs.createSplit === 'function'` stays a meaningful feature test: before the UI scripts run, the shim calls `sidebar.hello` and `tabs.query({active:true, currentWindow:true})`-free capability probe `sidebar.capabilities` → `{split: boolean, tabGroups: boolean, userScripts: boolean}` and only defines `createSplit`/`unsplit` when supported. The UI modules must not run until the shim is ready: the shim exposes `window.__sidebarReady` (a Promise) and `sidepanel.js` / `boost-view.js` await it at the start of init when present.
- Events: `chrome.<ns>.<onEvent>` = `{addListener, removeListener, hasListener}` fed by `bridgeEvent`.
- `chrome.runtime.sendMessage(msg, cb?)` → `sidebar.cmd`. `chrome.runtime.onMessage` = no-op event. `chrome.runtime.id` / `getURL(path)` → extension id from hello (`chrome-extension://<id>/<path>`). `chrome.runtime.lastError` = undefined. `chrome.runtime.getManifest()` sync → cached from hello.
- `chrome.windows.getCurrent()` → `{id: <windowId query param>}`; `chrome.windows.WINDOW_ID_CURRENT = -2`, `WINDOW_ID_NONE = -1`; `chrome.tabGroups.TAB_GROUP_ID_NONE = -1`; `chrome.sidePanel.open` → resolves; `chrome.identity` absent.
- Favicons: any `<img>` whose `src` starts with `chrome-extension://` gets swapped (MutationObserver on subtree + attribute `src`) for the data URL from `sidebar.favicon`, cached per URL; while loading show the existing letter-tile fallback (don't break the default-icon hash detection — it compares pixel hashes; data URLs from the same source compare fine).
- `chrome.tabs.create` etc. for `chrome://` URLs work normally through the bridge.

## 3. Overlay mode in the panel (`?mode=overlay`)

When `mode=overlay`:
- Hide the left-hint card, the "Show panel on the left" tip and the keyboard-shortcut tip.
- Show a slim header row at the very top: profile switcher stays, plus at the right a **pin** toggle (`data-testid="pin-toggle"`, aria-pressed) and in Settings a **"When pinned"** select (`data-testid="settings-pin-mode"`): "Move the page over" (`push`) / "Float over the page" (`float`).
- Host messages, page → app: `{type:"host", action, value}` via the same transport: `ready` (after first render), `setPinned` (bool), `setPinMode` ("push"|"float"), `theme` ({color, dark}) whenever the profile colour or colour scheme changes, `busy` (bool — true while a context menu, rename input, drag, confirm dialog or the boost code editor is open; the app must not auto-hide the sidebar while busy), `activeTitle` ({title, favIconUrl}) for the active tab of this window whenever it changes.
- App → page: `window.__sidebarHostState({pinned, pinMode, state})` where `state` is `"peek"|"pinned"`; the pin toggle reflects it.
- Background: fully opaque profile-tinted background (no transparency), 10 px rounded corners on the right side only when floating (CSS class `overlay-float` on `<html>` set from host state).

## 4. Mac app

Swift Package (`mac/Package.swift`, macOS 13+, single executable target `SidebarApp`, no Xcode project), plus `mac/build.sh` that builds release, assembles `Sidebar.app` (Info.plist: bundle id `ca.simplistics.sidebar`, `LSUIElement` true, `NSAccessibilityUsageDescription`), copies the web UI files from `extension/` into `Contents/Resources/web/` (sidepanel.html/.css/.js, shared.js, icons.js, boost-view.js, boost.css, bridge-shim.js), ad-hoc signs (`codesign --force --deep -s -`), and zips to `mac/dist/Sidebar.zip`. GitHub Actions workflow `.github/workflows/mac.yml` on `macos-latest`: runs `mac/build.sh` and uploads the zip as an artifact; triggered on push and workflow_dispatch.

### Structure (files under `mac/Sources/SidebarApp/`)

- `App.swift` — `@main`, NSApplication with accessory activation policy, status bar menu.
- `BridgeServer.swift` — Unix socket server (POSIX socket + DispatchSource, newline JSON), tracks one `ProfileBridge` per connection (`profileDir`, `profiles`). `ProfileBridge.call(call, args) async throws -> JSON` with request ids and 10 s timeout; event fan-out to subscribers.
- `ChromeTracker.swift` — finds Google Chrome (`com.google.Chrome`) via NSWorkspace, AXObserver on its pid for `kAXWindowCreatedNotification`, `kAXUIElementDestroyedNotification`, `kAXMovedNotification`, `kAXResizedNotification`, `kAXFocusedWindowChangedNotification`, `kAXWindowMiniaturizedNotification`, `kAXWindowDeminiaturizedNotification`; NSWorkspace activate/deactivate/hide/unhide/terminate notifications; a 0.5 s safety poll. For each AX window: frame (AXPosition/AXSize, top-left screen coords), minimized, fullscreen (`AXFullScreen`), subrole standard, CGWindowID via `_AXUIElementGetWindow` (dlsym; fall back to matching `CGWindowListCopyWindowInfo` by owner pid + bounds).
- `WindowMapper.swift` — matches AX windows to `(profileDir, chromeWindowId)` by asking every ProfileBridge `windows.getAll({windowTypes:['normal']})` and comparing bounds (±3 px). Re-map on window create/remove/move/resize events (debounced 150 ms). Unmapped Chrome windows (no bridge yet) still get a tab-strip cover but a sidebar showing "Waiting for the Sidebar extension…".
- `OverlayController.swift` — one per mapped Chrome window; owns `TopCoverPanel` and `SidebarPanel`; follows the Chrome window. While a window is moving/resizing (AX moved/resized notifications in the last 300 ms) follow at display refresh using a CADisplayLink-equivalent (`CVDisplayLink` or a 120 Hz timer on the main run loop) reading the AX frame; otherwise update on events. Ordering: after every frame update and on Chrome activation, call `panel.order(.above, relativeTo: chromeCGWindowID)` so overlays sit just above their Chrome window and below other apps' windows. Hide all overlays when Chrome is hidden/inactive *and* its window is covered? No — keep them ordered with Chrome; only hide when the Chrome window is minimized, fullscreen, or closed, or Chrome quits.
- `TopCoverPanel.swift` — borderless non-activating `NSPanel` (`.nonactivatingPanel`, `hidesOnDeactivate = false`, `isFloatingPanel = false`, `level = .normal`, `collectionBehavior` includes `.managed`, `.participatesInCycle` off). Frame: the Chrome window's tab strip — x from `window.minX + trafficLightWidth` (default 78, measured from the AX close/minimize/zoom buttons' frames when available: right edge of the zoom button + 8) to `window.maxX`, y = window top, height = tab strip height. Tab strip height: auto-detect = top of the first AX descendant with role `AXToolbar` minus window top (search breadth-first, max depth 6); fallback 40; overridable in the menu (Auto / 36 / 40 / 44 / 48). Content (native AppKit, `NSVisualEffectView` not used — solid colour): background = profile colour mixed 14% into window background (from the `theme` host message, dark/light aware), a sidebar toggle button at the left (SF Symbol `sidebar.left`), the active tab's title centred (from `activeTitle`), and a `+` new-tab button at the right (bridge `tabs.create({windowId})`). Mouse: drag anywhere else moves the Chrome window (track mouseDragged deltas, set AXPosition, also move overlays immediately); double-click → press the window's AX zoom button (`kAXZoomButtonAttribute`) — or follow the user's "double-click title bar" preference from `UserDefaults` `AppleActionOnDoubleClick` (Maximize/Minimize/None).
- `SidebarPanel.swift` — non-activating `NSPanel` that can become key (override `canBecomeKey` true; `becomesKeyOnlyIfNeeded = true`) hosting a `WKWebView` that loads `sidebar://app/sidepanel.html?mode=overlay&windowId=<id>&profile=<dir>` through a `WKURLSchemeHandler` serving `Contents/Resources/web/` with correct MIME types (html, js → `text/javascript`, css, png, svg). Bridge: `WKScriptMessageHandler` named `sidebarBridge`; page bridge envelopes are sent to that window's ProfileBridge as `toExt`; matching `bridgeResult` and all `bridgeEvent`s of that profile are delivered via `evaluateJavaScript("window.__sidebarBridgeReceive(" + jsonStringLiteral + ")")`. Host messages handled by the controller. Width default 280, min 220, max 420; a 6 px resize handle on the right edge (native) persists the width per app (`UserDefaults`).
  - **States**: `hidden`, `peek`, `pinned`.
  - **Hover reveal**: a global + local `NSEvent` monitor for `.mouseMoved` (and `.leftMouseDragged` for dragging tabs onto the edge). When Chrome is the frontmost app and the pointer sits within 4 px of the Chrome window's left edge, vertically between the bottom of the tab strip and the window bottom, for 80 ms → `peek`: the panel slides in from the left edge over the page (animate our own frame from width 0 → full width, 140 ms ease-out), occupying x = window.minX … + width, y = window top + tab strip height … window bottom. Leave `peek` (slide out, 120 ms) when the pointer has been outside the panel for 350 ms and the page isn't `busy`.
  - **Pinned (float)**: same frame as peek, always shown.
  - **Pinned (push)**: when pinning, if the Chrome window's minX − sidebar width ≥ the screen's visible minX, place the sidebar to the left of the window (no resize); otherwise shrink the Chrome window from the left by the sidebar width (set AXPosition then AXSize) and place the sidebar in the freed space, full window height (from window top to bottom, next to the tab-strip cover). Remember how much was shrunk and give it back on unpin. If the user resizes/moves the Chrome window while pinned-push, keep the sidebar glued to its left edge.
  - Shortcut: a global hot key (Carbon `RegisterEventHotKey`) Control+Option+S toggles pinned for the frontmost Chrome window (only when Chrome is frontmost); show the shortcut in the status menu.
- Focus: clicking in the sidebar must not activate Sidebar.app (non-activating panel), so Chrome stays the active app; text fields still get keyboard input because the panel becomes key. After the page sends a bridge call that activates a tab, re-assert Chrome's key window if needed by calling `AXRaise` on the Chrome window only if Chrome isn't frontmost.
- `Permissions.swift` — `AXIsProcessTrustedWithOptions` prompt on launch; until trusted, show a small onboarding window with "Open Accessibility Settings" (`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`) and poll every 1 s.
- `StatusMenu.swift` — menu bar icon with: Pin sidebar (⌃⌥S) · When pinned ▸ Move the page over / Float over the page · Cover Chrome's tab bar (toggle) · Tab bar height ▸ Auto / 36 / 40 / 44 / 48 · Open at login (SMAppService.mainApp) · Accessibility settings… · Quit. Settings stored in `UserDefaults`; pin mode also settable from the web UI (`setPinMode`) and reflected back via `__sidebarHostState`.
- Logging to `~/Library/Logs/Sidebar.log` (rotate at 1 MB).

### Things the app must handle

- Chrome not running → no overlays; start tracking when it launches.
- Several Chrome windows, several profiles, windows on different screens (use the screen containing the window; AX coordinates are top-left-origin global, NSWindow frames are bottom-left — convert with the primary screen height).
- Chrome window minimized, fullscreen, or tab-dragged out (new window appears) → overlays hide/appear accordingly.
- The helper/extension missing → status menu shows "Extension not connected" and the sidebar shows instructions.

## 5. Tests

- Perl helper: extend `helper/test-helper.pl` with relay tests using a fake app socket.
- Extension + shim + helper: `tools/overlay-e2e.mjs` — runs the extension in Chromium with the real helper (like `tools/e2e.mjs`), plays the Mac app with a Node script that listens on `overlay.sock`, serves `extension/` files over HTTP, and implements the `bridgeHttp` test transport (`POST /send`, `GET /events` SSE). Opens `http://127.0.0.1:<port>/sidepanel.html?mode=overlay&windowId=<id>&bridgeHttp=…` in a normal tab and checks: shim ready, Today rows render, clicking a row activates the tab, pinned/favourite drag and drop work, rename, tab groups render, boost button opens the view, host messages (`ready`, `setPinned`, `theme`, `activeTitle`, `busy`) arrive, `__sidebarHostState` updates the pin toggle, favicons are swapped for data URLs, and live updates happen when tabs change.
- Mac app: compiled in GitHub Actions only (no runtime tests possible there).
