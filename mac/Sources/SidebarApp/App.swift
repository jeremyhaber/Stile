import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = HostServer()
    private var manager: OverlayManager?
    private let permissions = Permissions()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One instance only: it owns host.sock.
        if let bundleID = Bundle.main.bundleIdentifier {
            let me = ProcessInfo.processInfo.processIdentifier
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
                .filter { $0.processIdentifier != me && !$0.isTerminated }
            if !others.isEmpty {
                Log.write("Sidebar already running (pid \(others[0].processIdentifier)); exiting")
                NSApp.terminate(nil)
                return
            }
        }
        Log.write("Sidebar \(AppInfo.version) launching (no menu bar icon, no Dock icon)")
        installMainMenu()

        HostSetup.runAtLaunch()
        server.start()
        let mgr = OverlayManager(server: server)
        manager = mgr

        HotKey.register { [weak mgr] in
            Task { @MainActor in
                mgr?.togglePinFocused(requireChromeFrontmost: true)
            }
        }

        permissions.ensure { [weak self] in
            guard let self = self else { return }
            self.manager?.start()
            self.server.setOverlayRunning(true)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        manager?.controllers.values.forEach { $0.teardown() }
        server.stop()
        Log.write("Sidebar quit")
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
        NSApp.mainMenu = main
    }
}

@main
@MainActor
enum SidebarMain {
    static func main() {
        // Connector mode: Chrome started this executable as a native messaging host.
        // Must happen before anything touches AppKit.
        if Connector.isConnectorLaunch() {
            Connector.run()
        }
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
