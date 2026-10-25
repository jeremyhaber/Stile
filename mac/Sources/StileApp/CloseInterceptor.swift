import AppKit
import ApplicationServices

/// Intercepts the red close button and Cmd+Shift+W on Chrome pop-out windows and asks the extension to
/// `mergeWindow` (live tab move) instead of closing. The event tap runs on its own thread (TapThread) and decides
/// from a lock-protected snapshot; the merge and everything else it triggers runs on the main thread.
private let closeTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
    let state = Unmanaged<CloseTapState>.fromOpaque(refcon).takeUnretainedValue()
    let t0 = TapMetrics.now()
    let swallow = state.handle(type, event)
    TapMetrics.finish("close", event: event, started: t0)
    return swallow ? nil : Unmanaged.passUnretained(event)
}

/// What the tap thread knows (no AX, no main-actor state).
final class CloseTapState: @unchecked Sendable {
    struct Snapshot {
        var frontmost = false
        /// Close button frames (AX coords) of windows whose close is merged.
        var targets: [(key: Int, frame: CGRect)] = []
        var focusedMergeKey: Int?
        var focusedLittle = false
    }

    private let lock = NSLock()
    private var snap = Snapshot()
    private var swallowUp = false
    var tap: CFMachPort?
    var onMerge: ((Int) -> Void)?
    var onPromote: (() -> Void)?

    func set(_ s: Snapshot) { lock.lock(); snap = s; lock.unlock() }
    private func get() -> Snapshot { lock.lock(); defer { lock.unlock() }; return snap }

    /// Returns true to swallow the event.
    func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            Log.write("close-interceptor: tap was disabled, re-enabled")
            return false
        case .leftMouseDown:
            swallowUp = false
            let s = get()
            if !s.frontmost || s.targets.isEmpty { return false }
            let p = event.location
            for t in s.targets where t.frame.insetBy(dx: -1, dy: -1).contains(p) {
                swallowUp = true
                let key = t.key
                DispatchQueue.main.async { [weak self] in self?.onMerge?(key) }
                return true
            }
            return false
        case .leftMouseUp:
            if swallowUp {
                swallowUp = false
                return true
            }
            return false
        case .keyDown:
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            guard code == 31 || code == 13 else { return false }
            let relevant: CGEventFlags = [.maskCommand, .maskShift, .maskControl, .maskAlternate]
            let flags = event.flags.intersection(relevant)
            let repeated = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            let s = get()
            if !s.frontmost { return false }
            if code == 31 {
                // Command+O in a little window: "Open as tab" (swallowed; key repeat promotes only once).
                guard flags == [.maskCommand], s.focusedLittle else { return false }
                if !repeated { DispatchQueue.main.async { [weak self] in self?.onPromote?() } }
                return true
            }
            guard flags == [.maskCommand, .maskShift], let key = s.focusedMergeKey else { return false }
            if !repeated { DispatchQueue.main.async { [weak self] in self?.onMerge?(key) } }
            return true
        default:
            return false
        }
    }
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

    private let tapState = CloseTapState()
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var lastTapAttempt = Date.distantPast
    private var loggedTapFailure = false

    private var roles: [UUID: Roles] = [:]
    private var subscriptions: [UUID: (ProfileBridge, UUID)] = [:]
    private var targets: [Int: Target] = [:]
    private var inFlight = Set<String>()

    // MARK: Tap lifecycle

    /// The tap matters only when some profile has merge-on-close with a main window (pop-outs to merge) or little
    /// windows exist (Command+O). Otherwise no tap is installed at all.
    private var tapNeeded: Bool {
        roles.values.contains { ($0.mergeOnClose && $0.mainWindowId != nil) || !$0.littleWindowIds.isEmpty }
    }

    /// Installs or removes the tap to match `tapNeeded`; cheap to call repeatedly (install retries at most every 5 s).
    func ensureTap() {
        if !tapNeeded || !Permissions.isTrusted {
            if tap != nil { stop(); Log.write("close-interceptor: event tap removed (nothing to intercept)") }
            return
        }
        if tap != nil { return }
        guard Date().timeIntervalSince(lastTapAttempt) > 5 else { return }
        lastTapAttempt = Date()
        // No drag events here, and the callback runs on the tap thread, never on the main thread.
        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp, .keyDown]
        var mask: CGEventMask = 0
        for t in types { mask |= (CGEventMask(1) << CGEventMask(t.rawValue)) }
        tapState.onMerge = { [weak self] key in
            runOnMain { self?.mergeFromTap(key) }
        }
        tapState.onPromote = { [weak self] in
            runOnMain { self?.promoteFromTap() }
        }
        let refcon = Unmanaged.passUnretained(tapState).toOpaque()
        guard let made = TapThread.shared.install(mask: mask, callback: closeTapCallback, refcon: refcon) else {
            if !loggedTapFailure {
                loggedTapFailure = true
                Log.write("close-interceptor: could not create event tap (Accessibility / Input Monitoring?)")
            }
            return
        }
        tap = made.tap
        runLoopSource = made.source
        tapState.tap = made.tap
        publishSnapshot()
        Log.write("close-interceptor: event tap installed (tap thread)")
    }

    func stop() {
        if let t = tap, let src = runLoopSource { TapThread.shared.remove(tap: t, source: src) }
        runLoopSource = nil
        tap = nil
        tapState.tap = nil
    }

    /// Copies what the tap thread needs into its lock-protected snapshot.
    private func publishSnapshot() {
        guard tap != nil else { return }
        var s = CloseTapState.Snapshot()
        s.frontmost = chromeIsFrontmost()
        for t in targets.values where qualifying(t.key) != nil { s.targets.append((t.key, t.frame)) }
        if let k = focusedWindowKey?() {
            if targets[k] != nil, qualifying(k) != nil { s.focusedMergeKey = k }
            s.focusedLittle = littleWindow(k) != nil
        }
        tapState.set(s)
    }

    private func mergeFromTap(_ key: Int) {
        guard let t = targets[key], let q = qualifying(key) else { return }
        merge(bridge: q.bridge, windowId: q.windowId, target: t)
    }

    private func promoteFromTap() {
        guard let key = focusedWindowKey?(), let l = littleWindow(key) else { return }
        Log.write("cmd-o: intercepted in little window \(l.windowId); promoting to a tab")
        LittleLinks.promote(bridge: l.bridge, windowId: l.windowId)
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

    /// Re-reads the close button frame of every visible window whose close would be merged (after tracker updates /
    /// following ends) and publishes the tap snapshot. The tap trusts this cache; it makes no AX calls.
    func refreshTargets(_ windows: [ChromeWindow]) {
        var out: [Int: Target] = [:]
        if tapNeeded {
            for w in windows where w.visible && qualifying(w.key) != nil {
                guard let button = AX.element(w.element, AXName.closeButton), let f = AX.frame(button) else { continue }
                out[w.key] = Target(key: w.key, window: w.element, button: button, frame: f)
            }
        }
        targets = out
        ensureTap()
        publishSnapshot()
    }

    // MARK: Decision

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

    // MARK: Action

    /// The header's red light: the same decision as a click on Chrome's own close button (merge an interceptable
    /// pop-out, else press the real AXCloseButton so Chrome's own close flow, including its prompts, runs).
    func performClose(key: Int, window: AXUIElement) {
        guard let button = AX.element(window, AXName.closeButton) else { return }
        if let q = qualifying(key) {
            merge(bridge: q.bridge, windowId: q.windowId,
                  target: Target(key: key, window: window, button: button, frame: AX.frame(button) ?? .zero))
        } else {
            AX.perform(button, AXName.actionPress)
        }
    }

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
