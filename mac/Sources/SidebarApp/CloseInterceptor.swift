import AppKit
import ApplicationServices

/// Intercepts the red close button and Cmd+Shift+W on Chrome pop-out windows and asks the extension to
/// `mergeWindow` (live tab move) instead of closing. Everything here runs on the main thread: the event tap
/// is attached to the main run loop and the bridge replies are delivered there too.
private let closeTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
    let me = Unmanaged<CloseInterceptor>.fromOpaque(refcon).takeUnretainedValue()
    var swallow = false
    if #available(macOS 14.0, *) {
        swallow = MainActor.assumeIsolated { me.handle(type, event) }
    }
    return swallow ? nil : Unmanaged.passUnretained(event)
}

@MainActor
final class CloseInterceptor {
    struct Roles {
        var mainWindowId: Int?
        var mergeOnClose: Bool
        /// v2.8: Chrome window ids of little windows (never merged, no overlay).
        var littleWindowIds: Set<Int> = []
    }

    /// Cached close button of a visible Chrome window (AX coordinates, top-left origin).
    struct Target {
        let key: Int
        let window: AXUIElement
        let button: AXUIElement
        var frame: CGRect
    }

    // Inputs, set by the OverlayManager.
    var mappingProvider: ((Int) -> WindowMapper.Mapping?)?
    var chromePid: (() -> pid_t)?
    var focusedWindowKey: (() -> Int?)?
    /// Called after a bridge's cached roles changed (the manager re-evaluates which windows are little).
    var onRolesChanged: (() -> Void)?
    /// v2.9: lockstep window moves / resizes share this tap (see DragController).
    var dragHandler: ((CGEventType, CGEvent) -> Bool)?

    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var lastTapAttempt = Date.distantPast
    private var loggedTapFailure = false

    private var roles: [UUID: Roles] = [:]
    private var subscriptions: [UUID: (ProfileBridge, UUID)] = [:]
    private var targets: [Int: Target] = [:]
    private var swallowNextMouseUp = false
    private var inFlight = Set<String>()

    // MARK: Tap lifecycle

    /// Creates the tap when Accessibility is granted; cheap to call repeatedly (retries at most every 5 s).
    func ensureTap() {
        if tap != nil { return }
        guard Permissions.isTrusted, Date().timeIntervalSince(lastTapAttempt) > 5 else { return }
        lastTapAttempt = Date()
        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .keyDown]
        var mask: CGEventMask = 0
        for t in types { mask |= (CGEventMask(1) << CGEventMask(t.rawValue)) }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                           options: .defaultTap, eventsOfInterest: mask,
                                           callback: closeTapCallback, userInfo: refcon) else {
            if !loggedTapFailure {
                loggedTapFailure = true
                Log.write("close-interceptor: could not create event tap (Accessibility / Input Monitoring?)")
            }
            return
        }
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        tap = port
        runLoopSource = src
        Log.write("close-interceptor: event tap installed")
    }

    func stop() {
        if let src = runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), src, .commonModes) }
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        runLoopSource = nil
        tap = nil
    }

    // MARK: Cached state

    /// Called with the currently identified bridges: subscribe once to role changes, fetch roles for new ones.
    func bridgesChanged(_ live: [ProfileBridge]) {
        for b in live where subscriptions[b.id] == nil {
            let token = b.addSubscriber { [weak self] msg in
                guard (msg["type"] as? String) == "bridgeEvent",
                      (msg["name"] as? String) == "sidebar.windowRolesChanged" else { return }
                let payload = (msg["args"] as? [Any])?.first as? [String: Any]
                runOnMain { self?.rolesChanged(b, payload) }
            }
            subscriptions[b.id] = (b, token)
            fetchRoles(b)
        }
        for (id, entry) in subscriptions where entry.0.closed {
            subscriptions.removeValue(forKey: id)
            roles.removeValue(forKey: id)
        }
    }

    private func rolesChanged(_ b: ProfileBridge, _ payload: [String: Any]?) {
        if let p = payload, p["mainWindowId"] != nil || p["mergeOnClose"] != nil || p["littleWindowIds"] != nil {
            roles[b.id] = parseRoles(p)
            onRolesChanged?()
        } else {
            fetchRoles(b)
        }
    }

    private func parseRoles(_ d: [String: Any]) -> Roles {
        let little = ((d["littleWindowIds"] as? [Any]) ?? []).compactMap { JSONUtil.int($0) }
        return Roles(mainWindowId: JSONUtil.int(d["mainWindowId"]), mergeOnClose: (d["mergeOnClose"] as? Bool) ?? false,
                     littleWindowIds: Set(little))
    }

    /// True when the mapped Chrome window is a little window according to the cached roles.
    func isLittle(_ m: WindowMapper.Mapping?) -> Bool {
        guard let m = m, !m.bridge.closed, let r = roles[m.bridge.id] else { return false }
        return r.littleWindowIds.contains(m.windowId)
    }

    /// The (bridge, windowId) of the window with this key when it is a little window.
    private func littleWindow(_ key: Int) -> (bridge: ProfileBridge, windowId: Int)? {
        guard let m = mappingProvider?(key), isLittle(m) else { return nil }
        return (m.bridge, m.windowId)
    }

    private func fetchRoles(_ b: ProfileBridge) {
        Task { @MainActor [weak self] in
            do {
                let res = try await b.call("sidebar.windowRoles")
                if let d = res as? [String: Any], let self = self {
                    self.roles[b.id] = self.parseRoles(d)
                    self.onRolesChanged?()
                }
            } catch {
                Log.write("close-interceptor: sidebar.windowRoles failed for \(b.profileDir): \(error.localizedDescription)")
            }
        }
    }

    /// Re-reads the close button frame of every visible window (after tracker updates / following ends).
    func refreshTargets(_ windows: [ChromeWindow]) {
        var out: [Int: Target] = [:]
        for w in windows where w.visible {
            guard let button = AX.element(w.element, AXName.closeButton), let f = AX.frame(button) else { continue }
            out[w.key] = Target(key: w.key, window: w.element, button: button, frame: f)
        }
        targets = out
    }

    // MARK: Decision (runs inside the tap callback; keep it fast)

    /// The (bridge, windowId) to merge when the window with this key is an interceptable pop-out.
    private func qualifying(_ key: Int) -> (bridge: ProfileBridge, windowId: Int)? {
        guard let m = mappingProvider?(key), !m.bridge.closed, let r = roles[m.bridge.id],
              r.mergeOnClose, let main = r.mainWindowId, main != m.windowId,
              !r.littleWindowIds.contains(m.windowId) else { return nil }
        return (m.bridge, m.windowId)
    }

    private func chromeIsFrontmost() -> Bool {
        guard let pid = chromePid?(), pid != 0 else { return false }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    }

    /// The pop-out to merge when this mouse-down hits the close button of an interceptable window.
    private func closeHit(_ event: CGEvent) -> (bridge: ProfileBridge, windowId: Int, target: Target)? {
        if targets.isEmpty || !chromeIsFrontmost() { return nil }
        let p = event.location
        for t in targets.values where t.frame.insetBy(dx: -1, dy: -1).contains(p) {
            // The cache may be stale (window moved without a refresh yet): confirm against the live frame.
            guard let live = AX.frame(t.button), live.insetBy(dx: -1, dy: -1).contains(p) else { return nil }
            guard let q = qualifying(t.key) else { return nil }
            return (q.bridge, q.windowId, t)
        }
        return nil
    }

    /// Returns true to swallow the event.
    func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            Log.write("close-interceptor: tap was disabled, re-enabled")
            _ = dragHandler?(type, event)
            return false

        case .leftMouseDown:
            swallowNextMouseUp = false
            if let q = closeHit(event) {
                swallowNextMouseUp = true
                merge(bridge: q.bridge, windowId: q.windowId, target: q.target)
                return true
            }
            return dragHandler?(type, event) ?? false

        case .leftMouseUp:
            if swallowNextMouseUp {
                swallowNextMouseUp = false
                return true
            }
            return dragHandler?(type, event) ?? false

        case .leftMouseDragged:
            return dragHandler?(type, event) ?? false

        case .keyDown:
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            let relevant: CGEventFlags = [.maskCommand, .maskShift, .maskControl, .maskAlternate]
            if code == 31 {
                // Command+O in a little window: "Open as tab" (swallowed; key repeat promotes only once).
                guard event.flags.intersection(relevant) == [.maskCommand], chromeIsFrontmost(),
                      let key = focusedWindowKey?(), let l = littleWindow(key) else { return false }
                if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
                    LittleLinks.promote(bridge: l.bridge, windowId: l.windowId)
                }
                return true
            }
            guard code == 13 else { return false }
            guard event.flags.intersection(relevant) == [.maskCommand, .maskShift] else { return false }
            if targets.isEmpty || !chromeIsFrontmost() { return false }
            guard let key = focusedWindowKey?(), let t = targets[key], let q = qualifying(key) else { return false }
            // Key repeat: keep swallowing, but only merge once.
            if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
                merge(bridge: q.bridge, windowId: q.windowId, target: t)
            }
            return true

        default:
            return false
        }
    }

    // MARK: Action

    /// Asks the extension to merge the window. A single-tab window (or any failure) is closed normally via the
    /// close button instead, so the extension's single-tab archive rule / snapshot fallback still applies.
    private func merge(bridge: ProfileBridge, windowId: Int, target: Target) {
        let tag = "\(bridge.id.uuidString)#\(windowId)"
        if inFlight.contains(tag) { return }
        inFlight.insert(tag)
        let button = target.button
        Task { @MainActor [weak self] in
            defer { self?.inFlight.remove(tag) }
            var tabCount = 2
            if let res = try? await bridge.call("tabs.query", [["windowId": windowId]]), let arr = res as? [Any] {
                tabCount = arr.count
            }
            if tabCount <= 1 {
                AX.perform(button, AXName.actionPress)
                return
            }
            do {
                let res = try await bridge.call("sidebar.cmd", [["cmd": "mergeWindow", "windowId": windowId]])
                if let d = res as? [String: Any], (d["ok"] as? Bool) == false {
                    Log.write("close-interceptor: mergeWindow refused (\(d["error"] as? String ?? "unknown")); closing normally")
                    AX.perform(button, AXName.actionPress)
                }
            } catch {
                Log.write("close-interceptor: mergeWindow failed (\(error.localizedDescription)); closing normally")
                AX.perform(button, AXName.actionPress)
            }
        }
    }
}
