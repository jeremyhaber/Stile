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

    private var visible = false
    private var chromeFrontmost = false
    private var busy = false
    private var animating = false
    private var animToken = 0
    private var resizing = false
    private var resizeStartWidth: CGFloat = 0
    private var resizeSplitterStart: CGPoint?

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

    private let dwell = OneShot()
    private let hideTimer = OneShot()
    private let rescanTimer = OneShot()
    private let pressTimer = OneShot()

    /// Tell the manager that a geometry change was made locally (so it runs the follow timer).
    var onLocalGeometryChange: (() -> Void)?

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
        sidebar.onNonEditingClick = { [weak self] in
            guard let self = self else { return }
            AX.setBool(self.window.element, AXName.main, true)
        }
        sidebar.onBridgeCall = { [weak self] call in self?.pageCalled(call) }
        sidebar.onDidBecomeKey = { [weak self] in self?.reorderSidebar() }
        sidebar.onResizeBegan = { [weak self] in self?.beginResize() }
        sidebar.onPointerEnter = { [weak self] in self?.pointerEntered() }
        sidebar.onPointerExit = { [weak self] in self?.pointerExited() }
        sidebar.onResize = { [weak self] w in self?.liveResize(to: w) }
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
        captureTimer = nil
        sidebar.teardown()
    }

    func attach(_ mapping: WindowMapper.Mapping?) {
        if let m = mapping, !m.bridge.closed {
            unmappedSince = nil
            if bridge !== m.bridge || chromeWindowId != m.windowId {
                bridge = m.bridge
                chromeWindowId = m.windowId
                sidebar.connect(bridge: m.bridge, windowId: m.windowId)
            }
        } else {
            if bridge != nil || chromeWindowId != nil {
                bridge = nil
                chromeWindowId = nil
                sidebar.showWaiting()
                unmappedSince = Date()
            }
            if unmappedSince == nil { unmappedSince = Date() }
        }
    }

    /// Visible but not matched to an extension window.
    var isUnmapped: Bool { visible && bridge == nil }

    /// True when this window has had no extension for more than 10 s (the manager then asks for the setup card).
    var needsSetupCheck: Bool {
        guard bridge == nil, visible, let since = unmappedSince else { return false }
        return Date().timeIntervalSince(since) > 10
    }

    func applySetup(candidates: [(dir: String, name: String)]) {
        if candidates.isEmpty {
            sidebar.showWaiting()
        } else {
            sidebar.showSetup(candidates: candidates)
        }
    }

    func update(window w: ChromeWindow, chromeFrontmost f: Bool) {
        let wasVisible = visible
        window = w
        chromeFrontmost = f
        visible = w.visible
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
    }

    private func apply(_ scan: RailScan) {
        rail = scan.rail
        contentTopRel = scan.contentTopRel
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
        var rect = CGRect(x: w.minX + r.rel.minX, y: w.minY + r.rel.minY, width: r.rel.width, height: r.rel.height)
        // Never cover Chrome's window buttons, whatever the rail's reported frame says.
        let minTop = w.minY + trafficLightsBottom()
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
        // While Chrome is the active app and this is its focused window, keep the sidebar at floating
        // level: clicking inside Chrome raises Chrome's window without any notification we could react
        // to, so ordering relative to it isn't enough. Other apps' windows can't be above Chrome then.
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

    func layout(following isFollowing: Bool = false) {
        guard visible else { return }
        let s = state
        if s == .hidden {
            if !animating { sidebar.orderOut(nil) }
            return
        }
        if animating { return }
        let ax = logicalAXRect(for: s)
        let ns = Geometry.flip(ax)
        let frame = panelFrame(logical: ns, state: s)
        let shadow: CGFloat = isFloating(s) ? Self.shadowWidth : 0
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
    }

    private func hideAll() {
        dwell.cancel()
        hideTimer.cancel()
        animToken += 1
        animating = false
        peeking = false
        sidebar.orderOut(nil)
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
        drag = DragState(startMouse: topLeft(p), startBounds: serverBounds() ?? window.frame)
    }

    /// Global left mouse drag event: place the panel from the predicted frame right away.
    func dragMoved(mouse p: NSPoint) {
        guard visible, drag != nil else { return }
        advance(mouse: topLeft(p), tick: false, real: nil)
    }

    /// Mouse up: stop predicting and snap to the real bounds.
    func dragEnded() {
        guard drag != nil else { return }
        drag = nil
        lastRealTick = nil
        if visible { followBounds(serverBounds()) }
    }

    /// Display-link frame: `real` is the window-server bounds, `mouse` is in NSEvent (bottom-left) coordinates.
    func followTick(real: CGRect?, mouse: NSPoint) {
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
        if color != chromeColor {
            chromeColor = color
            if push { pushHostState() }
        }
    }

    /// `requestScreenCapture` from the page: ask, then re-check every second for 30 s.
    private func startCaptureRequest() {
        Permissions.requestScreenCapture()
        captureDeadline = Date().addingTimeInterval(30)
        captureTimer?.invalidate()
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
        currentLogicalNS().insetBy(dx: -2, dy: -2).contains(p)
    }

    /// The pointer is over our visible strip and nothing of another app is on top of it.
    private func overStrip(_ p: NSPoint) -> Bool {
        guard sidebar.isVisible, sidebar.frame.contains(p) else { return false }
        return NSWindow.windowNumber(at: p, belowWindowWithWindowNumber: 0) == sidebar.windowNumber
    }

    func pointerMoved(_ p: NSPoint, chromeFrontmost f: Bool) {
        chromeFrontmost = f
        guard visible else { return }
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
        case "openExtensions":
            if let dir = value as? String, !dir.isEmpty { HostActions.openExtensionsPage(profileDir: dir) }
        case "revealExtension":
            HostActions.revealExtensionFolder()
        case "contextMenu":
            showContextMenu(value)
        case "editing":
            sidebar.isEditing = boolValue(value)
        case "busy":
            busy = boolValue(value)
            if busy { hideTimer.cancel() } else { scheduleHideIfOutside() }
        default:
            break   // theme, activeTitle: nothing to do now that the app draws no chrome of its own
        }
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
        ]
        if let c = chromeColor { obj["chromeColor"] = c } else { obj["chromeColor"] = NSNull() }
        sidebar.sendHostState(obj, force: force)
    }

    // MARK: Page calls

    private func pageCalled(_ call: String) {
        if call == "sidebar.cmd" || call.hasPrefix("tabs.") || call.hasPrefix("windows.") {
            reassertChrome()
        }
    }

    /// If Chrome is no longer frontmost after the page activated something, raise its window again.
    private func reassertChrome() {
        let pid = AX.pid(window.element)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
            AX.perform(window.element, AXName.actionRaise)
        }
    }
}

/// Target for native context-menu items: remembers which item id was chosen.
final class MenuPicker: NSObject {
    var chosenId: String?
    @objc func pick(_ sender: NSMenuItem) {
        chosenId = sender.representedObject as? String
    }
}
