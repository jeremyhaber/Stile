# Sidebar v3.0 — batch 1 + 2 (polish) and little-window fix

User feedback after 2.9.2 (lockstep drag now works well). Screenshots: Zap/Code cards are flat grey blocks; tab group rows put the coloured guide line between the favicon and the title (looks off); our sidebar top sits below Chrome's own rail header.

## 1. Settings window (web)
- Move settings out of the narrow sidebar into a dedicated **settings page** `settings.html` (extension page), opened by the sidebar's gear in a Chrome popup window ~860×640 (`chrome.windows.create({type:"popup"})`; reuse an existing settings window if open, focus it). In overlay mode the gear does the same (the bridge handles windows.create).
- Layout: left navigation list of sections + content pane: **General** (profile picker "This profile", colour), **Appearance** (Sidebar colour: Automatic/Custom from 2.5; compact behaviour), **Tabs & Archive** (archive after, default for all profiles, archive grouped tabs, pinned reset on restart), **Windows** (merge on close), **Little windows**, **Screenshots** (+ Upload), **Boosts** (site list), **Profiles** (icons/colours editor), **App** (Sidebar app status, show sidebar over Chrome's tabs, move together, launch at login, accessibility/screen recording status, find rail again, version, quit). Each setting is a row: label + description on the left, control on the right; groups in rounded cards; generous spacing; buttons never squeezed (wrap below on narrow widths). Light/dark.
- App-only settings (they need the overlay host channel) are reached from the settings page through the extension: add SW commands that relay to the app over the native connection (`appSetting {name, value}` → host message equivalents: setPinned is not needed here; `setLockstep`, `setLaunchAtLogin`, `requestScreenCapture`, `openAccessibilitySettings`, `rescanRail`, `quitApp`, `setOverlayEnabled`, `setDefaultBrowser`) and an `appState` query returning the app's latest host state (the app pushes it to the extension as `{type:"appState", state}` whenever it changes — add this native message in Swift + Node reference). Settings that are pure extension storage are edited directly.
- Keep all existing `data-testid`s on the controls (moved into settings.html). The sidebar keeps a gear button that opens the window (`settings-button`). Tests must be updated to drive settings.html.

## 2. Permissions onboarding (Mac)
- First launch (and from Settings → App → "Review permissions"): a native welcome window (≈560×520, standard titled window, app icon at top) listing permissions with live status (green check / button), polled every second:
  - **Accessibility** (required) — "Lets Sidebar follow and move Chrome's windows." Button "Allow…" → `AXIsProcessTrustedWithOptions(prompt)` + open the pane.
  - **Screen Recording** (optional) — "Matches the sidebar to Chrome's exact colour." Button "Allow…" → `CGRequestScreenCaptureAccess()`.
  - **Launch at login** (optional) — toggle.
  - **Default browser for links from other apps** (optional) — toggle → existing default-browser flow.
  - **Chrome extension** — status per Chrome profile (connected / not installed) with "Show extension folder" and "Open Chrome extensions page" buttons and the 3 steps.
  - Footer: "Done" (enabled once Accessibility is granted), "Skip for now".
- Replaces the old Accessibility-only onboarding window. Shown again automatically only if Accessibility is missing. Host message `reviewPermissions` opens it.

## 3. S3 form (web)
- Remove provider presets. One "S3-compatible storage" form: Endpoint URL, Bucket, Access key ID, Secret access key, Region (optional; auto-filled: `*.r2.cloudflarestorage.com` → `auto`, `s3.<region>.amazonaws.com` → that region, `*.<region>.digitaloceanspaces.com`, `s3.<region>.backblazeb2.com`, `s3.<region>.wasabisys.com`, `*.idrivee2-*.com` → region from host if present; else `us-east-1`), Path prefix, Addressing (Automatic: virtual-hosted for amazonaws.com, path-style otherwise; overridable under "Advanced"), file naming, link type. "Test connection" and "Clear credentials" as proper full-size buttons on their own row. Note "Works with any S3-compatible service (AWS, Cloudflare R2, Backblaze B2, iDrive e2, Wasabi, MinIO, …)".
- Existing stored settings migrate (drop `provider`).

## 4. Default colour (web)
- Automatic colour order: exact sampled `chromeColor` → Chrome theme `userColor` estimate → **Chrome's default frame colour** (light `#dfe3e7`? use Chrome's GM3 default light frame `#e9eef6`, dark `#1f1f1f`… keep the 2.1 defaults `#e9eef6` / `#1f1f1f`). The profile colour is no longer used as an automatic seed (only via Custom). Update the Automatic source line ("Chrome's default colour").

## 5. Footer and top (web)
- Remove the new-window button from the footer (keep the feature in menus / drop zone).
- Move the camera (capture) button and the Boost (Zap/Code) button from the address row into the footer, right side, next to the pin: order `[Archive …] … [camera] [boost] [pin] [gear]`. In compact mode only the archive icon shows (as now). Address field takes the full row width.

## 6. Zap / Code redesign (web, boost-view.js / boost.css)
- Replace the flat grey cards with lighter cards: each has a 32 px rounded icon tile (Zap: amber tile with bolt; Code: violet tile with braces), title + one-line description ("Hide parts of this page" / "Add your own CSS or JavaScript"), and a right-aligned status ("3 hidden" / "CSS · JS" / chevron). Card background = panel bg mixed 5% toward text colour, 1 px hairline border (text colour 8%), radius 12, hover raises contrast slightly; pressed state. The site header shows favicon + hostname and the on/off switch. Respect light/dark and the panel colour.

## 7. Split view icon menu (web)
- The split icon at the right of a split row becomes a button (`data-testid="split-menu"`) opening a menu: Swap sides, Separate, Close left tab, Close right tab, Move to new window. Overlay mode uses the native menu path (`contextMenu` host message).

## 8. Folders and groups redesign (web)
- **Groups**: header row = coloured dot + name + count + chevron; the group's tabs sit inside a soft rounded container (radius 12) tinted with the group colour at ~10% (dark ~16%), from the header to the last tab, 4 px inset from the sidebar edges; no guide line. Tabs inside keep the normal icon column position (icons aligned with all other rows). Collapsed group = just the header pill tinted.
- **Folders** (Pinned): Arc-style — folder icon (open/closed variants) in the icon column, name, chevron on hover; children indented by 16 px for both icon and text (icons no longer pinned to the column for folder children in expanded mode; in compact mode children icons return to the column as in 2.4); no guide line.
- Compact strip rules from 2.4 still hold (positions identical between modes, nothing clipped); update those tests where indentation of folder children intentionally differs in expanded mode (assert x stability only for non-folder rows; y stability for all).

## 9. Drag empty sidebar space to move Chrome (web + Mac)
- Web (overlay mode): on `mousedown` (left button, no modifiers) whose target is not interactive (not a button, input, link, row, tile, menu, scrollbar, resize handle; i.e. bare background areas, section header backgrounds, footer gaps, the top area) → post host message `beginWindowDrag` (with clientX/Y) and `preventDefault`. A drag that starts on a row still reorders tabs as before.
- Mac: on `beginWindowDrag`, if lockstep is on, start a lockstep **move** session for that window from the current mouse location (DragController API `beginFromPanel(windowKey)`), driven by the existing drag-tap events until mouse up; if lockstep is off, fall back to the follow path: move Chrome with AX on each drag event anyway (same code path) — i.e. sidebar-initiated drags always use lockstep moves. Double-click on empty space = title-bar double-click action.

## 10. Little window: Open in Chrome button + ⌘O (web + Mac)
- Mac: move the little-window pill into the window's **title bar**: right side, vertically centred in Chrome's popup title bar (AX: the window's title bar height = top of the first AX web area / toolbar minus window top; fallback 28 pt), 8 pt from the right edge; label "Open in Chrome" with an arrow-up-right icon; tooltip "Open as a tab (⌘O)"; compact 22 pt high; matches the title bar (no shadow, subtle hover). Log when ⌘O is intercepted or skipped and why.
- Web: `boost-content.js` (runs on every page) catches ⌘O (`keydown`, capture phase, metaKey, key "o", no other modifiers) — asks the SW `{cmd:"isLittleTab"}` once per page load (cache the answer, refresh on `visibilitychange`); if this tab is in a little window, `preventDefault()` + `stopPropagation()` and send `{cmd:"promoteLittle", tabId: <own>}` (SW: accept `tabId` too). `littlesearch.html` does the same.

## Tests
- Update existing suites for the moved settings (drive settings.html), the footer move, and the folder/group redesign; add tests for: settings window opens/reuses; each section renders; app settings relay through `appSetting`/`appState` (Node reference host); S3 form without presets + region auto-fill + migration; default colour falls back to #e9eef6 (light) when no theme/sample/custom; split menu actions; group container + folder indentation; `beginWindowDrag` posted on background mousedown and not on rows; ⌘O in a little window's page promotes it (content script path) and doesn't in a normal tab.
- All suites green: test-host, e2e, boost-e2e, overlay-e2e, capture-e2e.
- Screenshots (light + dark): settings window (General, Screenshots/Upload, App), Zap/Code view, a group and a folder (expanded + compact), footer.
