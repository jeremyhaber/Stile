import AppKit
import ApplicationServices

struct ChromeWindow {
    let key: Int
    let element: AXUIElement
    var cgID: CGWindowID
    var frame: CGRect          // AX coordinates (top-left origin)
    var minimized: Bool
    var fullscreen: Bool
    var onScreen: Bool

    /// Overlays are shown only for normal, on-screen windows.
    var visible: Bool { !minimized && !fullscreen && onScreen }

    func sameState(as o: ChromeWindow) -> Bool {
        key == o.key && cgID == o.cgID && frame == o.frame && minimized == o.minimized
            && fullscreen == o.fullscreen && onScreen == o.onScreen
    }
}

private let axObserverCallback: AXObserverCallback = { _, _, notification, refcon in
    guard let refcon = refcon else { return }
    let tracker = Unmanaged<ChromeTracker>.fromOpaque(refcon).takeUnretainedValue()
    let name = notification as String
    Task { @MainActor in
        tracker.axNotification(name)
    }
}

@MainActor
final class ChromeTracker {
    static let bundleID = "com.google.Chrome"

    var onUpdate: (() -> Void)?
    /// Chrome's keyboard focus moved (e.g. ⌘L into the address field). No window refresh: it fires on every click.
    var onFocusedElementChanged: (() -> Void)?

    private(set) var windows: [ChromeWindow] = []
    private(set) var chromeFrontmost = false
    private(set) var pid: pid_t = 0
    private(set) var appElement: AXUIElement?
    private(set) var lastGeometryEvent = Date.distantPast
    /// While true (a live move/resize is being followed from window-server bounds) refresh() does nothing,
    /// so no AX calls are made. The manager refreshes once when following ends.
    var paused = false

    private var observer: AXObserver?
    private var observedKeys = Set<Int>()
    private var pollTimer: Timer?
    private var workspaceTokens: [NSObjectProtocol] = []
    private var started = false

    var isRunning: Bool { pid != 0 }

    func noteGeometryEvent() {
        lastGeometryEvent = Date()
    }

    func start() {
        if started { return }
        started = true
        let center = NSWorkspace.shared.notificationCenter
        let names: [Notification.Name] = [
            NSWorkspace.didLaunchApplicationNotification,
            NSWorkspace.didActivateApplicationNotification,
            NSWorkspace.didDeactivateApplicationNotification,
            NSWorkspace.didHideApplicationNotification,
            NSWorkspace.didUnhideApplicationNotification,
            NSWorkspace.didTerminateApplicationNotification,
            NSWorkspace.activeSpaceDidChangeNotification,
        ]
        for n in names {
            let token = center.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.workspaceChanged() }
            }
            workspaceTokens.append(token)
        }
        pollTimer = Timer.scheduledTimer(timeInterval: 0.5, target: self, selector: #selector(pollTick),
                                         userInfo: nil, repeats: true)
        workspaceChanged()
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        for t in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(t) }
        workspaceTokens.removeAll()
        detach()
        started = false
    }

    @objc private func pollTick() {
        refresh(force: false)
    }

    private func workspaceChanged() {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID)
            .first(where: { !$0.isTerminated })
        if let r = running {
            if r.processIdentifier != pid { attach(r.processIdentifier) }
        } else if pid != 0 {
            detach()
        }
        refresh(force: true)
    }

    // MARK: AX observer

    private func attach(_ newPid: pid_t) {
        detach()
        pid = newPid
        let app = AXUIElementCreateApplication(newPid)
        // A busy Chrome must not block the main thread for the default 6 s per AX call.
        AXUIElementSetMessagingTimeout(app, 0.25)
        appElement = app
        setupObserver()
        Log.write("tracker: attached to Chrome pid \(newPid)")
    }

    private func detach() {
        if let obs = observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .commonModes)
        }
        observer = nil
        observedKeys.removeAll()
        appElement = nil
        let hadWindows = !windows.isEmpty
        windows = []
        pid = 0
        if hadWindows { onUpdate?() }
    }

    private func setupObserver() {
        guard pid != 0, let app = appElement, observer == nil else { return }
        var obs: AXObserver?
        let err = AXObserverCreate(pid, axObserverCallback, &obs)
        guard err == .success, let created = obs else { return }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for n in [AXName.windowCreated, AXName.focusedWindowChanged, AXName.focusedUIElementChanged] {
            _ = AXObserverAddNotification(created, app, n as CFString, refcon)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        observer = created
        observedKeys.removeAll()
    }

    private func observeWindow(_ el: AXUIElement, key: Int) {
        guard let obs = observer, !observedKeys.contains(key) else { return }
        observedKeys.insert(key)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for n in [AXName.moved, AXName.resized, AXName.elementDestroyed,
                  AXName.windowMiniaturized, AXName.windowDeminiaturized] {
            _ = AXObserverAddNotification(obs, el, n as CFString, refcon)
        }
    }

    fileprivate func axNotification(_ name: String) {
        if name == AXName.focusedUIElementChanged {
            onFocusedElementChanged?()
            return
        }
        if name == AXName.moved || name == AXName.resized {
            lastGeometryEvent = Date()
        }
        refresh(force: true)
    }

    // MARK: Refresh

    func refresh(force: Bool) {
        guard !paused, pid != 0, let app = appElement else { return }
        if observer == nil { setupObserver() }

        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        let infos = CGInfo.onScreenWindowInfo()
        var onScreenIDs = Set<CGWindowID>()
        for info in infos {
            if let n = info["kCGWindowNumber"] as? NSNumber { onScreenIDs.insert(CGWindowID(n.uint32Value)) }
        }

        // Chrome can miss the 0.25 s AX timeout mid-animation (full screen above all). A failed read keeps the
        // last known windows: dropping them tears the overlays down and rebuilds them from scratch.
        guard let elements = AX.children(app, AXName.windows) else { return }
        var list: [ChromeWindow] = []
        for el in elements {
            if let sub = AX.string(el, AXName.subrole), sub != "AXStandardWindow" { continue }
            let key = AX.windowKey(el)
            guard let frame = AX.frame(el) else {
                if let old = windows.first(where: { $0.key == key }) { list.append(old) }
                continue
            }
            var cg = AX.cgWindowID(el)
            let minimized = AX.bool(el, AXName.minimized) ?? false
            let fullscreen = AX.bool(el, AXName.fullScreen) ?? false
            if cg == 0 && !minimized {
                cg = CGInfo.match(pid: pid, frame: frame, in: infos)
            }
            let onScreen: Bool = cg == 0 ? !minimized : onScreenIDs.contains(cg)
            observeWindow(el, key: key)
            list.append(ChromeWindow(key: key, element: el, cgID: cg, frame: frame,
                                     minimized: minimized, fullscreen: fullscreen, onScreen: onScreen))
        }

        var changed = force || frontmost != chromeFrontmost || list.count != windows.count
        if !changed {
            for (a, b) in zip(list, windows) where !a.sameState(as: b) {
                changed = true
                break
            }
        }
        chromeFrontmost = frontmost
        windows = list
        if changed { onUpdate?() }
    }

    func focusedWindowKey() -> Int? {
        guard let app = appElement, let w = AX.element(app, AXName.focusedWindow) else { return nil }
        return AX.windowKey(w)
    }
}
