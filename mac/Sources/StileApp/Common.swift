import AppKit
import Foundation
import ServiceManagement

extension Notification.Name {
    static let sidebarSettingsChanged = Notification.Name("ca.simplistics.stile.settingsChanged")
    static let sidebarBridgesChanged = Notification.Name("ca.simplistics.stile.bridgesChanged")
    /// v3.0: open the permissions window (page host message or `appSetting` `reviewPermissions`).
    static let sidebarReviewPermissions = Notification.Name("ca.simplistics.stile.reviewPermissions")
    /// Turn on Chrome's vertical tabs (page host message `setUpChrome`).
    static let sidebarSetUpChrome = Notification.Name("ca.simplistics.stile.setUpChrome")
}

// MARK: - Logging (~/Library/Logs/Stile.log, rotated at 1 MB)

enum Log {
    private static let queue = DispatchQueue(label: "ca.simplistics.stile.log")
    private static let maxBytes = 1_000_000

    private static var fileURL: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Stile.log")
    }

    static func write(_ message: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let line = "\(stamp) \(message)\n"
        let url = fileURL
        queue.async {
            let fm = FileManager.default
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let attrs = try? fm.attributesOfItem(atPath: url.path),
               let size = attrs[.size] as? NSNumber, size.intValue > maxBytes {
                let old = url.appendingPathExtension("1")
                try? fm.removeItem(at: old)
                try? fm.moveItem(at: url, to: old)
            }
            if !fm.fileExists(atPath: url.path) {
                fm.createFile(atPath: url.path, contents: nil)
            }
            if let handle = try? FileHandle(forWritingTo: url) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: Data(line.utf8))
                try? handle.close()
            }
        }
    }
}

// MARK: - App info

enum AppInfo {
    static var version: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "2.1.0"
    }
}

// MARK: - Settings (UserDefaults)

enum Settings {
    private static let d = UserDefaults.standard

    static func post() {
        NotificationCenter.default.post(name: .sidebarSettingsChanged, object: nil)
    }

    static let minWidth: CGFloat = 220
    static let maxWidth: CGFloat = 420

    /// Width of the sidebar while it peeks over the page (default 280, persisted).
    static var peekWidth: CGFloat {
        get {
            let v = CGFloat(d.double(forKey: "peekWidth"))
            if v < minWidth {
                let old = CGFloat(d.double(forKey: "sidebarWidth"))   // value stored by earlier versions
                return old >= minWidth ? min(old, maxWidth) : 280
            }
            return min(v, maxWidth)
        }
        set {
            d.set(Double(min(max(newValue, minWidth), maxWidth)), forKey: "peekWidth")
            post()
        }
    }
}

extension Settings {
    /// v3.1: the menu bar (status item) icon. Default on.
    static var showMenuBarIcon: Bool {
        get { UserDefaults.standard.object(forKey: "showMenuBarIcon") as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: "showMenuBarIcon")
            post()
        }
    }

    /// v3.1: what the header's green button does on a plain click: "full" (macOS full screen) or "fill".
    static var greenButtonAction: String {
        get { UserDefaults.standard.string(forKey: "greenButtonAction") == "fill" ? "fill" : "full" }
        set {
            UserDefaults.standard.set(newValue == "fill" ? "fill" : "full", forKey: "greenButtonAction")
            post()
        }
    }

    /// v3.1: the one-time "green button now fills" note has not been shown yet (set by the full-screen fallback).
    static var greenButtonNotePending: Bool {
        get { UserDefaults.standard.bool(forKey: "greenButtonNotePending") }
        set { UserDefaults.standard.set(newValue, forKey: "greenButtonNotePending") }
    }
}

// MARK: - Launch at login

enum LoginItem {
    private static var cache: (value: Bool, at: Date)?

    static var enabled: Bool {
        if let c = cache, Date().timeIntervalSince(c.at) < 5 { return c.value }
        let v = SMAppService.mainApp.status == .enabled
        cache = (v, Date())
        return v
    }

    static func set(_ on: Bool) {
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            Log.write("login item change failed: \(error.localizedDescription)")
        }
        cache = nil
    }
}

// MARK: - Coordinates

enum Geometry {
    /// Height of the primary screen (NSScreen.screens[0]), the origin reference for AX coordinates.
    static var primaryHeight: CGFloat {
        NSScreen.screens.first?.frame.height ?? 0
    }

    /// Convert between AX (top-left origin, global) and NSWindow (bottom-left origin) rects.
    /// The formula is its own inverse: nsY = primaryHeight - axY - height.
    static func flip(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.minY - r.height, width: r.width, height: r.height)
    }

    /// The screen that overlaps the given AX-space rect the most.
    static func screen(forAXRect r: CGRect) -> NSScreen? {
        let ns = flip(r)
        var best: NSScreen?
        var bestArea: CGFloat = -1
        for s in NSScreen.screens {
            let i = s.frame.intersection(ns)
            if i.isNull { continue }
            let area = i.width * i.height
            if area > bestArea {
                bestArea = area
                best = s
            }
        }
        return best ?? NSScreen.screens.first
    }
}

// MARK: - One-shot timer

@MainActor
final class OneShot {
    private var timer: Timer?

    var isScheduled: Bool { timer != nil }

    func schedule(after seconds: TimeInterval, _ block: @escaping @MainActor () -> Void) {
        cancel()
        timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in
            Task { @MainActor in block() }
        }
    }

    func cancel() {
        timer?.invalidate()
        timer = nil
    }

    /// Call at the start of the scheduled block to mark it as consumed.
    func clear() {
        timer = nil
    }
}

// MARK: - Colours

enum ColorParse {
    /// Parses "#rgb", "#rrggbb", "rgb(r,g,b)", "rgba(...)", "hsl(h,s%,l%)".
    static func parse(_ raw: String) -> NSColor? {
        let s = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if s.hasPrefix("#") {
            var hex = String(s.dropFirst())
            if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
            guard hex.count == 6 || hex.count == 8, let v = UInt64(hex.prefix(6), radix: 16) else { return nil }
            return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255,
                           green: CGFloat((v >> 8) & 0xff) / 255,
                           blue: CGFloat(v & 0xff) / 255, alpha: 1)
        }
        guard let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")"), open < close else { return nil }
        let fn = String(s[s.startIndex..<open])
        let inner = s[s.index(after: open)..<close]
        let parts = inner
            .replacingOccurrences(of: "/", with: ",")
            .replacingOccurrences(of: " ", with: ",")
            .split(separator: ",")
            .map { String($0).replacingOccurrences(of: "%", with: "").replacingOccurrences(of: "deg", with: "") }
            .compactMap { Double($0) }
        guard parts.count >= 3 else { return nil }
        if fn.hasPrefix("rgb") {
            return NSColor(srgbRed: CGFloat(parts[0] / 255), green: CGFloat(parts[1] / 255), blue: CGFloat(parts[2] / 255), alpha: 1)
        }
        if fn.hasPrefix("hsl") {
            var h = parts[0].truncatingRemainder(dividingBy: 360)
            if h < 0 { h += 360 }
            let sat = max(0, min(1, parts[1] / 100))
            let l = max(0, min(1, parts[2] / 100))
            let c = (1 - abs(2 * l - 1)) * sat
            let hp = h / 60
            let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
            var r = 0.0, g = 0.0, b = 0.0
            switch Int(hp) {
            case 0: (r, g, b) = (c, x, 0)
            case 1: (r, g, b) = (x, c, 0)
            case 2: (r, g, b) = (0, c, x)
            case 3: (r, g, b) = (0, x, c)
            case 4: (r, g, b) = (x, 0, c)
            default: (r, g, b) = (c, 0, x)
            }
            let m = l - c / 2
            return NSColor(srgbRed: CGFloat(r + m), green: CGFloat(g + m), blue: CGFloat(b + m), alpha: 1)
        }
        return nil
    }

    static func mix(_ base: NSColor, _ tint: NSColor, amount: CGFloat) -> NSColor {
        guard let a = base.usingColorSpace(.sRGB), let b = tint.usingColorSpace(.sRGB) else { return base }
        let t = max(0, min(1, amount))
        return NSColor(srgbRed: a.redComponent * (1 - t) + b.redComponent * t,
                       green: a.greenComponent * (1 - t) + b.greenComponent * t,
                       blue: a.blueComponent * (1 - t) + b.blueComponent * t,
                       alpha: 1)
    }
}

// MARK: - JSON helpers

enum JSONUtil {
    static func string(_ obj: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// JSON bytes without escaped slashes (used for native messaging frames).
    static func data(_ obj: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(obj) else { return nil }
        return try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])
    }

    /// A JS string literal (with quotes) for arbitrary text.
    static func stringLiteral(_ s: String) -> String {
        if let data = try? JSONEncoder().encode(s), let out = String(data: data, encoding: .utf8) {
            return out
        }
        return "\"\""
    }

    static func double(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }

    static func int(_ v: Any?) -> Int? {
        if let n = v as? NSNumber { return n.intValue }
        return nil
    }
}

/// The Dock icon (and Command+Tab) shows while any editor, recording preview or the settings window is open.
@MainActor
enum DockPresence {
    static func update() {
        let on = CaptureEditors.shared.hasOpen || RecordingWindows.shared.hasOpen || AppSettingsWindow.shared.isOpen
        guard (NSApp.activationPolicy() == .regular) != on else { return }
        NSApp.setActivationPolicy(on ? .regular : .accessory)
        Log.write("dock: \(on ? "in the Dock (window open)" : "menu bar only again")")
    }
}
