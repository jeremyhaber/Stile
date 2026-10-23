# Sidebar: handoff

This document is for whoever picks this project up next (most likely Claude running on Jeremy's Mac). It covers what the project is, how it's built, what's verified, what isn't, and what's next. The detailed design history is in the `SPEC*.md` files, in version order.

## 1. What this is

Jeremy wants Chrome to work like Arc. This project gives him that with three parts:

1. **Chrome extension** (`extension/`, MV3, plain JS, no build step except the screenshot editor). It does all the browser work through Chrome's extension APIs: tabs, windows, groups, bookmarks (Favourites and Pinned are stored as bookmarks), auto-archive, boosts (Zap/Code), screenshots, little windows and settings. Its UI can be shown in two places:
   - **Side-panel mode:** Chrome's own side panel. Works without the Mac app.
   - **Overlay mode:** the same HTML page, loaded by Sidebar.app in a native panel. It talks to the extension through a bridge (`bridge-shim.js` turns `chrome.*` calls into bridge calls).
2. **Sidebar.app** (`mac/`, Swift Package, AppKit + WebKit, macOS 13+).
   - **Overlay:** draws the sidebar exactly over Chrome's vertical tab rail (Chrome must be in vertical-tabs mode), with hover-to-peek and pin.
   - **Following:** keeps the sidebar glued to Chrome's windows, including "lockstep" drags, where the app moves Chrome itself.
   - **Native host:** it is the extension's native messaging host. Chrome launches the same executable in "connector mode" as a byte pipe to the app's `host.sock`.
   - **Other jobs:** profile switching, shared settings, close-button interception (pop-out windows merge back), little windows and the default-browser link router, screenshot colour sampling, permissions onboarding, and the menu bar icon.
3. **Node reference host** (`tools/fake-app/`): a JavaScript implementation of Sidebar.app's host protocol, used by the Linux test suites in place of the Swift app. The Swift `HostServer` must behave the same as this reference.

The old Perl helper (`helper/`) is gone. Its job moved into Sidebar.app in 2.1.

## 2. Working with Jeremy

- **Setup:** he's on a Mac, uses Chrome with several profiles, and tests every build himself. He sends screenshots and clear feedback.
- **Discuss first when asked.** When he says "let's discuss before implementing", answer and wait. He also often adds requests mid-task; fold them in.
- **Product preferences so far:**
  - Arc-like feel, cohesive and native-looking. It should not feel like a separate app.
  - No gradients.
  - Draw our own traffic lights rather than leaving a cut-out for Chrome's.
  - No back/forward/reload in the top bar.
  - Menu bar icon wanted.
  - "Move Chrome and the sidebar together" (lockstep) works for him and he likes it.
  - Little windows: Minimal style by default, window style is a user choice, 6 h expiry, routing rules deferred.
- **Repo:** `https://github.com/simplisticsj/chrome_toolbar` exists but is empty. The cloud session never got access. The code so far exists only as zips sent to him and in the cloud session's local git repo (14 commits, latest is "Sidebar 3.0"). **First step on the Mac: put this tree in that repo and commit.** Git attribution lines are in the session's system reminders.
- **Extension ID** is fixed by the manifest `key`: `ffblekellgdmlecjablfojaaadpkmdgg`. The native host name is `com.sidebar.helper`.

## 3. Repo map

```
extension/            Chrome extension (manifest 1.3.0)
  background.js       service worker: commands dispatcher (dispatchCommand), bindings, archive, windows/merge,
                      little windows, locks, names, app connection (connectNative), appSetting/appState relay
  bridge-sw.js        bridge for overlay mode (allow-listed chrome.* calls, events forwarded to the app)
  bridge-shim.js      in the overlay page: fake `chrome` object over the bridge (WKWebView or ?bridgeHttp test transport)
  sidepanel.*         the sidebar UI (both modes); overlay mode = ?mode=overlay
  settings.*          settings window (popup, opened by the gear)
  boost*.js, zap-picker.js, boosts-sw.js   Boosts (Zap = hide elements, Code = CSS/JS via userScripts)
  capture/            screenshots: capture-sw.js, capture-view.js, page.js, s3.js (SigV4), capture.html,
                      dist/ (built React editor), src/ (TS/React sources incl. Jeremy's annotation code)
  littlesearch.*      quick search page for little windows
mac/
  Package.swift, build.sh, copy-web.sh, Resources/ (Info.plist, AppIcon.iconset)
  Sources/SidebarApp/
    App.swift              entry; connector mode check happens before AppKit
    Connector.swift        native messaging byte pipe (stdio <-> host.sock), launches the app if needed
    HostServer/HostStore/HostSetup.swift   native messaging host (the protocol), state.json, manifest self-registration
    OverlayManager.swift   owns tracker, mapper, controllers, follow loop, hotkeys, app settings
    OverlayController.swift  one per Chrome window: sidebar panel states (collapsed/peek/pinned), host state, menus
    SidebarPanel.swift     the WKWebView panel (non-activating, key forwarding to Chrome)
    ChromeTracker.swift, WindowMapper.swift, RailFinder.swift, AX.swift   finding/following Chrome windows and the rail
    DragController.swift   lockstep moves/resizes (own event tap only while needed)
    CloseInterceptor.swift close button / Cmd+Shift+W -> merge; Cmd+O in little windows
    LittleLinks.swift, LittlePillPanel.swift   default browser + little windows
    ChromeColor.swift      exact colour sampling (Screen Recording)
    Permissions.swift      onboarding window;  MenuBar.swift  status item;  SetupNoticePanel.swift  "not set up" pill
tools/
  e2e.mjs, overlay-e2e.mjs, boost-e2e.mjs, capture-e2e.mjs   Playwright + Chromium suites
  fake-app/ (host-server.js, connector.js, test-host.mjs)     reference host + protocol tests
  capture-build/ + build-capture.mjs                          esbuild/React build for the screenshot editor
  v3-shots.mjs                                                regenerates design screenshots
SPEC.md … SPEC-v3.1-topbar.md     design history; read the latest few first
```

## 4. Build, install, run (Mac)

```bash
cd mac && bash build.sh          # -> mac/dist/Sidebar.app and mac/dist/Sidebar.zip (UNIVERSAL=1 for arm64+x86_64)
killall SidebarApp 2>/dev/null; open mac/dist/Sidebar.app
```
- **Extension:** load `extension/` unpacked in each Chrome profile (`chrome://extensions`, Developer mode). The app bundle also carries a copy at `Contents/Resources/extension`. After changes, click reload on the extension in each profile.
- **After every rebuild**, macOS treats the app as new. Remove it from System Settings → Privacy & Security → Accessibility with "–", then add it again (or let the onboarding window prompt). Screen Recording is the same if it's used.
- **Chrome:** right-click the tab strip → "Show tabs vertically", then collapse the rail.
- **Logs:**
  - `~/Library/Logs/Sidebar.log` (app). Useful greps: `rail[window`, `lockstep`, `focus:`, `host:`, `fullscreen`, `little`.
  - `~/Library/Logs/Sidebar-connector.log`.
- **App state:** `~/Library/Application Support/Sidebar/` holds `state.json`, `host.sock`, and the `quit-by-user` flag.
- **Native host manifest:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sidebar.helper.json` (written by the app on launch).
- **Emergency off:** `killall SidebarApp` brings Chrome's own UI back.
- **Swift:** Xcode 16 toolchain in Swift 5 language mode. Previous compile errors were actor-isolation issues: a nonisolated function touching `@MainActor` members. Event tap callbacks use `MainActor.assumeIsolated`, which only swallows events on macOS 14+.

## 5. Tests (Linux or Mac, Node + Playwright Chromium)

Run each separately; each takes a few minutes. All must stay green. Last counts:

| Command | Last count |
|---|---|
| `node tools/fake-app/test-host.mjs` | 158 |
| `node tools/e2e.mjs` | 199 |
| `node tools/boost-e2e.mjs` | all passed |
| `node tools/overlay-e2e.mjs` | 274 |
| `node tools/capture-e2e.mjs` | 102 |
| `cd tools/capture-build && npm test` (Vitest: Jeremy's annotation model/history/flatten + SigV4) | 116 |

- `overlay-e2e` serves the page from the web root built by `mac/copy-web.sh`, which is the same copy the app ships. That guard exists because 2.9 shipped without `capture/` and the sidebar went blank.
- Split view needs Chrome 155+. The test Chromium (141) lacks it, so tests stub `splitViewId`.
- Swift code has **no automated tests**. Verify on the Mac: build, run, read the log, and look at the screen.

## 6. Status

### Confirmed working on Jeremy's Mac
- The app builds and runs. The sidebar shows over the vertical rail, the bridge connects and tabs list.
- Lockstep "Move Chrome and the sidebar together" works (since 2.9.2).
- Resize follows live (rail height uses `bottomInset`).
- The collapsed-strip design improvements (2.4) were well received, apart from the specific notes that led to 3.0.

### Written but NOT yet verified on a Mac (watch these first)
- **3.0 (Mac side):**
  - the permissions onboarding window layout
  - the menu bar icon and menu (`MenuBar.swift`)
  - `appState` / `appSetting` relay to the settings window
  - `beginWindowDrag` from empty sidebar space (temporary drag tap)
  - the little window's "Open in Chrome" title-bar button position
  - ⌘O logging
- **2.8:** default-browser switch and the link router (`LittleLinks.swift`), the Control+Option+N hotkey, little windows end-to-end.
- **2.7:** the "not set up" pill and the hide-when-disconnected rules.
- **2.6:** incognito detection by window title (the title format was guessed).
- **2.5:** key forwarding from the sidebar to Chrome, and close-button / Cmd+Shift+W interception merging pop-outs.
- **2.3:** exact colour via Screen Recording (may need an app relaunch after granting).
- **Extension features with no real-world check:** custom JavaScript boosts (needs "Allow User Scripts"), S3 upload against a real bucket (signing is verified against AWS's examples), and split view (Chrome 155+).

### Known small TODOs
- Settings: hide a group when all its rows are hidden.
- Remove unused `.cap-*` CSS in `capture/capture-view.css`.
- Add an e2e check for the extension's reaction to the "duplicate profile" identify reply.
- The menu bar icon can only be re-shown from the extension's settings after hiding it. Consider also re-showing it when the app is opened from Finder.
- A live little window's ⌘O promote reopens the page (tab id changes); popups can't be moved by Chrome.

## 7. Next steps (agreed order)

1. **3.1 top bar** (`SPEC-v3.1-topbar.md`, written, not started; both agents were cancelled before writing code). Replace Chrome's vertical-tabs header with a native header panel:
   - our own traffic lights at Chrome's exact positions, inactive state and hover glyphs
   - green button menu: Fill / Tile left / Tile right / Full screen / Restore
   - sidebar toggle replacing the footer pin
   - drag/double-click on empty space
   - keeping the overlay over Chrome's full-screen Space, with a logged fallback to Fill and a `greenButtonAction` setting

   Unknown: Chrome's header layout when the rail is collapsed (traffic lights are wider than the collapsed rail). Measure it with AX and look at the screen first.
2. **Downloads popover:** hovering Archive shows the last 4 downloads with progress. Files are draggable into other apps: `chrome.downloads.drag` in side-panel mode, a native `NSDraggingSession` from the app in overlay mode.
3. **Presentation mode** (agreed design): "Start presenting" opens a dedicated presentation window whose sidebar shows only the tabs added to it, with other windows, profiles, Temporary and downloads hidden. Jeremy shares that window in Zoom/Meet. "Stop presenting" merges the tabs back. macOS doesn't tell other apps which window is being shared, so it's explicit, not detected.
4. **Offered, not yet decided:**
   - put restored pinned tabs to sleep at startup (memory)
   - routing rules for little windows (site → profile)

## 8. Lessons learned (don't repeat these)

- **Event taps:** never intercept `leftMouseDragged` (or anything hot) in a long-lived tap. Every event waits for our main thread, and Chrome lagged badly. The drag tap exists only during a lockstep session.
- **Mouse state:** after swallowing a mouse-down, `NSEvent.pressedMouseButtons` reports the button as up. Use `CGEventSource.buttonState(.hidSystemState, button: .left)`.
- **Focus:** don't raise or activate Chrome windows in response to background page activity. A "reassert focus" on every bridge call made two profiles fight over focus. Only act within ~0.8 s of a click in that panel.
- **Duplicate identities:** two connections claiming the same profile replace each other forever. The host now refuses after 3 replacements in 60 s and the extension asks "Which profile is this?".
- **Web root:** the app's web root must contain the whole extension folder (subfolders included). Use `mac/copy-web.sh`, which the tests also use.
- **Chrome API gotchas:**
  - `chrome.tabs.group` without `createProperties.windowId` groups in the *current* window and moves the tabs there.
  - `tabs.move` can't move tabs out of popup windows.
  - `tabGroups.move` keeps a group, but `tabs.move` on one grouped tab drops it from the group.
- **MV3 service worker:** register listeners synchronously at top level, persist everything in `chrome.storage`, and serialize writes through the existing queue.
- **Covering Chrome:** only cover Chrome's UI when connected. With no connection, Chrome's own tabs must stay visible.
- **Design rule for the collapsed strip:** one DOM for compact and expanded, identical vertical positions, and nothing clipped at the strip edge.
