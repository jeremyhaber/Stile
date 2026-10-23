import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = BridgeServer()
    private var manager: OverlayManager?
    private var statusMenu: StatusMenu?
    private let permissions = Permissions()

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.write("Sidebar launching")
        installMainMenu()

        server.start()
        let mgr = OverlayManager(server: server)
        manager = mgr
        statusMenu = StatusMenu(manager: mgr, server: server)

        HotKey.register { [weak mgr] in
            Task { @MainActor in
                mgr?.togglePinFocused(requireChromeFrontmost: true)
            }
        }

        permissions.ensure { [weak mgr] in
            mgr?.start()
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
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
