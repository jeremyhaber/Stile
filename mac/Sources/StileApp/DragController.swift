import AppKit
import ApplicationServices

/// v2.9 lockstep: takes over Chrome window drags (toolbar's empty area) and edge resizes inside the shared
/// CGEventTap (CloseInterceptor forwards mouse events here). Chrome's window is moved with synchronous AX
/// sets and our panel is moved right after each set, so both come from the same code path.
/// Everything runs on the main thread (the tap is attached to the main run loop).
/// Own event tap, installed only while lockstep is on (or, briefly, for a drag started from our own panel):
/// drag events in a tap wait for our main thread, so they must not be intercepted at all otherwise.
private let dragTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
    let me = Unmanaged<DragController>.fromOpaque(refcon).takeUnretainedValue()
    var swallow = false
    if #available(macOS 14.0, *) {
        swallow = MainActor.assumeIsolated { me.handle(type, event) }
    }
    return swallow ? nil : Unmanaged.passUnretained(event)
}

@MainActor
final class DragController {
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?

    /// Installs or removes the tap to match the setting. Cheap to call often. A panel-initiated session (v3.0)
    /// keeps the tap alive until it ends even when the setting is off; it is removed right after.
    func syncTap() {
        let want = Settings.lockstepDrag && !Self.disabledThisRun && Permissions.isTrusted
        if want {
            _ = installTap()
        } else if tap != nil, session?.fromPanel != true {
            removeTap()
        }
    }

    @discardableResult
    private func installTap() -> Bool {
        if tap != nil { return true }
        let types: [CGEventType] = [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        var mask: CGEventMask = 0
        for t in types { mask |= (CGEventMask(1) << CGEventMask(t.rawValue)) }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                           options: .defaultTap, eventsOfInterest: mask,
                                           callback: dragTapCallback, userInfo: refcon) else {
            Log.write("lockstep: could not create event tap")
            return false
        }
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        tap = port
        tapSource = src
        Log.write("lockstep: event tap installed")
        return true
    }

    private func removeTap() {
        guard let t = tap else { return }
        if session != nil { finish(at: nil, replay: false) }
        CGEvent.tapEnable(tap: t, enable: false)
        if let src = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), src, .commonModes) }
        tap = nil
        tapSource = nil
        Log.write("lockstep: event tap removed")
    }

    /// Value of `.eventSourceUserData` on the click we replay to Chrome, so the tap ignores it.
    nonisolated static let marker: Int64 = 0x5342_4C4B

    private struct Edges {
        var left = false, right = false, top = false, bottom = false
    }

    private enum Gesture {
        case move
        case resize(Edges)
    }

    private struct Session {
        var mismatches = 0
        var failed = false
        let key: Int
        let window: AXUIElement
        let pid: pid_t
        let gesture: Gesture
        let startMouse: CGPoint
        let startFrame: CGRect
        let minSize: CGSize
        let flags: CGEventFlags
        /// Started by `beginWindowDrag` from our own panel (the mouse-down went to the panel, not to Chrome).
        var fromPanel = false
        var latest: CGPoint
        var moved = false
        var resized = false
        var lastFrame: CGRect
    }

    weak var manager: OverlayManager?

    private var session: Session?
    private var applyScheduled = false
    /// Set when Chrome didn't follow a lockstep drag; native dragging is used until the app restarts.
    static var disabledThisRun = false
    private var swallowUp = false

    private static let interactiveRoles: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton", "AXMenuButton",
        "AXRadioButton", "AXCheckBox", "AXTab", "AXLink", "AXSlider", "AXIncrementor", "AXMenuItem",
    ]

    // MARK: Tap entry point

    /// Returns true to swallow the event. Keep it fast: only mouse-downs near Chrome windows do real work.
    func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if session != nil { finish(at: nil, replay: false) }
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            return false
        default:
            break
        }
        if event.getIntegerValueField(.eventSourceUserData) == Self.marker { return false }
        switch type {
        case .leftMouseDown:
            swallowUp = false
            if session != nil { finish(at: nil, replay: false) }   // stale session (missed mouse-up)
            return mouseDown(event)
        case .leftMouseDragged:
            guard var s = session else { return false }
            // Read the HARDWARE button state: we swallowed the mouse-down, so the window server's own state
            // (NSEvent.pressedMouseButtons) thinks the button is up and would end every drag immediately.
            if !CGEventSource.buttonState(.hidSystemState, button: .left) {
                finish(at: event.location, replay: false)
                return false
            }
            s.latest = event.location
            if !s.moved, hypot(s.latest.x - s.startMouse.x, s.latest.y - s.startMouse.y) > 3 { s.moved = true }
            session = s
            if s.moved { scheduleApply() }
            return true
        case .leftMouseUp:
            if swallowUp {
                swallowUp = false
                return true
            }
            guard let s = session else { return false }
            if s.fromPanel {
                // The panel saw the mouse-down, so it must see the mouse-up too; nothing to replay.
                finish(at: event.location, replay: false)
                return false
            }
            finish(at: event.location, replay: true)
            return true
        default:
            return false
        }
    }

    // MARK: Mouse down

    private func mouseDown(_ event: CGEvent) -> Bool {
        guard !Self.disabledThisRun, let m = manager, m.overlayEnabled, Settings.lockstepDrag,
              Permissions.isTrusted, m.tracker.chromeFrontmost, m.tracker.pid != 0,
              let app = m.tracker.appElement else { return false }
        let flags = event.flags
        if !flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty { return false }
        let p = event.location
        let focused = m.tracker.focusedWindowKey()
        var wins = m.tracker.windows.filter { w in
            guard w.visible, let mapping = m.closer.mappingProvider?(w.key) else { return false }
            return !m.closer.isLittle(mapping)
        }
        if wins.isEmpty { return false }
        wins.sort { ($0.key == focused ? 0 : 1) < ($1.key == focused ? 0 : 1) }

        // Edge resize first (its zone overlaps the top of the drag band).
        for w in wins {
            guard let e = edges(at: p, in: w.frame), let c = m.controllers[w.key] else { continue }
            if c.blocksLockstep(at: p) { continue }
            return begin(w, gesture: .resize(e), event: event, focused: focused)
        }

        // Toolbar drag.
        for w in wins where w.frame.contains(p) {
            guard let c = m.controllers[w.key] else { continue }
            let bandBottom = w.frame.minY + c.toolbarBottomRel
            guard p.y < bandBottom else { continue }
            if c.blocksLockstep(at: p) { continue }
            guard isDraggableArea(app: app, window: w.element, at: p) else { continue }
            if event.getIntegerValueField(.mouseEventClickState) >= 2 {
                swallowUp = true
                performTitleBarDoubleClick(w.element)
                Log.write("lockstep: double-click action")
                return true
            }
            return begin(w, gesture: .move, event: event, focused: focused)
        }
        return false
    }

    private func begin(_ w: ChromeWindow, gesture: Gesture, event: CGEvent, focused: Int?) -> Bool {
        startSession(w, gesture: gesture, at: event.location, flags: event.flags, focused: focused, fromPanel: false)
    }

    @discardableResult
    private func startSession(_ w: ChromeWindow, gesture: Gesture, at p: CGPoint, flags: CGEventFlags,
                              focused: Int?, fromPanel: Bool) -> Bool {
        guard let m = manager else { return false }
        let live = AX.frame(w.element) ?? w.frame
        if w.key != focused { AX.perform(w.element, AXName.actionRaise) }
        var minSize = CGSize(width: 500, height: 350)
        if let ms = AX.size(w.element, "AXMinimumSize") {
            minSize = CGSize(width: max(minSize.width, ms.width), height: max(minSize.height, ms.height))
        }
        session = Session(key: w.key, window: w.element, pid: m.tracker.pid, gesture: gesture, startMouse: p,
                          startFrame: live, minSize: minSize, flags: flags, fromPanel: fromPanel, latest: p, lastFrame: live)
        m.tracker.paused = true
        let origin = fromPanel ? " (from sidebar)" : ""
        switch gesture {
        case .move: Log.write("lockstep: move started\(origin)")
        case .resize: Log.write("lockstep: resize started\(origin)")
        }
        return true
    }

    // MARK: Panel-initiated drags (v3.0)

    /// `beginWindowDrag` from the sidebar page: the mouse-down landed on empty sidebar space. Starts a lockstep
    /// move of this window from the current mouse location, whatever the lockstep setting says. With the setting
    /// off, the drag tap exists only for this session. `doubleClick` runs the title-bar double-click action instead.
    @discardableResult
    func beginFromPanel(windowKey key: Int, doubleClick: Bool = false) -> Bool {
        guard let m = manager, m.overlayEnabled, Permissions.isTrusted, m.tracker.pid != 0 else {
            Log.write("lockstep: sidebar drag ignored (overlay off, no Accessibility or Chrome not running)")
            return false
        }
        guard let w = m.tracker.windows.first(where: { $0.key == key && $0.visible }) else {
            Log.write("lockstep: sidebar drag ignored (window \(key) not visible)")
            return false
        }
        if doubleClick {
            if session?.fromPanel == true { finish(at: nil, replay: false) }
            performTitleBarDoubleClick(w.element)
            Log.write("lockstep: double-click action (from sidebar)")
            return true
        }
        // The mouse-down is already behind us: only start while the button is still physically down.
        guard CGEventSource.buttonState(.hidSystemState, button: .left) else {
            Log.write("lockstep: sidebar drag ignored (button already released)")
            return false
        }
        if session != nil { finish(at: nil, replay: false) }
        guard installTap() else { return false }
        let ns = NSEvent.mouseLocation
        let p = CGEvent(source: nil)?.location ?? CGPoint(x: ns.x, y: Geometry.primaryHeight - ns.y)
        return startSession(w, gesture: .move, at: p, flags: [], focused: m.tracker.focusedWindowKey(), fromPanel: true)
    }

    // MARK: Hit testing

    private func edges(at p: CGPoint, in f: CGRect) -> Edges? {
        let outside: CGFloat = 5, inside: CGFloat = 3, corner: CGFloat = 10
        guard f.insetBy(dx: -outside, dy: -outside).contains(p) else { return nil }
        if f.insetBy(dx: inside, dy: inside).contains(p) { return nil }
        var e = Edges()
        e.left = p.x < f.minX + inside
        e.right = p.x > f.maxX - inside
        e.top = p.y < f.minY + inside
        e.bottom = p.y > f.maxY - inside
        let nearLeft = p.x < f.minX + corner, nearRight = p.x > f.maxX - corner
        let nearTop = p.y < f.minY + corner, nearBottom = p.y > f.maxY - corner
        if (e.left || e.right) && (nearTop || nearBottom) {
            e.top = nearTop
            e.bottom = nearBottom
        }
        if (e.top || e.bottom) && (nearLeft || nearRight) {
            e.left = nearLeft
            e.right = nearRight
        }
        return e
    }

    /// True when the AX element at the point is part of `window` and is not interactive.
    private func isDraggableArea(app: AXUIElement, window: AXUIElement, at p: CGPoint) -> Bool {
        var found: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app, Float(p.x), Float(p.y), &found) == .success,
              let hit = found else { return false }
        if let top = AX.element(hit, "AXWindow"), !CFEqual(top, window) { return false }   // a bubble / other window
        var current: AXUIElement? = hit
        for _ in 0...3 {
            guard let el = current else { break }
            let role = AX.string(el, AXName.role) ?? ""
            if role == "AXWindow" { break }
            if Self.interactiveRoles.contains(role) { return false }
            var names: CFArray?
            if AXUIElementCopyActionNames(el, &names) == .success,
               let list = names as? [String], list.contains(AXName.actionPress) { return false }
            current = AX.element(el, "AXParent")
        }
        return true
    }

    private func performTitleBarDoubleClick(_ window: AXUIElement) {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "None":
            break
        case "Minimize":
            AX.setBool(window, AXName.minimized, true)
        default:
            if let zoom = AX.element(window, AXName.zoomButton) { AX.perform(zoom, AXName.actionPress) }
        }
    }

    // MARK: Applying

    private func scheduleApply() {
        if applyScheduled { return }
        applyScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.applyScheduled = false
            self.applyLatest()
        }
    }

    /// Top of the usable area (below the menu bar) of the screen under the mouse, in AX coordinates.
    private func clampTop(for mouse: CGPoint) -> CGFloat {
        let ns = NSPoint(x: mouse.x, y: Geometry.primaryHeight - mouse.y)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(ns) }) ?? NSScreen.screens.first
        guard let s = screen else { return -.greatestFiniteMagnitude }
        return Geometry.primaryHeight - s.visibleFrame.maxY
    }

    private func targetFrame(_ s: Session) -> CGRect {
        let dx = s.latest.x - s.startMouse.x
        let dy = s.latest.y - s.startMouse.y
        let start = s.startFrame
        let minTop = clampTop(for: s.latest)
        switch s.gesture {
        case .move:
            return CGRect(x: start.minX + dx, y: max(start.minY + dy, minTop), width: start.width, height: start.height)
        case .resize(let e):
            var minX = start.minX, maxX = start.maxX, minY = start.minY, maxY = start.maxY
            if e.left { minX += dx }
            if e.right { maxX += dx }
            if e.top { minY = max(minY + dy, minTop) }
            if e.bottom { maxY += dy }
            if maxX - minX < s.minSize.width {
                if e.left { minX = maxX - s.minSize.width } else { maxX = minX + s.minSize.width }
            }
            if maxY - minY < s.minSize.height {
                if e.top { minY = maxY - s.minSize.height } else { maxY = minY + s.minSize.height }
            }
            return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
        }
    }

    private func applyLatest() {
        guard var s = session, s.moved, !s.failed else { return }
        apply(&s)
        session = s
    }

    /// Sets Chrome's window (position first, then size, only what changed), then moves our panel immediately.
    private func apply(_ s: inout Session) {
        let f = targetFrame(s)
        let last = s.lastFrame
        let posChanged = abs(f.minX - last.minX) > 0.01 || abs(f.minY - last.minY) > 0.01
        let sizeChanged = abs(f.width - last.width) > 0.01 || abs(f.height - last.height) > 0.01
        if !posChanged && !sizeChanged { return }
        var ok = true
        if posChanged { ok = AX.setPosition(s.window, f.origin) && ok }
        if sizeChanged {
            ok = AX.setSize(s.window, f.size) && ok
            s.resized = true
        }
        // Failsafe: if Chrome refuses the move (or silently ignores it twice), stop taking over drags for the rest
        // of this run so the user can always move the window natively.
        if ok, let actual = AX.frame(s.window), abs(actual.minX - f.minX) > 2 || abs(actual.minY - f.minY) > 2 {
            s.mismatches += 1
            if s.mismatches >= 2 { ok = false }
        } else if ok {
            s.mismatches = 0
        }
        if !ok {
            Log.write("lockstep: Chrome didn't follow the drag; turning lockstep off for this session")
            Self.disabledThisRun = true
            s.failed = true
            DispatchQueue.main.async { [weak self] in self?.syncTap() }
            return
        }
        s.lastFrame = f
        manager?.controllers[s.key]?.lockstepFrame(f)
    }

    // MARK: Finishing

    /// Ends the session. `point` is the final mouse location (nil when aborting). When the mouse never moved
    /// more than 3 pt the click is replayed to Chrome.
    private func finish(at point: CGPoint?, replay: Bool) {
        guard var s = session else { return }
        session = nil
        if let p = point { s.latest = p }
        if s.moved && !s.failed { apply(&s) }
        let m = manager
        m?.tracker.paused = false
        m?.controllers[s.key]?.lockstepFinished(resized: s.resized)
        m?.tracker.refresh(force: true)
        switch s.gesture {
        case .move: Log.write("lockstep: move ended")
        case .resize: Log.write("lockstep: resize ended")
        }
        if s.fromPanel {
            // Remove the temporary tap (outside the tap callback) unless the setting wants it.
            DispatchQueue.main.async { [weak self] in self?.syncTap() }
        }
        if replay && !s.moved {
            let start = s.startMouse, flags = s.flags, pid = s.pid
            DispatchQueue.main.async {
                Self.replayClick(at: start, flags: flags, pid: pid)
            }
        }
    }

    nonisolated private static func replayClick(at p: CGPoint, flags: CGEventFlags, pid: pid_t) {
        for t in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
            guard let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left) else { continue }
            e.flags = flags
            e.setIntegerValueField(.mouseEventClickState, value: 1)
            e.setIntegerValueField(.eventSourceUserData, value: marker)
            e.postToPid(pid)
        }
    }
}
