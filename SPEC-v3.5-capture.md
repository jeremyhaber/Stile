# Stile v3.5 / v3.6: Shottr-level capture, capture-only mode, screen recording

Request (Jeremy, 2026-10-24): match Shottr's capture menu (scrolling capture matters most, OCR not wanted); let Stile run as a capture-only tool for people who don't want the sidebar in Chrome; add screen + mic recording (window, whole screen, area) with a video preview, save / copy / upload, and a timeline trim. "A simplified Loom."

Starting point (v3.4, written, **not yet verified on a Mac**): `ScreenCapture.swift` shells out to `/usr/sbin/screencapture` for screen / area / window. Pictures open in the React editor in an app window (`CaptureEditor.swift`, `capture.html?host=app`). Upload uses S3 settings that the extension pushes (`captureConfig`, memory only). Full Chrome page capture is the extension's scrolling capture. **Verify 3.4 on the Mac before building on it.**

## Why `screencapture` has to go

`screencapture -i` never tells us which rect or window the user picked. That rules out Repeat Area Capture, recording an area, and scrolling capture of a chosen region. All three need **our own selection overlay** and **ScreenCaptureKit** (SCK) to grab pixels. `CGWindowListCreateImage` is obsolete in the macOS 15 SDK, so it's not an option.

## Minimum macOS → 15 (agreed)

| Need | API | macOS |
|---|---|---|
| Single-frame capture of a display / window / rect | `SCScreenshotManager` | 14 |
| Video frames + system audio | `SCStream` | 13 |
| Mic in the same stream, already in sync | `SCStreamConfiguration.captureMicrophone` | 15 |
| Write the stream straight to an .mp4 | `SCRecordingOutput` | 15 |

With macOS 15 the recorder is mostly configuration: SCK records the screen, system audio and mic into one file, with no `AVAssetWriter` and no manual audio sync. Staying on 13 or 14 means an `AVCaptureSession` for the mic, our own `AVAssetWriter` and timestamp alignment, which is a lot more code to maintain. Jeremy runs macOS 26.

## 1. Selection overlay (shared by screenshots, recording and scrolling capture)

- One borderless, transparent, non-activating panel per display, at `.screenSaver` level, joining all Spaces. A crosshair cursor and a dim layer with the selection cut out.
- **Area:** drag a rect. Live `W × H` label (in points; pixels when the display is Retina). A loupe near the pointer for pixel-precise edges. Arrow keys nudge the rect and Shift+arrow resizes it after the drag. Return confirms and Esc cancels.
- **Window:** hovering highlights the window under the pointer (from `SCShareableContent` windows, front to back, filtered to on-screen and layer 0). Space switches between area and window modes, like macOS.
- **Screen:** clicking a display picks the whole display.
- Returns `.rect(CGRect, displayID)`, `.window(SCWindow)` or `.display(SCDisplay)`. The last rect is kept in memory and in `state.json`, so Repeat Area works after a relaunch.
- Hidden from its own capture: SCK excludes our app's windows with `excludingApplications`, except (3.6.1) Stile's panels over Chrome (sidebar, header, little-window pill), which are what the user sees there. A window capture of a Chrome window with panels over it is composited from its display (`including:` the window and its panels, `sourceRect` on the window) instead of a single-window filter, which would show Chrome's own tab rail.

## 2. Screenshots (v3.5a): Shottr menu parity

| Item | Behaviour | Default hotkey |
|---|---|---|
| Capture Screen | display under the pointer | ⌃⌥3 (unchanged) |
| Capture Area | overlay in area mode | ⌃⌥4 (unchanged) |
| Capture Window | overlay in window mode (Shottr's "Any Window") | ⌃⌥5 (unchanged) |
| Capture Active Window | frontmost app's focused window, no picking | ⌃⌥⇧5 |
| Repeat Area Capture | last rect, no overlay | ⌃⌥⇧4 |
| Scrolling Capture | see §3 | ⌃⌥7 |
| Capture Full Chrome Page | existing extension capture (Chrome mode only) | ⌃⌥6 (unchanged) |
| Delayed Screenshot (3 s) | countdown badge near the pointer, then Capture Screen | none |
| Open Image… | NSOpenPanel → editor | none |
| Load From Clipboard | pasteboard image → editor (disabled when the pasteboard holds no image) | none |

- Window captures keep their shadow and transparent corners, as macOS does. A setting turns the shadow off.
- After capture, the existing flow continues: editor window, recent captures in the extension when connected.
- No OCR / QR.

## 3. Scrolling capture (v3.5b)

Shottr-style: the user picks an area, then scrolls; we capture and stitch.

1. Overlay in area mode, then a small floating bar beside the rect: "Scroll to capture · Done · Cancel" with a live height counter.
2. Capture the rect with `SCStream` at ~15 fps (not `SCScreenshotManager` in a loop, which is too slow). Only keep frames that changed.
3. **Stitch:** for each new frame, find the vertical offset against the previous one. Compare per-row hashes of a grayscale downsample, search offsets 1…h·0.9, and pick the offset with the most matching rows. Confirm it with a full-resolution check on a band. Append only the new rows.
4. **Sticky headers/footers:** rows that are identical at the top (or bottom) of every frame are treated as fixed and are not repeated. Kept once, at the top (or bottom) of the result.
5. Scrolling up (Shottr's "Scrolling (Up)") is the same thing with negative offsets, prepending rows.
6. Stops on Done, Return, Esc (keep what was captured), or a size cap (e.g. 30 000 px tall). If no offset is found for a frame (a jump, an animation), that frame is skipped and the bar flashes "Scroll slower".
7. Auto-scroll (default when Accessibility is granted): park the pointer in the rect and post pixel scroll-wheel events at ~0.8 of the rect's height per second. Slow down on an unmatched frame, finish when nothing new appears for 2 s, and hand over to manual scrolling when the user moves the pointer.

Inside Chrome, while Chrome mode is connected, "Capture Full Chrome Page" stays the better tool: it's exact, with no stitching. The scrolling capture is for every other app.

## 4. Capture-only mode

A first-run choice in onboarding, and a setting: **"Use Stile with Chrome"** on / off.

- **Off (capture only):** no overlay, no Chrome tracking, no native-host registration, no event taps. Accessibility isn't asked for, only Screen Recording (plus Microphone on the first recording). The menu bar shows only capture / record items, Settings and Quit. The Chrome-only items (sidebar toggles, lockstep, Capture Full Chrome Page) are hidden.
- **Settings move into the app.** Today the S3 config lives in the extension and is pushed to the app. In capture-only mode there's no extension, so:
  - The app becomes the owner of capture settings: save folder, file name pattern, hotkeys, S3 bucket/region/prefix/public URL base, window shadow, recording defaults. These are kept in `state.json`, with **S3 secrets in the Keychain**.
  - The extension's settings page shows them through the existing `appSetting` relay when connected (one source of truth). When the app isn't connected, the extension falls back to its own stored copy, so side-panel-only users are unaffected.
  - Settings window in capture-only mode: the extension's `settings.html?host=app` in an app window (like the editor), showing only the Capture and Recording groups, so there's still one settings UI.
- Switching the mode on later runs the normal Chrome onboarding.

## 5. Recording (v3.6)

### Start
- Menu items: **Record Screen**, **Record Window**, **Record Area**, **Record Chrome Tab** (Chrome mode only, see below) (⌃⌥8 opens the recording bar; the default target is the last one used). They share the selection overlay.
- After picking: a compact **recording bar** under the selection, or bottom-centre for full screen: mic picker (None / device list), system audio toggle, Start (Return). Choices are remembered.
- 3-2-1 countdown (setting, default on), then recording.

### Always clear what is being recorded (Jeremy: "I want it clear what's being recorded")
- **Before Start:** the chosen target stays highlighted (screen: tinted border around the whole display; window: border hugging the window; area: the rect with handles). The recording bar names it: "Recording: Entire display (Studio Display)", "Recording: Window — Slack", "Recording: Area 1280 × 720", "Recording: Chrome tab — {title}". Mic and system audio state are shown in the same bar.
- **During:** a 3 pt red border around exactly what is captured. The whole display edge for screen. A border that tracks the window frame (moves and resizes with it, hidden while minimized) for window and Chrome tab, drawn around the page area only for a tab. The rect for area. All of it excluded from the capture. The pill repeats the target name next to the timer, and shows a live mic level meter when a mic is on. Menu bar icon is a red stop square.
- **Paused:** the border turns amber and the pill says "Paused".

### Record Chrome Tab (page only, no toolbars)
- Entry points: menu bar "Record Chrome Tab" (active tab of the last focused Chrome window), the sidebar tab context menu "Record this tab", and the extension command `recordTab {tabId}` (both modes, sent to the app as `{type: 'recordTab', windowId, tabId, title}`). Disabled with a tooltip when the app isn't connected (side-panel-only users).
- How: SCK **window** filter on that Chrome window (so it keeps recording when other windows cover it, and our overlay/top bar are never in it), with `sourceRect` = the window's web content area, read from AX (the `AXWebArea` frame relative to the window). Re-read and `updateConfiguration` when the window resizes or the toolbar/bookmark bar changes height. Output size follows the page area.
- Audio: system audio limited to Chrome (SCK app-level audio filter) plus the selected mic.
- Following the tab: the extension tells the app when the recorded tab stops / starts being the active tab of its window (`{type: 'recordTabState', tabId, active}`), and when it's closed. Not active means **auto-pause** (pill: "Paused: tab not visible"), active again means resume. Closing the tab stops the recording and opens the preview. Moving the tab to another window retargets the filter to that window.

### While recording
- A floating pill (excluded from the capture): red dot + timer, **Pause/Resume**, **Stop**, **Restart**, **Discard** (asks to confirm).
- The menu bar icon turns into a red stop square. Clicking it stops. ⌃⌥8 also stops.
- Area recordings show a thin dashed outline around the rect (excluded from the capture) so the user knows what is being recorded.
- Window recording follows the window as it moves (SCK window filter). Minimizing pauses the frames.
- Show the cursor (default on). Optional click highlights (later).
- Output: H.264 MP4 (HEVC option), 30 fps default (60 option), AAC audio, Retina resolution capped at 1080p/1440p by setting. Temp file in `~/Library/Caches/Stile/recordings/`.

### After: preview window
A native window (not the web editor). WKWebView's custom scheme handler needs byte-range support to seek video, and AVKit gives us trim for free:

- **The editor looks like the screenshot editor** (its colour tokens, 46 pt bar: Copy, Save, Upload, grip | drawing tools | title; the video on the canvas; a floating properties card; status line; toasts).
- **Editing is Premiere-style** (3.7, replacing 3.6.1–3.6.3's trim handles and cut sections): the timeline is the edited video, a row of clips with filmstrips. Cut at the playhead (S / ⌘K) cuts the clip at the playhead; select a clip and Delete removes it and the rest closes up. A red mark on a clip edge means footage was removed there: drag the edge out to bring it back. Set Start / Set End (I / O), Reset, undo / redo (⌘Z / ⇧⌘Z). Play plays the whole edit. 3.8: drag a clip into any order; a time ruler above the clips scrubs. 3.9: a Cut tool (C; snaps to the playhead, ⌥ overrides): scissors pointer and a cut line over the clips; click to cut.
- **Camera** (3.9, Loom-style, kept simple): Record Camera (camera only), or pick a camera in the recording bar for screen + camera. The camera is a round bubble over the screen, recorded with it; drag it anywhere, right-click for size (S / M / L) and corners.
- **Drawing on the video** (3.7): Rectangle, Arrow, Text, Highlight and Blur with the screenshot editor's colours and sizes. Each has a bar in the timeline's layer lanes: drag it to change when it shows, its ends to change how long. Blur boxes stay put (no tracking of moving things: not wanted). 3.8: simple transition presets per annotation (None, Fade, Pop, Slide up, Draw), in and out, with an Animate switch to turn them all off. Anything drawn means a re-encode on export.
- Title field (default "Recording — {app} — {date}"), used as the file name.
- Actions:
  - **Save** writes to the save folder (default `~/Movies/Stile`). ⌘S picks a location.
  - **Copy** puts the file on the pasteboard (pastes into Slack, Finder, Mail).
  - **Upload** sends to S3 with a progress bar, then copies the link. Multipart for files over 100 MB so progress and retries work.
  - **Drag out** from the grip, like the screenshot editor.
- A trimmed export uses `AVAssetExportSession`: passthrough when the cuts fall on keyframes, otherwise re-encoding with the same preset. It runs in the background with progress.
- Closing an unsaved, un-uploaded recording asks "Discard recording?".
- **Recent recordings** (last 10, thumbnails) in the menu bar submenu. When connected, they're also listed beside recent captures in the extension (metadata + thumbnail only, since 1 MB native message limit).

### Out of scope for v3.6 (candidates for later)
Camera bubble (Loom's face cam), GIF export, a hosted share page with a player (a bare S3 MP4 link plays in every browser), drawing on screen while recording.

## 6. Permissions
- Screen Recording: already handled. SCK uses the same TCC entry. macOS 15+ shows its periodic "is still recording your screen" reminder for apps not using the picker; we accept it (we can't avoid it without `SCContentSharingPicker`, which can't do areas).
- Microphone: `NSMicrophoneUsageDescription` in Info.plist, asked on the first recording with a mic selected. Added as a row in the permissions window.
- Accessibility: only for Chrome mode (and later auto-scroll).

## 7. Code layout (Mac)
```
Capture/SelectionOverlay.swift   per-display panels, area/window/screen picking, loupe, last-rect memory
Capture/Screenshotter.swift      SCScreenshotManager captures; replaces the screencapture shell-out in ScreenCapture.swift
Capture/ScrollCapture.swift      SCStream frames + stitcher (pure, unit-testable: frames in -> image out)
Capture/Recorder.swift           SCStream + SCRecordingOutput, pause/resume, countdown, recording pill
Capture/RecordingWindow.swift    AVPlayerView preview, trim, export, save/copy/upload
Capture/S3Upload.swift           URLSession SigV4 (single + multipart), shared with the screenshot editor's upload
CaptureSettings.swift            app-owned settings + Keychain
```
The first Swift tests in the repo: a `StileCoreTests` target for the stitcher (synthetic scrolled frames, sticky header) and SigV4 multipart signing.

## 8. Phasing
1. **3.5a:** selection overlay, SCK screenshots, the new menu items and hotkeys, open file / clipboard, macOS 15 minimum.
2. **3.5b:** scrolling capture.
3. **3.5c:** capture-only mode and app-owned capture settings.
4. **3.6:** recording, preview / trim, save / copy / upload, recent recordings.

## Decisions (2026-10-24)
1. Minimum macOS 15: agreed.
2. Recording preview is native AVKit; trim is our own always-visible timeline (3.6.1, replacing the built-in trimmer).
3. App owns capture settings, S3 secrets in the Keychain. The extension edits them through the relay when connected.
4. Capture-only is a mode of the same app.
5. Scrolling capture auto-scrolls (manual when Accessibility is missing or the user moves the pointer).
6. No camera bubble: agreed, not wanted.
7. Hotkeys: ⌃⌥ + digit as in the table (default; not yet confirmed).
8. Upload link: bare S3 MP4 URL (default; not yet confirmed).
9. Added: "Record Chrome Tab" (page area only) and a strong what-is-being-recorded indicator.
