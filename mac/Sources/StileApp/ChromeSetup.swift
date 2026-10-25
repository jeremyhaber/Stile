import AppKit
import Foundation

/// Puts Chrome in the layout the overlay expects: vertical tabs on, and Chrome's own expand-on-hover off (it
/// would open the rail under the sidebar's peek). Both are plain prefs in <profile>/Preferences. Chrome reads
/// them at launch and rewrites the file on quit, so a running Chrome is quit first (after asking) and
/// relaunched with its session restored. The rail's collapsed state is left alone: pinning drives it.
@MainActor
enum ChromeSetup {
    static let bundleID = "com.google.Chrome"
    private static var busy = false

    /// Pref path, wanted value, Chrome's default when the pref is missing.
    private static let wanted: [(path: [String], value: Bool, fallback: Bool)] = [
        (["vertical_tabs", "enabled"], true, false),
        (["vertical_tabs", "expand_on_hover"], false, false),
    ]

    private static var dataDir: String { (HostPaths.localState as NSString).deletingLastPathComponent }

    private static func prefsPath(_ dir: String) -> String? {
        guard !dir.isEmpty, !dir.contains("/"), dir != ".", dir != ".." else { return nil }
        return dataDir + "/" + dir + "/Preferences"
    }

    private static func readPrefs(_ path: String) -> [String: Any]? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              (attrs[.size] as? Int ?? 0) <= HostStore.maxPrefs,
              let raw = FileManager.default.contents(atPath: path) else { return nil }
        return (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any]
    }

    private static func bool(_ prefs: [String: Any], _ path: [String]) -> Bool? {
        var o: Any? = prefs
        for k in path { o = (o as? [String: Any])?[k] }
        return o as? Bool
    }

    private static func setting(_ obj: [String: Any], _ path: ArraySlice<String>, _ v: Bool) -> [String: Any] {
        guard let k = path.first else { return obj }
        var o = obj
        o[k] = path.count == 1 ? v : setting((o[k] as? [String: Any]) ?? [:], path.dropFirst(), v)
        return o
    }

    /// Profiles whose Preferences exist and are not in the wanted layout (never-opened profiles have none).
    static func profilesNeedingSetup() -> [(dir: String, name: String)] {
        HostStore.readProfiles(withExtras: false).compactMap { p in
            guard let dir = p["dir"] as? String, let path = prefsPath(dir), let prefs = readPrefs(path) else { return nil }
            let ok = wanted.allSatisfy { (bool(prefs, $0.path) ?? $0.fallback) == $0.value }
            return ok ? nil : (dir, (p["name"] as? String) ?? dir)
        }
    }

    static var chromeRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }

    /// Sets up every profile that needs it. When Chrome is running, asks before quitting and relaunching it.
    /// `done(true)` once everything is set up (or nothing was needed).
    static func run(_ done: ((Bool) -> Void)? = nil) {
        guard !busy else { return }
        let todo = profilesNeedingSetup()
        guard !todo.isEmpty else { done?(true); return }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        if apps.isEmpty {
            done?(apply(todo))
            return
        }
        let names = todo.map(\.name)
        let alert = NSAlert()
        alert.messageText = "Restart Chrome to turn on vertical tabs?"
        alert.informativeText = "Stile will quit Chrome, set up " +
            (names.count == 1 ? "the \u{201C}\(names[0])\u{201D} profile" : "\(names.count) profiles") +
            ", and reopen it with your windows and tabs."
        alert.addButton(withTitle: "Restart Chrome")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { done?(false); return }

        busy = true
        Log.write("chrome setup: quitting Chrome to set up \(todo.map(\.dir).joined(separator: ", "))")
        for a in apps { a.terminate() }
        waitForQuit(until: Date().addingTimeInterval(20)) { quit in
            busy = false
            guard quit else {
                Log.write("chrome setup: Chrome did not quit")
                let a = NSAlert()
                a.messageText = "Chrome didn\u{2019}t quit"
                a.informativeText = "Close any \u{201C}Leave site?\u{201D} dialogs in Chrome and try again."
                a.runModal()
                done?(false)
                return
            }
            let ok = apply(todo)
            relaunch()
            done?(ok)
        }
    }

    private static func waitForQuit(until deadline: Date, _ then: @escaping @MainActor (Bool) -> Void) {
        if !chromeRunning { then(true); return }
        if Date() > deadline { then(false); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            Task { @MainActor in waitForQuit(until: deadline, then) }
        }
    }

    private static func apply(_ todo: [(dir: String, name: String)]) -> Bool {
        todo.reduce(true) { ok, p in write(dir: p.dir) && ok }
    }

    /// Writes the wanted prefs into one profile's Preferences, keeping a backup. Chrome must not be running.
    private static func write(dir: String) -> Bool {
        guard let path = prefsPath(dir), var prefs = readPrefs(path) else { return false }
        for w in wanted { prefs = setting(prefs, w.path[...], w.value) }
        guard let data = try? JSONSerialization.data(withJSONObject: prefs, options: [.withoutEscapingSlashes]) else {
            return false
        }
        let fm = FileManager.default
        let backup = path + ".stile-backup"
        do {
            let perms = (try? fm.attributesOfItem(atPath: path))?[.posixPermissions]
            try? fm.removeItem(atPath: backup)
            try fm.copyItem(atPath: path, toPath: backup)
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            if let perms = perms { try? fm.setAttributes([.posixPermissions: perms], ofItemAtPath: path) }
            Log.write("chrome setup: vertical tabs on in \(dir) (backup \(backup))")
            return true
        } catch {
            Log.write("chrome setup: cannot write \(path): \(error.localizedDescription)")
            return false
        }
    }

    private static func relaunch() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.arguments = ["--restore-last-session"]
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, err in
            if let e = err { Log.write("chrome setup: relaunch failed: \(e.localizedDescription)") }
        }
    }
}
