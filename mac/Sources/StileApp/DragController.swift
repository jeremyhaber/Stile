import AppKit
import ApplicationServices

/// v2.9 lockstep: takes over Chrome window drags (empty toolbar gaps) and edge resizes. Chrome's window is moved
/// with synchronous AX sets and our panel is moved right after each set, so both come from the same code path.
///
/// The event tap runs on its own thread (TapThread) and never touches the main thread or AX: it decides from a
/// lock-protected snapshot (window frames, toolbar bands, cached interactive-control and panel rects) and hands
/// every side effect to the main queue. Own tap, installed only while lockstep is on (or, briefly, for a drag
/// started from our own panel): drag events must not wait on anything slow.
private let dragTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
    let state = Unmanaged<LockstepTapState>.fromOpaque(refcon).takeUnretainedValue()
    let t0 = TapMetrics.now()
    let swallow = state.handle(type, event)
    TapMetrics.finish("lockstep", event: event, started: t0)
    return swallow ? nil : Unmanaged.passUnretained(event)
}

struct LockstepEdges {
    var left = false, right = false, top = false, bottom = false
}

enum LockstepGesture {
    case move
    case resize(LockstepEdges)
}

/// Everything the tap thread knows and shares with the main thread (one lock).
final class LockstepTapState: @unchecked Sendable {
    struct Win {
        let key: Int
        let frame: CGRect            // AX coordinates
        let bandBottom: CGFloat      // AX y: below it the point is not in the toolbar band
        let interactive: [CGRect]    // cached controls (AX coordinates)
        let blocked: [CGRect]        // our own panels / Chrome's rail splitter
        let toolbarKnown: Bool       // the AX tree was populated enough to trust `interactive`
    }

    private let lock = NSLock()
    // Snapshot (written by the main thread).
    private var enabled = false
    private var wins: [Win] = []
    var disabled = false
    // Session state shared with the main thread.
    private var active = false
    private(set) var fromPanel = false
    private var moved = false
    private var startMouse = CGPoint.zero
    private var latest = CGPoint.zero
    private var swallowUp = false
    private var applyScheduled = false
    private var lastClaim: (at: Date, point: CGPoint)?

    var tap: CFMachPort?
    var onBegin: ((Int, LockstepGesture, CGPoint, CGEventFlags) -> Void)?
    var onApply: (() -> Void)?
    var onFinish: ((CGPoint?, Bool, Bool) -> Void)?    // final point, replay the click, session was a drag
    var onDoubleClick: ((Int) -> Void)?

    func setSnapshot(enabled e: Bool, wins w: [Win]) {
        lock.lock(); enabled = e; wins = w; lock.unlock()
    }

    var sessionActive: Bool { lock.lock(); defer { lock.unlock() }; return active }

    /// Main thread: a session started from our own panel (the mouse is already down).
    func beginPanelSession(at p: CGPoint) {
        lock.lock()
        active = true; fromPanel = true; moved = false; startMouse = p; latest = p; swallowUp = false
        lock.unlock()
    }

    func endSession() {
        lock.lock(); active = false; lock.unlock()
    }

    /// Main thread: the latest pointer position and whether the drag threshold was passed.
    func current() -> (latest: CGPoint, start: CGPoint, moved: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (latest, startMouse, moved)
    }

    /// Value of `.eventSourceUserData` on the click we replay, so the tap ignores it.
    static let marker: Int64 = 0x5342_4C4B

    func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            lock.lock(); let was = active; active = false; lock.unlock()
            if was { DispatchQueue.main.async { [weak self] in self?.onFinish?(nil, false, false) } }
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            return false
        default:
            break
        }
        if event.getIntegerValueField(.eventSourceUserData) == Self.marker { return false }
        switch type {
        case .leftMouseDown:
            return mouseDown(event)
        case .leftMouseDragged:
            lock.lock()
            guard active else { lock.unlock(); return false }
            // Read the HARDWARE button state: we swallowed the mouse-down, so the window server's own state
            // (NSEvent.pressedMouseButtons) thinks the button is up and would end every drag immediately.
            if !CGEventSource.buttonState(.hidSystemState, button: .left) {
                active = false
                lock.unlock()
                let p = event.location
                DispatchQueue.main.async { [weak self] in self?.onFinish?(p, false, false) }
                return false
            }
            latest = event.location
            if !moved, hypot(latest.x - startMouse.x, latest.y - startMouse.y) > 3 { moved = true }
            let needApply = moved && !applyScheduled
            if needApply { applyScheduled = true }
            lock.unlock()
            if needApply {
                DispatchQueue.main.async { [weak self] in
                    guard let self = self else { return }
                    self.lock.lock(); self.applyScheduled = false; self.lock.unlock()
                    self.onApply?()
                }
            }
            return true
        case .leftMouseUp:
            lock.lock()
            if swallowUp {
                swallowUp = false
                lock.unlock()
                return true
            }
            guard active else { lock.unlock(); return false }
            active = false
            latest = event.location
            let panel = fromPanel
            let wasMoved = moved
            lock.unlock()
            let p = event.location
            // From the panel the mouse-down went to the panel, so it must see the mouse-up too; nothing to replay.
            DispatchQueue.main.async { [weak self] in self?.onFinish?(p, !panel, wasMoved) }
            return !panel
        default:
            return false
        }
    }

    private func mouseDown(_ event: CGEvent) -> Bool {
        lock.lock()
        swallowUp = false
        let stale = active
        active = false
        let on = enabled && !disabled
        let list = wins
        lock.unlock()
        if stale { DispatchQueue.main.async { [weak self] in self?.onFinish?(nil, false, false) } }
        guard on, !list.isEmpty else { return false }
        let flags = event.flags
        if !flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty { return false }
        let p = event.location

        // Edge resize first (its zone overlaps the top of the drag band).
        for w in list {
            guard let e = Self.edges(at: p, in: w.frame) else { continue }
            if w.blocked.contains(where: { $0.contains(p) }) { continue }
            return claim(w.key, .resize(e), at: p, flags: flags, why: "edge")
        }

        // Toolbar drag: only gaps between cached controls inside a populated toolbar.
        for w in list where w.frame.contains(p) && p.y < w.bandBottom {
            if w.blocked.contains(where: { $0.contains(p) }) { continue }
            guard w.toolbarKnown else { continue }
            if w.interactive.contains(where: { $0.insetBy(dx: -3, dy: -3).contains(p) }) { continue }
            let clicks = event.getIntegerValueField(.mouseEventClickState)
            lock.lock()
            let recent = lastClaim.map {
                Date().timeIntervalSince($0.at) <= NSEvent.doubleClickInterval && hypot(p.x - $0.point.x, p.y - $0.point.y) <= 5
            } ?? false
            lock.unlock()
            // A second click only counts as a title-bar double-click when the first one was a drag we claimed;
            // otherwise the event passes through untouched.
            if clicks >= 2 {
                guard recent else { return false }
                lock.lock(); lastClaim = nil; swallowUp = true; lock.unlock()
                let key = w.key
                DispatchQueue.main.async { [weak self] in self?.onDoubleClick?(key) }
                return true
            }
            lock.lock(); lastClaim = (Date(), p); lock.unlock()
            return claim(w.key, .move, at: p, flags: flags,
                         why: "toolbar gap, \(w.interactive.count) cached controls")
        }
        return false
    }

    private func claim(_ key: Int, _ g: LockstepGesture, at p: CGPoint, flags: CGEventFlags, why: String) -> Bool {
        lock.lock()
        active = true; fromPanel = false; moved = false; startMouse = p; latest = p
        lock.unlock()
        DispatchQueue.main.async { [weak self] in
            Log.write("lockstep: claimed at \(Int(p.x)),\(Int(p.y)) (\(why))")
            self?.onBegin?(key, g, p, flags)
        }
        return true
    }

    static func edges(at p: CGPoint, in f: CGRect) -> LockstepEdges? {
        let outside: CGFloat = 5, inside: CGFloat = 3, corner: CGFloat = 10
        guard f.insetBy(dx: -outside, dy: -outside).contains(p) else { return nil }
        if f.insetBy(dx: inside, dy: inside).contains(p) { return nil }
        var e = LockstepEdges()
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
}

@MainActor
final class DragController {
    private let state = LockstepTapState()
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?

    weak var manager: OverlayManager?

    /// Set when Chrome didn't follow a lockstep drag; native dragging is used until the app restarts.
    static var disabledThisRun = false

    private struct Session {
        var mismatches = 0
        var failed = false
        let key: Int
        let window: AXUIElement
        let pid: pid_t
        let gesture: LockstepGesture
        let startMouse: CGPoint
        let startFrame: CGRect
        let minSize: CGSize
        let flags: CGEventFlags
        /// Started by `beginWindowDrag` from our own panel (the mouse-down went to the panel, not to Chrome).
        var fromPanel = false
        var moved = false
        var resized = false
        var lastFrame: CGRect
    }
    private var session: Session?

    init() {
        state.onBegin = { [weak self] key, g, p, flags in
            runOnMain { self?.beginSession(key: key, gesture: g, at: p, flags: flags) }
        }
        state.onApply = { [weak self] in runOnMain { self?.applyLatest() } }
        state.onFinish = { [weak self] p, replay, moved in
            runOnMain { self?.finish(at: p, replay: replay, tapMoved: moved) }
        }
        state.onDoubleClick = { [weak self] key in
            runOnMain {
                guard let w = self?.manager?.tracker.windows.first(where: { $0.key == key }) else { return }
                self?.performTitleBarDoubleClick(w)
                Log.write("lockstep: double-click action")
            }
        }
    }

    /// Installs or removes the tap to match the setting. Cheap to call often. A panel-initiated session (v3.0)
    /// keeps the tap alive until it ends even when the setting is off; it is removed right after.
    func syncTap() {
        let want = Settings.lockstepDrag && Settings.useChrome && !Self.disabledThisRun && Permissions.isTrusted
        if want {
            _ = installTap()
        } else if tap != nil, session?.fromPanel != true {
            removeTap()
        }
        state.disabled = Self.disabledThisRun
        updateSnapshot()
    }

    @discardableResult
    private func installTap() -> Bool {
        if tap != nil { return true }
        let types: [CGEventType] = [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        var mask: CGEventMask = 0
        for t in types { mask |= (CGEventMask(1) << CGEventMask(t.rawValue)) }
        let refcon = Unmanaged.passUnretained(state).toOpaque()
        guard let made = TapThread.shared.install(mask: mask, callback: dragTapCallback, refcon: refcon) else {
            Log.write("lockstep: could not create event tap")
            return false
        }
        tap = made.tap
        tapSource = made.source
        state.tap = made.tap
        Log.write("lockstep: event tap installed (tap thread)")
        return true
    }

    private func removeTap() {
        guard let t = tap else { return }
        if session != nil { finish(at: nil, replay: false, tapMoved: false) }
        state.endSession()
        if let src = tapSource { TapThread.shared.remove(tap: t, source: src) }
        tap = nil
        tapSource = nil
        state.tap = nil
        Log.write("lockstep: event tap removed")
    }

    // MARK: Snapshot for the tap thread

    /// Window frames, toolbar bands and blocked rects for the tap. Called after tracker updates, layout changes and
    /// setting changes; reads only cached state (no AX).
    func updateSnapshot() {
        guard let m = manager else { return }
        let on = m.overlayEnabled && Settings.lockstepDrag && Permissions.isTrusted && m.tracker.chromeFrontmost
            && m.tracker.pid != 0
        var list: [LockstepTapState.Win] = []
        if on {
            for w in m.tracker.windows where w.visible {
                guard let mapping = m.closer.mappingProvider?(w.key), !m.closer.isLittle(mapping),
                      let c = m.controllers[w.key] else { continue }
                let info = c.lockstepInfo()
                list.append(LockstepTapState.Win(key: w.key, frame: w.frame, bandBottom: w.frame.minY + c.toolbarBottomRel,
                                                 interactive: info.interactive, blocked: info.blocked,
                                                 toolbarKnown: info.toolbarKnown))
            }
            let focused = m.tracker.focusedWindowKey()
            list.sort { ($0.key == focused ? 0 : 1) < ($1.key == focused ? 0 : 1) }
        }
        state.setSnapshot(enabled: on, wins: list)
    }

    // MARK: Session

    /// Main thread, after the tap claimed a mouse-down: reads the window live and starts moving it.
    private func beginSession(key: Int, gesture: LockstepGesture, at p: CGPoint, flags: CGEventFlags) {
        guard let m = manager, let w = m.tracker.windows.first(where: { $0.key == key }) else {
            state.endSession()
            return
        }
        startSession(w, gesture: gesture, at: p, flags: flags, focused: m.tracker.focusedWindowKey(), fromPanel: false)
    }

    @discardableResult
    private func startSession(_ w: ChromeWindow, gesture: LockstepGesture, at p: CGPoint, flags: CGEventFlags,
                              focused: Int?, fromPanel: Bool) -> Bool {
        guard let m = manager else { return false }
        let live = AX.frame(w.element) ?? w.frame
        if w.key != focused { AX.perform(w.element, AXName.actionRaise) }
        var minSize = CGSize(width: 500, height: 350)
        if let ms = AX.size(w.element, "AXMinimumSize") {
            minSize = CGSize(width: max(minSize.width, ms.width), height: max(minSize.height, ms.height))
        }
        session = Session(key: w.key, window: w.element, pid: m.tracker.pid, gesture: gesture, startMouse: p,
                          startFrame: live, minSize: minSize, flags: flags, fromPanel: fromPanel, lastFrame: live)
        m.tracker.paused = true
        let origin = fromPanel ? " (from sidebar)" : ""
        switch gesture {
        case .move: Log.write("lockstep: move started\(origin)")
        case .resize: Log.write("lockstep: resize started\(origin)")
        }
        return true
    }

    // MARK: Panel-initiated drags (v3.0)

    /// `beginWindowDrag` from the sidebar page or the header: the mouse-down landed on empty space of our own panel.
    /// Starts a lockstep move of this window from the current mouse location, whatever the lockstep setting says.
    /// With the setting off, the drag tap exists only for this session. `doubleClick` runs the title-bar
    /// double-click action instead.
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
            if session?.fromPanel == true { finish(at: nil, replay: false, tapMoved: false) }
            performTitleBarDoubleClick(w)
            Log.write("lockstep: double-click action (from sidebar)")
            return true
        }
        // The mouse-down is already behind us: only start while the button is still physically down.
        guard CGEventSource.buttonState(.hidSystemState, button: .left) else {
            Log.write("lockstep: sidebar drag ignored (button already released)")
            return false
        }
        if session != nil { finish(at: nil, replay: false, tapMoved: false) }
        guard installTap() else { return false }
        let ns = NSEvent.mouseLocation
        let p = CGEvent(source: nil)?.location ?? CGPoint(x: ns.x, y: Geometry.primaryHeight - ns.y)
        state.beginPanelSession(at: p)
        return startSession(w, gesture: .move, at: p, flags: [], focused: m.tracker.focusedWindowKey(), fromPanel: true)
    }

    /// Pressing Chrome's zoom button would enter full screen (where Stile doesn't run), so Maximize/Fill
    /// uses the same Fill / restore as Stile's green button.
    private func performTitleBarDoubleClick(_ w: ChromeWindow) {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "None":
            break
        case "Minimize":
            AX.setBool(w.element, AXName.minimized, true)
        default:
            manager?.controllers[w.key]?.fillOrRestore()
        }
    }

    // MARK: Applying

    /// Top of the usable area (below the menu bar) of the screen under the mouse, in AX coordinates.
    private func clampTop(for mouse: CGPoint) -> CGFloat {
        let ns = NSPoint(x: mouse.x, y: Geometry.primaryHeight - mouse.y)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(ns) }) ?? NSScreen.screens.first
        guard let s = screen else { return -.greatestFiniteMagnitude }
        return Geometry.primaryHeight - s.visibleFrame.maxY
    }

    private func targetFrame(_ s: Session, latest: CGPoint) -> CGRect {
        let dx = latest.x - s.startMouse.x
        let dy = latest.y - s.startMouse.y
        let start = s.startFrame
        let minTop = clampTop(for: latest)
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
        guard var s = session, !s.failed else { return }
        let cur = state.current()
        guard cur.moved else { return }
        s.moved = true
        apply(&s, latest: cur.latest)
        session = s
    }

    /// Sets Chrome's window (position first, then size, only what changed), then moves our panel immediately.
    private func apply(_ s: inout Session, latest: CGPoint) {
        let f = targetFrame(s, latest: latest)
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
            state.disabled = true
            s.failed = true
            DispatchQueue.main.async { [weak self] in self?.syncTap() }
            return
        }
        s.lastFrame = f
        manager?.controllers[s.key]?.lockstepFrame(f)
    }

    // MARK: Finishing

    /// Ends the session. `point` is the final mouse location (nil when aborting). When the mouse never moved
    /// more than 3 pt the click is replayed to whatever is under the cursor.
    private func finish(at point: CGPoint?, replay: Bool, tapMoved: Bool) {
        state.endSession()
        guard var s = session else { return }
        session = nil
        let cur = state.current()
        let latest = point ?? cur.latest
        if (s.moved || tapMoved || cur.moved) && !s.failed {
            s.moved = true
            apply(&s, latest: latest)
        }
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
            let start = s.startMouse, flags = s.flags
            DispatchQueue.main.async {
                Self.replayClick(at: start, flags: flags)
            }
        }
    }

    nonisolated private static func replayClick(at p: CGPoint, flags: CGEventFlags) {
        for t in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
            guard let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left) else { continue }
            e.flags = flags
            e.setIntegerValueField(.mouseEventClickState, value: 1)
            e.setIntegerValueField(.eventSourceUserData, value: LockstepTapState.marker)
            e.post(tap: .cgSessionEventTap)   // routes like a real click to whatever is under the cursor
        }
    }
}
