# Sidebar v2.7 — never cover tabs when disconnected; on/off toggle

## 1. Only cover when connected (Mac app)

- A window's sidebar panel is shown (covering the rail, peeking, pinned) ONLY when the window is mapped to a profile whose extension connection is live. Any other case — app just started and still mapping, profile connection dropped, extension missing, window unsupported/incognito — the panel is ordered out and Chrome's own tabs are visible. No more "Waiting for the Sidebar extension…" panel over the rail.
- When a connection drops for a profile, immediately hide that profile's panels (don't wait for timers). When it comes back and the window maps, show them again.
- Missing extension notice: instead of the old setup card covering the rail, a small native pill (non-activating panel, ordered just above the Chrome window, not covering the toolbar or the rail's tab list): anchored bottom-left inside the window, 8 pt from the left and bottom edges, ~230×28 pt, rounded 14, subtle material/background matching the window appearance, text "Sidebar isn't set up for this profile" + chevron. Shown only when the existing setup-card conditions hold (2.6 rules). Clicking it shows the setup steps in a small popover/panel (reuse the existing setup.html in a WKWebView sized ~320×260 anchored above the pill); "×" on the pill dismisses it for that profile until the app restarts.
- The close interceptor (2.5 §6) is unaffected (still requires a live connection).

## 2. Toolbar badge when the app isn't connected (extension)

- When the extension's native connection to Sidebar.app is not live (helper status `not_installed`, `error`, or disconnected), set `chrome.action.setBadgeText({text:"!"})` with `setBadgeBackgroundColor({color:"#f59e0b"})` and title "Sidebar.app isn't running — click for details". Clear badge (text "") and restore title "Sidebar" when connected. Update on every status change and on SW startup.
- The side panel (which the action opens) shows, at the top, a card when not connected: "Sidebar.app isn't running" with buttons "Open Sidebar.app" (calls `retryHelper` — connecting launches the app via the connector unless the user quit it; if still not connected after 5 s, the card says "Couldn't start it. Open Sidebar.app from your Applications folder.") and "Retry". `data-testid="app-offline-card"`.
- Don't show the badge if the user never installed the app? Can't tell apart — show it only after the extension has connected successfully at least once (`storage.local.appEverConnected = true`), so people using only the side panel aren't nagged.

## 3. On/off toggle (extension + app + host protocol)

- Global setting owned by the app: `overlayEnabled` (default true), persisted in `state.json` (shared) — the app is the source of truth.
- Host protocol additions (Swift HostServer and the Node reference `tools/fake-app/host-server.js`):
  - extension → app: `{type:"setOverlayEnabled", enabled, requestId}` → app saves, replies `{type:"overlayEnabled", enabled, requestId}`, and broadcasts `{type:"overlayEnabled", enabled}` to all other connections.
  - `hello` reply gains `settings.overlayEnabled`.
- Extension:
  - keeps `storage.local.overlayEnabled` mirrored from hello/broadcasts;
  - `chrome.contextMenus` item on the action: checkbox "Show sidebar over Chrome's tabs" (`contexts: ["action"]`, id `overlay-toggle`), checked state kept in sync; clicking toggles via `setOverlayEnabled`. Needs the `contextMenus` permission. Only shown while connected to the app (otherwise remove/disable it);
  - Settings → App (overlay mode) and Settings → "Sidebar app" (side-panel mode): switch "Show sidebar over Chrome's tabs" (`data-testid="overlay-enabled"`), sends `setOverlayEnabled`;
  - SW command `setOverlayEnabled {enabled}` used by the panel.
- App:
  - When disabled: hide all sidebar panels and notices; Chrome's tabs visible; stop hover/peek monitors (keep close interception and host server running). If Chrome's rail is currently expanded because we pinned it, leave it as is (it's Chrome's own UI now).
  - When enabled: resume normally (rescan rails).
  - Global hotkey Control+Option+Shift+S toggles `overlayEnabled` (while Chrome is frontmost), broadcasting to extensions.
  - Host state to pages gains `overlayEnabled` (pages normally won't be visible when disabled, but keep the switch consistent).
- Tests:
  - Node reference host: `setOverlayEnabled` persists to state.json, reply + broadcast to other connections, `hello` includes it (test-host.mjs).
  - e2e (side panel): badge "!" set when the host is unavailable after having connected once; cleared when connected; offline card shown; toggle switch sends `setOverlayEnabled` and reflects broadcasts; context menu item exists while connected (check via the SW: `chrome.contextMenus` has no getter — track created items in SW state exposed by `debugState.contextMenus`).
  - overlay-e2e: App settings switch present and posts/sends the command.
  - All suites green.
