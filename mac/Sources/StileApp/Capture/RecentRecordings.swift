import AppKit
import AVFoundation
import CryptoKit

/// One remembered recording (the last 10), as persisted in Application Support/Stile/recent-recordings.json.
struct RecentRecording: Codable, Equatable {
    var id: String
    var title: String
    var target: String
    /// the saved copy when there is one, else the temp file the recorder wrote
    var path: String
    var saved: Bool
    var link: String
    var duration: Double
    var date: Date
    var hasAudio: Bool
}

/// v3.6: the "Recent Recordings" list: persisted, thumbnailed with `AVAssetImageGenerator`, shown in the menu bar and (when
/// an extension is connected) mirrored to it as `{type: 'nativeRecording', ...}` (metadata and a small JPEG only: native
/// messages to the extension are capped at 1 MB).
@MainActor
final class RecentRecordings {
    static let shared = RecentRecordings()
    static let limit = 10

    /// The connected, identified extensions (App.swift sets it).
    var bridges: () -> [ProfileBridge] = { [] }

    private(set) var entries: [RecentRecording] = []
    private var thumbs: [String: NSImage] = [:]

    private var dir: URL { URL(fileURLWithPath: HostPaths.appDir, isDirectory: true) }
    private var listFile: URL { dir.appendingPathComponent("recent-recordings.json") }
    private var thumbDir: URL { dir.appendingPathComponent("recording-thumbs", isDirectory: true) }

    init() { load() }

    /// A stable id for a recording file: the same file always gets the same entry.
    static func id(for url: URL) -> String {
        SHA256.hash(data: Data(url.standardizedFileURL.path.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Persistence

    private func load() {
        guard let data = try? Data(contentsOf: listFile) else { return }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .secondsSince1970
        entries = ((try? dec.decode([RecentRecording].self, from: data)) ?? []).prefix(Self.limit).map { $0 }
    }

    private func persist() {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? enc.encode(entries) { try? data.write(to: listFile, options: .atomic) }
    }

    // MARK: Changes

    func entry(id: String) -> RecentRecording? { entries.first { $0.id == id } }

    /// Adds (or updates in place) and moves to the front; the thumbnail is made in the background.
    func upsert(_ e: RecentRecording) {
        let isNew = !entries.contains { $0.id == e.id }
        entries.removeAll { $0.id == e.id }
        entries.insert(e, at: 0)
        for old in entries.dropFirst(Self.limit) {
            removeThumb(old.id)
            send(removed: old.id)
        }
        entries = Array(entries.prefix(Self.limit))
        persist()
        if isNew || thumbs[e.id] == nil && !FileManager.default.fileExists(atPath: thumbFile(e.id).path) {
            Task { await makeThumbnail(for: e) }
        } else {
            send(e)
        }
    }

    /// Changes one entry (saved path, link) without moving it.
    func update(id: String, _ change: (inout RecentRecording) -> Void) {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return }
        change(&entries[i])
        persist()
        send(entries[i])
    }

    func remove(id: String) {
        guard entries.contains(where: { $0.id == id }) else { return }
        entries.removeAll { $0.id == id }
        removeThumb(id)
        persist()
        send(removed: id)
    }

    func clear() {
        for e in entries { removeThumb(e.id); send(removed: e.id) }
        entries = []
        persist()
    }

    // MARK: Thumbnails

    private func thumbFile(_ id: String) -> URL { thumbDir.appendingPathComponent("\(id).jpg") }
    private func removeThumb(_ id: String) {
        thumbs[id] = nil
        try? FileManager.default.removeItem(at: thumbFile(id))
    }

    func thumbnail(for id: String) -> NSImage? {
        if let t = thumbs[id] { return t }
        guard let img = NSImage(contentsOf: thumbFile(id)) else { return nil }
        thumbs[id] = img
        return img
    }

    private func makeThumbnail(for e: RecentRecording) async {
        let asset = AVURLAsset(url: URL(fileURLWithPath: e.path))
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 240, height: 150)
        let t = CMTime(seconds: min(1, max(0, e.duration / 2)), preferredTimescale: 600)
        do {
            let cg = try await gen.image(at: t).image
            let rep = NSBitmapImageRep(cgImage: cg)
            if let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) {
                try? FileManager.default.createDirectory(at: thumbDir, withIntermediateDirectories: true)
                try? jpeg.write(to: thumbFile(e.id), options: .atomic)
            }
        } catch {
            Log.write("recording: thumbnail failed for \(e.id): \(error.localizedDescription)")
        }
        if let cur = entry(id: e.id) { send(cur) }
    }

    // MARK: The extension

    private func send(_ e: RecentRecording) {
        let live = bridges()
        guard !live.isEmpty else { return }
        var m: [String: Any] = ["type": "nativeRecording", "id": e.id, "title": e.title, "duration": e.duration,
                                "time": Int(e.date.timeIntervalSince1970 * 1000), "link": e.link]
        if let jpeg = try? Data(contentsOf: thumbFile(e.id)), jpeg.count < 200_000 { m["thumb"] = jpeg.base64EncodedString() }
        for b in live { b.sendToExt(m) }
    }

    private func send(removed id: String) {
        for b in bridges() { b.sendToExt(["type": "nativeRecording", "id": id, "removed": true]) }
    }

    /// An extension (re)connected: give it the whole list (it merges by id).
    func syncToExtension() {
        for e in entries.reversed() { send(e) }
    }

    // MARK: Menu bar

    /// Fills the "Recent Recordings" submenu (rebuilt each time the menu opens).
    func populate(_ menu: NSMenu, target: AnyObject, open: Selector, reveal: Selector, clear: Selector) {
        menu.removeAllItems()
        let fm = FileManager.default
        if entries.isEmpty {
            let none = NSMenuItem(title: "No recordings yet", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
            return
        }
        for e in entries {
            let exists = fm.fileExists(atPath: e.path)
            let item = NSMenuItem(title: e.title, action: open, keyEquivalent: "")
            item.target = target
            item.representedObject = e.id
            item.isEnabled = exists
            item.toolTip = exists ? e.path : "The file is gone"
            if let img = thumbnail(for: e.id) {
                let small = img.copy() as! NSImage
                small.size = NSSize(width: 56, height: 35)
                item.image = small
            }
            item.attributedTitle = Self.attributed(title: e.title, detail: "\(Self.format(duration: e.duration)) · \(Self.relative(e.date))\(e.link.isEmpty ? "" : " · link")")
            menu.addItem(item)
            // Option held: Show in Finder instead
            let alt = NSMenuItem(title: "Show “\(e.title)” in Finder", action: reveal, keyEquivalent: "")
            alt.target = target
            alt.representedObject = e.id
            alt.isAlternate = true
            alt.keyEquivalentModifierMask = [.option]
            alt.isEnabled = exists
            menu.addItem(alt)
        }
        menu.addItem(.separator())
        let folder = NSMenuItem(title: "Show Recordings Folder", action: reveal, keyEquivalent: "")
        folder.target = target
        menu.addItem(folder)
        let clr = NSMenuItem(title: "Clear Recent Recordings", action: clear, keyEquivalent: "")
        clr.target = target
        menu.addItem(clr)
    }

    private static func attributed(title: String, detail: String) -> NSAttributedString {
        let s = NSMutableAttributedString(string: title + "\n", attributes: [.font: NSFont.menuFont(ofSize: 0)])
        s.append(NSAttributedString(string: detail, attributes: [.font: NSFont.menuFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
        return s
    }

    static func format(duration: Double) -> String {
        let s = Int(duration.rounded())
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s % 3600 / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    private static func relative(_ d: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: d, relativeTo: Date())
    }
}
