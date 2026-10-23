# Sidebar v2.4 — collapsed strip, follow lag, hover timing, shadow

Builds on SPEC-v2.2-polish.md (one DOM for compact/expanded, fixed icon column). User feedback on the running 2.3 build (screenshot: compact strip ~110 px wide over Chrome's rail; active tab highlight cut off at the strip edge; an empty dashed "Drag tabs here to pin" box half-visible; a split-view pair shown as two separate icons):

## 1. Collapsed strip: a designed mode, not a cropped sidebar (web, overlay mode)

Model it on Chrome's own collapsed vertical tabs. Everything visible in compact must sit fully inside the strip (width = `railWidth`, from host state). Keep each item's **vertical position identical** between compact and expanded (row heights unchanged) so expanding doesn't jump; what changes is each item's *shape*, animated (160 ms, `cubic-bezier(.2,.8,.2,1)`).

- **Row pills**: in compact every row's hover/active background becomes a centred rounded square: size `min(36px, railWidth - 12px)`, radius 10 px, centred on `--icon-x`. Expanded, the same element is the full-width row pill. Implement with one background element per row whose `left`/`width` (or `clip-path: inset(...) round 10px`) animates between the two shapes — never a full-width pill clipped by the strip edge.
- **Section headers** ("Pinned", "Today", window sections): in compact the label fades out and a thin centred divider (width 20 px, 1 px, text colour at 15%) fades in at the same y. Section action buttons (Tidy, Clear, Merge all, new folder) fade out.
- **Empty placeholders** (dashed "Drag tabs here…" boxes for favourites/pinned): make them a slimmer single-line height (32 px) in expanded mode too; in compact they fade out completely (no border visible). Keep their space so nothing below moves.
- **Favourites**: compact = single column of 36 px rounded-square tiles centred on the icon column (FLIP between grid and column stays). Active favourite = filled square like other rows.
- **Profile**: only the current profile's avatar (28 px) centred; others fade.
- **Search**: 32 px rounded-square button centred on the icon column.
- **Tab groups**: compact group header = a small rounded bar in the group colour (16×6 px) centred at the header's y (label/chevron/count fade). The group's tabs get a rounded outline in the group colour (1.5 px, radius 12) wrapping the group's tab pills, inset 4 px from the strip edges, from the first to the last tab (one absolutely-positioned element per group, recalculated on render). Collapsed groups (Chrome collapsed) show just the bar with a small count badge.
- **Split view pairs**: compact = ONE pill the size of one row containing both favicons side by side (12 px gap, a 1 px divider between, total ≤ strip width − 12). If either tab of the pair is active, the whole pill gets the active background; the active half's favicon full opacity, the other 70%. Clicking a favicon activates that half. Expanded split rows keep their two-halves look, with the pair's background also highlighted when either is active (same rule — "selected grouping").
- **Pinned folders** in compact: folder icon centred; children icons centred (no indentation; guide line hidden).
- **Footer**: archive icon centred on the icon column; other footer buttons fade.
- **Badges** (audible dot, open dot) sit at the icon's top-right inside the pill.
- **Scrolling**: the list scrolls vertically in compact with no visible scrollbar; same scroll position kept when expanding.
- Tooltips on hover in compact = full title (native `title` attribute is fine).

## 2. Follow lag (Mac app)

- Predict from the mouse during drags: on a global left-mouse-down while Chrome is frontmost, record mouse location and the window's bounds. On each drag event and each display-link frame: read window-server bounds; on the first frame where bounds differ from the start, classify the gesture — *move* (size unchanged, origin delta ≈ mouse delta ±2 pt) or *resize* (record which edges changed and whether they track the mouse). While the classification holds, compute the target window frame directly from the current mouse location (`NSEvent.mouseLocation`, converted to top-left coords) and place the panel from that predicted frame immediately in the drag-event handler (not waiting for the next frame); each display-link frame, compare with window-server bounds and snap to the real bounds if they differ by more than 2 pt (e.g. when macOS clamps the window at the menu bar or screen edge). End on mouse up (snap to real bounds).
- Use `setFrameOrigin` when only the origin changes; only call `setFrame` when size changes.
- Keep the 2.3 behaviour (window-server bounds, no AX during following) for non-mouse changes (keyboard window management, Rectangle/Magnet, etc.).

## 3. Hover timing (Mac app)

- Reveal after the pointer has been over the compact strip for 50 ms (was 120). Hide 150 ms after it leaves the sidebar (was 350), unless the page is busy.
- Slide-in 120 ms ease-out, slide-out 100 ms ease-in.
- Use an `NSTrackingArea` (mouseEnteredAndExited + activeAlways) on the panel content view for enter/exit instead of polling where possible; keep the global mouse monitor for the edge zone when no rail is found.
- Don't reveal while a mouse button is held (dragging something in Chrome across the strip), except while dragging a tab out of our own sidebar.

## 4. Peek shadow (Mac app + web)

- Much lighter: a soft 8 pt gradient from black at 7% (light) / 18% (dark) to transparent, plus a 1 px hairline at the panel's right edge in text colour at 8%. No other shadow.

## Tests

- overlay-e2e (web): in compact with `railWidth: 56`, every visible element's bounding box lies within x ∈ [0, 56]; the active row's background in compact is a square (width ≤ 44, height ≤ 44) centred within ±1 px of the icon column; y positions of rows are identical between compact and expanded; empty placeholders invisible in compact (opacity 0); section headers show the divider in compact; a group renders the coloured outline element spanning its tabs; a split pair (stub `splitViewId` on two tabs through a test hook if the browser lacks split support) renders as one compact pill with both favicons and is highlighted when either half is active; expanded split row also highlighted.
- All suites green: test-host, e2e, boost-e2e, overlay-e2e. Screenshots: compact vs expanded, light/dark, with a group and a split pair.
