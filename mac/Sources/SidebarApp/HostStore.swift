import CryptoKit
import Darwin
import Foundation

// Paths, Local State parsing and state.json: a port of the Perl helper's data layer.
// Everything here runs on the main queue (or, for HostPaths, in the connector process).

enum HostPaths {
    static let sunPathMax = 100   // macOS sun_path is 104 bytes incl. NUL; stay under.

    private static func env(_ name: String) -> String? {
        if let e = ProcessInfo.processInfo.environment[name], !e.isEmpty { return e }
        return nil
    }

    /// ~/Library/Application Support/Sidebar (override: SIDEBAR_APP_DIR).
    static var appDir: String {
        env("SIDEBAR_APP_DIR") ?? (NSHomeDirectory() + "/Library/Application Support/Sidebar")
    }

    /// Old Perl helper directory (override: SIDEBAR_HELPER_DIR).
    static var legacyDir: String {
        env("SIDEBAR_HELPER_DIR") ?? (NSHomeDirectory() + "/Library/Application Support/SidebarHelper")
    }

    static var localState: String {
        env("SIDEBAR_LOCAL_STATE") ?? (NSHomeDirectory() + "/Library/Application Support/Google/Chrome/Local State")
    }

    static var nativeMessagingDir: String {
        env("SIDEBAR_NMH_DIR") ?? (NSHomeDirectory() + "/Library/Application Support/Google/Chrome/NativeMessagingHosts")
    }

    static var stateFile: String { appDir + "/state.json" }
    /// Present while the user has quit the app from the sidebar's settings; the connector then won't relaunch it.
    static var quitFlagPath: String { appDir + "/quit-by-user" }

    static func md5Prefix(_ s: String) -> String {
        let digest = Insecure.MD5.hash(data: Data(s.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(12))
    }

    /// <APP_DIR>/host.sock, else <APP_DIR>/sock/<md5-12 of "host">.sock, else /tmp/sbh-<uid>-<md5-12>.sock.
    /// A pure function of the app dir, so the app and the connector always agree.
    static func hostSocketPath() -> String {
        let dir = appDir
        var path = dir + "/host.sock"
        if path.utf8.count > sunPathMax {
            path = dir + "/sock/" + md5Prefix("host") + ".sock"
            if path.utf8.count > sunPathMax {
                path = "/tmp/sbh-\(getuid())-" + md5Prefix(dir + "\u{0}host") + ".sock"
            }
        }
        return path
    }
}

enum HostStore {
    static let allowedIcons: Set<String> = [
        "picture", "initial", "home", "briefcase", "code", "star", "heart", "book", "music", "camera",
        "palette", "rocket", "leaf", "coffee", "game", "globe", "bolt", "moon",
    ]
    static let maxPicture = 150 * 1024
    static let maxPrefs = 5 * 1024 * 1024
    static let maxReply = 900 * 1000   // hello/profiles replies stay under 900 KB (Chrome caps host messages at 1 MB)

    // MARK: Scalar helpers (mirror Perl's "defined && !ref" checks)

    static func isBool(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }

    /// A non-empty-or-empty string, or a number rendered as text; booleans, arrays, objects and null are "ref/undef".
    static func scalarString(_ v: Any?) -> String? {
        if let s = v as? String { return s }
        if let n = v as? NSNumber, !isBool(n) { return n.stringValue }
        return nil
    }

    private static func nonNull(_ v: Any?) -> Any? {
        if v is NSNull { return nil }
        return v
    }

    private static func isIntegerText(_ s: String, allowSign: Bool) -> Bool {
        var chars = Substring(s)
        if allowSign, chars.first == "-" { chars = chars.dropFirst() }
        return !chars.isEmpty && chars.allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    /// Integer from a JSON number or an integer-looking string (like Perl's /^-?\d+$/).
    static func integer(_ v: Any?, allowSign: Bool) -> Int64? {
        if let s = v as? String {
            return isIntegerText(s, allowSign: allowSign) ? Int64(s) : nil
        }
        if let n = v as? NSNumber, !isBool(n) {
            let d = n.doubleValue
            if d != d.rounded() || abs(d) >= 9e18 { return nil }
            if !allowSign && d < 0 { return nil }
            return Int64(d)
        }
        return nil
    }

    static func validMinutes(_ v: Any?) -> Int? {
        guard let i = integer(v, allowSign: false), i >= 0 else { return nil }
        return Int(i)
    }

    static func colorHex(_ v: Any?) -> String? {
        guard var n = integer(v, allowSign: true) else { return nil }
        if n < 0 { n += 4_294_967_296 }
        return String(format: "#%06x", UInt32(truncatingIfNeeded: n & 0xFFFFFF))
    }

    static func validHexColor(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard u.count == 7, u[0] == UInt8(ascii: "#") else { return false }
        for b in u.dropFirst() {
            let isHex = (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102)
            if !isHex { return false }
        }
        return true
    }

    private static func safeComponent(_ s: String) -> Bool {
        !(s.contains("/") || s.contains("\\") || s == ".." || s == ".")
    }

    /// Size of a regular file (following symlinks), or nil.
    private static func regularFileSize(_ path: String) -> Int? {
        let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              v.isRegularFile == true, let size = v.fileSize else { return nil }
        return size
    }

    // MARK: Local State

    private static func localStateObject() -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: HostPaths.localState) else {
            Log.write("host: cannot read Local State '\(HostPaths.localState)'")
            return nil
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            Log.write("host: Local State parse error (not an object)")
            return nil
        }
        return obj
    }

    /// `profile.last_active_profiles` (the profiles Chrome had open), possibly empty.
    static func lastActiveProfiles() -> [String] {
        guard let ls = localStateObject(), let prof = ls["profile"] as? [String: Any],
              let arr = prof["last_active_profiles"] as? [Any] else { return [] }
        return arr.compactMap { $0 as? String }
    }

    private static func cleanStyle(_ v: Any?) -> [String: Any]? {
        guard let s = v as? [String: Any],
              let icon = s["icon"] as? String, allowedIcons.contains(icon),
              let color = s["color"] as? String, validHexColor(color) else { return nil }
        return ["icon": icon, "color": color]
    }

    private static func readPicture(dataDir: String, dir: String, entry: [String: Any]) -> String? {
        var file = "Google Profile Picture.png"
        if let g = entry["gaia_picture_file_name"] as? String, !g.isEmpty, safeComponent(g) { file = g }
        guard safeComponent(dir) else { return nil }
        let path = dataDir + "/" + dir + "/" + file
        guard let size = regularFileSize(path), size > 0, size <= maxPicture,
              let raw = FileManager.default.contents(atPath: path), !raw.isEmpty else { return nil }
        return "data:image/png;base64," + raw.base64EncodedString()
    }

    /// {userColor, colorScheme, variant, themeId} from <profile>/Preferences; nulls when missing/unreadable.
    static func readChromeTheme(dataDir: String, dir: String) -> [String: Any] {
        var userColor: Any = NSNull()
        var colorScheme = "system"
        var variant: Any = NSNull()
        var themeId: Any = NSNull()
        func result() -> [String: Any] {
            ["userColor": userColor, "colorScheme": colorScheme, "variant": variant, "themeId": themeId]
        }
        guard safeComponent(dir) else { return result() }
        let path = dataDir + "/" + dir + "/Preferences"
        guard let size = regularFileSize(path), size > 0, size <= maxPrefs,
              let raw = FileManager.default.contents(atPath: path),
              let p = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else { return result() }
        let browser = p["browser"] as? [String: Any]
        let th = (browser?["theme"] as? [String: Any]) ?? [:]
        if let c = colorHex(th["user_color"]) { userColor = c }
        let cs: Any? = nonNull(th["color_scheme2"]) ?? nonNull(th["color_scheme"])
        if let n = integer(cs, allowSign: false) {
            colorScheme = n == 1 ? "light" : (n == 2 ? "dark" : "system")
        }
        if let v = integer(th["color_variant"], allowSign: true) { variant = NSNumber(value: v) }
        let ext = p["extensions"] as? [String: Any]
        let theme = ext?["theme"] as? [String: Any]
        if let id = scalarString(theme?["id"]), !id.isEmpty { themeId = id }
        return result()
    }

    private static func utf8Less(_ a: String, _ b: String) -> Bool {
        Array(a.utf8).lexicographicallyPrecedes(Array(b.utf8))
    }

    /// Profile objects in Chrome's order. `withExtras: false` skips pictures, styles and themes.
    static func readProfiles(withExtras: Bool = true) -> [[String: Any]] {
        guard let ls = localStateObject() else { return [] }
        let prof = (ls["profile"] as? [String: Any]) ?? [:]
        let cache = (prof["info_cache"] as? [String: Any]) ?? [:]
        let dataDir = (HostPaths.localState as NSString).deletingLastPathComponent
        let styles = (withExtras ? readState()["profileStyles"] as? [String: Any] : nil) ?? [:]

        var by: [String: [String: Any]] = [:]
        for (dir, raw) in cache {
            if dir.hasPrefix("Guest") || dir.hasPrefix("System") { continue }
            guard let e = raw as? [String: Any] else { continue }
            var col = colorHex(e["profile_highlight_color"])
            if col == nil { col = colorHex(e["default_avatar_fill_color"]) }
            var entry: [String: Any] = [
                "dir": dir,
                "name": scalarString(e["name"]) ?? dir,
                "email": (e["user_name"] as? String) ?? "",
                "color": col.map { $0 as Any } ?? NSNull(),
            ]
            if withExtras {
                entry["picture"] = readPicture(dataDir: dataDir, dir: dir, entry: e).map { $0 as Any } ?? NSNull()
                entry["style"] = cleanStyle(styles[dir]).map { $0 as Any } ?? NSNull()
                entry["chromeTheme"] = readChromeTheme(dataDir: dataDir, dir: dir)
            } else {
                entry["picture"] = NSNull()
                entry["style"] = NSNull()
                entry["chromeTheme"] = NSNull()
            }
            by[dir] = entry
        }

        var out: [[String: Any]] = []
        var seen = Set<String>()
        if let order = prof["profiles_order"] as? [Any] {
            for item in order {
                guard let d = item as? String, !seen.contains(d), let e = by[d] else { continue }
                out.append(e)
                seen.insert(d)
            }
        }
        let rest = by.keys.filter { !seen.contains($0) }.sorted { a, b in
            let da = a == "Default" ? 0 : 1, db = b == "Default" ? 0 : 1
            if da != db { return da < db }
            let na = (by[a]?["name"] as? String ?? "").lowercased()
            let nb = (by[b]?["name"] as? String ?? "").lowercased()
            if na != nb { return utf8Less(na, nb) }
            return utf8Less(a, b)
        }
        for d in rest { if let e = by[d] { out.append(e) } }
        return out
    }

    /// Profiles list for hello/getProfiles/profiles replies: pictures are dropped largest-first
    /// if the encoded list would push a reply over the cap.
    static func profilesCapped() -> [[String: Any]] {
        var list = readProfiles()
        guard var size = JSONUtil.data(list)?.count, size > maxReply - 4096 else { return list }
        let order = list.indices
            .filter { list[$0]["picture"] is String }
            .sorted { (list[$0]["picture"] as? String ?? "").count > (list[$1]["picture"] as? String ?? "").count }
        for i in order {
            size -= (list[i]["picture"] as? String ?? "").utf8.count
            list[i]["picture"] = NSNull()
            if size <= maxReply - 4096 { break }
        }
        return list
    }

    // MARK: state.json

    static func readState() -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: HostPaths.stateFile), !data.isEmpty,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return obj
    }

    static func writeState(_ st: [String: Any]) {
        let dir = HostPaths.appDir
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        guard var data = try? JSONSerialization.data(withJSONObject: st, options: [.sortedKeys, .withoutEscapingSlashes]) else {
            Log.write("host: state not serialisable")
            return
        }
        data.append(0x0A)
        do {
            try data.write(to: URL(fileURLWithPath: HostPaths.stateFile), options: .atomic)
        } catch {
            Log.write("host: state write failed: \(error.localizedDescription)")
        }
    }

    static func settings(from st: [String: Any]) -> [String: Any] {
        ["archiveDefaultMinutes": validMinutes(st["archiveDefaultMinutes"]) ?? 720]
    }

    static func currentSettings() -> [String: Any] { settings(from: readState()) }

    /// Merge `changes` into state.json and return the resulting settings.
    static func updateState(_ changes: [String: Any]) -> [String: Any] {
        var st = readState()
        for (k, v) in changes { st[k] = v }
        writeState(st)
        return settings(from: st)
    }
}
