# Sidebar: handoff

This document is for whoever picks this project up next (most likely Claude running on Jeremy's Mac). It covers what the project is, how it's built, what's verified, what isn't, and what's next. The detailed design history is in the `SPEC*.md` files, in version order.

## 1. What this is

Jeremy wants Chrome to work like Arc. This project gives him that with three parts:

1. **Chrome extension** (`extension/`, MV3, plain JS, no build step except the screenshot editor). It does all the browser work through Chrome's extension APIs: tabs, windows, groups, bookmarks (Favourites and Pinned are stored as bookmarks), auto-archive, boosts (Zap/Code), screenshots, little windows and settings. Its UI can be shown in two places:
   - **Side-panel mode:** Chrome's own side panel. Still needs the Mac app: without a connection it shows only the "Stile.app required" screen.
   - **Overlay mode:** the same HTML page, loaded by Sidebar.app in a native panel. It talks to the extension through a bridge (`bridge-shim.js` turns `chrome.*` calls into bridge calls).
2. **Sidebar.app** (`mac/`, Swift Package, AppKit + WebKit, macOS 13+).
   - **Overlay:** draws the sidebar exactly over Chrome's vertical tab rail (Chrome must be in vertical-tabs mode), with hover-to-peek and pin.
   - **Following:** keeps the sidebar glued to Chrome's windows, including "lockstep" drags, where the app moves Chrome itself (always on; there is no setting for it).
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
  - Moving Chrome and the sidebar together (lockstep) works for him and he likes it, so it is now always on (the setting was removed).
  - Little windows: Minimal style by default, window style is a user choice, 6 h expiry, routing rules deferred.
- **Repo:** `https://github.com/simplisticsj/chrome_toolbar` exists but is empty. The cloud session never got access. The code so far exists only as zips sent to him and in the cloud session's local git repo (14 commits, latest is "Sidebar 3.0"). **First step on the Mac: put this tree in that repo and commit.** Git attribution lines are in the session's system reminders.
- **Extension ID** is fixed by the manifest `key`: `ffblekellgdmlecjablfojaaadpkmdgg`. The native host name is `com.sidebar.helper`.

## 3. Repo map

```
extension/            Chrome extension (manifest 1.0.0)
  background.js       service worker: commands dispatcher (dispatchCommand), bindings, archive, windows/merge,
                      little windows, locks, names, app connection (connectNative), appSetting/appState relay
  bridge-sw.js        bridge for overlay mode (allow-listed chrome.* calls, events forwarded to the app)
  bridge-shim.js      in the overlay page: fake `chrome` object over the bridge (WKWebView or ?bridgeHttp test transport)
  sidepanel.*         the sidebar UI (both modes); overlay mode = ?mode=overlay
  settings.*          settings UI. The gear (`openSettings`) asks Stile.app to show its window (`showSettings`); the Chrome popup page is the fallback.
                      No General section (default = Tabs & Archive); each section is `global` / `profile` / `mixed` with a "Settings for <profile>" picker or an
                      "All profiles" chip in the pane header; Tabs has the global archive default ("Apply to all profiles" = `clearArchiveOverrides`) above the per-profile override;
                      the profile override ("Chrome profile") lives in App > Troubleshooting. `settings.html?host=app&profile=<dir>` = the same page in the app's WKWebView over bridge-shim
                      (scope from the app's `stileSettings` state: `connectedProfiles`, `scopeProfile`, op `selectProfile`)
  settings-app.js    the app window without an extension (`settings.html?host=app`, capture-only mode or no profile connected; no `chrome.*`)
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
    DragController.swift   lockstep moves/resizes, always on in Chrome mode (own event tap on its own thread)
    CloseInterceptor.swift close button / Cmd+Shift+W -> merge; Cmd+O in little windows
    LittleLinks.swift, LittlePillPanel.swift   default browser + little windows
    ChromeColor.swift      exact colour sampling (Screen Recording)
    ScreenCapture.swift    capture modes + after-capture flow (editor, recent captures); Capture/: SelectionOverlay (picking),
                           SelectionHighlight (outline), Screenshotter (ScreenCaptureKit)
    Permissions.swift      onboarding window;  MenuBar.swift  status item;  SetupNoticePanel.swift  "not set up" pill
    AppMode.swift          "Use Stile with Chrome" (Settings.useChrome) + first-run choice;  CaptureSettings.swift  app-owned capture
                           settings (state.json `capture`, Keychain secret);  AppSettingsWindow.swift  settings.html?host=app window
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
| `node tools/fake-app/test-host.mjs` | 186 |
| `node tools/e2e.mjs` | 240 |
| `node tools/boost-e2e.mjs` | all passed |
| `node tools/overlay-e2e.mjs` | 338 (with the Green button select checks at the top of the Windows section removed: that row left the settings window with the 3.1 work and the test was not updated, so the suite stops there as committed) |
| `node tools/capture-e2e.mjs` | 130 |
| `node tools/capture-app-e2e.mjs` (editor in an app window, WebKit; needs Playwright's WebKit for this Playwright version, or `PLAYWRIGHT_PATH` pointing at one that has it; also covers `settings.html?host=app`) | 33 |
| `cd tools/capture-build && npm test` (Vitest: Jeremy's annotation model/history/flatten + SigV4) | 136 |

- `overlay-e2e` serves the page from the web root built by `mac/copy-web.sh`, which is the same copy the app ships. That guard exists because 2.9 shipped without `capture/` and the sidebar went blank.
- Split view needs Chrome 155+. The test Chromium (141) lacks it, so tests stub `splitViewId`.
- Swift code has **no automated tests**. Verify on the Mac: build, run, read the log, and look at the screen.

## 6. Status

### Confirmed working on Jeremy's Mac
- The app builds and runs. The sidebar shows over the vertical rail, the bridge connects and tabs list.
- Lockstep (moving Chrome and the sidebar together) works (since 2.9.2); always on since 3.x, the setting was removed. If Chrome doesn't follow a drag, the app falls back to native dragging until it restarts.
- The extension requires Stile.app. When the app isn't connected (helper status `not_installed` or `error`; never while checking), the side panel (not overlay mode) and the settings window show a "Stile.app required" gate: download + steps if it never connected, Open Stile.app / Retry if it did. They switch back live once the app connects (helper-retry alarm every minute, or Retry). Not yet seen on the Mac. The download URL is a placeholder constant `STILE_APP_URL` in `extension/shared.js`; fill it in once there is a real download location.
- Resize follows live (rail height uses `bottomInset`).
- The collapsed-strip design improvements (2.4) were well received, apart from the specific notes that led to 3.0.

### Written but NOT yet verified on a Mac (watch these first)
- **3.6 recording (record half)** (`Capture/Recorder.swift`, `RecordingController.swift`, `RecordingBar.swift`, `RecordingPill.swift`;
  menu items, Control+Option+8, `MenuBar.setRecording`; extension `recordTab*` messages, see `mac/README.md`): nothing was run live
  (no TCC in the build session). Check: SCRecordingOutput really finalises on `stopCapture` (segment files appear and play), the
  pause/resume segments join cleanly and in sync, mic and system audio end up in the MP4 (and whether the mic is its own track),
  `sourceRect` for a window filter is window-relative, AXWebArea frame for the tab (Chrome exposes it after `AXManualAccessibility`),
  window-resize `updateConfiguration` scaling, the bar taking Return/Esc without activating the app, the status item swap, the
  tab auto-pause/close/move messages, mic permission prompt flow, red border excluded from display recordings.
- **3.6 recording (preview half)** (`Capture/RecordingWindow.swift`, `S3Upload.swift`, `RecentRecordings.swift`, `StileCore/SigV4.swift`,
  `RecordingExport.swift`; menu "Recent Recordings"; `nativeRecording` to the extension): SigV4, multipart request shapes, the
  trim export (passthrough vs re-encode on a generated clip) and the extension list are unit / e2e tested; NOT run live: the 3.7
  editor driven by mouse / keys (seen rendering in the dev preview with splits, a ripple delete and one annotation of each kind,
  live blur and the background export running; 3.8 seen: reordered clips with the ruler, split annotation bars, each
transition mid-way; 3.9 seen: the scissors cursor image, the recording bar's camera row; NOT run at all: the camera (the
bubble, dragging / sizing it, it showing up in screen / window / tab recordings, Camera only recording, pause, the MP4
rewrap, the camera permission prompt), the Razor's line and click; and no clicks or drags: dragging clips into a new order, playback across reordered clips, the transition
menu and Animate toggle, Split / Delete / edge drags to restore, the timeline's
  annotation bars, drawing / moving / resizing / typing text on the video, the properties card, undo / redo, playback across
  cuts), the editor in dark mode, the
  window sizing, Stile's panels in recordings / screenshots of Chrome (composited window recording following moves), Copy pasting a file into Slack / Mail, the drag grip into Finder / Slack, an
  upload to a real bucket (single PUT and a >100 MB multipart, cancel -> abort), the Dock icon coming and going with previews and
  editors, Option-click in the Recent Recordings submenu, the thumbnail images in menu items.
- **3.5c capture-only mode and app-owned capture settings** (`AppMode.swift`, `CaptureSettings.swift`, `AppSettingsWindow.swift`,
  `OverlayManager.stop()`, `Permissions.swift`, `MenuBar.swift`): the first-run choice window, switching the mode at runtime
  (taps and overlay really go away, nothing flickers; switching back runs the Chrome onboarding), capture-only onboarding
  (Screen Recording required, Microphone optional), the trimmed menu, `settings.html?host=app` in the app window (WKWebView:
  folder chooser, connection test through URLSession, mic list), Keychain read/write (an ad-hoc signed rebuild may prompt),
  adoption of the extension's S3 setup, the editor using the app's folder/pattern.
- **3.4 screenshots of any app** (`ScreenCapture.swift`, `CaptureEditor.swift`, see `mac/README.md`): menu bar items and
  Control+Option+3/4/5/6, `screencapture` (needs Screen Recording), the editor in an app window (WKWebView, `?host=app`)
  for app captures and, while connected, Chrome captures too: copy, save to ~/Downloads/Screenshots, S3 upload through
  URLSession, native drag-out from the grip, red button asking "Discard changes?".
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

### Store install (v3.10, written, not run on a Mac)
- **TODO before release:** paste the Chrome Web Store ID into `HostSetup.storeExtensionID` (`mac/Sources/StileApp/HostSetup.swift`). While it is the `REPLACE_WITH_STORE_ID` placeholder (`HostSetup.storeIDSet` false) all store UI and logic is off and the app looks as before. Try to reuse the manifest key on first upload so the ID stays `ffblekellgdmlecjablfojaaadpkmdgg` (the Web Store reportedly lets the first upload include `key.pem` in the zip; unverified).
- Onboarding: *Install in all profiles* writes the External Extensions file (`StileCore/ExtensionInstall.swift`, user click only, never overwritten, never removed; Chrome installs on next start; `SIDEBAR_EXTERNAL_EXT_DIR` overrides the folder), *Restart Chrome* (`ChromeSetup.restartChrome`) only on click, per-profile *Add from Chrome Web Store* (`HostActions.openStorePage`), unpacked steps kept under "Developer: load unpacked". The sidebar setup card has the same store button (`openStore`).
- Profile rows: Connected / Installed (store) / Installed (unpacked) / Not installed, classified by `location` in `Preferences` + `Secure Preferences`. Unit tests: `ExtensionInstallTests`.

### Known small TODOs
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

- **Event taps:** never intercept `leftMouseDragged` (or anything hot) in a long-lived tap. Every event waits for our main thread, and Chrome lagged badly. The drag tap runs on its own thread, decides from a lock-protected snapshot and hands side effects to the main queue (lockstep is always on).
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
