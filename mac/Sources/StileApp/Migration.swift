import Foundation

/// One-time carry-over from the app's former name (Sidebar, bundle id ca.simplistics.sidebar) to Stile.
/// Runs at the very start of a normal launch (not in connector mode), before the quit-by-user flag is cleared.
enum Migration {
    static let oldBundleID = "ca.simplistics.sidebar"
    /// Every UserDefaults key the app reads or writes.
    static let defaultsKeys = ["peekWidth", "sidebarWidth", "showMenuBarIcon", "greenButtonAction",
                               "greenButtonNotePending", "permissionsOnboarded", "screenCaptureAsked", "captureWindowShadow"]

    static func run() {
        migrateSupportDir()
        migrateDefaults()
    }

    /// ~/Library/Application Support/Sidebar -> Stile: only when the old folder exists and the new one doesn't.
    /// Moves state.json and the quit-by-user flag; host.sock is recreated by the new app.
    private static func migrateSupportDir() {
        // Skip when the location is overridden (tests, development).
        if let e = ProcessInfo.processInfo.environment["SIDEBAR_APP_DIR"], !e.isEmpty { return }
        let fm = FileManager.default
        let base = NSHomeDirectory() + "/Library/Application Support"
        let old = base + "/Sidebar", new = base + "/Stile"
        guard fm.fileExists(atPath: old), !fm.fileExists(atPath: new) else { return }
        do {
            try fm.createDirectory(atPath: new, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            for name in ["state.json", "quit-by-user"] where fm.fileExists(atPath: old + "/" + name) {
                try fm.moveItem(atPath: old + "/" + name, toPath: new + "/" + name)
            }
            try? fm.removeItem(atPath: old + "/host.sock")
            try? fm.removeItem(atPath: old)   // only succeeds when nothing else is left in it
            Log.write("migrate: moved \(old) -> \(new)")
        } catch {
            Log.write("migrate: support folder move failed: \(error.localizedDescription)")
        }
    }

    /// Copies the preferences from the old bundle's domain for keys not yet set under the new bundle id.
    private static func migrateDefaults() {
        guard Bundle.main.bundleIdentifier != oldBundleID else { return }
        let new = UserDefaults.standard
        var copied: [String] = []
        for key in defaultsKeys where new.object(forKey: key) == nil {
            if let v = CFPreferencesCopyAppValue(key as CFString, oldBundleID as CFString) {
                new.set(v, forKey: key)
                copied.append(key)
            }
        }
        if !copied.isEmpty { Log.write("migrate: copied preferences from \(oldBundleID): \(copied.joined(separator: ", "))") }
    }
}
