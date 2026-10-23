# Sidebar v2.2 polish — colour, lag, corners, collapse/expand

Builds on SPEC-v2.1-overlay.md. User feedback after running 2.1 on a Mac:
1. The sidebar's background should be exactly Chrome's background colour.
2. Following Chrome's window when it is moved or resized lags noticeably.
3. No rounded corners on the sidebar.
4. Collapsed → expanded feels jumpy because items move around.

## 1. Exact Chrome colour (Mac app + web)

- Sample the real colour of Chrome's tab rail with a window-only capture of the Chrome window (so our own panel is never in the image): `CGWindowListCreateImage(rect, .optionIncludingWindow, cgWindowID, [.boundsIgnoreFraming, .nominalResolution])` for a small rect (e.g. 4×24 pt) inside the rail near its bottom (x = rail.minX + 6, y = rail.maxY − 40), avoiding tab rows and the rounded window corner. Take the median colour of the pixels. If `CGWindowListCreateImage` is unavailable or deprecated-warning only, that's fine (still works on macOS 14/15); wrap it so a nil image just means "no sample". Use `CGPreflightScreenCaptureAccess()` to check permission and `CGRequestScreenCaptureAccess()` only when the user turns the feature on.
- When: on rail found/rescan, on Chrome window focus/blur (Chrome dims inactive windows' frame colour), on appearance change (`NSApp.effectiveAppearance` / distributed notification `AppleInterfaceThemeChangedNotification`), and every 5 s while visible (cheap). Only push when the colour changes.
- Host state gets `chromeColor: "#rrggbb" | null` and `screenCapture: true|false`. New host message from page: `requestScreenCapture` (calls `CGRequestScreenCaptureAccess()`, then rechecks every 1 s for 30 s).
- Web (overlay mode): when `chromeColor` is set, it is the panel background (`--overlay-bg`) and derived colours come from it: hover = bg mixed 6% toward text colour, active row = bg mixed 12% toward text colour (text colour chosen by bg luminance: dark text on light bg, light text on dark bg). Without `chromeColor`, keep the current chromeTheme estimate.
- Settings → App: "Match Chrome's colour exactly" row: status "On" when screenCapture is true, otherwise a button "Turn on" (posts `requestScreenCapture`) with the note "Needs Screen Recording permission. Sidebar only looks at Chrome's window."

## 2. No lag following Chrome (Mac app)

- Get the window frame during following from the window server, not AX: `CGWindowListCopyWindowInfo([.optionIncludingWindow], cgWindowID)` → `kCGWindowBounds` (top-left origin, same as AX). This is fast and updates live during drags. Use AX only to (re)discover windows and rail geometry (rail rect is stored relative to the window, so it moves with the bounds).
- Start following on input, not on Chrome's (late) AX notifications: a global `NSEvent` monitor for `.leftMouseDown` / `.leftMouseDragged` / `.leftMouseUp`; when Chrome is frontmost and a left-mouse drag begins, start the follow loop immediately and keep it running until 300 ms after mouse up. Also keep the existing AX moved/resized triggers.
- Follow loop: a `CVDisplayLink` (or `CADisplayLink` via `NSScreen.displayLink(target:selector:)` on macOS 14+, falling back to a 120 Hz `Timer` on 13) that each frame reads the bounds and, if changed, sets the panel frame with `setFrame(_:display:false)` inside `NSAnimationContext` with `duration = 0` / `allowsImplicitAnimation = false`, and disable the web view's layer actions during following so nothing animates. Read bounds once per frame for all visible controllers in one `CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)` call when several windows are visible.
- Live resize of Chrome from its left edge or bottom: same loop handles it (rail rect is relative to the window's top-left; height follows window height).
- During following, skip anything expensive (no AX calls, no rescans, no host-state pushes); after following ends, do one AX rescan.

## 3. Square corners (Mac app + web)

- Remove all rounded corners on the sidebar panel in every state, including peek. The only rounding kept: when the panel's bottom-left corner coincides with the Chrome window's bottom-left corner, clip that one corner with the window's radius (10 pt) so nothing pokes outside Chrome's window shape.
- Keep the thin shadow strip on the right edge while peeking (no radius).
- Web: remove the `overlay-float` border radius; no rounded panel edge in CSS.

## 4. No jumping between collapsed and expanded (Mac app + web)

Principle: the page is always laid out at the **expanded** width; "collapsed" is the same layout clipped to the rail width by the native panel. Expanding reveals more of the same layout; nothing re-flows.

Mac app:
- The web view's width is the *target expanded width*: peek width when the next expansion would be a peek, Chrome's expanded rail width when pinned. In collapsed state the panel frame is the rail rect, the web view keeps the expanded width inside a clipped container anchored at the left, so only the left strip shows. On collapsed → peek the panel frame animates its width (140 ms ease-out) while the web view stays put. On pin, set the web view width to the expanded rail width first (while still clipped), then let Chrome expand and follow.
- Host state `state` stays `collapsed|peek|pinned`; add `compact: true` while collapsed (or while the collapse animation runs) and `railWidth` (collapsed rail width in CSS px) so the page knows where the clip edge is.

Web (overlay mode):
- **Fixed icon column**: every row-type element puts its icon centred at x = railWidth / 2 (CSS var `--icon-x`, default 24 px; set from host state `railWidth`): profile row (current profile icon first), pinned items, folder rows, group headers (colour dot), Today tabs, "New tab", window section headers, footer buttons (archive at left in the column; pin/settings/new-window on the right side are only visible expanded). Row text starts after the icon column. Indentation for folder/group children moves the *text*, not the icon (children keep their icon in the column and show a thin guide line to the right of the column).
- **Elements that must change shape animate instead of jumping** (CSS transitions 160 ms, transform/opacity/width only):
  - Profile switcher: other profiles fade out in compact (opacity 0, pointer-events none), positions unchanged.
  - Address field: in compact it becomes a 32 px square search button at the same left position (animate width); the sparkle/boost button fades out.
  - Favourites: expanded = grid; compact = single column. Animate the change with FLIP (record each tile's rect before toggling `html.compact`, apply the new layout, set inverse transforms, then transition to identity). Collapse/expand of every other element must not move anything vertically: keep section headers ("Pinned", "Today") in place with their text fading out in compact (keep height).
  - Hide-only elements (Tidy, Clear, folder-new button, counts, hover × buttons) fade, never collapse their space.
- Remove the separate compact-strip DOM (`compact-strip` etc.) introduced in 2.1; the compact look is now the same DOM clipped + the fades above. Keep the testids `compact-strip` on the main list container when compact (so tests can assert compact mode), and keep the click behaviour (clicking an icon in compact activates/opens the same thing).
- Drag and drop stays disabled while compact.

## Tests

- overlay-e2e: with `compact:true, railWidth:48`, the Today row favicons and pinned favicons have the same x centre (±1 px) as when expanded, and their y positions are identical between compact and expanded (±1 px) for rows below the favourites section when there are no favourites; favourites tiles animate (transition present) rather than snap; address field width animates; no element with border-radius > 0 on the panel root; `chromeColor` sets the background exactly; settings show the Screen Recording row and post `requestScreenCapture`.
- All suites green: `node tools/fake-app/test-host.mjs`, `node tools/e2e.mjs`, `node tools/boost-e2e.mjs`, `node tools/overlay-e2e.mjs`.
- Screenshots to the scratchpad overlay-shots folder: compact vs expanded side by side (same scroll position) in light and dark.
