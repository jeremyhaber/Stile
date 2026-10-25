import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = HostServer()
    private var manager: OverlayManager?
    private var menuBar: MenuBarController?
    private let permissions = Permissions()
    private let capturer = ScreenCapturer()
    private lazy var router = LinkRouter(server: server)
    private let modeChoice = ModeChoiceWindow()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One instance only: it owns host.sock.
        if let bundleID = Bundle.main.bundleIdentifier {
            let me = ProcessInfo.processInfo.processIdentifier
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
                .filter { $0.processIdentifier != me && !$0.isTerminated }
            if !others.isEmpty {
                Log.write("Stile already running (pid \(others[0].processIdentifier)); exiting")
                NSApp.terminate(nil)
                return
            }
        }
        Log.write("Stile \(AppInfo.version) launching (menu bar icon optional, no Dock icon)")
        installMainMenu()

        AppMode.inferExistingInstall()   // v3.5c: an install from before the mode choice keeps Chrome mode
        HostSetup.runAtLaunch()
        CaptureSettings.shared.migrate()
        server.start()
        let mgr = OverlayManager(server: server)
        manager = mgr
        router.preferredBridge = { [weak mgr] in mgr?.preferredBridge() }
        capturer.bridgeFor = { [weak mgr] in mgr?.captureBridge() }
        server.onOpenCaptureEditor = { id, png, meta, theme, bridge in
            MainActor.assumeIsolated {
                // v3.5c: the app owns the settings; the extension's first S3 setup is adopted once
                CaptureSettings.shared.adoptIfEmpty(from: bridge.captureConfig)
                return CaptureEditors.shared.open(CaptureDocument(
                    id: id, png: png, meta: meta,
                    config: CaptureSettings.shared.editorConfig(sidebarColor: bridge.captureConfig["sidebarColor"]),
                    theme: theme, bridge: bridge))
            }
        }
        server.onCaptureConfig = { cfg, bridge in
            MainActor.assumeIsolated {
                CaptureSettings.shared.adoptIfEmpty(from: cfg)
                CaptureEditors.shared.refreshConfigs(from: bridge)
            }
        }
        // v3.6: recent recordings go to connected extensions (and again when one (re)connects and sends its config)
        RecentRecordings.shared.bridges = { [server] in server.identified }
        let configHandler = server.onCaptureConfig
        server.onCaptureConfig = { cfg, bridge in
            configHandler?(cfg, bridge)
            MainActor.assumeIsolated { RecentRecordings.shared.syncToExtension() }
        }
        // v3.6: recording (Chrome tab messages from the extension, the hot key; the menu bar controller wires its own icon)
        RecordingController.shared.manager = mgr
        AppSettingsWindow.shared.server = server
        AppSettingsWindow.shared.manager = mgr
        Screenshotter.overlayPanels = { [weak mgr] in mgr?.capturePanels() ?? [:] }
        RecordingController.shared.server = server
        server.onRecordMessage = { type, msg, bridge in
            runOnMain { RecordingController.shared.handleExtensionMessage(type, msg, from: bridge) }
        }
        HotKey.registerRecord { Task { @MainActor in RecordingController.shared.hotKey() } }
        menuBar = MenuBarController(manager: mgr, server: server, capturer: capturer)

        // The Chrome hot keys do nothing in capture-only mode.
        HotKey.registerPin { [weak mgr] in
            Task { @MainActor in
                guard Settings.useChrome else { return }
                mgr?.togglePinFocused(requireChromeFrontmost: true)
            }
        }
        HotKey.registerToggleOverlay { [weak mgr] in
            Task { @MainActor in
                guard Settings.useChrome else { return }
                mgr?.toggleOverlay(requireChromeFrontmost: true)
            }
        }

        HotKey.registerLittle { [weak self] in
            Task { @MainActor in
                guard Settings.useChrome else { return }
                self?.router.openNewLittle()
            }
        }

        HotKey.registerCaptures(
            screen: { [weak self] in Task { @MainActor in self?.capturer.capture(.screen) } },
            area: { [weak self] in Task { @MainActor in self?.capturer.capture(.area) } },
            window: { [weak self] in Task { @MainActor in self?.capturer.capture(.window) } },
            chromePage: { [weak mgr] in Task { @MainActor in if Settings.useChrome { mgr?.captureChromePage() } } },
            activeWindow: { [weak self] in Task { @MainActor in self?.capturer.capture(.activeWindow) } },
            repeatArea: { [weak self] in Task { @MainActor in self?.capturer.capture(.repeatArea) } },
            scrolling: { [weak self] in Task { @MainActor in self?.capturer.capture(.scrolling) } })

        permissions.server = server
        NotificationCenter.default.addObserver(forName: .sidebarReviewPermissions, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.permissions.show() }
        }
        NotificationCenter.default.addObserver(forName: .sidebarSetUpChrome, object: nil, queue: .main) { _ in
            Task { @MainActor in ChromeSetup.run() }
        }

        // Opened by the user (Finder, Spotlight) rather than hidden by Chrome's connector (`open -g`): the app is active
        // shortly after launch. Bring the menu bar icon back if it was hidden, so the app is never unreachable.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if NSApp.isActive && !Settings.showMenuBarIcon {
                Log.write("opened by the user: showing the menu bar icon again")
                Settings.showMenuBarIcon = true
            }
        }

        // v3.5c: the mode, and the app-owned capture settings
        NotificationCenter.default.addObserver(forName: .stileModeChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.startForMode(runtimeSwitch: true) }
        }
        NotificationCenter.default.addObserver(forName: .stileCaptureSettingsChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.manager?.pushAppState()
                CaptureEditors.shared.refreshConfigs()
            }
        }
        if Settings.modeDecided {
            startForMode(runtimeSwitch: false)
        } else {
            // first run: ask before touching Chrome or Accessibility
            modeChoice.show { [weak self] useChrome in
                Log.write("mode: first run, chose \(useChrome ? "Stile for Chrome" : "capture only")")
                Settings.useChrome = useChrome   // posts; startForMode(runtimeSwitch: true) runs from the observer
                if useChrome == false { self?.menuBar?.sync() }
            }
        }
    }

    /// Starts what the current mode needs. Chrome mode: the native host manifest, the permissions flow (Accessibility)
    /// and the overlay manager. Capture-only: stops the manager and its event taps; only Screen Recording is asked for.
    /// The native host manifest is not written in capture-only mode; one already there is left alone (harmless: an
    /// installed extension can still connect for the capture settings, and switching back needs no re-registration).
    private func startForMode(runtimeSwitch: Bool) {
        if Settings.useChrome {
            HostSetup.registerManifest()
            HostSetup.removeOldManifest()
            permissions.modeChanged()
            permissions.ensure { [weak self] in
                guard let self = self else { return }
                self.manager?.start()
                self.server.setOverlayRunning(true)
            }
            // switching Chrome mode on later runs the normal Chrome onboarding
            if runtimeSwitch { permissions.show() }
        } else {
            manager?.stop()
            server.setOverlayRunning(false)
            permissions.modeChanged()
            permissions.ensureCaptureOnly()
        }
        manager?.pushAppState()
        menuBar?.sync()
    }

    /// v2.8: links (and HTML files) handed to us as the default browser. Only reached in the normal app
    /// process; connector mode (Chrome launching this executable) exits before an AppDelegate exists.
    func application(_ application: NSApplication, open urls: [URL]) {
        // capture-only mode has no little windows: links go straight to Chrome
        if Settings.useChrome { router.handle(urls) } else { LittleLinks.openInChrome(urls) }
    }

    /// The app is opened again from Finder while already running: show the menu bar icon if it was hidden.
    /// The Dock icon (shown only while a screenshot editor is open) brings the latest editor window forward.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if CaptureEditors.shared.reopen() { return false }
        if RecordingWindows.shared.reopenFront() { return false }
        if AppSettingsWindow.shared.isOpen { AppSettingsWindow.shared.show(); return false }
        if !Settings.showMenuBarIcon {
            Log.write("reopened from Finder: showing the menu bar icon again")
            Settings.showMenuBarIcon = true   // posts; the menu bar controller adds the status item
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        manager?.controllers.values.forEach { $0.teardown() }
        server.stop()
        Log.write("Stile quit")
    }

    /// A hidden Edit menu so Cmd+C / Cmd+V / Cmd+A / Cmd+Z reach text fields in the sidebar's web view.

    private func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        // v3.4: the screenshot editor windows
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.mainMenu = main
    }
}

@main
@MainActor
enum StileMain {
    static func main() {
        // Connector mode: Chrome started this executable as a native messaging host.
        // Must happen before anything touches AppKit.
        if Connector.isConnectorLaunch() {
            Connector.run()
        }
        // Development: `STILE_PREVIEW_RECORDING=/path/clip.mp4 .build/debug/StileApp` opens only the recording editor (no
        // migration, server or overlay, nothing written to the recent recordings), to work on its design beside a running Stile.
        if let path = ProcessInfo.processInfo.environment["STILE_PREVIEW_RECORDING"] {
            NSApplication.shared.setActivationPolicy(.regular)
            RecordingWindows.shared.previewForDevelopment(URL(fileURLWithPath: path))
            NSApplication.shared.run()
            return
        }
        Migration.run()
        // Started normally (Finder, login item): clear any earlier "quit by user" so Chrome can wake us again.
        try? FileManager.default.removeItem(atPath: HostPaths.quitFlagPath)
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
