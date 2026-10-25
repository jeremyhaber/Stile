import AppKit
import AVFoundation
import Foundation
import Security

extension Notification.Name {
    /// v3.5c: a capture setting changed (any origin): editors, the settings window and connected extensions refresh.
    static let stileCaptureSettingsChanged = Notification.Name("ca.simplistics.stile.captureSettingsChanged")
    /// v3.5c: "Use Stile with Chrome" was switched.
    static let stileModeChanged = Notification.Name("ca.simplistics.stile.modeChanged")
}

/// The S3 secret access key lives in the Keychain (generic password), never in state.json.
enum Keychain {
    private static var service: String { (Bundle.main.bundleIdentifier ?? "ca.simplistics.stile") + ".s3" }

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func get(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status != errSecSuccess && status != errSecItemNotFound { Log.write("keychain: read failed (\(status))") }
        guard status == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    @discardableResult
    static func set(_ account: String, _ value: String) -> Bool {
        if value.isEmpty { return delete(account) }
        let data = Data(value.utf8)
        let status = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return true }
        var add = query(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let s2 = SecItemAdd(add as CFDictionary, nil)
        if s2 != errSecSuccess { Log.write("keychain: write failed (\(s2))") }
        return s2 == errSecSuccess
    }

    @discardableResult
    static func delete(_ account: String) -> Bool {
        let s = SecItemDelete(query(account) as CFDictionary)
        return s == errSecSuccess || s == errSecItemNotFound
    }
}

/// v3.5c: the app owns the capture settings (state.json `capture`; the S3 secret in the Keychain). The extension edits
/// them through the `appSetting` relay when connected and keeps its own copy for side-panel-only use; the editor window
/// gets its config from here. Recording keys are reserved for 3.6.
@MainActor
final class CaptureSettings {
    static let shared = CaptureSettings()

    static let defaultPattern = "Screenshot {yyyy}-{mm}-{dd} at {hh}.{min}.{ss}"
    static let secretAccount = "s3-secret-access-key"
    private static let s3Strings = ["endpoint", "region", "bucket", "accessKeyId", "prefix", "publicBase"]
    private var secretCache: String??   // nil = not read yet; .some(nil) = none stored

    // MARK: Storage

    private var stored: [String: Any] { (HostStore.readState()["capture"] as? [String: Any]) ?? [:] }

    private func save(_ mutate: (inout [String: Any]) -> Void) {
        var st = HostStore.readState()
        var cap = (st["capture"] as? [String: Any]) ?? [:]
        mutate(&cap)
        st["capture"] = cap
        HostStore.writeState(st)
    }

    /// Carries the old `UserDefaults` window-shadow switch (3.5a) over to state.json; runs at launch.
    func migrate() {
        guard stored["windowShadow"] == nil, let old = UserDefaults.standard.object(forKey: "captureWindowShadow") as? Bool else { return }
        save { $0["windowShadow"] = old }
        Log.write("capture settings: moved the window shadow switch to state.json")
    }

    // MARK: Values

    private static func expand(_ p: String) -> String { (p as NSString).expandingTildeInPath }

    static var defaultScreenshotFolder: URL {
        (FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")).appendingPathComponent("Screenshots", isDirectory: true)
    }
    static var defaultRecordingFolder: URL {
        (FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Movies")).appendingPathComponent("Stile", isDirectory: true)
    }

    var screenshotFolder: URL {
        if let p = stored["screenshotFolder"] as? String, !p.isEmpty { return URL(fileURLWithPath: Self.expand(p), isDirectory: true) }
        return Self.defaultScreenshotFolder
    }
    var recordingFolder: URL {
        if let p = stored["recordingFolder"] as? String, !p.isEmpty { return URL(fileURLWithPath: Self.expand(p), isDirectory: true) }
        return screenshotFolder   // no separate recordings folder chosen: follow the screenshot folder
    }
    /// True while no separate recordings folder is set (clear it by applying `recordingFolder: ""`).
    var recordingFolderFollowsScreenshots: Bool {
        !((stored["recordingFolder"] as? String).map { !$0.isEmpty } ?? false)
    }
    var filenamePattern: String {
        let p = (stored["filenamePattern"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        return p.isEmpty ? Self.defaultPattern : p
    }
    var windowShadow: Bool {
        get { (stored["windowShadow"] as? Bool) ?? (UserDefaults.standard.object(forKey: "captureWindowShadow") as? Bool) ?? true }
        set { apply(["windowShadow": newValue]) }
    }
    var annotate: Bool { (stored["annotate"] as? Bool) ?? true }
    var askWhere: Bool { (stored["askWhere"] as? Bool) ?? false }

    /// The reserved recording defaults (3.6 reads these).
    var recording: [String: Any] {
        let r = (stored["recording"] as? [String: Any]) ?? [:]
        return [
            "micDeviceId": (r["micDeviceId"] as? String) ?? "",
            "systemAudio": (r["systemAudio"] as? Bool) ?? false,
            "countdown": (r["countdown"] as? Bool) ?? true,
            "fps": (r["fps"] as? Int) == 60 ? 60 : 30,
            "codec": (r["codec"] as? String) == "hevc" ? "hevc" : "h264",
            "maxResolution": ["1080p", "1440p", "native"].contains((r["maxResolution"] as? String) ?? "") ? r["maxResolution"]! : "1080p",
            "showCursor": (r["showCursor"] as? Bool) ?? true,
        ]
    }

    /// The extension's S3 shape (see `DEFAULT_S3` in capture/s3.js) minus the secret.
    private var s3Public: [String: Any] {
        let s = (stored["s3"] as? [String: Any]) ?? [:]
        var out: [String: Any] = [:]
        for k in Self.s3Strings { out[k] = (s[k] as? String) ?? "" }
        out["prefix"] = (s["prefix"] as? String) ?? "screenshots/{yyyy}/{mm}/"
        out["regionAuto"] = (s["regionAuto"] as? Bool) ?? true
        out["style"] = ["auto", "path", "virtual"].contains((s["style"] as? String) ?? "") ? s["style"]! : "auto"
        out["naming"] = (s["naming"] as? String) == "timestamp" ? "timestamp" : "random"
        out["linkType"] = (s["linkType"] as? String) == "public" ? "public" : "presigned"
        out["recordingShare"] = (s["recordingShare"] as? String) == "file" ? "file" : "page"
        out["expiry"] = min(604_800, max(1, (s["expiry"] as? Int) ?? 604_800))
        out["v"] = 2
        return out
    }

    var secretAccessKey: String {
        if let c = secretCache { return c ?? "" }
        let v = Keychain.get(Self.secretAccount)
        secretCache = .some(v)
        return v ?? ""
    }

    private func setSecret(_ v: String) {
        Keychain.set(Self.secretAccount, v)
        secretCache = .some(v.isEmpty ? nil : v)
    }

    var s3Configured: Bool {
        let s = s3Public
        return !(s["endpoint"] as! String).isEmpty && !(s["bucket"] as! String).isEmpty
            && !(s["accessKeyId"] as! String).isEmpty && !secretAccessKey.isEmpty
    }

    // MARK: Views

    /// What the settings pages and `appState` carry: no secret (`secretSet` says whether there is one).
    /// `full` adds the secret (the connection test; never put in appState).
    func publicDict(full: Bool = false) -> [String: Any] {
        var s3 = s3Public
        s3["secretSet"] = !secretAccessKey.isEmpty
        if full { s3["secretAccessKey"] = secretAccessKey }
        return [
            "screenshotFolder": screenshotFolder.path, "recordingFolder": recordingFolder.path,
            "recordingFolderFollowsScreenshots": recordingFolderFollowsScreenshots,
            "defaultScreenshotFolder": Self.defaultScreenshotFolder.path, "defaultRecordingFolder": Self.defaultRecordingFolder.path,
            "filenamePattern": filenamePattern, "defaultPattern": Self.defaultPattern,
            "windowShadow": windowShadow, "annotate": annotate, "askWhere": askWhere,
            "s3": s3, "recording": recording,
        ]
    }

    /// The config the editor window loads (`window.__stileConfig` shape): the app's settings plus the profile's colour.
    func editorConfig(sidebarColor: Any?) -> [String: Any] {
        var s3 = s3Public
        s3["secretAccessKey"] = secretAccessKey
        var cfg: [String: Any] = ["annotate": annotate, "askWhere": askWhere, "s3": s3]
        if let c = sidebarColor, !(c is NSNull) { cfg["sidebarColor"] = c }
        return cfg
    }

    // MARK: Changes

    /// Applies a patch from the relay / settings window; unknown keys and invalid values are ignored.
    func apply(_ patch: [String: Any]) {
        var changed = false
        var newSecret: String?
        save { cap in
            func str(_ v: Any?, max: Int = 500) -> String? { (v as? String).map { String($0.prefix(max)) } }
            for k in ["screenshotFolder", "recordingFolder"] {
                // "" = back to the default (for recordings: same as screenshots); otherwise an absolute (or ~) path
                if let p = str(patch[k], max: 1024), p.isEmpty || p.hasPrefix("/") || p.hasPrefix("~") { cap[k] = p; changed = true }
            }
            if let p = str(patch["filenamePattern"], max: 200) { cap["filenamePattern"] = p; changed = true }
            for k in ["windowShadow", "annotate", "askWhere"] where HostStore.isBool(patch[k]) {
                cap[k] = patch[k] as? Bool ?? false; changed = true
            }
            if let s = patch["s3"] as? [String: Any] {
                var cur = (cap["s3"] as? [String: Any]) ?? [:]
                for k in Self.s3Strings { if let v = str(s[k]) { cur[k] = v.trimmingCharacters(in: .whitespaces) } }
                if HostStore.isBool(s["regionAuto"]) { cur["regionAuto"] = s["regionAuto"] as? Bool ?? true }
                if let v = s["style"] as? String, ["auto", "path", "virtual"].contains(v) { cur["style"] = v }
                if let v = s["naming"] as? String, ["random", "timestamp"].contains(v) { cur["naming"] = v }
                if let v = s["linkType"] as? String, ["presigned", "public"].contains(v) { cur["linkType"] = v }
                if let v = s["recordingShare"] as? String, ["page", "file"].contains(v) { cur["recordingShare"] = v }
                if let n = (s["expiry"] as? NSNumber)?.intValue { cur["expiry"] = min(604_800, max(1, n)) }
                if let sec = s["secretAccessKey"] as? String { newSecret = String(sec.prefix(512)).trimmingCharacters(in: .whitespacesAndNewlines) }
                cap["s3"] = cur
                changed = true
            }
            if let r = patch["recording"] as? [String: Any] {
                var cur = (cap["recording"] as? [String: Any]) ?? [:]
                if let v = str(r["micDeviceId"]) { cur["micDeviceId"] = v }
                for k in ["systemAudio", "countdown", "showCursor"] where HostStore.isBool(r[k]) { cur[k] = r[k] as? Bool ?? false }
                if let n = (r["fps"] as? NSNumber)?.intValue, n == 30 || n == 60 { cur["fps"] = n }
                if let v = r["codec"] as? String, ["h264", "hevc"].contains(v) { cur["codec"] = v }
                if let v = r["maxResolution"] as? String, ["1080p", "1440p", "native"].contains(v) { cur["maxResolution"] = v }
                cap["recording"] = cur
                changed = true
            }
        }
        if let s = newSecret { setSecret(s); changed = true }
        guard changed else { return }
        NotificationCenter.default.post(name: .stileCaptureSettingsChanged, object: nil)
    }

    /// First connection of an extension that has an S3 setup while the app has none: adopt it, once, and keep the
    /// secret in the Keychain. `cfg` is the extension's `captureConfig`.
    func adoptIfEmpty(from cfg: [String: Any]) {
        guard stored["s3Adopted"] as? Bool != true, !s3Configured, let s3 = cfg["s3"] as? [String: Any],
              let bucket = s3["bucket"] as? String, !bucket.isEmpty else { return }
        var patch: [String: Any] = ["s3": s3]
        if HostStore.isBool(cfg["annotate"]), stored["annotate"] == nil { patch["annotate"] = cfg["annotate"] }
        if HostStore.isBool(cfg["askWhere"]), stored["askWhere"] == nil { patch["askWhere"] = cfg["askWhere"] }
        apply(patch)
        save { $0["s3Adopted"] = true }
        Log.write("capture settings: adopted the extension's S3 setup (bucket \(bucket)); the secret is in the Keychain")
    }

    // MARK: File names and folders

    /// "Screenshot 2026-10-24 at 14.03.22.png" from the pattern: {yyyy} {mm} {dd} {hh} {min} {ss} {app}.
    func fileName(app: String, date: Date = Date(), ext: String = "png") -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        func p(_ n: Int?, _ w: Int = 2) -> String { String(format: "%0\(w)d", n ?? 0) }
        var s = filenamePattern
        for (token, value) in [("{yyyy}", p(c.year, 4)), ("{mm}", p(c.month)), ("{dd}", p(c.day)), ("{hh}", p(c.hour)),
                               ("{min}", p(c.minute)), ("{ss}", p(c.second)), ("{app}", app)] {
            s = s.replacingOccurrences(of: token, with: value)
        }
        s = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".").trimmingCharacters(in: .whitespaces)
        if s.isEmpty || s.hasPrefix(".") { s = Date().formatted(.iso8601) }
        return s + "." + ext
    }

    /// Input devices for the reserved recording microphone choice.
    static func microphones() -> [[String: String]] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone], mediaType: .audio, position: .unspecified)
            .devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
    }

    /// A folder chooser (the settings pages ask for it); applies the pick as `key` ("screenshotFolder" / "recordingFolder").
    func chooseFolder(key: String, completion: (() -> Void)? = nil) {
        guard key == "screenshotFolder" || key == "recordingFolder" else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.title = key == "screenshotFolder" ? "Save screenshots to" : "Save recordings to"
        panel.directoryURL = key == "screenshotFolder" ? screenshotFolder : recordingFolder
        NSApp.activate()
        if panel.runModal() == .OK, let url = panel.url { apply([key: url.path]) }
        completion?()
    }
}

extension Settings {
    /// 3.5a switch, now owned by `CaptureSettings` (state.json).
    static var captureWindowShadow: Bool {
        get { MainActor.assumeIsolated { CaptureSettings.shared.windowShadow } }
        set { MainActor.assumeIsolated { CaptureSettings.shared.windowShadow = newValue } }
    }
}
