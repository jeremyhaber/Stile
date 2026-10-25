import AppKit
import Foundation
import StileCore

/// Launch-time housekeeping: native messaging manifest, import of the old helper's state, clean-up.
enum HostSetup {
    static let hostName = "com.stile.helper"
    /// v3.10: the ID of the unpacked extension, fixed by the key in extension/manifest.json.
    static let unpackedExtensionID = "ffblekellgdmlecjablfojaaadpkmdgg"
    static let extensionOrigin = "chrome-extension://" + unpackedExtensionID + "/"

    // TODO: after publishing, paste the Chrome Web Store ID here (32 letters a-p, from the store URL). If the
    // store upload reused the manifest key, it equals unpackedExtensionID. While this is the placeholder every
    // store-install feature stays off.
    /// v3.10: the Chrome Web Store ID of the published extension.
    static let storeExtensionID = "REPLACE_WITH_STORE_ID"

    /// v3.10: true once storeExtensionID is a real Chrome ID; the placeholder disables all store logic.
    static var storeIDSet: Bool { ExtensionInstall.isValidID(storeExtensionID) }

    /// v3.10: native messaging origins to allow: unpacked first, the store ID too when set and different.
    static var allowedOrigins: [String] {
        var o = [extensionOrigin]
        if storeIDSet && storeExtensionID != unpackedExtensionID { o.append("chrome-extension://" + storeExtensionID + "/") }
        return o
    }

    /// v3.10: IDs to look for in a profile's preferences.
    static var knownExtensionIDs: [String] {
        storeIDSet && storeExtensionID != unpackedExtensionID ? [unpackedExtensionID, storeExtensionID] : [unpackedExtensionID]
    }

    /// v3.10: how the extension is installed in each profile (by dir), from its Preferences and Secure Preferences.
    /// Profiles without it are absent from the result.
    static func installedKinds() -> [String: ExtensionInstallKind] {
        let dataDir = (HostPaths.localState as NSString).deletingLastPathComponent
        func read(_ path: String) -> [String: Any]? {
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
                  (attrs[.size] as? Int ?? 0) <= HostStore.maxPrefs,
                  let raw = FileManager.default.contents(atPath: path) else { return nil }
            return (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any]
        }
        var out: [String: ExtensionInstallKind] = [:]
        for p in HostStore.readProfiles(withExtras: false) {
            guard let dir = p["dir"] as? String, !dir.isEmpty, !dir.contains("/"), !dir.contains("\\"),
                  dir != ".", dir != ".." else { continue }
            let base = dataDir + "/" + dir
            if let k = ExtensionInstall.installKind(preferences: read(base + "/Preferences"),
                                                    securePreferences: read(base + "/Secure Preferences"),
                                                    ids: knownExtensionIDs) {
                out[dir] = k
            }
        }
        return out
    }

    static func runAtLaunch() {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: HostPaths.appDir, withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o700])
        importLegacyState()
        removeLegacyHelper()
        // v3.5c: capture-only mode (or an undecided first run) doesn't register the native host
        if Settings.modeDecided && Settings.useChrome {
            registerManifest()
            removeOldManifest()
        }
    }

    /// The pre-rename host name; its manifest is deleted once the new one is in place.
    static let oldHostName = "com.sidebar.helper"

    /// Deletes .../NativeMessagingHosts/com.sidebar.helper.json (Chrome's directory, the only one the app registers in)
    /// once the new manifest exists, so Chrome no longer finds the old host.
    static func removeOldManifest() {
        let fm = FileManager.default
        guard fm.fileExists(atPath: HostPaths.nativeMessagingDir + "/" + hostName + ".json") else { return }
        let old = HostPaths.nativeMessagingDir + "/" + oldHostName + ".json"
        guard fm.fileExists(atPath: old) else { return }
        do {
            try fm.removeItem(atPath: old)
            Log.write("setup: removed old manifest \(old)")
        } catch {
            Log.write("setup: cannot remove \(old): \(error.localizedDescription)")
        }
    }

    /// Writes ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.stile.helper.json
    /// pointing at this executable (rewritten when the path changed; replaces an old Perl helper manifest).
    static func registerManifest() {
        guard let exe = Bundle.main.executablePath else {
            Log.write("setup: no executable path; manifest not written")
            return
        }
        let manifest: [String: Any] = [
            "name": hostName,
            "description": "Stile",
            "path": exe,
            "type": "stdio",
            "allowed_origins": allowedOrigins,
        ]
        let dir = HostPaths.nativeMessagingDir
        let file = dir + "/" + hostName + ".json"
        let fm = FileManager.default
        if let data = fm.contents(atPath: file),
           let existing = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           NSDictionary(dictionary: existing).isEqual(to: manifest) {
            return
        }
        do {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            guard var data = try? JSONSerialization.data(withJSONObject: manifest,
                                                         options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return }
            data.append(0x0A)
            try data.write(to: URL(fileURLWithPath: file), options: .atomic)
            Log.write("setup: wrote native messaging manifest \(file) -> \(exe)")
        } catch {
            Log.write("setup: cannot write manifest \(file): \(error.localizedDescription)")
        }
    }

    /// First launch: copy the old helper's state.json (archive default, profile styles).
    private static func importLegacyState() {
        let fm = FileManager.default
        let dest = HostPaths.stateFile
        let old = HostPaths.legacyDir + "/state.json"
        guard !fm.fileExists(atPath: dest), fm.fileExists(atPath: old) else { return }
        do {
            try fm.copyItem(atPath: old, toPath: dest)
            Log.write("setup: imported \(old)")
        } catch {
            Log.write("setup: cannot import \(old): \(error.localizedDescription)")
        }
    }

    private static func removeLegacyHelper() {
        let script = HostPaths.legacyDir + "/sidebar-helper.pl"
        guard FileManager.default.fileExists(atPath: script) else { return }
        do {
            try FileManager.default.removeItem(atPath: script)
            Log.write("setup: removed old Perl helper \(script)")
        } catch {
            Log.write("setup: cannot remove \(script): \(error.localizedDescription)")
        }
    }
}

/// Things the app does on request (switching profiles, the setup card's buttons).
enum HostActions {
    static func chromeBinary() -> String {
        if let e = ProcessInfo.processInfo.environment["SIDEBAR_CHROME_BIN"], !e.isEmpty { return e }
        let def = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        if FileManager.default.isExecutableFile(atPath: def) { return def }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
            return url.appendingPathComponent("Contents/MacOS/Google Chrome").path
        }
        return def
    }

    /// Runs the Chrome binary directly, detached; with Chrome already running this hands the arguments
    /// to the running instance. Returns an error message, or nil on success.
    static func launchChrome(args: [String]) -> String? {
        let bin = chromeBinary()
        guard FileManager.default.isExecutableFile(atPath: bin) else {
            return "Chrome binary not found or not executable: \(bin)"
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = args
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
        } catch {
            return "launch failed: \(error.localizedDescription)"
        }
        Log.write("launched Chrome pid \(p.processIdentifier) \(args.joined(separator: " "))")
        return nil
    }

    /// Opens chrome://extensions in a window of the given profile.
    static func openExtensionsPage(profileDir: String) {
        if let err = launchChrome(args: ["--profile-directory=\(profileDir)", "chrome://extensions"]) {
            Log.write("setup: cannot open chrome://extensions: \(err)")
        }
    }

    /// v3.10: opens the extension's Chrome Web Store page in a window of the given profile (user-initiated).
    static func openStorePage(profileDir: String) {
        guard HostSetup.storeIDSet else { return }
        let url = "https://chromewebstore.google.com/detail/" + HostSetup.storeExtensionID
        if let err = launchChrome(args: ["--profile-directory=\(profileDir)", url]) {
            Log.write("setup: cannot open the store page: \(err)")
        }
    }

    static var bundledExtensionURL: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("extension", isDirectory: true)
    }

    static func revealExtensionFolder() {
        guard let url = bundledExtensionURL, FileManager.default.fileExists(atPath: url.path) else {
            Log.write("setup: bundled extension folder not found")
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}

/// The "Add the Stile extension to this profile" card, shown instead of the UI for Chrome windows
/// whose profile has no connected extension.
enum SetupCard {
    private static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    static func html(candidates: [(dir: String, name: String)]) -> String {
        var buttons = ""
        for c in candidates {
            let label = candidates.count == 1 ? "Open chrome://extensions" : "Open chrome://extensions in \(esc(c.name))"
            buttons += "<button data-dir=\"\(esc(c.dir))\" onclick=\"post('openExtensions', this.getAttribute('data-dir'))\">\(label)</button>\n"
        }
        // v3.10: with a store ID, "Add from Chrome Web Store" leads and the unpacked steps get a subheading.
        // Both stay empty with the placeholder, which keeps the output unchanged.
        var storeBlock = ""
        var devHeading = ""
        var storeCSS = ""
        if HostSetup.storeIDSet {
            for c in candidates {
                let label = candidates.count == 1 ? "Add from Chrome Web Store" : "Add from Chrome Web Store in \(esc(c.name))"
                storeBlock += "<button class=\"primary\" data-dir=\"\(esc(c.dir))\" onclick=\"post('openStore', this.getAttribute('data-dir'))\">\(label)</button>\n"
            }
            storeBlock = "<div class=\"store\">\(storeBlock)</div>"
            devHeading = "<h2>Developer: load unpacked</h2>"
            storeCSS = "h2{font-size:11px;font-weight:600;margin:18px 0 8px;opacity:.6}.store{margin-bottom:4px}button.primary{background:rgba(10,132,255,.9);color:#fff}button.primary:hover{background:rgba(10,132,255,1)}"
        }
        return """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <style>
        :root{color-scheme:light dark}
        body{margin:0;font:13px -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}
        .mini{display:none;height:100vh;align-items:center;justify-content:center;font-size:18px;opacity:.7}
        .card{padding:18px 16px;overflow:auto;height:100vh;box-sizing:border-box}
        h1{font-size:14px;margin:0 0 10px}
        ol{margin:0;padding-left:18px}
        li{margin:0 0 12px;line-height:1.4}
        li span{display:block;opacity:.75}
        button{display:block;margin-top:6px;font:inherit;padding:5px 10px;border-radius:8px;border:0;
          background:rgba(128,128,128,.22);color:inherit;cursor:pointer;text-align:left}
        button:hover{background:rgba(128,128,128,.34)}
        p{opacity:.65;line-height:1.4}\(storeCSS)
        @media (max-width:120px){.card{display:none}.mini{display:flex}}
        </style>
        <div class="mini" title="Add the Stile extension to this profile">+</div>
        <div class="card"><h1>Add the Stile extension to this profile</h1>\(storeBlock)\(devHeading)
        <ol>
        <li>Open the extensions page<span>chrome://extensions</span>
        \(buttons)</li>
        <li>Turn on <b>Developer mode</b><span>Switch in the top right corner.</span></li>
        <li>Click <b>Load unpacked</b> and choose the <b>extension</b> folder
        <button onclick="post('revealExtension', null)">Show extension folder</button></li>
        </ol>
        <p>This sidebar connects by itself once the extension is loaded.</p></div>
        <script>
        function post(action, value){
          try { window.webkit.messageHandlers.sidebarBridge.postMessage(JSON.stringify({type:'host', action:action, value:value})); } catch (e) {}
        }
        </script>
        """
    }
}
