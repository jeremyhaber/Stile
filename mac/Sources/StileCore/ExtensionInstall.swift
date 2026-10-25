import Foundation

/// v3.10: how the Stile extension got into a Chrome profile, read from the profile's Preferences files.
public enum ExtensionInstallKind: Equatable, Sendable {
    /// Installed from the Chrome Web Store (or by the External Extensions file, which also updates from the store).
    case store
    /// Loaded unpacked (developer mode) or via --load-extension.
    case unpacked
}

/// v3.10: pure helpers for store-install support: classifying an installed extension and writing Chrome's
/// External Extensions file. No AppKit, no app state.
public enum ExtensionInstall {
    /// Chrome's `Manifest::Location` values that mean "loaded from a folder".
    private static let unpackedLocations: Set<Int> = [4, 8]   // UNPACKED, COMMAND_LINE

    /// A Chrome extension ID: exactly 32 characters, each a-p.
    public static func isValidID(_ id: String) -> Bool {
        id.utf8.count == 32 && id.utf8.allSatisfy { $0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "p") }
    }

    private static func integer(_ v: Any?) -> Int? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d == d.rounded(), abs(d) < 1e9 else { return nil }
        return n.intValue
    }

    private static func entry(_ prefs: [String: Any]?, _ id: String) -> [String: Any] {
        let ext = prefs?["extensions"] as? [String: Any]
        let settings = ext?["settings"] as? [String: Any]
        return (settings?[id] as? [String: Any]) ?? [:]
    }

    private static func uninstalled(_ prefs: [String: Any]?) -> Set<String> {
        let ext = prefs?["extensions"] as? [String: Any]
        return Set((ext?["external_uninstalls"] as? [Any])?.compactMap { $0 as? String } ?? [])
    }

    /// The install kind of the first of `ids` that is installed, with unpacked winning over store when both are
    /// present; nil when none is. `preferences` and `securePreferences` are the parsed JSON of a profile's
    /// Preferences and Secure Preferences (either may be nil). Chrome on macOS keeps most of an extension's
    /// settings in Secure Preferences and may leave a partial entry in Preferences, so the two entries are merged
    /// per ID (Secure Preferences wins). An entry counts only with an integer `location`; the kind comes from the
    /// location, not the ID, since the store and unpacked IDs are the same when the manifest key is reused.
    public static func installKind(preferences: [String: Any]?, securePreferences: [String: Any]?,
                                   ids: [String]) -> ExtensionInstallKind? {
        let removed = uninstalled(preferences).union(uninstalled(securePreferences))
        var found: Set<ExtensionInstallKind> = []
        for id in ids where !removed.contains(id) {
            let merged = entry(preferences, id).merging(entry(securePreferences, id)) { _, secure in secure }
            guard let loc = integer(merged["location"]) else { continue }
            found.insert(unpackedLocations.contains(loc) ? .unpacked : .store)
        }
        if found.contains(.unpacked) { return .unpacked }
        return found.contains(.store) ? .store : nil
    }

    // MARK: External Extensions file

    public enum WriteResult: Equatable, Sendable {
        case written
        case alreadyPresent
        case failed(String)
    }

    static let updateURL = "https://clients2.google.com/service/update2/crx"

    private static func filePath(dir: String, id: String) -> String { dir + "/" + id + ".json" }

    public static func externalFileExists(dir: String, id: String) -> Bool {
        FileManager.default.fileExists(atPath: filePath(dir: dir, id: id))
    }

    /// Writes `<dir>/<id>.json` with the Web Store update URL, only if it is missing; never overwrites.
    /// Chrome reads the directory on its next start, installs the extension into every profile and shows its own
    /// enable prompt. If the user later removes the extension, Chrome won't re-add it through this route (it
    /// records an external uninstall), which is intended. Nothing here or elsewhere removes the file.
    public static func writeExternalExtensionFile(dir: String, id: String) -> WriteResult {
        guard isValidID(id) else { return .failed("invalid extension ID") }
        let path = filePath(dir: dir, id: id)
        let fm = FileManager.default
        if fm.fileExists(atPath: path) { return .alreadyPresent }
        do {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let body = "{\n  \"external_update_url\": \"\(updateURL)\"\n}\n"
            // .withoutOverwriting (O_EXCL) also covers a file appearing between the check above and this write.
            try Data(body.utf8).write(to: URL(fileURLWithPath: path), options: .withoutOverwriting)
            return .written
        } catch CocoaError.fileWriteFileExists {
            return .alreadyPresent
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}
