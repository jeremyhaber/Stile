# Sidebar.app (macOS overlay)

A small menu-bar app that hides Chrome's horizontal tab strip behind its own cover and gives the
Sidebar extension's side panel Arc-style behaviour: hover the left edge to peek, pin to keep it open.
Chrome stays real Chrome; the address bar and extension buttons stay visible. The side panel keeps
working inside Chrome when the app is not running.

## Install

1. Download `Sidebar.zip` (from the **mac** GitHub Actions run's artifacts, or build it yourself, see below).
2. Unzip and drag `Sidebar.app` to `/Applications`.
3. The app is ad-hoc signed, not notarized. First launch: right-click the app, choose **Open**, confirm.
   If macOS still refuses: `xattr -dr com.apple.quarantine /Applications/Sidebar.app`.
4. Grant **Accessibility** permission (below). Optionally enable *Open at login* from the menu bar icon.

Requires macOS 13 or later.

### Build from source

```
cd mac
bash build.sh            # native arch; UNIVERSAL=1 bash build.sh for arm64 + x86_64
```

Needs Xcode command line tools. `build.sh` copies the web UI from `../extension` (including
`bridge-shim.js`; the build fails if any file is missing), assembles `dist/Sidebar.app`, ad-hoc signs it
and writes `dist/Sidebar.zip`.

## Accessibility permission

Sidebar reads and moves Chrome's windows through the macOS Accessibility API. On first launch it shows
a prompt and a small window with **Open Accessibility Settings**; enable *Sidebar* under
Privacy & Security > Accessibility. The window closes by itself once access is granted (polled every second).
If you rebuild or replace the app, macOS may treat it as a new app: remove the old entry and add it again.

## How it works with the extension and helper

```
Sidebar.app <-- unix socket --> helper (one per Chrome profile) <-- native messaging --> extension
```

- The extension (with its bridge) executes `chrome.*` calls and forwards `chrome.*` events.
- The Perl helper relays between the extension and the app's socket
  (`~/Library/Application Support/SidebarHelper/overlay.sock`, or `$SIDEBAR_HELPER_DIR/overlay.sock`).
  Install the helper as before; it reconnects to the app every 3 seconds.
- The app draws, per Chrome window: a cover over the tab strip (sidebar toggle, active tab title, new tab
  button; drag it to move the window, double-click follows your "double-click a window's title bar" setting)
  and a sidebar panel showing the extension's `sidepanel.html` in a web view (`?mode=overlay`).
- Chrome windows are matched to extension windows by comparing bounds. Until a window is matched the
  sidebar shows "Waiting for the Sidebar extension...".

### Using it

- **Peek**: with Chrome frontmost, rest the pointer on the window's left edge (below the tab strip) for
  a moment. The sidebar slides in and hides again shortly after the pointer leaves, unless a menu,
  rename field, drag or dialog in the sidebar is open.
- **Pin**: pin button in the sidebar, the toggle in the cover, the menu bar item, or Control+Option+S
  (while Chrome is frontmost).
- **When pinned**: *Move the page over* pushes the page right: the sidebar goes into free space left of
  the Chrome window if there is room on that screen, otherwise Chrome's window is narrowed from the left
  (and restored on unpin). *Float over the page* keeps the window as it is.
- Drag the sidebar's right edge to resize (220 to 420 pt; remembered).
- Menu bar icon: pin, pin mode, cover on/off, tab bar height (Auto/36/40/44/48), open at login, quit.

Settings live in `UserDefaults` (`ca.simplistics.sidebar`). Log: `~/Library/Logs/Sidebar.log`.

## Known limits

- Chrome only (`com.google.Chrome`); Chrome Beta/Canary/Brave/Edge are not tracked.
- The tab strip height is auto-detected from Chrome's accessibility tree; if it looks wrong pick a fixed
  height in the menu. The cover assumes Chrome's standard layout with traffic lights at the top left.
- Windows are matched by bounds. Two windows from different profiles at exactly the same position and
  size can be matched the wrong way round until one is moved.
- Overlays sit directly above their Chrome window, so another app's window raised above Chrome hides them
  with it. Fullscreen and minimized Chrome windows get no overlay; windows on other Spaces are skipped.
- Clicking the sidebar makes its panel the key window (needed for typing) without activating Sidebar.app,
  so Chrome's own keyboard shortcuts stop working until you click back into the page.
- The web view runs on a custom `sidebar://` scheme (not a secure context): no clipboard API, no service workers.
- Pin push mode cannot shrink Chrome below its minimum width; in that case the sidebar overlaps the page.
- Not notarized; Gatekeeper needs the right-click Open step once.
