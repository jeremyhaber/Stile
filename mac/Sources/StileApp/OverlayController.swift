import AppKit
import ApplicationServices

enum SidebarState {
    case hidden      // no vertical-tab rail and not peeking: nothing on screen
    case collapsed   // compact strip over Chrome's collapsed rail
    case peek        // full sidebar sliding over the page
    case pinned      // covering Chrome's expanded rail (or floating over the page as the fallback)

    /// Name sent to the page ("collapsed" | "peek" | "pinned").
    var hostName: String {
        switch self {
        case .peek: return "peek"
        case .pinned: return "pinned"
        case .hidden, .collapsed: return "collapsed"
        }
    }
}

/// One per Chrome window: owns the sidebar panel, finds the window's vertical tab rail and follows it.
@MainActor
final class OverlayController {
    static let shadowWidth: CGFloat = 8
    static let fallbackContentTop: CGFloat = 88

    let key: Int
    private(set) var window: ChromeWindow
    let sidebar = SidebarPanel()
    /// v3.1: native header over Chrome's vertical-tabs header (own traffic lights, sidebar toggle).
    let topBar = TopBarPanel()
    /// Small "Stile isn't set up for this profile" pill shown instead of a panel over the rail.
    private let notice = SetupNoticePanel()
    private var noticeCandidates: [(dir: String, name: String)] = []
    /// v2.8/v3.0: "Open in Chrome" button in the title bar (right side) of a little window.
    private let littlePill = LittlePillPanel()
    /// Title-bar height of this little window relative to its top, from AX (nil = not measured yet).
    private var littleTitleBarRel: CGFloat?
    private var littleTitleBarFallbackAt = Date.distantPast
    /// This window is a little window (per the extension's windowRoles): no sidebar, no setup pill.
    private(set) var isLittle = false
    /// Global on/off (set by the manager). While off, nothing of ours is on screen.
    var overlayEnabled = true

    /// v3.6.1: our panels on screen over this window (sidebar, header, little-window pill), so captures show Stile rather
    /// than Chrome's tab rail under it. The "not set up" pill is left out: it's a prompt for the user, not part of the window.
    var capturePanelIDs: [CGWindowID] {
        [sidebar, topBar, littlePill].filter { $0.isVisible && $0.windowNumber > 0 }.map { CGWindowID($0.windowNumber) }
    }

    private var visible = false
    private var chromeFrontmost = false
    private var busy = false
    private var animating = false
    private var animToken = 0
    private var resizing = false
    private var resizeStartWidth: CGFloat = 0
    private var resizeSplitterStart: CGPoint?

    // v3.1 header
    /// Chrome's close / minimize / zoom button frames relative to the window top-left (empty when unreadable).
    private var lightsRel: [CGRect] = []
    /// Left edge of Chrome's first toolbar control (left of the address field), window-relative.
    private var firstControlMinXRel: CGFloat?
    private var topBarOn = false
    /// The header shows its sidebar toggle (it is dropped when Chrome's toolbar leaves no room); the page shows its
    /// own footer pin toggle otherwise.
    private var topBarToggle = false
    /// Window-relative frames of interactive elements near the top (from the last scan) and whether they can be trusted.
    private var interactiveRel: [CGRect] = []
    private var toolbarPopulated = false
    private var loggedHeader = false
    private var themeBg: NSColor?
    private var themeDark = false
    /// Frame before our Fill / Tile (AX coords), so Restore Size and a second Fill can return to it.
    private var restoreFrame: CGRect?
    private var fsFlipAt = Date.distantPast
    private var fsTransitionUntil = Date.distantPast
    private let fsRecheck = OneShot()
    /// While full screen and not docked: re-reads Chrome's "Always Show Toolbar in Full Screen" tick every ~1 s.
    private let fsDockedPoll = OneShot()
    private let fsCheck = OneShot()
    private var fsCheckPending = false
    /// Full screen: Chrome's toolbar element and how far its reveal currently reaches below the window top.
    private var toolbarEl: AXUIElement?
    private var revealInset: CGFloat = 0
    /// The element whose bottom is the toolbar's visible edge (the toolbar, or its slightly taller container).
    private var revealEdgeEl: AXUIElement?
    /// AppKit's full-screen reveal window (owned by Chrome, above it, alpha 0): its height follows the menu bar +
    /// toolbar slide frame by frame, where AX only reports the toolbar hidden or fully out.
    private var revealWinID: CGWindowID = 0
    /// Its bottom below the window top: lowest seen (toolbar hidden) and highest seen (fully revealed).
    private var revealWinRest: CGFloat = 0
    private var revealWinFull: CGFloat = 0
    /// The toolbar's exact edge when fully out (from AX), to map the window's slide onto.
    private var revealFull: CGFloat?
    private var revealLaidOut = true
    private var revealLastW: CGFloat = 0
    /// When the reveal window last moved, how fast (pt/s), and which way (1 in, -1 out; sticks while it pauses).
    private var revealLastMove: CFTimeInterval = 0
    private var revealSpeed: CGFloat = 0
    private var revealDir = 0
    private var revealWatchUntil = Date.distantPast
    private let revealPoll = OneShot()
    private let noteTimer = OneShot()
    static let toggleSize: CGFloat = 28
    /// Full screen: how far the sidebar's toolbar-coloured top strip reaches up into Chrome's toolbar while it is out.
    /// Chrome's toolbar has 6 pt of plain padding below the address bar, and the first frame of a slide up (which we
    /// cannot see coming) moves it 3–6 pt.
    static let revealStrip: CGFloat = 6
    /// Chrome's toolbar colour just above its bottom edge, sampled once it is out (nil: no screen capture, no strip).
    private var revealToolbarColor: NSColor?
    private var revealColorSampled = false
    /// Held while following the toolbar: Stile is a background app, and macOS coalesces its timers (12–22 ms from
    /// Chrome's first step to ours, measured, against ~4 ms polling), which is what still showed a sliver of the rail.
    private var revealActivity: NSObjectProtocol?
    /// Pointer below the window top (full screen), whether the address bar has focus, and until when a predicted
    /// slide up (see preSlideOut) holds the sidebar ahead of a toolbar that hasn't moved yet.
    private var revealPointerY: CGFloat = 0
    private var toolbarHoldsFocus = false
    private var revealPreSlideUntil: CFTimeInterval = 0
    private var revealPreSlideLead: CGFloat = 0
    /// Chrome always shows its toolbar in full screen (see refreshDockedToolbar): no reveal tracking at all.
    private var dockedToolbar = false
    private var dockedCheckedAt = Date.distantPast
    /// After the pointer leaves with the address bar focused: poll AX's toolbar edge, since the reveal window is static.
    private var revealAXWatchUntil: CFTimeInterval = 0
    private var revealAXLast: CGFloat = -1
    private var revealAXRest: CGFloat = 0
    /// AX toolbar edge last seen while the reveal window was at rest (-1: none yet).
    private var revealAXHidden: CGFloat = -1
    private var revealAXHiddenMoved: CFTimeInterval = 0
    /// Chrome's address-bar suggestions window while it is open: the sidebar is ordered below it.
    private var omniboxPopupID: CGWindowID = 0
    /// Its bounds (CG / AX coordinates): the sidebar has a hole cut there (see SidebarPanel.setHole).
    private var omniboxPopupBounds: CGRect = .zero
    private let popupCheck = OneShot()
    /// How far ahead of the toolbar's edge a predicted slide up starts (plus the 6 pt strip): its first two frames.
    static let preSlideLead: CGFloat = 16

    private func holdRevealLatency(_ on: Bool) {
        if on, revealActivity == nil {
            revealActivity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical],
                                                                   reason: "Following Chrome's full-screen toolbar")
        } else if !on, let a = revealActivity {
            ProcessInfo.processInfo.endActivity(a)
            revealActivity = nil
        }
    }

    // Rail discovery
    private var rail: RailInfo?
    private var contentTopRel: CGFloat?
    private var lastScan = Date.distantPast
    private var lastScanSize = CGSize.zero
    private var loggedFound = false
    private var loggedMissing = false
    private var controlFailed = false   // Chrome's expand/collapse button could not be pressed or had no effect

    // Following (live move/resize from window-server bounds; no AX calls while it runs)
    private var following = false
    private var movedWhileFollowing = false

    // Mouse-predicted following during window drags / resizes
    private struct Edges { var left = false, top = false, right = false, bottom = false }
    private enum DragKind { case undecided, move, resize(Edges), unmatched }
    private struct DragState {
        var startMouse: CGPoint      // top-left global coordinates
        var startBounds: CGRect      // window-server bounds at mouse down
        var kind: DragKind = .undecided
        var diverged = false         // real bounds disagree with the prediction (screen edge / menu bar clamp)
    }
    private var drag: DragState?
    private var lastRealTick: CGRect?

    // Exact Chrome colour (needs Screen Recording permission)
    private var chromeColor: String?
    /// Chrome's toolbar colour, sampled when the header sits in Chrome's toolbar row (rail collapsed).
    private var toolbarColor: NSColor?
    private var lastActive = false
    private var captureDeadline = Date.distantPast
    private var captureTimer: Timer?
    private let sampleTimer = OneShot()

    // Widths for the compact/expanded layout
    private var lastCollapsedRailWidth: CGFloat = 48
    private var lastExpandedRailWidth: CGFloat?
    /// While Chrome is being asked to expand its rail, the web view is already laid out at this width.
    private var pendingPinWidth: CGFloat?

    // State inputs (the visible state is derived, see `state`)
    private var peeking = false
    private var floatPin = false        // fallback pin: floating over the page at peek width
    private var peekWidth: CGFloat = Settings.peekWidth

    private var bridge: ProfileBridge?
    private var chromeWindowId: Int?
    private var unmappedSince: Date? = Date()
    private var unmappedVisibleSince: Date?

    /// Not handled by the extension (typically incognito without "Allow in Incognito"): no sidebar, no setup
    /// card, Chrome's own UI stays visible. See `evaluateSupport`.
    private(set) var unsupported = false
    /// Profiles without a connected extension whose name matches this window's title (positive identification).
    private var lackingMatch: [(dir: String, name: String)] = []

    private let dwell = OneShot()
    private let hideTimer = OneShot()
    private let rescanTimer = OneShot()
    private let pressTimer = OneShot()

    /// Tell the manager that a geometry change was made locally (so it runs the follow timer).
    var onLocalGeometryChange: (() -> Void)?
    /// v3.0: `beginWindowDrag` from the page: (window key, doubleClick). The manager forwards to the DragController.
    var onWindowDrag: ((Int, Bool) -> Void)?
    /// v3.1: the header's red light (window key, AX window): the manager runs the close interceptor's decision.
    var onTopBarClose: ((Int, AXUIElement) -> Void)?
    /// v3.0: this controller pushed host state to its page (the manager then pushes `appState` to the extension).
    var onHostStatePushed: (() -> Void)?
    /// v3.1: panels were laid out (not while following): the manager refreshes the tap snapshots.
    var onLayoutSettled: (() -> Void)?
    /// Set by OverlayManager: CG ids of all Chrome windows the tracker knows (every profile). Never an address-bar popup.
    var knownChromeWindowIDs: (() -> Set<CGWindowID>)?

    /// The live extension connection this window is mapped to.
    var mappedBridge: ProfileBridge? { liveMapped ? bridge : nil }

    init(window: ChromeWindow) {
        self.key = window.key
        self.window = window
        wireUp()
    }

    private func wireUp() {
        sidebar.onHost = { [weak self] action, value in self?.handleHost(action, value) }
        sidebar.chromePid = { [weak self] in
            guard let self = self else { return 0 }
            return AX.pid(self.window.element)
        }
        sidebar.onPanelMouseDown = { [weak self] in
            guard let self = self else { return }
            self.lastPanelClick = Date()
            // Raise this window among Chrome's windows right away (no app activation yet: that waits until
            // we know the click did not land in a text field, which needs the panel to keep the keyboard).
            self.raiseWindowForClick()
        }
        sidebar.onNonEditingClick = { [weak self] in
            // A user click in this window's sidebar: bring the window (and Chrome) to the front.
            self?.activateChromeAfterClick()
        }
        sidebar.onBridgeCall = { [weak self] call in self?.pageCalled(call) }
        sidebar.onDidBecomeKey = { [weak self] in self?.reorderSidebar() }
        sidebar.onResizeBegan = { [weak self] in self?.beginResize() }
        sidebar.onPointerEnter = { [weak self] in self?.pointerEntered() }
        sidebar.onPointerExit = { [weak self] in self?.pointerExited() }
        sidebar.onResize = { [weak self] w in self?.liveResize(to: w) }
        notice.onDismissed = { [weak self] in self?.updateNotice() }
        littlePill.onClick = { [weak self] in self?.promoteLittle() }
        let bar = topBar.bar
        bar.onClose = { [weak self] in
            guard let self = self else { return }
            self.onTopBarClose?(self.key, self.window.element)
        }
        bar.onMinimize = { [weak self] in
            guard let self = self else { return }
            AX.setBool(self.window.element, AXName.minimized, true)
        }
        bar.onZoom = { [weak self] option in self?.zoomClicked(option: option) }
        bar.menuProvider = { [weak self] in self?.buildZoomMenu() ?? (NSMenu(), []) }
        bar.onToggle = { [weak self] in
            guard let self = self else { return }
            self.setPinned(self.state != .pinned)
        }
        bar.onWindowDrag = { [weak self] dbl in
            guard let self = self else { return }
            self.onWindowDrag?(self.key, dbl)
        }
        bar.onMouseDown = { [weak self] in
            self?.raiseWindowForClick()
            self?.activateChromeAfterClick()
        }
        bar.toggleTip = { [weak self] in
            (self?.state == .pinned) ? "Collapse sidebar" : "Keep sidebar open (\u{2303}\u{2325}S)"
        }
        if window.fullscreen { applySpaceBehaviour(true); syncSidebarFill() }
        sidebar.onResizeEnded = { [weak self] in
            guard let self = self else { return }
            self.resizing = false
            if self.isFloating(self.state) { Settings.peekWidth = self.peekWidth }
        }
    }

    // MARK: Derived state

    private var railExpanded: Bool { rail?.expanded ?? false }

    var railControllable: Bool { rail != nil && rail?.button != nil && !controlFailed }

    var state: SidebarState {
        if rail != nil {
            if railExpanded || floatPin { return .pinned }
            return peeking ? .peek : .collapsed
        }
        if floatPin { return .pinned }
        return peeking ? .peek : .hidden
    }

    /// Floating over the page (peek, or the fallback pin) rather than sitting on Chrome's rail.
    private func isFloating(_ s: SidebarState) -> Bool {
        s == .peek || (s == .pinned && !railExpanded)
    }

    // MARK: Lifecycle

    func teardown() {
        dwell.cancel()
        hideTimer.cancel()
        rescanTimer.cancel()
        pressTimer.cancel()
        sampleTimer.cancel()
        captureTimer?.invalidate()
        revealPoll.cancel()
        holdRevealLatency(false)
        captureTimer = nil
        fsRecheck.cancel()
        fsDockedPoll.cancel()
        fsCheck.cancel()
        noteTimer.cancel()
        topBar.hide()
        sidebar.teardown()
        notice.teardown()
        littlePill.teardown()
    }

    func attach(_ mapping: WindowMapper.Mapping?) {
        if let m = mapping, !m.bridge.closed {
            noticeCandidates = []
            unmappedSince = nil
            unmappedVisibleSince = nil
            if unsupported { setUnsupported(false) }
            if bridge !== m.bridge || chromeWindowId != m.windowId {
                bridge = m.bridge
                chromeWindowId = m.windowId
                if !isLittle { sidebar.connect(bridge: m.bridge, windowId: m.windowId) }
            }
        } else {
            if bridge != nil || chromeWindowId != nil {
                noticeCandidates = []   // the 10 s grace before any setup notice starts over
                bridge = nil
                chromeWindowId = nil
                sidebar.showWaiting()
                unmappedSince = Date()
            }
            if unmappedSince == nil { unmappedSince = Date() }
        }
        // The sidebar is only ever shown for a window mapped to a live connection.
        if computeVisible() != visible { update(window: window, chromeFrontmost: chromeFrontmost) }
        updateNotice()
        updateLittlePill()
    }

    // MARK: Little windows (v2.8)

    /// Manager: whether this window is a little window. Little windows never show the sidebar or the setup pill.
    func setLittle(_ on: Bool) {
        if isLittle == on { return }
        isLittle = on
        Log.write("window \(key): \(on ? "little window" : "regular window")")
        littleTitleBarRel = nil
        littleTitleBarFallbackAt = .distantPast
        if on {
            visible = false
            hideAll()
            notice.hide()
        } else if let b = bridge, let id = chromeWindowId, !b.closed {
            sidebar.connect(bridge: b, windowId: id)
            visible = computeVisible()
            if visible { rescan(reason: "no longer little") }
        }
        updateNotice()
        updateLittlePill()
    }

    private func promoteLittle() {
        guard isLittle, let b = bridge, !b.closed, let id = chromeWindowId else { return }
        LittleLinks.promote(bridge: b, windowId: id)
    }

    /// Height of the little window's title bar: top of the first AX toolbar / web area minus the window top
    /// (28 pt when that cannot be read). Cached; a fallback is retried every few seconds.
    private func littleTitleBarHeight() -> CGFloat {
        if let h = littleTitleBarRel { return h }
        if Date().timeIntervalSince(littleTitleBarFallbackAt) < 3 { return 28 }
        let top = window.frame.minY
        var best: CGFloat?
        var queue: [(AXUIElement, Int)] = [(window.element, 0)]
        var seen = 0
        while !queue.isEmpty, seen < 80 {
            let (el, depth) = queue.removeFirst()
            seen += 1
            if depth > 0 {
                let role = AX.string(el, AXName.role) ?? ""
                if role == "AXToolbar" || role == "AXWebArea", let f = AX.frame(el) {
                    let rel = f.minY - top
                    if rel >= 18 && rel <= 70 { best = min(best ?? rel, rel) }
                }
            }
            if depth < 3, let kids = AX.children(el) {
                for k in kids { queue.append((k, depth + 1)) }
            }
        }
        if let b = best {
            littleTitleBarRel = b
            return b
        }
        littleTitleBarFallbackAt = Date()
        return 28
    }

    /// Right side of the title bar, vertically centred, 8 pt from the window's right edge.
    private func layoutLittlePill(in frame: CGRect) {
        let size = littlePill.pillSize
        let barH = littleTitleBarHeight()
        let ax = CGRect(x: frame.maxX - 8 - size.width, y: frame.minY + (barH - size.height) / 2,
                        width: size.width, height: size.height)
        let ns = Geometry.flip(ax)
        if littlePill.frame != ns { littlePill.setFrame(ns, display: true) }
    }

    private func updateLittlePill() {
        guard isLittle, window.visible, liveMapped else {
            littlePill.hide()
            return
        }
        layoutLittlePill(in: window.frame)
        orderAbove(littlePill)
    }

    /// Mapped to an extension window whose connection is live.
    private var liveMapped: Bool {
        if let b = bridge, !b.closed { return true }
        return false
    }

    /// The sidebar panel may be on screen: Chrome window visible and supported, overlay on, live mapping.
    private func computeVisible() -> Bool {
        // Full screen is supported only with Chrome's View -> "Always Show Toolbar in Full Screen" (`dockedToolbar`):
        // nothing slides, the sidebar sits below the toolbar. With the auto-hiding toolbar (decided Oct 2026) Stile
        // still steps aside: its slide can't be followed without the tab rail showing through, and the address bar's
        // suggestions can't be layered above us. The reveal tracking is kept but unreachable. The extension (Chrome's
        // own side panel) still works either way.
        window.shown && (!window.fullscreen || dockedToolbar) && Date() >= fsTransitionUntil
            && !unsupported && overlayEnabled && liveMapped && !isLittle
    }


    /// Manager: the global `overlayEnabled` changed. Hides everything, or resumes (the update rescans the rail).
    func setOverlayEnabled(_ on: Bool) {
        overlayEnabled = on
        update(window: window, chromeFrontmost: chromeFrontmost)
        pushHostState()
    }

    /// Visible but not matched to an extension window.
    var isUnmapped: Bool { visible && bridge == nil }

    var isMapped: Bool { bridge != nil }

    /// On screen (ignoring `unsupported`) and not matched to an extension window: the mapper should keep trying.
    var wantsMapping: Bool { window.shown && bridge == nil }

    private var looksIncognito: Bool {
        let el = window.element
        if let t = AX.string(el, AXName.axTitle)?.trimmingCharacters(in: .whitespaces),
           t.lowercased().hasSuffix("(incognito)") { return true }
        for attr in ["AXRoleDescription", AXName.axDescription] {
            if let d = AX.string(el, attr), d.range(of: "incognito", options: .caseInsensitive) != nil { return true }
        }
        return false
    }

    /// Decides whether this window is unsupported: unmapped and either looks incognito, or no connected profile
    /// reported it for more than 3 s (counted from when it became visible / a profile connected) while at least
    /// one profile is connected. A window whose title positively names a profile without the extension stays
    /// supported so it can show the setup card. Returns true when the state changed.
    @discardableResult
    func evaluateSupport(anyConnected: Bool, connectedSince: Date?,
                         lacking: [(dir: String, name: String)]) -> Bool {
        var new = false
        if bridge != nil {
            unmappedVisibleSince = nil
            lackingMatch = []
        } else if !window.shown {
            unmappedVisibleSince = nil
            new = unsupported   // cannot tell while hidden; keep the last verdict
        } else {
            if unmappedVisibleSince == nil { unmappedVisibleSince = Date() }
            let title = AX.string(window.element, AXName.axTitle) ?? ""
            lackingMatch = lacking.filter { !$0.name.isEmpty && title.hasSuffix(" - " + $0.name) }
            if looksIncognito {
                new = true
            } else if anyConnected && lackingMatch.isEmpty {
                let start = max(unmappedVisibleSince ?? Date(), connectedSince ?? .distantPast)
                new = Date().timeIntervalSince(start) > 3
            }
        }
        if new == unsupported { return false }
        setUnsupported(new)
        return true
    }

    private func setUnsupported(_ on: Bool) {
        if unsupported == on { return }
        unsupported = on
        Log.write("window \(key): \(on ? "unsupported (not reported by any connected profile, or incognito)" : "supported")")
        if on {
            visible = false
            hideAll()
            sidebar.showWaiting()
        } else {
            visible = computeVisible()
            if visible { rescan(reason: "supported") }
        }
        updateNotice()
    }

    /// Candidates for the setup card: when profiles are connected, only the one positively identified.
    var lackingProfiles: [(dir: String, name: String)] { lackingMatch }

    /// True when this window has had no extension for more than 10 s (the manager then asks for the setup card).
    var needsSetupCheck: Bool {
        guard bridge == nil, overlayEnabled, window.visible, !unsupported, let since = unmappedSince else { return false }
        return Date().timeIntervalSince(since) > 10
    }

    func applySetup(candidates: [(dir: String, name: String)]) {
        noticeCandidates = candidates
        updateNotice()
    }

    // MARK: Setup notice

    /// Bottom-left pill: 8 pt from the window's left and bottom edges.
    private func layoutNotice(in frame: CGRect) {
        let size = notice.pillSize
        let ax = CGRect(x: frame.minX + 8, y: frame.maxY - 8 - size.height, width: size.width, height: size.height)
        let ns = Geometry.flip(ax)
        if notice.frame != ns { notice.setFrame(ns, display: true) }
    }

    /// Shown only for a visible, supported window with no live mapping, a profile positively lacking the
    /// extension (see `applySetup`), the overlay on, and not dismissed for that profile.
    private func updateNotice() {
        let cands = noticeCandidates.filter { !SetupNoticePanel.isDismissed($0.dir) }
        guard overlayEnabled, window.visible, !unsupported, !liveMapped, !isLittle, !cands.isEmpty else {
            notice.hide()
            return
        }
        notice.configure(candidates: cands)
        layoutNotice(in: window.frame)
        orderAbove(notice)
    }

    func update(window w: ChromeWindow, chromeFrontmost f: Bool) {
        let wasVisible = visible
        var w = w
        if w.fullscreen != window.fullscreen {
            // Enter/exit animation: hide both panels until the bounds settle.
            fsFlipAt = Date()
            fsTransitionUntil = Date().addingTimeInterval(0.8)
            fsCheckPending = false
            fsCheck.cancel()
            // Order out before changing Spaces behaviour: macOS doesn't move a window that is already
            // placed, so the panels must be re-ordered in after the change to land on the new Space.
            hideAll()
            revealInset = 0
            revealWinID = 0
            revealFull = nil
            revealColorSampled = false
            sidebar.setTopStrip(nil)
            dockedToolbar = false
            dockedCheckedAt = .distantPast
            revealPoll.cancel()
            holdRevealLatency(false)
            applySpaceBehaviour(w.fullscreen)
            syncSidebarFill(fullscreen: w.fullscreen)
            Log.write("fullscreen[window \(key)]: \(w.fullscreen ? "entered" : "left")")
            scheduleFullscreenRecheck(after: 0.85)
        }
        if w.fullscreen {
            if w.cgID != 0, let b = CGInfo.boundsMap(ids: [w.cgID])[w.cgID] { w.frame = b }   // window-server bounds
            if sameRect(w.frame, window.frame, 2) == false, Date().timeIntervalSince(fsFlipAt) < 2.5,
               window.fullscreen == w.fullscreen {
                fsTransitionUntil = Date().addingTimeInterval(0.4)   // still resizing
                scheduleFullscreenRecheck(after: 0.45)
            }
        }
        window = w
        chromeFrontmost = f
        if restoreFrame != nil, !following, WindowActions.arrangement(of: w.frame) == .none { restoreFrame = nil }
        // Full screen runs only with the toolbar docked: read that first, even while the overlay is hidden (throttled
        // to 1/s; the flip reset the check, and the recheck after the transition lands here).
        if window.fullscreen {
            if Date() >= fsTransitionUntil { refreshDockedToolbar() }
            if !fsDockedPoll.isScheduled {
                fsDockedPoll.schedule(after: 1.05) { [weak self] in
                    guard let self = self else { return }
                    self.fsDockedPoll.clear()
                    self.update(window: self.window, chromeFrontmost: self.chromeFrontmost)
                }
            }
        } else {
            fsDockedPoll.cancel()
        }
        visible = computeVisible()
        defer {
            updateNotice()
            updateLittlePill()
        }
        if !visible {
            hideAll()
            return
        }
        // Chrome dims an inactive window's frame colour: re-sample when this window gains/loses focus.
        let active = f && isFocusedChromeWindow
        if active != lastActive {
            lastActive = active
            scheduleSample(after: 0.2)
        }
        if lastScan == .distantPast || !wasVisible {
            rescan(reason: wasVisible ? "first" : "shown")
        } else if w.frame.size != lastScanSize {
            rescanTimer.schedule(after: 0.3) { [weak self] in
                self?.rescanTimer.clear()
                self?.rescan(reason: "window resized")
            }
        }
        layout()
        if visible, window.fullscreen, !fsCheckPending, Date() >= fsTransitionUntil {
            fsCheckPending = true
            fsCheck.schedule(after: 1.5) { [weak self] in
                self?.fsCheck.clear()
                self?.checkFullscreenSpace()
            }
        }
    }

    private func scheduleFullscreenRecheck(after t: TimeInterval) {
        fsRecheck.schedule(after: t) { [weak self] in
            guard let self = self else { return }
            self.fsRecheck.clear()
            self.update(window: self.window, chromeFrontmost: self.chromeFrontmost)
        }
    }

    /// Full screen needs the panels to live on Chrome's full-screen Space.
    private func applySpaceBehaviour(_ fullscreen: Bool) {
        let b: NSWindow.CollectionBehavior = fullscreen ? [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
                                                        : [.managed, .fullScreenAuxiliary, .ignoresCycle]
        sidebar.collectionBehavior = b
        topBar.collectionBehavior = b
        topBar.bar.cornerRadius = fullscreen ? 0 : 10
    }

    /// 1.5 s into full screen: if our panel did not make it onto Chrome's Space, fall back to Fill for the green button.
    private func checkFullscreenSpace() {
        guard visible, window.fullscreen, window.onScreen else { fsCheckPending = false; return }
        let probe: NSPanel = sidebar.isVisible ? sidebar : topBar
        guard probe.isVisible else { return }
        // isOnActiveSpace is always true for a .canJoinAllSpaces window; ask the window server instead.
        let onScreen = CGInfo.onScreenWindowInfo().contains {
            ($0["kCGWindowNumber"] as? NSNumber)?.intValue == probe.windowNumber
        }
        if onScreen {
            Log.write("fullscreen[window \(key)]: overlay is on Chrome's full-screen Space")
            return
        }
        Log.write("fullscreen: overlay can't join Chrome's full-screen Space")
        if Settings.greenButtonAction == "full" {
            Settings.greenButtonAction = "fill"   // posts; the next zoom click fills instead
            Settings.greenButtonNotePending = true
            Log.write("fullscreen: green button now fills the screen instead (setting greenButtonAction=fill)")
        }
    }

    func settingsChanged() {
        peekWidth = Settings.peekWidth
        layout()
        pushHostState()
    }

    // MARK: Rail discovery

    /// Scans the window's AX tree for the vertical tab rail and its collapse/expand button.
    func rescan(reason: String) {
        guard visible else { return }
        trafficLightsBottomRel = nil
        lightsRel = readLights()
        lastScan = Date()
        lastScanSize = window.frame.size
        let scan = RailFinder.scan(window: window.element, windowFrame: window.frame,
                                   wantLog: !(loggedFound && loggedMissing))
        let nowFound = scan.rail != nil
        // The first outcome of each kind (found / not found) per window is logged with the tree path.
        if (nowFound && !loggedFound) || (!nowFound && !loggedMissing) {
            Log.write("rail[window \(key)] scan (\(reason)):\n" + scan.logLines.joined(separator: "\n"))
            if nowFound { loggedFound = true } else { loggedMissing = true }
        }
        apply(scan)
        if let r = scan.rail, !loggedHeader, !scan.toolbarLog.isEmpty {
            loggedHeader = true
            let names = ["close", "minimize", "zoom"]
            var msg = "topbar[window \(key)] measured (window w=\(Int(window.frame.width)) h=\(Int(window.frame.height))):\n"
            if lightsRel.isEmpty {
                msg += "  traffic lights: not readable"
            } else {
                var parts: [String] = []
                for (n, f) in zip(names, lightsRel) { parts.append("\(n)=\(fmt(f))") }
                msg += "  traffic lights (window-relative): " + parts.joined(separator: " ")
            }
            let geo = headerGeometry()
            msg += "\n  rail header: rail rel \(fmt(r.rel)) -> height by \(geo?.note ?? "n/a")"
            msg += "\n" + scan.toolbarLog.joined(separator: "\n")
            var headerDesc = "none"
            if let g = geo {
                let t = g.toggle.map { fmt($0) } ?? "dropped"
                headerDesc = "w=\(Int(g.size.width)) h=\(Int(g.size.height)) toggle=\(t)"
            }
            msg += "\n  header rect (window-relative): " + headerDesc
            Log.write(msg)
        }
    }

    private func fmt(_ r: CGRect) -> String {
        "x=\(Int(r.minX)) y=\(Int(r.minY)) w=\(Int(r.width)) h=\(Int(r.height))"
    }

    private func apply(_ scan: RailScan) {
        defer { if window.fullscreen { refreshDockedToolbar(force: true) } }
        rail = scan.rail
        contentTopRel = scan.contentTopRel
        firstControlMinXRel = scan.firstToolbarControlMinX.map { $0 - window.frame.minX }
        if let t = scan.toolbar, toolbarEl.map({ !CFEqual($0, t) }) ?? true { revealEdgeEl = nil }
        toolbarEl = scan.toolbar
        interactiveRel = scan.interactiveRel
        toolbarPopulated = scan.toolbarPopulated
        if rail == nil { controlFailed = false }
        if railExpanded {
            // Chrome's own rail is open: it is the pinned state; fallback floating pin no longer applies.
            floatPin = false
            peeking = false
            pendingPinWidth = nil
        }
        noteRailWidths()
        layout()
        sampleColor(push: false)
        pushHostState()
    }

    /// Forced re-scan from the page's "Find Chrome's tab rail again" button.
    func forceRescan() {
        controlFailed = false
        loggedFound = false
        loggedMissing = false
        rescan(reason: "requested")
    }

    /// Called by the manager about once a second.
    func railTick(quiet: Bool) {
        guard visible, !quiet else { return }
        if let r = rail {
            guard let f = AX.frame(r.railElement) else {
                rescan(reason: "rail element gone")
                return
            }
            let rel = CGRect(x: f.minX - window.frame.minX, y: f.minY - window.frame.minY, width: f.width, height: f.height)
            if abs(rel.minX - r.rel.minX) > 1.5 || abs(rel.minY - r.rel.minY) > 1.5
                || abs(rel.width - r.rel.width) > 1.5 || abs(rel.height - r.rel.height) > 1.5 {
                rail?.rel = rel
                rail?.bottomInset = max(0, window.frame.maxY - f.maxY)
                if railExpanded { floatPin = false; peeking = false }
                layout()
                pushHostState()
            }
        } else if Date().timeIntervalSince(lastScan) > 2 {
            rescan(reason: "no rail yet")
        }
    }

    /// Ask Chrome to expand or collapse its rail by pressing its button, then check the result.
    private func pressRail(wantExpanded: Bool) {
        guard let button = rail?.button else { return }
        if !AX.perform(button, AXName.actionPress) {
            Log.write("rail[window \(key)]: pressing Chrome's collapse/expand button failed; falling back to floating")
            railControlFailed(wantExpanded: wantExpanded)
            return
        }
        checkRailAfterPress(wantExpanded: wantExpanded, attempt: 1)
    }

    private func checkRailAfterPress(wantExpanded: Bool, attempt: Int) {
        pressTimer.schedule(after: attempt == 1 ? 0.25 : 0.4) { [weak self] in
            guard let self = self else { return }
            self.pressTimer.clear()
            self.rescan(reason: "after pressing the rail button")
            if self.rail != nil && self.railExpanded == wantExpanded { return }
            if attempt < 2 {
                self.checkRailAfterPress(wantExpanded: wantExpanded, attempt: attempt + 1)
            } else {
                Log.write("rail[window \(self.key)]: pressing the rail button did not change the rail; falling back to floating")
                self.railControlFailed(wantExpanded: wantExpanded)
            }
        }
    }

    private func railControlFailed(wantExpanded: Bool) {
        controlFailed = true
        pendingPinWidth = nil
        if wantExpanded { floatPin = true; peeking = false }
        layout()
        pushHostState()
    }

    // MARK: Geometry

    private var windowAX: CGRect { window.frame }

    /// Rail frame in AX coordinates, from the cached window-relative frame.
    /// Bottom of Chrome's close/minimise/zoom buttons, relative to the window top (cached per scan).
    private var trafficLightsBottomRel: CGFloat?

    private func trafficLightsBottom() -> CGFloat {
        if let c = trafficLightsBottomRel { return c }
        var bottom: CGFloat = 0
        for name in [AXName.closeButton, AXName.zoomButton] {
            if let b = AX.element(window.element, name), let f = AX.frame(b) {
                bottom = max(bottom, f.maxY - window.frame.minY)
            }
        }
        // Leave a little air under the buttons; fall back to the standard title-bar height.
        let value = bottom > 0 ? bottom + 6 : 32
        trafficLightsBottomRel = value
        return value
    }

    private func railAXRect() -> CGRect? {
        guard let r = rail else { return nil }
        let w = windowAX
        // Height follows the live window height (see RailInfo.bottomInset) so resizing never waits for a rescan.
        let liveHeight = max(0, w.height - r.rel.minY - r.bottomInset)
        var rect = CGRect(x: w.minX + r.rel.minX, y: w.minY + r.rel.minY, width: r.rel.width, height: liveHeight)
        // The header panel covers everything above the rail; never overlap it. In full screen, nor Chrome's
        // revealed toolbar.
        let minTop = w.minY + max(headerHeightRel() ?? 0, window.fullscreen ? revealInset : 0)
        if rect.minY < minTop {
            let cut = minTop - rect.minY
            rect.origin.y = minTop
            rect.size.height = max(0, rect.height - cut)
        }
        return rect
    }

    private func contentTopAX() -> CGFloat {
        windowAX.minY + max(contentTopRel ?? Self.fallbackContentTop, trafficLightsBottom())
    }

    /// The sidebar's own frame (without the shadow strip) in AX coordinates for a state.
    private func logicalAXRect(for s: SidebarState) -> CGRect {
        let w = windowAX
        let sw = max(peekWidth, Settings.minWidth)
        switch s {
        case .collapsed:
            return railAXRect() ?? CGRect(x: w.minX, y: contentTopAX(), width: 48, height: max(0, w.maxY - contentTopAX()))
        case .pinned where railExpanded:
            return railAXRect() ?? CGRect(x: w.minX, y: contentTopAX(), width: sw, height: max(0, w.maxY - contentTopAX()))
        case .peek, .pinned, .hidden:
            if let r = railAXRect() {
                return CGRect(x: r.minX, y: r.minY, width: max(sw, r.width), height: r.height)
            }
            let top = contentTopAX()
            return CGRect(x: w.minX, y: top, width: sw, height: max(0, w.maxY - top))
        }
    }

    private func currentLogicalNS() -> CGRect {
        Geometry.flip(logicalAXRect(for: state))
    }

    /// 4 px hover zone on Chrome's left edge, only used when no rail was found.
    private var edgeZoneNS: CGRect {
        let w = windowAX
        let top = contentTopAX()
        return Geometry.flip(CGRect(x: w.minX, y: top, width: 4, height: max(0, w.maxY - top)))
    }

    /// Set by OverlayManager: true when this is Chrome's focused window.
    var isFocusedChromeWindow = false

    private func orderAbove(_ panel: NSPanel) {
        if window.fullscreen {
            if panel.level != .floating { panel.level = .floating }
            panel.orderFrontRegardless()
            return
        }
        if chromeFrontmost && isFocusedChromeWindow {
            if panel.level != .floating { panel.level = .floating }
            panel.orderFrontRegardless()
            return
        }
        if panel.level != .normal { panel.level = .normal }
        if window.cgID != 0 {
            panel.order(.above, relativeTo: Int(window.cgID))
        } else {
            panel.orderFront(nil)
        }
    }

    private func reorderSidebar() {
        guard visible, state != .hidden else { return }
        orderAbove(sidebar)
    }

    /// Width the web view is laid out at: always the target expanded width. When collapsed the panel is only
    /// the rail wide and clips the left strip of the same layout.
    private func contentWidth(for s: SidebarState, logical w: CGFloat) -> CGFloat {
        if s == .collapsed {
            return max(pendingPinWidth ?? max(peekWidth, Settings.minWidth), w)
        }
        return w
    }

    private func noteRailWidths() {
        guard let r = rail else { return }
        if r.expanded { lastExpandedRailWidth = r.rel.width } else { lastCollapsedRailWidth = r.rel.width }
    }

    private func panelFrame(logical ns: NSRect, state s: SidebarState) -> NSRect {
        var f = ns
        if isFloating(s) { f.size.width += Self.shadowWidth }
        return f
    }

    private func applyChrome(ax: CGRect, state s: SidebarState) {
        let w = windowAX
        let touchesBottomLeft = abs(ax.minX - w.minX) <= 2 && abs(ax.maxY - w.maxY) <= 2
        sidebar.setCorners(bottomLeft: touchesBottomLeft)
        sidebar.handle.isHidden = !canResize(s)
    }

    private func canResize(_ s: SidebarState) -> Bool {
        if isFloating(s) { return true }
        if s == .pinned { return rail?.splitter != nil }
        return false
    }

    func layout(following isFollowing: Bool = false, revealSlide: Bool = false) {
        guard visible else { return }
        let s = state
        layoutTopBar(following: isFollowing)
        if s == .hidden {
            if !animating { sidebar.orderOut(nil) }
            return
        }
        if animating { return }
        let ax = logicalAXRect(for: s)
        let ns = Geometry.flip(ax)
        var frame = panelFrame(logical: ns, state: s)
        let shadow: CGFloat = isFloating(s) ? Self.shadowWidth : 0
        if window.fullscreen {
            // Full screen: the panel always keeps its toolbar-hidden height and Chrome's toolbar sliding in or out only
            // moves it, the bottom running off the screen (borderless, so not constrained). Resizing the panel costs
            // 10–25 ms (window server + WebKit), which is how far it fell behind the toolbar, mostly on the first step
            // of a slide out. At rest the web view alone is fitted to the visible part (see SidebarPanel.bottomOverflow).
            let saved = revealInset
            revealInset = 0
            let tall = panelFrame(logical: Geometry.flip(logicalAXRect(for: s)), state: s)
            revealInset = saved
            let overflow = max(0, tall.height - frame.height)
            // Plus the toolbar-coloured strip on top (SidebarPanel.topStrip), clear unless the toolbar is out.
            let top = frame.maxY + Self.revealStrip
            frame.size.height = tall.height + Self.revealStrip
            frame.origin.y = top - frame.height
            if !revealSlide { sidebar.bottomOverflow = overflow }
            sidebar.topInset = Self.revealStrip
        } else {
            sidebar.bottomOverflow = 0
            sidebar.topInset = 0
        }
        defer { if omniboxPopupID != 0 { syncSidebarHole() } }
        if isFollowing {
            // Hot path: nothing animates, nothing is redrawn eagerly, no ordering or corner work.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            NSAnimationContext.beginGrouping()
            NSAnimationContext.current.duration = 0
            NSAnimationContext.current.allowsImplicitAnimation = false
            if abs(frame.width - sidebar.frame.width) < 0.01 && abs(frame.height - sidebar.frame.height) < 0.01 {
                // Pure move: only the origin changes.
                sidebar.setFrameOrigin(frame.origin)
            } else {
                sidebar.setFrame(frame, display: false)
                sidebar.fitContent(panelWidth: ns.width, contentWidth: contentWidth(for: s, logical: ns.width), shadow: shadow)
            }
            NSAnimationContext.endGrouping()
            CATransaction.commit()
            return
        }
        sidebar.setFrame(frame, display: true)
        sidebar.fitContent(panelWidth: ns.width, contentWidth: contentWidth(for: s, logical: ns.width), shadow: shadow)
        applyChrome(ax: ax, state: s)
        orderAbove(sidebar)
        onLayoutSettled?()
    }

    private func hideAll() {
        dwell.cancel()
        hideTimer.cancel()
        animToken += 1
        animating = false
        peeking = false
        sidebar.orderOut(nil)
        topBar.hide()
        if topBarOn { topBarOn = false; topBarToggle = false; pushHostState() }
    }

    // MARK: Header (v3.1)

    private struct HeaderGeo {
        var size: CGSize
        var lights: [CGRect]      // view coordinates (= window-relative AX points)
        var toggle: CGRect?
        var note: String
    }

    /// Chrome's close / minimize / zoom frames relative to the window top-left; empty unless all three are readable
    /// and inside the title-bar area.
    private func readLights() -> [CGRect] {
        var out: [CGRect] = []
        for name in [AXName.closeButton, AXName.minimizeButton, AXName.zoomButton] {
            guard let b = AX.element(window.element, name), let f = AX.frame(b) else { return [] }
            let rel = CGRect(x: f.minX - window.frame.minX, y: f.minY - window.frame.minY, width: f.width, height: f.height)
            if rel.minX < -2 || rel.minY < -2 || rel.maxY > 100 || rel.width > 40 { return [] }
            out.append(rel)
        }
        return out
    }

    /// No header in full screen: Chrome has no traffic lights there (they only appear with the toolbar reveal) and the
    /// rail starts at the window top, so the sidebar covers it all and its own toggle stands in for the header's.
    private var topBarWanted: Bool { overlayEnabled && rail != nil && !isLittle && !unsupported && !window.fullscreen }

    /// Header height: the rail's top (the part of Chrome's header above the rail), else the bottom of Chrome's
    /// traffic lights + 8, else 36.
    private func headerHeightRel() -> CGFloat? {
        guard topBarWanted, let r = rail else { return nil }
        if r.rel.minY >= 20 { return r.rel.minY }
        if let bottom = lightsRel.map({ $0.maxY }).max() { return bottom + 8 }
        return 36
    }

    private func headerGeometry() -> HeaderGeo? {
        guard let h = headerHeightRel(), let r = rail else { return nil }
        let clusterRight = lightsRel.map { $0.maxX }.max()
        let toggleX = (clusterRight ?? 0) + 8
        let need = toggleX + Self.toggleSize + 8
        let limit = firstControlMinXRel.map { $0 - 4 }
        var width = max(r.rel.width, need)
        var showToggle = true
        var note = r.rel.minY >= 20 ? "rail top" : (lightsRel.isEmpty ? "fallback 36" : "traffic lights bottom + 8")
        if let l = limit, need > l {
            showToggle = false
            width = max(r.rel.width, (clusterRight ?? 0) + 8)
            note += "; toggle dropped (no room before the first toolbar control)"
        }
        if let l = limit { width = max(min(width, l), (clusterRight ?? 0) + 4) }
        width = min(width, window.frame.width)
        let midY = lightsRel.isEmpty ? h / 2 : lightsRel[0].midY
        let toggle = showToggle ? CGRect(x: toggleX, y: midY - Self.toggleSize / 2, width: Self.toggleSize, height: Self.toggleSize) : nil
        return HeaderGeo(size: CGSize(width: width, height: h), lights: lightsRel, toggle: toggle, note: note)
    }

    /// The header sits in Chrome's toolbar row (above a collapsed rail) rather than over the rail's own header.
    private var headerInToolbarRow: Bool { (rail?.rel.minY ?? 0) >= 20 }

    private func syncTopBarLook() {
        let bar = topBar.bar
        var bg = headerInToolbarRow ? toolbarColor : nil
        if bg == nil && headerInToolbarRow {
            // No Screen Recording sample: Chrome's default toolbar colours.
            bg = themeDark ? NSColor(srgbRed: 0.235, green: 0.235, blue: 0.235, alpha: 1) : .white
        }
        if bg == nil { bg = themeBg }
        if bg == nil, let c = chromeColor { bg = ColorParse.parse(c) }
        bar.bg = bg ?? .windowBackgroundColor
        bar.dark = themeDark
        bar.active = chromeFrontmost && isFocusedChromeWindow
        bar.fillGlyph = restoreFrame != nil && WindowActions.arrangement(of: window.frame) == .fill
    }

    private func layoutTopBar(following isFollowing: Bool) {
        guard let g = headerGeometry() else {
            if topBarOn { topBarOn = false; topBarToggle = false; topBar.hide(); pushHostState() }
            return
        }
        let ax = CGRect(origin: window.frame.origin, size: g.size)
        let ns = Geometry.flip(ax)
        if isFollowing && abs(ns.width - topBar.frame.width) < 0.01 && abs(ns.height - topBar.frame.height) < 0.01 {
            topBar.setFrameOrigin(ns.origin)
            if !topBar.isVisible { orderAbove(topBar) }
            return
        }
        topBar.setFrame(ns, display: true)
        let bar = topBar.bar
        bar.lights = g.lights
        bar.toggleRect = g.toggle
        syncTopBarLook()
        bar.needsDisplay = true
        orderAbove(topBar)
        if !topBarOn || topBarToggle != (g.toggle != nil) {
            topBarOn = true
            topBarToggle = g.toggle != nil
            pushHostState()
        }
    }

    // MARK: Green button actions

    /// Stile's green button maximises (Fill screen) rather than entering full screen (its menu has Enter/Exit Full
    /// Screen; Stile shows in full screen only when Chrome's toolbar is docked).
    private func zoomClicked(option: Bool) {
        fillOrRestore()
    }

    private var liveFrame: CGRect { AX.frame(window.element) ?? window.frame }

    private func applyFrame(_ r: CGRect) {
        WindowActions.setFrame(window.element, r)
        if let f = AX.frame(window.element) { window.frame = f }
        onLocalGeometryChange?()   // the manager follows for a moment and refreshes the tracker
        layout()
        syncTopBarLook()
    }

    func fillOrRestore() {
        if let back = restoreFrame, WindowActions.arrangement(of: liveFrame) == .fill {
            restoreFrame = nil
            applyFrame(back)
        } else {
            arrange(.fill)
        }
    }

    private func arrange(_ a: WindowActions.Arrangement) {
        let cur = liveFrame
        guard let vf = WindowActions.visibleFrame(for: cur) else { return }
        // Keep the very first frame when going Fill -> Tile and so on.
        if restoreFrame == nil || WindowActions.arrangement(of: cur) == .none { restoreFrame = cur }
        applyFrame(WindowActions.target(a, in: vf))
    }

    private func restoreSize() {
        guard let back = restoreFrame else { return }
        restoreFrame = nil
        applyFrame(back)
    }

    /// Menu under the green button. The second element keeps the menu item targets alive while it is open.
    private func buildZoomMenu() -> (NSMenu, [AnyObject]) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var keep: [AnyObject] = []
        let current = WindowActions.arrangement(of: liveFrame)
        func add(_ title: String, checked: Bool = false, _ block: @escaping () -> Void) {
            let t = MenuBlock(block)
            keep.append(t)
            let it = NSMenuItem(title: title, action: #selector(MenuBlock.run), keyEquivalent: "")
            it.target = t
            it.state = checked ? .on : .off
            menu.addItem(it)
        }
        let fs = AX.bool(window.element, AXName.fullScreen) ?? false
        add("Fill Screen", checked: current == .fill) { [weak self] in self?.fillOrRestore() }
        add("Tile Left", checked: current == .left) { [weak self] in self?.arrange(.left) }
        add("Tile Right", checked: current == .right) { [weak self] in self?.arrange(.right) }
        menu.addItem(NSMenuItem.separator())
        add(fs ? "Exit Full Screen" : "Enter Full Screen") { [weak self] in
            guard let self = self else { return }
            WindowActions.setFullScreen(self.window.element, !fs)
        }
        if restoreFrame != nil && current != .none {
            add("Restore Size") { [weak self] in self?.restoreSize() }
        }
        return (menu, keep)
    }

    // MARK: Lockstep (DragController)

    /// Bottom of Chrome's toolbar relative to the window top (the draggable band is window top ... this).
    var toolbarBottomRel: CGFloat {
        max(contentTopRel ?? Self.fallbackContentTop, trafficLightsBottom())
    }

    /// Cached facts for the lockstep tap thread (AX coordinates): interactive control frames, rects it must not
    /// claim (our panels, Chrome's rail splitter) and whether the AX tree was populated enough to trust them.
    func lockstepInfo() -> (interactive: [CGRect], blocked: [CGRect], toolbarKnown: Bool) {
        let o = window.frame.origin
        let interactive = interactiveRel.map { $0.offsetBy(dx: o.x, dy: o.y) }
        var blocked: [CGRect] = []
        for p in [sidebar, topBar] where p.isVisible {
            blocked.append(Geometry.flip(p.frame))
        }
        if let sp = rail?.splitterRel { blocked.append(sp.offsetBy(dx: o.x, dy: o.y).insetBy(dx: -4, dy: -4)) }
        return (interactive, blocked, toolbarPopulated && rail != nil)
    }

    /// True when a click at this AX point belongs to our own panel (sidebar body or its splitter).
    func blocksLockstep(at ax: CGPoint) -> Bool {
        if sidebar.isVisible, sidebar.frame.contains(NSPoint(x: ax.x, y: Geometry.primaryHeight - ax.y)) { return true }
        if topBar.isVisible, topBar.frame.contains(NSPoint(x: ax.x, y: Geometry.primaryHeight - ax.y)) { return true }
        if let sp = rail?.splitter, let f = AX.frame(sp), f.insetBy(dx: -4, dy: -4).contains(ax) { return true }
        return false
    }

    /// Chrome's window was just set to `f` by the lockstep drag: move/resize our panel right away.
    func lockstepFrame(_ f: CGRect) {
        window.frame = f
        guard visible else { return }
        following = true
        movedWhileFollowing = true
        layout(following: true)
    }

    func lockstepFinished(resized: Bool) {
        following = false
        movedWhileFollowing = false
        guard visible else { return }
        if resized {
            rescanTimer.cancel()
            rescan(reason: "after lockstep resize")
        }
    }

    /// Update from the window server's live bounds (called once per display frame while Chrome moves or
    /// resizes). No AX calls here.
    func followBounds(_ b: CGRect?) {
        guard visible, let b = b else { return }
        applyFollowFrame(b, tolerance: 0.5)
    }

    private func sameRect(_ a: CGRect, _ b: CGRect, _ tol: CGFloat) -> Bool {
        abs(a.minX - b.minX) <= tol && abs(a.minY - b.minY) <= tol
            && abs(a.width - b.width) <= tol && abs(a.height - b.height) <= tol
    }

    private func applyFollowFrame(_ f: CGRect, tolerance: CGFloat) {
        if sameRect(f, window.frame, tolerance) { return }
        following = true
        movedWhileFollowing = true
        window.frame = f
        layout(following: true)
        onLocalGeometryChange?()
    }

    // MARK: Mouse-predicted following

    private func topLeft(_ p: NSPoint) -> CGPoint {
        CGPoint(x: p.x, y: Geometry.primaryHeight - p.y)
    }

    private func serverBounds() -> CGRect? {
        guard window.cgID != 0 else { return nil }
        return CGInfo.boundsMap(ids: [window.cgID])[window.cgID]
    }

    /// Global left mouse down while Chrome is frontmost: remember the mouse and the window's bounds.
    func dragBegan(mouse p: NSPoint) {
        lastRealTick = nil
        guard visible, window.cgID != 0 else { drag = nil; return }
        // The tracker's frame, not a window-server query: this runs on every click while Chrome is frontmost.
        drag = DragState(startMouse: topLeft(p), startBounds: window.frame)
    }

    /// Global left mouse drag event: place the panel from the predicted frame right away.
    func dragMoved(mouse p: NSPoint) {
        guard visible, drag != nil else { return }
        advance(mouse: topLeft(p), tick: false, real: nil)
    }

    /// Mouse up: stop predicting and snap to the real bounds.
    func dragEnded() {
        guard let d = drag else { return }
        drag = nil
        lastRealTick = nil
        // A plain click never decided a gesture: nothing moved, so no window-server query.
        if case .undecided = d.kind { return }
        if visible { followBounds(serverBounds()) }
    }

    /// Display-link frame: `real` is the window-server bounds, `mouse` is in NSEvent (bottom-left) coordinates.
    func followTick(real: CGRect?, mouse: NSPoint) {
        if notice.isVisible, let r = real, drag == nil { layoutNotice(in: r) }
        if littlePill.isVisible, let r = real, drag == nil { layoutLittlePill(in: r) }
        guard visible, let r = real else { return }
        if drag != nil {
            advance(mouse: topLeft(mouse), tick: true, real: r)
        } else {
            followBounds(r)
        }
        lastRealTick = r
    }

    private func classify(start s: CGRect, real r: CGRect, mouse m: CGPoint, from d: DragState) -> DragKind {
        let tol: CGFloat = 2
        let mdx = m.x - d.startMouse.x
        let mdy = m.y - d.startMouse.y
        let dMinX = r.minX - s.minX, dMaxX = r.maxX - s.maxX
        let dMinY = r.minY - s.minY, dMaxY = r.maxY - s.maxY
        if abs(r.width - s.width) < 0.5 && abs(r.height - s.height) < 0.5 {
            return (abs(dMinX - mdx) <= tol && abs(dMinY - mdy) <= tol) ? .move : .unmatched
        }
        var e = Edges()
        e.left = abs(dMinX) > 0.5
        e.right = abs(dMaxX) > 0.5
        e.top = abs(dMinY) > 0.5
        e.bottom = abs(dMaxY) > 0.5
        if e.left && abs(dMinX - mdx) > tol { return .unmatched }
        if e.right && abs(dMaxX - mdx) > tol { return .unmatched }
        if e.top && abs(dMinY - mdy) > tol { return .unmatched }
        if e.bottom && abs(dMaxY - mdy) > tol { return .unmatched }
        return .resize(e)
    }

    private func predictedFrame(_ d: DragState, mouse m: CGPoint) -> CGRect {
        let dx = m.x - d.startMouse.x
        let dy = m.y - d.startMouse.y
        let s = d.startBounds
        switch d.kind {
        case .move:
            return s.offsetBy(dx: dx, dy: dy)
        case .resize(let e):
            var minX = s.minX, maxX = s.maxX, minY = s.minY, maxY = s.maxY
            if e.left { minX += dx }
            if e.right { maxX += dx }
            if e.top { minY += dy }
            if e.bottom { maxY += dy }
            return CGRect(x: minX, y: minY, width: max(1, maxX - minX), height: max(1, maxY - minY))
        case .undecided, .unmatched:
            return s
        }
    }

    private func advance(mouse m: CGPoint, tick: Bool, real realIn: CGRect?) {
        guard var d = drag else { return }
        var real = realIn
        if case .undecided = d.kind {
            if real == nil { real = serverBounds() }
            guard let r = real, !sameRect(r, d.startBounds, 0.5) else { return }   // nothing moved yet
            d.kind = classify(start: d.startBounds, real: r, mouse: m, from: d)
            drag = d
        }
        switch d.kind {
        case .undecided:
            return
        case .unmatched:
            if let r = real { followBounds(r) }
        case .move, .resize:
            let predicted = predictedFrame(d, mouse: m)
            if tick, let r = real {
                let settled = lastRealTick.map { sameRect($0, r, 0.5) } ?? false
                if sameRect(predicted, r, 2) {
                    d.diverged = false
                    applyFollowFrame(predicted, tolerance: 0.25)
                } else if settled {
                    // The window server stopped short of the prediction (menu bar / screen edge / min size).
                    d.diverged = true
                    followBounds(r)
                } else if d.diverged {
                    followBounds(r)
                } else {
                    applyFollowFrame(predicted, tolerance: 0.25)
                }
            } else if !d.diverged {
                applyFollowFrame(predicted, tolerance: 0.25)
            }
            drag = d
        }
    }

    /// Following is over: one AX rescan (the rail rect is window-relative, so only a resize can change it).
    func endFollowing() {
        let moved = movedWhileFollowing
        following = false
        movedWhileFollowing = false
        guard visible else { return }
        if moved {
            rescanTimer.cancel()
            rescan(reason: "after follow")
        }
        sampleColor()
    }

    // MARK: Chrome colour

    private func scheduleSample(after t: TimeInterval) {
        sampleTimer.schedule(after: t) { [weak self] in
            self?.sampleTimer.clear()
            self?.sampleColor()
        }
    }

    /// Samples the rail colour; pushes host state when it changed.
    func sampleColor(push: Bool = true) {
        guard visible, !following else { return }
        var color = chromeColor
        if let r = rail, window.cgID != 0, Permissions.screenCaptureGranted {
            let w = window.frame
            let y = r.rel.height > 120 ? w.minY + r.rel.maxY - 40 : w.minY + r.rel.midY - 12
            let rect = CGRect(x: w.minX + r.rel.minX + 6, y: y, width: 4, height: 24)
            if let c = ChromeColor.sample(windowID: window.cgID, rect: rect) { color = c }
        } else if !Permissions.screenCaptureGranted {
            color = nil
        }
        sampleToolbarColor()
        if color != chromeColor {
            chromeColor = color
            if push { pushHostState() }
        }
    }

    /// Samples Chrome's toolbar just right of the traffic lights (our header is not in the window-only capture).
    private func sampleToolbarColor() {
        var c: NSColor?
        if headerInToolbarRow, let r = rail, window.cgID != 0, Permissions.screenCaptureGranted {
            let w = window.frame
            let x = (lightsRel.map { $0.maxX }.max() ?? 70) + 3
            let rect = CGRect(x: w.minX + x, y: w.minY + 6, width: 4, height: max(8, r.rel.minY - 12))
            c = ChromeColor.sample(windowID: window.cgID, rect: rect).flatMap { ColorParse.parse($0) }
        }
        if c != toolbarColor {
            toolbarColor = c
            syncTopBarLook()
        }
    }

    /// `requestScreenCapture` from the page: ask, then re-check every second for 30 s.
    func startCaptureRequest() {
        Permissions.requestScreenCapture()
        captureDeadline = Date().addingTimeInterval(30)
        captureTimer?.invalidate()
        revealPoll.cancel()
        holdRevealLatency(false)
        captureTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.captureTick() }
        }
    }

    private func captureTick() {
        sampleColor(push: false)
        pushHostState()
        if Permissions.screenCaptureGranted || Date() > captureDeadline {
            captureTimer?.invalidate()
            captureTimer = nil
        }
    }

    // MARK: State changes

    func setPinned(_ on: Bool) {
        dwell.cancel()
        hideTimer.cancel()
        animToken += 1
        animating = false
        noteRailWidths()
        pendingPinWidth = nil
        if railControllable {
            if on {
                if !railExpanded {
                    // Lay the web view out at the expanded width first (still clipped to the rail).
                    pendingPinWidth = lastExpandedRailWidth ?? max(peekWidth, Settings.minWidth)
                    layout()
                    pressRail(wantExpanded: true)
                }
            } else {
                floatPin = false
                if railExpanded { pressRail(wantExpanded: false) }
                peeking = false
            }
        } else if rail != nil && railExpanded {
            // Chrome's rail is open but we cannot collapse it.
            if !on { Log.write("rail[window \(key)]: cannot collapse Chrome's rail (no usable button)") }
        } else {
            // No rail, or a rail we cannot control: pinned floats over the page at peek width.
            floatPin = on
            peeking = false
        }
        layout()
        pushHostState()
    }

    private func showPeek() {
        let before = state
        guard before == .collapsed || before == .hidden, visible else { return }
        peeking = true
        let ax = logicalAXRect(for: .peek)
        let ns = Geometry.flip(ax)
        let target = panelFrame(logical: ns, state: .peek)
        var start = target
        if before == .collapsed && sidebar.isVisible { start = sidebar.frame } else { start.size.width = 1 }
        sidebar.setFrame(start, display: false)
        // Only the panel frame animates; the web view is already at the peek width.
        sidebar.fitContent(panelWidth: ns.width, contentWidth: ns.width, shadow: Self.shadowWidth)
        applyChrome(ax: ax, state: .peek)
        orderAbove(sidebar)
        pushHostState()
        animateSidebar(to: target, duration: 0.12, timing: .easeOut) { [weak self] in self?.layout() }
    }

    private func hidePeek() {
        guard state == .peek else { return }
        peeking = false
        let after = state   // .collapsed (rail found) or .hidden
        var end = sidebar.frame
        if after == .collapsed {
            end = Geometry.flip(logicalAXRect(for: .collapsed))
        } else {
            end.size.width = 1
        }
        animateSidebar(to: end, duration: 0.10, timing: .easeIn) { [weak self] in
            guard let self = self else { return }
            if self.state == .hidden {
                self.sidebar.orderOut(nil)
            } else {
                self.layout()
            }
            self.pushHostState()
        }
    }

    private func animateSidebar(to target: NSRect, duration: TimeInterval, timing: CAMediaTimingFunctionName, completion: @escaping @MainActor () -> Void) {
        animating = true
        animToken += 1
        let token = animToken
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = duration
            ctx.timingFunction = CAMediaTimingFunction(name: timing)
            self.sidebar.animator().setFrame(target, display: true)
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self = self, self.animToken == token else { return }
                self.animating = false
                completion()
            }
        })
    }

    // MARK: Resizing

    private func beginResize() {
        resizing = true
        resizeStartWidth = sidebar.container.frame.width
        resizeSplitterStart = nil
        if state == .pinned && !isFloating(state), let sp = rail?.splitter {
            resizeSplitterStart = AX.point(sp, AXName.position)
        }
    }

    private func liveResize(to proposed: CGFloat) {
        let s = state
        if isFloating(s) {
            let w = min(max(proposed, Settings.minWidth), Settings.maxWidth)
            guard abs(w - peekWidth) >= 1 else { return }
            peekWidth = w
            layout()
        } else if s == .pinned, let sp = rail?.splitter, let start = resizeSplitterStart {
            // Drag Chrome's own rail splitter, if it lets us.
            let delta = proposed - resizeStartWidth
            if !AX.setPosition(sp, CGPoint(x: start.x + delta, y: start.y)) {
                Log.write("rail[window \(key)]: cannot move the rail splitter")
            }
            refreshRailFrame()
        }
    }

    private func refreshRailFrame() {
        guard let r = rail, let f = AX.frame(r.railElement) else { return }
        rail?.rel = CGRect(x: f.minX - window.frame.minX, y: f.minY - window.frame.minY, width: f.width, height: f.height)
        layout()
    }

    // MARK: Pointer / hover

    private func pointerInsideSidebar(_ p: NSPoint) -> Bool {
        currentLogicalNS().insetBy(dx: -2, dy: -2).contains(p) || (topBar.isVisible && topBar.frame.contains(p))
    }

    /// The pointer is over our visible strip and nothing of another app is on top of it.
    private func overStrip(_ p: NSPoint) -> Bool {
        guard sidebar.isVisible, sidebar.frame.contains(p) else { return false }
        return NSWindow.windowNumber(at: p, belowWindowWithWindowNumber: 0) == sidebar.windowNumber
    }

    func pointerMoved(_ p: NSPoint, chromeFrontmost f: Bool) {
        chromeFrontmost = f
        guard visible else { return }
        if window.fullscreen { watchReveal(pointerAXY: Geometry.primaryHeight - p.y) }
        switch state {
        case .hidden:
            if f && edgeZoneNS.contains(p) { scheduleDwell() } else { dwell.cancel() }
        case .collapsed:
            if overStrip(p) { scheduleDwell() } else { dwell.cancel() }
        case .peek:
            if pointerInsideSidebar(p) || resizing {
                hideTimer.cancel()
            } else {
                scheduleHideIfOutside()
            }
        case .pinned:
            break
        }
    }

    // MARK: Full-screen toolbar reveal

    /// Chrome slides its toolbar down over the page when the pointer nears the top of a full-screen window. Watch it
    /// while the pointer is up there (and while it is out) so the sidebar starts below it.
    /// Full screen only: the top edge moves with Chrome's toolbar there, so the strip it uncovers must never be clear.
    private func syncSidebarFill(fullscreen: Bool? = nil) {
        sidebar.fill = (fullscreen ?? window.fullscreen) ? (themeBg ?? chromeColor.flatMap { ColorParse.parse($0) }) : nil
    }

    private func watchReveal(pointerAXY y: CGFloat) {
        let rel = y - window.frame.minY
        let was = revealPointerY
        revealPointerY = rel
        guard rel < 160 || revealInset > 0 else { return }
        // Measured (pointer + frames): AppKit starts hiding the toolbar 23–43 ms after the pointer leaves it, every
        // time, and our move takes ~10–15 ms to reach the screen. So start ahead the moment it leaves, unless the
        // address bar has focus (then it stays out). Back into the toolbar: cancel.
        let bottom = revealWinFull
        if bottom > 0, revealWinID != 0 {
            if was <= bottom, rel > bottom {
                if toolbarHoldsFocus {
                    // Address bar focused: Chrome may still hide the toolbar (40–130 ms later) but animates it itself,
                    // and the reveal window doesn't move until it's gone. Never jump over the address bar for it (it
                    // may well stay out, with its suggestions open): follow AX's toolbar frame for a while instead.
                    revealAXWatchUntil = CACurrentMediaTime() + 0.6
                    revealAXLast = -1
                } else {
                    preSlideOut(for: 0.12, lead: Self.preSlideLead)
                }
            } else if rel <= bottom, revealPreSlideUntil > 0 || revealAXWatchUntil > 0 {
                revealPreSlideUntil = 0
                revealAXWatchUntil = 0
            }
        }
        startRevealWatch()
    }

    /// Manager: Chrome's keyboard focus moved; in full screen that may slide the toolbar in or out.
    func chromeFocusChanged() {
        guard visible, window.fullscreen || isFocusedChromeWindow else { return }
        let was = toolbarHoldsFocus
        toolbarHoldsFocus = toolbarHasFocus()
        if was != toolbarHoldsFocus { Log.write("window \(key): address bar focus \(toolbarHoldsFocus ? "in" : "out")") }
        // Typing in the address bar opens its suggestions with no further focus change: watch while it has focus.
        if toolbarHoldsFocus || omniboxPopupID != 0 { checkOmniboxPopup() }
        guard window.fullscreen else { return }
        // Focus left the address bar with the pointer below the toolbar (Esc, Enter, a click in the page): it hides.
        if was, !toolbarHoldsFocus, revealWinFull > 0, revealPointerY > revealWinFull {
            preSlideOut(for: 0.2, lead: Self.preSlideLead)
        }
        startRevealWatch()
    }

    /// Chrome's focused element is in its toolbar (the address bar).
    private func toolbarHasFocus() -> Bool {
        let app = AXUIElementCreateApplication(AX.pid(window.element))
        guard let el = AX.element(app, "AXFocusedUIElement"), let f = AX.frame(el) else { return false }
        let edge = window.frame.minY + (window.fullscreen ? (revealFull ?? 120) : max(contentTopRel ?? 120, 60))
        return f.height < 80 && f.maxY <= edge + 1 && f.minY >= window.frame.minY - 1
    }

    /// The address bar's suggestions are a separate Chrome window over the sidebar's top. macOS won't order the
    /// sidebar under it in full screen (tried: below it, and directly above Chrome's window), so while it's open
    /// the sidebar has a transparent, click-through hole exactly where it is.
    private func checkOmniboxPopup() {
        popupCheck.cancel()
        let (found, bounds) = findOmniboxPopup()
        if found != omniboxPopupID {
            Log.write("window \(key): address bar suggestions \(found != 0 ? "open (\(found))" : "closed")")
        }
        if found != omniboxPopupID || bounds != omniboxPopupBounds {
            omniboxPopupID = found
            omniboxPopupBounds = bounds
            syncSidebarHole()
        }
        guard visible, toolbarHoldsFocus || omniboxPopupID != 0 else { return }
        // Display rate while open: the list grows as suggestions arrive.
        popupCheck.schedule(after: omniboxPopupID != 0 ? 1.0 / 60 : 0.05) { [weak self] in self?.checkOmniboxPopup() }
    }

    private func syncSidebarHole() {
        guard omniboxPopupID != 0, omniboxPopupBounds.width > 0 else { sidebar.setHole(nil); return }
        let ns = Geometry.flip(omniboxPopupBounds)
        let f = sidebar.frame
        sidebar.setHole(NSRect(x: ns.minX - f.minX, y: ns.minY - f.minY, width: ns.width, height: ns.height))
    }

    private func findOmniboxPopup() -> (CGWindowID, CGRect) {
        let pid = AX.pid(window.element)
        let f = window.frame
        let edge = f.minY + (window.fullscreen ? (revealFull ?? 120) : (contentTopRel ?? 120))
        let infos = CGInfo.onScreenWindowInfo()
        let known = knownChromeWindowIDs?() ?? []
        for info in infos {
            guard let owner = info["kCGWindowOwnerPID"] as? NSNumber, owner.int32Value == pid,
                  let n = info["kCGWindowNumber"] as? NSNumber,
                  let d = info["kCGWindowBounds"] as? NSDictionary,
                  let b = CGRect(dictionaryRepresentation: d as CFDictionary) else { continue }
            let id = CGWindowID(n.uint32Value)
            // All profiles share Chrome's process, so another real window (e.g. the Stile Settings popup of a
            // different profile) can pass the geometry test below, be taken for the suggestions list and hole the sidebar.
            if id == window.cgID || id == revealWinID || known.contains(id) { continue }
            // Measured: the suggestions window starts over the address bar itself (e.g. 99,24 1213×89 growing to
            // ×538 with the toolbar edge at 118) and reaches below the toolbar; Chrome's own full-width windows don't.
            if b.minX > f.minX + 40, b.minX < f.minX + 600, b.width > 200, b.width < f.width - 40,
               b.minY < edge, b.maxY > edge + 8, b.height < f.height - 100 {
                return (id, b)
            }
        }
        return (0, .zero)
    }

    /// The toolbar is about to slide up (see watchReveal): lead it from now, while it is still fully out, so Chrome's
    /// first step (3–10 pt in one frame, which polling can't see coming) never uncovers its rail. If no slide starts
    /// within `duration`, the sidebar returns to the toolbar's edge.
    private func preSlideOut(for duration: CFTimeInterval, lead: CGFloat) {
        guard visible, window.fullscreen, !dockedToolbar, let full = revealFull, revealInset >= full - 0.5 else { return }
        revealPreSlideUntil = CACurrentMediaTime() + duration
        revealPreSlideLead = lead
        revealInset = max(0, full - lead)
        revealLaidOut = false
        syncRevealStrip()
        layout(following: true, revealSlide: true)
        startRevealWatch()
    }

    private func startRevealWatch() {
        refreshDockedToolbar()
        if dockedToolbar { return }
        revealWatchUntil = Date().addingTimeInterval(1.0)
        if !revealPoll.isScheduled { pollReveal() }
    }

    /// Chrome's View → "Always Show Toolbar in Full Screen": the toolbar is part of the layout, nothing slides, and
    /// the sidebar simply starts below it. Read from Chrome's menu bar (AX), at most once a second unless forced.
    private func refreshDockedToolbar(force: Bool = false) {
        guard window.fullscreen else {
            dockedToolbar = false
            return
        }
        if !force, Date().timeIntervalSince(dockedCheckedAt) < 1 { return }
        dockedCheckedAt = Date()
        let docked = Self.chromeAlwaysShowsToolbar(pid: AX.pid(window.element)) ?? dockedToolbar
        if !visible {
            // Hidden (e.g. waiting for the tick): just remember it; the rescan on show fits the edge via apply().
            if docked != dockedToolbar {
                Log.write("fullscreen[window \(key)]: toolbar \(docked ? "always shown (docked)" : "auto-hides")")
                dockedToolbar = docked
                revealInset = 0
            }
            return
        }
        let edge = docked ? toolbarEdgeInset() : 0
        guard docked != dockedToolbar || (docked && abs(edge - revealInset) >= 0.5) else { return }
        if docked != dockedToolbar {
            Log.write("fullscreen[window \(key)]: toolbar \(docked ? "always shown (docked)" : "auto-hides")")
        }
        dockedToolbar = docked
        revealPoll.cancel()
        holdRevealLatency(false)
        revealPreSlideUntil = 0
        revealAXWatchUntil = 0
        revealInset = edge
        revealLaidOut = true
        syncRevealStrip()
        layout()
    }

    /// The tick on Chrome's View → "Always Show Toolbar in Full Screen" (English menu title), nil when not found.
    private static func chromeAlwaysShowsToolbar(pid: pid_t) -> Bool? {
        let app = AXUIElementCreateApplication(pid)
        guard let bar = AX.element(app, "AXMenuBar"), let menus = AX.children(bar) else { return nil }
        for m in menus {
            guard let t = AX.string(m, "AXTitle"), t == "View",
                  let menu = AX.children(m)?.first, let items = AX.children(menu) else { continue }
            for item in items {
                guard let title = AX.string(item, "AXTitle"), title.localizedCaseInsensitiveContains("Toolbar in Full Screen")
                else { continue }
                let mark = AX.string(item, "AXMenuItemMarkChar") ?? ""
                return !mark.isEmpty
            }
        }
        return nil
    }

    private func pollReveal() {
        revealPoll.clear()
        guard visible, window.fullscreen else {
            holdRevealLatency(false)
            if revealInset != 0 { revealInset = 0; layout() }
            return
        }
        if dockedToolbar {
            holdRevealLatency(false)
            return
        }
        var target: CGFloat
        if let b = revealWindowBottom() {
            // Measured frame by frame: Chrome's toolbar edge tracks the reveal window's
            // bottom linearly, within ~2 pt, both ways. So follow the window directly, offset so that fully out lands
            // exactly on the toolbar's edge. AX (a slow round trip to Chrome) is only asked once, when fully out.
            let now = CACurrentMediaTime()
            revealWinFull = max(revealWinFull, b)
            revealWinRest = min(revealWinRest, b)
            let hidden = b <= revealWinRest + 0.5
            if abs(b - revealLastW) >= 0.5 {
                let dt = max(now - revealLastMove, 1.0 / 240)
                revealSpeed = dt < 0.1 ? abs(b - revealLastW) / CGFloat(dt) : 0
                revealDir = b > revealLastW ? 1 : -1
                revealPreSlideUntil = 0
                revealAXWatchUntil = 0
                revealAXLast = -1
                revealLastW = b
                revealLastMove = now
            } else if now - revealLastMove > 0.06 {
                revealSpeed = 0
            }
            // Fully out and settled (not just the highest bottom seen so far, when found mid-slide): ask AX for the edge.
            let out = !hidden && b >= revealWinFull - 0.5 && now - revealLastMove > 0.05
            if out, revealFull == nil {
                let e = toolbarEdgeInset()
                if e > 0 {
                    revealFull = e
                    Log.write("fullscreen[window \(key)]: toolbar edge +\(Int(e)), reveal window bottom +\(Int(b))")
                }
            }
            if hidden { revealColorSampled = false }
            // Only with the pointer in the toolbar: once it has left, Chrome may already be sliding the toolbar away
            // itself (address bar focused) while the reveal window still reads fully out.
            if out, !revealColorSampled, revealPointerY <= b, revealPreSlideUntil == 0 {
                revealColorSampled = true
                sampleRevealToolbarColor()
            }
            let full = revealFull ?? revealWinFull
            let edge = min(max(0, b - (revealWinFull - full)), full)
            if hidden {
                // Chrome shows the toolbar itself for ⌘L / address-bar focus: the reveal window stays hidden, but
                // AX's toolbar frame is out (and moves with Chrome's own slide; measured). Follow it: behind it on the
                // way down (overlap), ahead of it on the way up.
                let ax = toolbarEdgeInset()
                if ax <= 0 {
                    target = 0
                } else if revealAXHidden >= 0, ax < revealAXHidden - 0.5 {
                    target = min(revealInset, max(0, ax - 20))
                } else {
                    target = ax
                }
                if ax != revealAXHidden {
                    if (ax > 0) != (revealAXHidden > 0) {
                        Log.write("fullscreen[window \(key)]: toolbar \(ax > 0 ? "shown" : "hidden") by Chrome (reveal window at rest), +\(Int(ax))")
                    }
                    revealAXHidden = ax
                    revealAXHiddenMoved = now
                }
            } else if (out || edge >= full - 0.5), now < revealAXWatchUntil {
                // Reveal window fully out, but Chrome may be animating the toolbar itself: AX's frame is all there is.
                // Measured: AX moves in step with the drawn toolbar here, but sits ~38 pt off (80 → 48 while the drawn
                // edge goes 118 → 86, then the reveal window drops to hidden). So use its movement from where it
                // started, not its value.
                let ax = toolbarEdgeInset()
                if revealAXLast < 0 { revealAXRest = ax }
                if ax != revealAXLast {
                    Log.write(String(format: "fullscreen[window \(key)]: ax edge t=%.4f +%.1f", now, ax))
                    revealAXLast = ax
                }
                let moved = revealAXRest - ax
                if ax <= 0 {
                    target = 0
                } else if moved >= 1 {
                    target = min(revealInset, max(0, full - moved - max(20, Self.preSlideLead)))
                } else {
                    target = full
                }
            } else if out || edge >= full - 0.5 {
                // Still fully out: a predicted slide up keeps the lead it took; otherwise sit on the edge.
                target = now < revealPreSlideUntil ? min(revealInset, max(0, full - revealPreSlideLead)) : full
            } else if revealDir < 0 {
                // Sliding up: the toolbar (drawn in Chrome's own window, with its rail) moves on before our frame lands
                // (poll + window server + display: up to ~3 frames), so stay ahead by what it covers in ~50 ms. Never
                // move back down while it slides up: that bounce is what showed the rail.
                // The first step of a slide has no speed yet and may still carry the one resize from rest: lead more.
                let lead = revealSpeed > 0 ? max(20, revealSpeed * 0.05) : 32
                target = min(revealInset, max(0, edge - lead))
            } else {
                // Sliding down: our frame lands after the toolbar has moved on, so we overlap its bottom (never a gap);
                // 2 pt short covers the window running slightly ahead of the drawn toolbar early in the slide.
                target = max(0, edge - 2)
            }
        } else {
            target = toolbarEdgeInset()
        }
        if abs(target - revealInset) >= 0.5 {
            revealInset = target
            revealLaidOut = false
            syncRevealStrip()
            layout(following: true, revealSlide: true)
        } else if !revealLaidOut, CACurrentMediaTime() >= revealPreSlideUntil {
            // Not while a predicted slide is pending: the full layout refits the web view (WebKit, ms) right when the
            // slide is about to start.
            revealLaidOut = true
            syncRevealStrip()
            layout()
        }
        // Display rate (120 Hz on ProMotion) while watching, while it is out (a slide back up lasts ~140 ms) and until
        // laid out: at 60 Hz the panel trails a 120 Hz slide by a frame more.
        guard Date() < revealWatchUntil || revealInset > 0 || !revealLaidOut else {
            holdRevealLatency(false)
            return
        }
        holdRevealLatency(true)
        // Out and at rest, waiting for a slide up: poll at 240 Hz, so our first move makes the next display frame.
        let display = max(60, sidebar.screen?.maximumFramesPerSecond ?? 60)
        let axDriven = revealAXHidden > 0
        // AX-driven and still for a while (⌘L, typing): 20 Hz is enough; Esc / focus changes poll at once anyway.
        let axIdle = axDriven && CACurrentMediaTime() - revealAXHiddenMoved > 0.3
        let fps = axIdle ? 20 : (revealInset > 0 && revealLaidOut && !axDriven ? 240 : display)
        revealPoll.schedule(after: 1.0 / Double(fps)) { [weak self] in self?.pollReveal() }
    }

    /// The strip shows only while the sidebar's top is below Chrome's rail top by its height, i.e. over the toolbar;
    /// near the top of the screen it would paint over the (black) menu bar.
    private func syncRevealStrip() {
        let railTop = rail?.rel.minY ?? 0
        sidebar.setTopStrip(!dockedToolbar && revealInset - Self.revealStrip >= railTop ? revealToolbarColor : nil)
    }

    /// Chrome's toolbar padding just above its bottom edge (window-only capture: our panel isn't in it).
    private func sampleRevealToolbarColor() {
        guard window.cgID != 0, Permissions.screenCaptureGranted else { return }
        let w = window.frame
        let edge = revealFull ?? revealInset
        guard edge > Self.revealStrip else { return }
        let y = w.minY + edge - Self.revealStrip + 1
        let left = CGRect(x: w.minX + 20, y: y, width: 100, height: Self.revealStrip - 3)
        // The toolbar's padding runs the full width; the rail only sits under its left end. Both must agree, or the
        // toolbar wasn't where we thought (mid-slide) and the sample would paint the strip in the rail's colours.
        let right = CGRect(x: w.maxX - 160, y: y, width: 100, height: Self.revealStrip - 3)
        guard let l = ChromeColor.sample(windowID: window.cgID, rect: left),
              let r = ChromeColor.sample(windowID: window.cgID, rect: right),
              l.lowercased() == r.lowercased(), let c = ColorParse.parse(l) else { return }
        revealToolbarColor = c
        syncRevealStrip()
    }

    /// The toolbar's bottom edge below the window top from AX: 0 while hidden, its full height once out (nothing in
    /// between). +1: its 1 pt bottom separator is drawn just below the reported frame.
    private func toolbarEdgeInset() -> CGFloat {
        guard let el = revealEdge(), let f = AX.frame(el) else { return 0 }
        return min(max(0, f.maxY + 1 - window.frame.minY), 200)
    }

    /// The reveal window's bottom below the window top, or nil when it cannot be found.
    private func revealWindowBottom() -> CGFloat? {
        if revealWinID == 0 {
            guard let found = findRevealWindow() else { return nil }
            revealWinID = found.id
            let b = found.bounds.maxY - window.frame.minY
            // Found mid-reveal: its rest bottom isn't known yet; the lowest bottom seen takes over once it hides.
            revealWinRest = toolbarEdgeInset() > 0 ? 0 : b
            revealWinFull = 0
            revealLastW = b
            revealLastMove = 0
            revealSpeed = 0
            revealDir = 0
            Log.write("fullscreen[window \(key)]: reveal window \(found.id) bottom +\(Int(b))")
        }
        guard let b = CGInfo.boundsMap(ids: [revealWinID])[revealWinID] else {
            revealWinID = 0
            return nil
        }
        return min(max(0, b.maxY - window.frame.minY), 300)
    }

    /// Chrome-owned, above normal level, spanning the window's width from the top of the screen.
    private func findRevealWindow() -> (id: CGWindowID, bounds: CGRect)? {
        let pid = AX.pid(window.element)
        let f = window.frame
        for info in CGInfo.onScreenWindowInfo() {
            guard let owner = info["kCGWindowOwnerPID"] as? NSNumber, owner.int32Value == pid,
                  let layer = info["kCGWindowLayer"] as? NSNumber, layer.intValue > 0,
                  let n = info["kCGWindowNumber"] as? NSNumber,
                  let d = info["kCGWindowBounds"] as? NSDictionary,
                  let b = CGRect(dictionaryRepresentation: d as CFDictionary) else { continue }
            if abs(b.minX - f.minX) <= 1, abs(b.width - f.width) <= 1, b.minY <= f.minY + 1, b.height < 300 {
                return (CGWindowID(n.uint32Value), b)
            }
        }
        return nil
    }

    /// The toolbar's visible bottom edge: Chrome's AXToolbar stops a few points short of it, so prefer a parent
    /// that is as wide and ends a little lower.
    private func revealEdge() -> AXUIElement? {
        if let e = revealEdgeEl { return e }
        guard let el = toolbarEl, let f = AX.frame(el) else { return nil }
        var edge = el
        if let p = AX.element(el, "AXParent"), let pf = AX.frame(p),
           pf.maxY > f.maxY, pf.maxY - f.maxY <= 12, pf.width >= f.width - 1 {
            edge = p
        }
        revealEdgeEl = edge
        return edge
    }

    private func scheduleDwell() {
        if dwell.isScheduled { return }
        if buttonHeldElsewhere { return }
        dwell.schedule(after: 0.05) { [weak self] in
            self?.dwell.clear()
            self?.dwellFired()
        }
    }

    /// A mouse button is down and the press did not start in our own sidebar (something is being dragged in Chrome).
    private var buttonHeldElsewhere: Bool {
        if NSEvent.pressedMouseButtons == 0 {
            sidebar.pressedHere = false
            return false
        }
        return !sidebar.pressedHere
    }

    /// NSTrackingArea enter/exit on the panel's content view.
    private func pointerEntered() {
        guard visible else { return }
        switch state {
        case .collapsed: scheduleDwell()
        case .peek: hideTimer.cancel()
        default: break
        }
    }

    private func pointerExited() {
        guard visible else { return }
        switch state {
        case .collapsed: dwell.cancel()
        case .peek: scheduleHideIfOutside()
        default: break
        }
    }

    private func dwellFired() {
        guard visible, !buttonHeldElsewhere else { return }
        let p = NSEvent.mouseLocation
        switch state {
        case .hidden:
            if chromeFrontmost && edgeZoneNS.contains(p) { showPeek() }
        case .collapsed:
            if overStrip(p) { showPeek() }
        default:
            break
        }
    }

    private func scheduleHideIfOutside() {
        guard state == .peek, !busy, !hideTimer.isScheduled else { return }
        if pointerInsideSidebar(NSEvent.mouseLocation) { return }
        hideTimer.schedule(after: 0.15) { [weak self] in
            self?.hideTimer.clear()
            self?.evaluatePeekHide()
        }
    }

    private func evaluatePeekHide() {
        guard state == .peek else { return }
        if busy || resizing || pointerInsideSidebar(NSEvent.mouseLocation) { return }
        hidePeek()
    }

    // MARK: Host messages from the web UI

    private func boolValue(_ v: Any?) -> Bool {
        (v as? Bool) ?? ((v as? NSNumber)?.boolValue ?? false)
    }

    private func handleHost(_ action: String, _ value: Any?) {
        switch action {
        case "ready", "pageLoaded":
            pushHostState(force: true)
        case "setPinned":
            setPinned(boolValue(value))
        case "beginWindowDrag":
            // v3.0: mousedown on empty sidebar space. {clientX, clientY, clickCount|detail} (all optional).
            let d = value as? [String: Any]
            let clicks = JSONUtil.int(d?["clickCount"]) ?? JSONUtil.int(d?["detail"]) ?? 1
            onWindowDrag?(key, clicks >= 2 || boolValue(d?["doubleClick"]))
        case "windowDoubleClick":
            onWindowDrag?(key, true)
        case "reviewPermissions":
            NotificationCenter.default.post(name: .sidebarReviewPermissions, object: nil)
        case "setUpChrome":
            NotificationCenter.default.post(name: .sidebarSetUpChrome, object: nil)
        case "setPeekWidth":
            if let d = JSONUtil.double(value) { Settings.peekWidth = CGFloat(d) }   // posts; the manager calls settingsChanged
        case "quitApp":
            FileManager.default.createFile(atPath: HostPaths.quitFlagPath, contents: nil)
            NSApp.terminate(nil)
        case "setLaunchAtLogin":
            LoginItem.set(boolValue(value))
            Settings.post()
        case "openAccessibilitySettings":
            Permissions.openSettings()
        case "rescanRail":
            forceRescan()
        case "requestScreenCapture":
            startCaptureRequest()
        case "pickScreenColor":
            pickScreenColor()
        case "openExtensions":
            if let dir = value as? String, !dir.isEmpty { HostActions.openExtensionsPage(profileDir: dir) }
        case "openStore":
            if let dir = value as? String, !dir.isEmpty { HostActions.openStorePage(profileDir: dir) }
        case "revealExtension":
            HostActions.revealExtensionFolder()
        case "contextMenu":
            showContextMenu(value)
        case "editing":
            sidebar.isEditing = boolValue(value)
        case "theme":
            if let d = value as? [String: Any] {
                themeDark = boolValue(d["dark"])
                if let bg = d["bg"] as? String, let c = ColorParse.parse(bg) { themeBg = c }
                syncTopBarLook()
                syncSidebarFill()
            }
        case "greenButtonNoteSeen":
            Settings.greenButtonNotePending = false
            pushHostState()
        case "dragDownload":
            beginDownloadDrag(value)
        case "busy":
            if downloadDragSource != nil { break }   // the native file drag keeps the panel busy until it ends
            busy = boolValue(value)
            if busy { hideTimer.cancel() } else { scheduleHideIfOutside() }
        default:
            break   // theme, activeTitle: nothing to do now that the app draws no chrome of its own
        }
    }

    // MARK: Screen color picker

    /// The capture menu's "Pick color from screen…": macOS's own loupe (no Screen Recording permission). The hex goes to
    /// the pasteboard and back to the page (window.__sidebarColorPicked(hex | null)); the panel stays out while it runs.
    private func pickScreenColor() {
        busy = true
        hideTimer.cancel()
        NSColorSampler().show { [weak self] color in
            guard let self else { return }
            MainActor.assumeIsolated {
                var arg = "null"
                if let c = color?.usingColorSpace(.sRGB) {
                    let v = { (x: CGFloat) in Int((min(1, max(0, x)) * 255).rounded()) }
                    let hex = String(format: "#%02x%02x%02x", v(c.redComponent), v(c.greenComponent), v(c.blueComponent))
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(hex, forType: .string)
                    arg = JSONUtil.stringLiteral(hex)
                }
                self.sidebar.webView.evaluateJavaScript("window.__sidebarColorPicked && window.__sidebarColorPicked(\(arg))", completionHandler: nil)
                self.busy = false
                self.scheduleHideIfOutside()
            }
        }
    }

    // MARK: Dragging a finished download out (v3.2)

    /// Keeps the drag source alive while a session runs; nil when no download drag is active.
    private var downloadDragSource: DownloadDragSource?

    /// `dragDownload {path, clientX, clientY}` from the downloads popover: starts a native file drag (the page cancelled
    /// its own web drag, which cannot leave the panel). Only existing regular files are offered.
    private func beginDownloadDrag(_ value: Any?) {
        guard downloadDragSource == nil, let d = value as? [String: Any], let path = d["path"] as? String,
              path.hasPrefix("/") else { return }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else {
            Log.write("dragDownload: not a file: \(path)")
            return
        }
        let web = sidebar.webView
        let x = CGFloat(JSONUtil.double(d["clientX"]) ?? 24)
        let y = CGFloat(JSONUtil.double(d["clientY"]) ?? 24)
        let local = NSPoint(x: x, y: web.isFlipped ? y : web.bounds.height - y)
        let inWindow = web.convert(local, to: nil)
        var event = NSApp.currentEvent
        if event == nil || ![.leftMouseDown, .leftMouseDragged].contains(event!.type) || event!.window !== sidebar {
            event = NSEvent.mouseEvent(with: .leftMouseDragged, location: inWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: sidebar.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        }
        guard let ev = event else { return }
        let url = URL(fileURLWithPath: path)
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        let icon = NSWorkspace.shared.icon(forFile: path)
        icon.size = NSSize(width: 48, height: 48)
        item.setDraggingFrame(NSRect(x: local.x - 24, y: local.y - 24, width: 48, height: 48), contents: icon)
        let source = DownloadDragSource { [weak self] in
            guard let self = self else { return }
            self.downloadDragSource = nil
            self.busy = false
            self.scheduleHideIfOutside()
        }
        downloadDragSource = source
        busy = true
        hideTimer.cancel()
        web.beginDraggingSession(with: [item], event: ev, source: source)
        Log.write("dragDownload: started for \(url.lastPathComponent)")
    }

    // MARK: Native context menus

    private func buildMenu(_ items: [[String: Any]], target: MenuPicker) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for d in items {
            if boolValue(d["separator"]) { menu.addItem(NSMenuItem.separator()); continue }
            let label = (d["label"] as? String) ?? ""
            let enabled = d["enabled"] == nil ? true : boolValue(d["enabled"])
            if boolValue(d["header"]) {
                let h = NSMenuItem(title: label, action: nil, keyEquivalent: "")
                h.isEnabled = false
                menu.addItem(h)
                continue
            }
            if let sub = d["submenu"] as? [[String: Any]] {
                let it = NSMenuItem(title: label, action: nil, keyEquivalent: "")
                it.isEnabled = enabled
                it.submenu = buildMenu(sub, target: target)
                menu.addItem(it)
                continue
            }
            let it = NSMenuItem(title: label, action: #selector(MenuPicker.pick(_:)), keyEquivalent: "")
            it.target = target
            it.isEnabled = enabled
            it.state = boolValue(d["checked"]) ? .on : .off
            it.representedObject = d["id"] as? String
            menu.addItem(it)
        }
        return menu
    }

    private func showContextMenu(_ value: Any?) {
        guard let dict = value as? [String: Any],
              let items = dict["items"] as? [[String: Any]], !items.isEmpty else {
            sidebar.webView.evaluateJavaScript("window.__sidebarMenuResult && window.__sidebarMenuResult(null)", completionHandler: nil)
            return
        }
        let x = JSONUtil.double(dict["x"]) ?? 0
        let y = JSONUtil.double(dict["y"]) ?? 0
        let web = sidebar.webView
        let py = web.isFlipped ? CGFloat(y) : web.bounds.height - CGFloat(y)
        let point = NSPoint(x: CGFloat(x), y: py)
        let picker = MenuPicker()
        let menu = buildMenu(items, target: picker)
        busy = true
        hideTimer.cancel()
        menu.popUp(positioning: nil, at: point, in: web)   // synchronous: returns once the menu closes
        busy = false
        let arg: String
        if let id = picker.chosenId {
            arg = JSONUtil.stringLiteral(id)
        } else {
            arg = "null"
        }
        web.evaluateJavaScript("window.__sidebarMenuResult && window.__sidebarMenuResult(\(arg))", completionHandler: nil)
        scheduleHideIfOutside()
    }

    func pushHostState(force: Bool = false) {
        if Settings.greenButtonNotePending, window.visible, sidebar.isVisible, !noteTimer.isScheduled {
            // One-time note: shown to the page now, cleared after 12 s (or when the page reports it was seen).
            noteTimer.schedule(after: 12) { [weak self] in
                self?.noteTimer.clear()
                Settings.greenButtonNotePending = false
                self?.pushHostState()
            }
        }
        sidebar.sendHostState(hostStateObject(), force: force)
        onHostStatePushed?()
    }

    /// The host state object sent to the page (`__sidebarHostState`) and, plus app-wide fields, to the extension
    /// as `appState` (see OverlayManager).
    func hostStateObject() -> [String: Any] {
        let s = state
        noteRailWidths()
        var obj: [String: Any] = [
            "state": s.hostName,
            "pinned": s == .pinned,
            "railFound": rail != nil,
            "railControllable": railControllable,
            "launchAtLogin": LoginItem.enabled,
            "accessibility": Permissions.isTrusted,
            "appVersion": AppInfo.version,
            "peekWidth": Int(peekWidth),
            "screenCapture": Permissions.screenCaptureGranted,
            "compact": s == .collapsed || s == .hidden,
            "railWidth": Int(lastCollapsedRailWidth.rounded()),
            "overlayEnabled": overlayEnabled,
            "showMenuBarIcon": Settings.showMenuBarIcon,
            "topBar": topBarOn,
            "topBarToggle": topBarOn && topBarToggle,
            "greenButtonAction": Settings.greenButtonAction,
            "greenButtonNote": Settings.greenButtonNotePending,
        ]
        if let c = chromeColor { obj["chromeColor"] = c } else { obj["chromeColor"] = NSNull() }
        return obj
    }

    // MARK: Page calls

    /// Time of the last mouse-down inside this window's sidebar panel.
    private var lastPanelClick: Date = .distantPast

    private func pageCalled(_ call: String) {
        // Only right after the user clicked in THIS sidebar: the page re-renders (and queries tabs/windows)
        // constantly in the background, and raising Chrome's window on those made windows of different
        // profiles fight over focus.
        guard Date().timeIntervalSince(lastPanelClick) < 0.8 else { return }
        if call == "sidebar.cmd" || call == "tabs.update" || call == "windows.update" || call == "tabs.create" {
            reassertChrome()
        }
    }

    /// Mouse-down on this window's sidebar or header: make it Chrome's focused window. Runs before the
    /// click is handled, so anything the click opens (the settings window, a new window) stays on top.
    private func raiseWindowForClick() {
        let pid = AX.pid(window.element)
        guard pid > 0 else { return }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        if front && isFocusedChromeWindow { return }
        AX.setBool(window.element, AXName.main, true)
        AX.perform(window.element, AXName.actionRaise)
    }

    /// After a click on the overlay: bring Chrome forward if it is not already. Never re-raises a window
    /// (the click may have focused another Chrome window, e.g. settings), and stays out of the way while a
    /// native menu is open or when the click opened one of Stile's own windows.
    private func activateChromeAfterClick() {
        guard !busy, !NSApp.isActive else { return }
        let pid = AX.pid(window.element)
        guard pid > 0, NSWorkspace.shared.frontmostApplication?.processIdentifier != pid,
              let app = NSRunningApplication(processIdentifier: pid) else { return }
        Log.write("focus: activating Chrome after a click on the overlay")
        app.activate()
    }

    /// If Chrome is no longer frontmost after the page activated something, raise its window again.
    private func reassertChrome() {
        let pid = AX.pid(window.element)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
            Log.write("focus: raising Chrome window after a sidebar click")
            AX.perform(window.element, AXName.actionRaise)
        }
    }
}

/// Drag source for a download dragged out of the sidebar: copy only, reports the end of the session.
final class DownloadDragSource: NSObject, NSDraggingSource {
    private let onEnd: () -> Void
    init(onEnd: @escaping () -> Void) { self.onEnd = onEnd }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        DispatchQueue.main.async { [onEnd] in onEnd() }
    }
}

/// Target for native context-menu items: remembers which item id was chosen.
final class MenuPicker: NSObject {
    var chosenId: String?
    @objc func pick(_ sender: NSMenuItem) {
        chosenId = sender.representedObject as? String
    }
}

