# Stile.app (macOS)

A background app that puts the Stile extension's UI exactly over Chrome's **vertical tab rail**, so it
looks and behaves like Chrome's own sidebar. Chrome's toolbar, address bar and window buttons stay
untouched. The app also *is* the extension's native messaging host: there is no separate helper to
install and no Dock icon. A small menu bar icon (SF Symbol `sidebar.left`) gives quick access to
the sidebar on/off switch (Control+Option+Shift+S), keeping it open (Control+Option+S), moving Chrome and the
sidebar together, Settings, the permissions window and Quit. Turn it off with "Show menu bar icon" in the
extension's settings (App section).

## Screenshots of any app

The menu bar menu starts with Shottr-style capture items, each also a global hotkey (macOS 15 or later):

| Item | Hotkey |
|---|---|
| Capture Screen (the display under the pointer) | Control+Option+3 |
| Capture Area (drag; Space switches to window picking, Esc cancels) | Control+Option+4 |
| Capture Window (hover highlights, click picks) | Control+Option+5 |
| Capture Active Window (the frontmost app's window, no picking) | Control+Option+Shift+5 |
| Repeat Area Capture (in More; the last area, no overlay; picks one if none yet) | Control+Option+Shift+4 |
| Scrolling Capture (pick an area; it scrolls by itself and stops at the end; works in any app) | Control+Option+7 |
| Capture Full Chrome Page (the extension's scrolling capture of the last focused Chrome window) | Control+Option+6 |
| More: Delayed Screenshot (3 s countdown badge, then the screen), Open Image…, Load From Clipboard | none |

Our own selection overlay (`Capture/SelectionOverlay.swift`: a dimmed panel per display, live size label, a loupe, hold
Option when releasing the drag to keep adjusting: arrows nudge, Shift+arrows resize, Return confirms; Esc cancels) does the picking and ScreenCaptureKit
(`Capture/Screenshotter.swift`, `SCScreenshotManager`) takes the picture, excluding Stile's own windows. Window captures
keep macOS's shadow (setting `windowShadow`, default on; `CaptureSettings.swift`). The last area is kept in `state.json` (`lastCaptureRect`).
`Capture/SelectionHighlight.swift` outlines a rect / window / display for features that need the target to stay visible.
Scrolling capture (`Capture/ScrollCapture.swift`): pick an area (arrows adjust, Return confirms); it parks the pointer there and
posts scroll-wheel events (Accessibility), finishing once nothing new appears for 2 s; moving the pointer hands over to manual scrolling. An `SCStream`
at ~15 fps feeds frames to the stitcher (`Sources/StileCore/ScrollStitcher.swift`, pure and unit-tested: `swift test`), which matches
row hashes to find each frame's offset, keeps sticky headers / footers once, handles scrolling up, and skips frames it cannot match
(the floating bar flashes "Scroll slower"). Done / Return / Esc keep the result, Cancel discards, 30 000 px is the cap.
The picture opens in the **editor window** (`CaptureEditor.swift`): the
extension's own React editor (`capture/capture.html?host=app`) in a WKWebView. It asks the app for everything Chrome
did for the popup (`stileCapture` message handler: load, copyImage, copyText, save to the app's screenshot folder (default `~/Downloads/Screenshots`), the
S3 request through URLSession, setLink, dragOut, close); the picture is served at `sidebar://app/__capture/<id>.png`.
While an editor window is open Stile shows in the Dock and Command+Tab (clicking the Dock icon brings the latest
editor forward); it goes back to menu-bar only when the last one closes. It works without Chrome; upload uses the profile's S3 settings, which the extension pushes (`captureConfig`, kept in
memory only). The picture also goes to that profile's recent captures in base64 parts
(`{type: 'nativeCapture', ..., open: false}`; native messages to Chrome are limited to 1 MB).

Chrome page captures (and "Recent captures") open in the same window while the app is connected: the extension sends
`{type: 'openCaptureEditor', id, part, parts, data, meta, config}` and falls back to its Chrome popup when the app
doesn't answer ok. Needs **Screen Recording** permission (asked on first use). Log lines start with `capture:`.

### Screen recording (3.6, recording half)

Menu: Record Screen / Window / Area / Chrome Tab (the last only in Chrome mode, enabled while an extension is connected).
Control+Option+8 stops a recording, otherwise opens the picker for the last-used target. Files: `Capture/Recorder.swift`
(engine), `RecordingController.swift` (flow), `RecordingBar.swift` (pre-start bar), `RecordingPill.swift` (pill + 3-2-1);
the preview window is `RecordingWindow.swift`. Flow: pick (the shared overlay) -> bar (target named "Recording: Window — Slack",
mic picker, system audio, Start/Return, Cancel/Esc; choices saved in the `capture.recording` settings) -> countdown -> recording.
While recording: red 3 pt border around exactly what is captured (amber + "Paused" when paused), the floating pill (timer, target,
mic level, Pause/Resume, Stop, Restart, Discard with confirmation) and a red stop square as the menu bar icon (click = stop).
Save folder: recordings follow the screenshot folder (`capture.screenshotFolder`, default `~/Downloads/Screenshots`) unless a separate
`capture.recordingFolder` is chosen; Settings > Capture shows "Same as screenshots" or the path plus "Use screenshot folder"
(sets `recordingFolder` to `""`). `recordingFolderFollowsScreenshots` in the settings payload says which. Older recordings in `~/Movies/Stile` stay put.
The border, bar and pill are this app's windows, so display recordings exclude them and window / tab recordings never see them.

- One `SCStream` + `SCRecordingOutput` (macOS 15) writes H.264 / HEVC MP4 with AAC to `~/Library/Caches/Stile/recordings/<uuid>.mp4`
  (fps, codec, max resolution and cursor from the settings). System audio = `capturesAudio` (our own excluded); the mic =
  `captureMicrophone` + `microphoneCaptureDeviceID`, permission asked when a mic is picked or at Start (denied: records without, says so in the bar).
- **Pause** ends the segment (stream stopped, file finalised) and resume starts the next one; Stop joins the segments with an
  `AVMutableComposition` + passthrough `AVAssetExportSession` (re-encodes only if passthrough fails, e.g. differing sizes). Restart = discard + start again.
- **Chrome tab:** SCK window filter on the Chrome window with `sourceRect` = the `AXWebArea` frame (largest web area, relative to
  the window), re-read every 0.25 s and fed to `updateConfiguration`; the output size stays that of the first segment. The window
  comes from the window mapper (overlay running), else by title / z-order; without Accessibility a fixed 88 pt toolbar is assumed.
  Audio with a window filter is that of the whole Chrome app, not only the tab. Extension messages: `recordTab {windowId, tabId, title}`
  (sidebar tab menu "Record this tab", command `recordTab`, or the app's `recordTabRequest` from the menu), `recordTabState {tabId, active}`
  (inactive = auto-pause "Paused: tab not visible"), `recordTabClosed {tabId}` (stop + preview), `recordTabMoved {tabId, windowId}`
  (retarget); the app answers `recordingTab {tabId|null}` so only that tab is tracked (a red dot shows on its sidebar row).
- Hand-off at Stop: `RecordingWindows.shared.open(RecordingDocument(...))`. Log lines start with `record:`.

### Camera (3.9)

`Capture/CameraCapture.swift`. Loom-style: **screen + camera** = pick a camera in the recording bar (Record Screen / Window /
Area / Chrome Tab); a round bubble (`CameraBubble`, an `AVCaptureVideoPreviewLayer`, mirrored) floats over everything,
starting in the target's bottom-left corner; drag it anywhere, right-click for Small / Medium / Large and the four corners.
It is recorded because captures *show* it: `Screenshotter.extraCaptureWindows` adds it to the display filters' excepted
windows, and a window or Chrome tab recording with it is composited from the display (`including:` the window and the
bubble; a tab's page rect is followed in display coordinates). **Camera only** (menu "Record Camera"): the same panel as a
16:9 preview while `CameraRecorder` records the session with an `AVCaptureMovieFileOutput` (camera + the chosen mic; native
pause), rewrapped to MP4 (passthrough) at the end. Both recorders sit behind `RecordingEngine`. The camera choice and bubble
size are remembered (`capture.recording.cameraDeviceId / cameraSize`); access is asked for when a camera is first picked
(`NSCameraUsageDescription`).

### Recording preview, export and sharing (3.6, preview half)

`Capture/RecordingWindow.swift`: a native window per finished recording (`RecordingWindows.shared.open(RecordingDocument)`), like
the screenshot editors it puts the app in the Dock while open. It looks like the screenshot editor (`Capture/EditorChrome.swift`:
its colour tokens, 46 pt bar of ghost buttons, canvas, floating properties card, status line, toasts).

**Editing (3.7, Premiere-style)** — `StileCore/EditModel.swift` (unit-tested), `Capture/EditTimeline.swift`: the recording is a
row of clips. **Cut at the playhead** (S / ⌘K / right-click "Split Here") cuts the clip under the playhead; select a clip and **Delete** removes it and the
rest closes up (ripple delete), so the timeline is always the edited video. A red mark on a clip edge = removed footage there:
drag that edge out to bring it back (any edge drags in to trim; the scale freezes during the drag, a left edge follows the
pointer and the gap closes on release). Set Start / Set End (I / O) remove everything before / after the playhead, Reset brings
everything back, ⌘Z / ⇧⌘Z undo (snapshots of clips + annotations). Playback plays the edit: a boundary observer at each cut
seeks over removed footage, `forwardPlaybackEndTime` stops at the last clip. 3.8: clips can be **dragged into any order** (a
line shows where it goes; the time ruler above the clips scrubs). Clips never share footage, so recording <-> sequence time
stays unique; an edge drags out into footage no other clip uses, whatever the order. Playback follows the timeline: a boundary
observer at every clip end hands over to the next clip (`playingClip`), seeking only when its footage doesn't follow on.
3.9: the **Cut** tool (C, or the Cut button; there is no separate Split button): over the clips the pointer is scissors (`EditTimeline.scissors`) and a red line
with the time shows where a click cuts. Within 8 pt (`StileCore/CutSnap.swift`, screen points so zoom doesn't matter) of the playhead the line snaps onto it
(white core, end dots) and the click cuts at the playhead time exactly as S does (`onSplit(nil)`); hold ⌥ to switch the snap off.

**Transitions between clips** — `StileCore/CutTransition.swift`, `EditModel` (style, speed, per-seam overrides), `EditComposition.swift`
(+ `CutTransitionTests`). The **Transitions** button in the editing row sets the edit-wide style (None default, Crossfade, Fade through
black, Fade through white) and speed (Short 0.3 s / Normal 0.5 s); one undo step. A bow-tie marker sits on each cut (always when transitions
are on, on hover otherwise): click it, or right-click a clip > "Transition Into This Clip", to give that cut its own style (None included) or
"Same as Edit". Cuts between contiguous footage count too. Timing model: a **crossfade overlaps** the two clips by `d`, so the edit is `d`
shorter per crossfade; a **dip** is centred on the cut (`d/2` out, `d/2` in), no overlap, length unchanged. `d` is clamped to 40 % of the
shorter neighbouring clip (under 0.04 s: none). `sequenceStart(of:)`, `length`, `clipIndex(atSequence:)`, annotation anchoring, the playhead and
the ruler all go through that, so they stay consistent; at a crossfade the incoming clip owns the overlap. Audio ramps with the picture
(`AVMutableAudioMix`). With any transition the editor plays and exports the **same** `EditComposition` (two alternating video and audio tracks,
`EditCompositor` custom compositor blending layers over black or white, annotations / blur drawn on top; player time = edited-video time, no
clip handover); with none it keeps the plain source-asset player and the passthrough export. Transitions always re-encode.

**Drawing (3.7)** — `StileCore/VideoAnnotation.swift` (+ tests), `Capture/AnnotationCanvas.swift`: Select (V), Rectangle (R),
Arrow (A), Text (T), Highlight (H), Blur (B), Count (N) in the bar; colours / sizes in the floating card (the screenshot editor's palette and
size steps, arrow head, text halo, blur strength). Count badges are numbered from a counter the editor holds (saved with undo): Reset in the card starts again at 1, and typing a number into a selected badge sets it and continues from there (1-999). Each annotation keeps recording time (it stays on its footage when clips
around it are cut) and has a bar in the timeline's lanes: drag it to move when it shows, its ends to change how long. New
drawings and blur boxes show for 4 s from the playhead. In the editor the drawings are live vectors on a
layer over the video (`AnnotationRenderer`), blur boxes go through a Core Image video composition on the player item
(installed only while there are blur boxes); the export draws both into every frame with the same renderer
(`AnnotationFrameRenderer`, the drawings cached per visible set) through `AVVideoComposition`, mapping output time back to
recording time per piece. Annotations always mean a re-encode. 3.8: **transitions** per annotation (None, Fade, Pop, Slide up,
Draw; in and mirrored out, 0.35 s, never more than half its time), picked in the properties card; **Animate** in the editing row
turns them all off for preview and export (remembered). They play while the video plays; paused, everything shows fully so it
can be edited. The export overlay cache is used only while every drawing is fully in.

To work on it next to a running Stile: `STILE_PREVIEW_RECORDING=/path/clip.mp4 .build/debug/StileApp` opens only this window
(no migration, server or overlay; nothing written to the recent recordings). An edit is exported 1.5 s after the last change, in
the background (`StileCore/RecordingExport.swift`: `AVAssetExportSession`, **passthrough** when the cut starts on a keyframe
(`AVSampleCursor` sync check), else a re-encode with a preset that keeps the codec and size; progress, cancellable) so Save, Copy,
Upload and the drag grip are instant. The title field names the file (the file name pattern applies only when the title is
untouched and the pattern is customised). **Save** -> recordings folder (⌘S asks where), **Copy** puts the file URL on the pasteboard
(pastes into Slack / Mail / Finder), **Upload** -> S3 with a progress bar, then copies the link and shows it with Copy Link, the
grip drags the file out. Closing a recording that was not saved, copied, uploaded or dragged asks "Discard recording?" (Save /
Discard / Cancel); discard deletes the temp file.

`StileCore/SigV4.swift` + `S3Config.swift` (pure, tested against AWS's documented vectors and s3.js): SigV4 for PutObject and the
multipart calls, presigned links, the key layout and public-link rules of `extension/capture/s3.js` (a default `screenshots/`
prefix becomes `recordings/`). `Capture/S3Upload.swift`: one PUT under 100 MB, else multipart (10 MB parts, 3 at a time, 3 tries
each, aborted on cancel or failure), `Content-Type: video/mp4`. `Capture/RecentRecordings.swift`: the last 10 recordings
(`Application Support/Stile/recent-recordings.json`, thumbnails in `recording-thumbs/`), the menu bar **Recent Recordings**
submenu (click reopens, Option-click shows in Finder) and `{type: 'nativeRecording', id, title, duration, time, link, thumb}` to
connected extensions (`{id, removed: true}` on removal; the extension lists the 10 newest beside recent captures). Log lines start with `recording:`.

### Capture-only mode and capture settings (3.5c)

**"Use Stile with Chrome"** (`Settings.useChrome`, UserDefaults `useChrome`; on for existing installs, asked on a first run) decides
what the app does. Off = capture only: no Chrome tracking, overlay, follow loop, event taps, close interceptor or little links
(`OverlayManager.stop()` tears them down at runtime; switching on runs the normal Chrome onboarding; no relaunch needed). The
native host manifest is **not written** in capture-only mode; one already there is left alone (harmless, and an installed extension
can still connect to edit the capture settings). `host.sock` is always served. The onboarding asks only for Screen Recording
(Microphone is an optional row for recording); the menu bar shows the capture items, Settings…, Review permissions… and Quit. Settings…
opens `settings.html?host=app` in an app window (`AppSettingsWindow.swift`, message handler `stileSettings`; `extension/settings-app.js`):
Capture, Recording and a small App pane (the mode switch, launch at login, permissions). In Chrome mode it still opens the extension's settings.

`CaptureSettings.swift` owns the capture settings: `state.json` `capture` (save folders, file name pattern with `{yyyy} {mm} {dd}
{hh} {min} {ss} {app}`, window shadow, annotate, ask-where, S3 endpoint/region/bucket/key id/prefix/link options, the reserved recording
defaults) and the **S3 secret in the Keychain** (generic password, service `<bundle id>.s3`). The editor window's config comes from
here; saving uses the folder and pattern. An extension's first `captureConfig` with an S3 bucket is adopted once while the app has none.
The extension edits the same values through `appSetting` (`setCaptureSettings` with a patch, `chooseCaptureFolder`, `setUseChrome`);
`appState` carries `capture` (no secret, `secretSet`), `useChrome`, `microphones`; `{type:'getCaptureSettings', full:true}` returns
the secret for the connection test and uploads. Log lines: `capture settings:`, `mode:`, `overlay: stopped`.

## Setup

1. **Load the extension unpacked in each Chrome profile.** The extension folder ships inside the app:
   `Stile.app/Contents/Resources/extension`. In Chrome open `chrome://extensions`, turn on
   *Developer mode*, click *Load unpacked* and choose that folder. (If a profile has no extension the
   sidebar shows a setup card with buttons for exactly this, including *Show extension folder*.)
   **Store install (v3.10).** Once `HostSetup.storeExtensionID` holds the Chrome Web Store ID (until then
   none of this shows), the welcome window's extension block offers *Install in all profiles*: a click
   writes `<ID>.json` (`external_update_url` = the Web Store) into Chrome's `External Extensions` folder
   (override: `SIDEBAR_EXTERNAL_EXT_DIR`). Chrome reads it on its next start, adds Stile to every profile
   and asks you to enable it; a *Restart Chrome* button appears if Chrome is open. Nothing is written
   automatically, an existing file is never overwritten and Stile never removes it (if you remove the
   extension Chrome won't re-add it through this file). Each not-installed profile also has *Add from
   Chrome Web Store*, and the sidebar's setup card leads with the same button. The load-unpacked steps
   stay under "Developer: load unpacked". Profile rows read *Connected*, *Installed (store)*,
   *Installed (unpacked)* or *Not installed* (from each profile's `Preferences` / `Secure Preferences`).
   If a profile has the unpacked copy, *Install in all profiles* is replaced by a note. Publishing should
   reuse the manifest key so the ID stays `ffblekellgdmlecjablfojaaadpkmdgg` (the Web Store reportedly
   lets the first upload include `key.pem` in the zip to keep the ID; unverified). Both origins are
   allowed in the native messaging manifest once the store ID is set.
2. **Open Stile.app and allow Accessibility** (System Settings > Privacy & Security > Accessibility).
   The first-run window closes by itself once access is granted. Open it once; after that Chrome starts it
   hidden whenever the extension needs it.
3. **Turn on Chrome's vertical tabs.** Click *Set up* next to "Chrome vertical tabs" in the welcome window
   (or *Set it up for me* on the sidebar's vertical-tabs card). In every profile this sets
   `vertical_tabs.enabled = true` and `vertical_tabs.expand_on_hover = false` in `<profile>/Preferences`,
   keeping a copy as `Preferences.stile-backup`. Chrome only reads these at launch and rewrites the file
   on quit, so if Chrome is open Stile asks, quits it, writes the prefs and relaunches it with
   `--restore-last-session`. To do it by hand: right-click the tab bar → *Show tabs vertically* in each
   profile, and leave Chrome's *Expand on hover* off. The sidebar covers the rail as a compact icon strip.

Quit from the sidebar's Settings (App section). Launch at login is a switch in the same place.

Requires macOS 13 or later. The app is signed with a self-signed certificate ("Stile Developer"), not
notarized, so macOS blocks the first launch: open it once, then allow it under System Settings > Privacy &
Security > **Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Stile.app`. Every release
is signed with the same certificate, so the Accessibility and Screen Recording grants survive updates.

### Build from source

```
cd mac
bash build.sh            # native arch; UNIVERSAL=1 bash build.sh for arm64 + x86_64
```

Needs Xcode command line tools. `build.sh` builds the executable, assembles `dist/Stile.app`,
copies the web UI (every top-level `*.js`, `*.css`, `*.html`, `*.png` of `../extension` plus `icons/`) to
`Contents/Resources/web`, copies the whole `../extension` folder to `Contents/Resources/extension`,
signs it and writes `dist/Stile.zip`. Signing uses `SIGN_IDENTITY` if set, else the "Stile Developer"
certificate if it is in the keychain, else the first valid code-signing certificate, else ad-hoc. Builds
signed with anything other than the release certificate count as a different app to macOS, so permissions
granted to a release don't carry over to them.

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
Chrome extension  <-- native messaging -->  StileApp (connector mode)  <-- host.sock -->  Stile.app
```

- Chrome starts `Stile.app/Contents/MacOS/StileApp chrome-extension://<id>/` as the native messaging
  host. The same executable detects that argument and runs as a **connector**: a plain byte pipe between
  stdio and `~/Library/Application Support/Stile/host.sock` (override the folder with
  `SIDEBAR_APP_DIR`). If the socket is missing it launches the app hidden (`open -g -a`) and retries for
  10 s. Connector log: `~/Library/Logs/Stile-connector.log`.
- The app's `HostServer` listens on `host.sock`; each connection is one profile's extension and speaks
  the same protocol the old Perl helper did (`hello`, `identify`, `getProfiles`, `switchProfile`,
  `setGlobalSettings`, `setProfileStyle`; unsolicited `activate`, `settings`, `profiles`), plus the bridge
  (`bridge`/`overlayStatus` to the extension, `bridgeResult`/`bridgeEvent` back) which now flows over the
  same connection. Profiles carry picture, style and `chromeTheme` (from each profile's `Preferences`).
- Settings shared between profiles live in `~/Library/Application Support/Stile/state.json`. On first
  launch an existing `SidebarHelper/state.json` is imported and the old `sidebar-helper.pl` is removed.
- On every launch the app writes the native messaging manifest
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.stile.helper.json` pointing at
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

Log: `~/Library/Logs/Stile.log` (search for `rail[window`).

## Known limits

- Chrome only (`com.google.Chrome`); Chrome Beta/Canary/Brave/Edge are not tracked.
- Rail detection depends on Chrome's accessibility tree, which can change between Chrome versions; the
  log shows what was found. The fallback is a floating sidebar.
- Resizing the pinned sidebar only works if Chrome exposes the rail's splitter to accessibility.
- Windows are matched by bounds. Two windows from different profiles at exactly the same position and
  size can be matched the wrong way round until one is moved.
- Overlays sit directly above their Chrome window, so another app's window raised above Chrome hides them
  with it. Minimized Chrome windows get no overlay, and windows on other Spaces are skipped.
- macOS full screen isn't supported: the overlay hides while a Chrome window is full screen, because
  Chrome's auto-hiding toolbar slides in and out and the sidebar can't follow it without the native rail
  showing through. Chrome's own side panel still works there.
- Screen sharing: sharing the entire screen (or a region of it) includes the sidebar, because Stile's
  windows aren't excluded from capture. Sharing a single Chrome window captures only Chrome's own window,
  so viewers see Chrome's native vertical tabs. macOS doesn't tell other apps which window is being
  captured, and Chrome's collapsed rail still shows tab icons, so Stile can't hide them. Sharing a tab
  shows only the page, with no tabs of either kind. To show the sidebar, share the screen. When sharing a
  window, Present limits the native rail to the tabs added to the presentation.
- Clicking the sidebar makes its panel the key window (needed for typing) without activating Stile.app,
  so Chrome's own keyboard shortcuts stop working until you click back into the page.
- The web view runs on a custom `sidebar://` scheme (not a secure context): no clipboard API, no service workers.
- Not notarized; Gatekeeper needs the right-click Open step once.
