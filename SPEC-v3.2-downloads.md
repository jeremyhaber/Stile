# Sidebar v3.2 — downloads popover and drag-out

Request (HANDOFF §7.2): hovering the Archive button in the footer shows the last downloads with live progress; finished files can be dragged out into other apps.

## Web (extension)

### Popover
- Hover (or keyboard focus-visible) on `#archive-btn` for 250 ms opens a small popover (`data-testid="downloads-popover"`) above the footer, left-aligned with it, width = panel width − 16 px (max 320). It closes 300 ms after the pointer leaves both the button and the popover, on click of the button (which still opens the Archive view), on Escape, and on blur. Not shown while compact (overlay strip), while a drag or menu is active, in a presentation window (v3.3) or when there are no downloads (nothing to show).
- Content: the **last 4** downloads (`chrome.downloads.search({orderBy:['-startTime'], limit:4})`, erased and deleted-and-cancelled items are skipped), newest first, one row each (`download-row`, `data-id`, `data-state`):
  - icon (`chrome.downloads.getFileIcon`, 32 px; generic file glyph while loading or when unavailable), file name (basename of `filename`, else the last path part of the URL), under it either a **progress bar** (`download-progress`, 3 px, accent colour; indeterminate when the total size is unknown) while `in_progress`, or the meta line: size ("12.4 MB") when complete, "Paused", "Cancelled", "Failed", "File moved or deleted" (`exists === false`), "Check in Chrome" (dangerous). While in progress the meta line reads "3.1 of 12.4 MB".
  - Click a row: complete and existing → `chrome.downloads.open(id)` (falls back to `show(id)` when open is refused); anything else → `show(id)` (reveal in the file manager).
  - Footer row "Show all downloads" (`downloads-show-all`) → new tab `chrome://downloads`.
- Live: `downloads.onCreated`, `onChanged`, `onErased` refresh the open popover. Chrome does not fire `onChanged` for `bytesReceived`, so while the popover is open and something is in progress it also polls `downloads.search({id})` every 500 ms.
- Style: same tokens as menus and the hint card (`--menu-bg`, `--menu-line`, `--menu-shadow`, radius 10), rows 40 px, no gradients, light/dark, `pop` animation.

### Drag a finished file out
- Rows of a complete, existing download are `draggable`.
- Side-panel mode: `dragstart` → `chrome.downloads.drag(id)` (Chrome starts the OS file drag).
- Overlay mode (no `chrome.downloads.drag` through the bridge): `dragstart` is cancelled and the page posts the host action `dragDownload {path, clientX, clientY}` with the item's absolute `filename`.

### Permissions / bridge
- manifest: `downloads` (already present) plus `downloads.open`. `downloads.ui` is not needed.
- bridge-sw allow-list: `downloads.search`, `downloads.open`, `downloads.show`, `downloads.showDefaultFolder`, `downloads.getFileIcon`; forwarded events `downloads.onCreated`, `downloads.onChanged`, `downloads.onErased`. bridge-shim exposes the same under `chrome.downloads` (no `drag`).

## Mac app
- `OverlayController.handleHost("dragDownload")`: validates the path (absolute, an existing regular file), then starts an `NSDraggingSession` on the panel's web view with the file URL as pasteboard item (drag image = the file's Finder icon, copy operation). The mouse event comes from `NSApp.currentEvent` when it is a left-mouse event, otherwise one is synthesised at `clientX/clientY` (the page cancels the web drag, so there is no live event). The panel counts as busy for the whole session, so a peeked sidebar does not hide under the drag.
- This is a page → `OverlayController` action only. `HostServer` (and so the Node reference host) is unchanged: no protocol change.

## Tests
- e2e (side-panel mode): popover opens on hover, lists at most 4 rows newest first, progress bar moves while a slow download runs and becomes the size when it completes, click on a finished row, "Show all" opens `chrome://downloads`, rows are draggable only when finished, popover hidden on click / leave.
- overlay-e2e: bridge allows the `downloads.*` calls and rejects other `downloads.*` ones, forwards `downloads.onChanged`, popover works through the bridge, dragstart of a finished row posts `dragDownload` with the real path and does not call `downloads.drag`.

## Decisions to confirm
- Nothing is shown on hover when there are no downloads. The popover shows 4 items, not "today's".
- Click opens the file (needs the `downloads.open` permission; Chrome may ask to re-accept permissions for the unpacked extension).
