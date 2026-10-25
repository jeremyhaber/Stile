// Records Chrome's full-screen toolbar slide frame by frame, for tuning Stile's reveal follow (dev/HANDOFF-fullscreen.md).
//
//   swiftc -O -parse-as-library tools/fs-reveal-recorder.swift -o /tmp/fs-rec && /tmp/fs-rec 20   # writes dev/fs-rec-out/
//
// Run with Chrome full screen and Stile running, then reveal and hide the toolbar a few times (pointer to the top
// edge and away, and ⌘L then Esc). Needs Screen Recording permission for the terminal (first run prompts).
// Output: frames/<n>_<t>.png (top-left corner of the Chrome window, every frame the screen changed, 2x),
// windows.csv (reveal window height, sidebar top, at ~500 Hz), meta.txt. Times are CACurrentMediaTime seconds.
import AppKit
import CoreMedia
import Foundation
import ImageIO
import QuartzCore
import ScreenCaptureKit
import UniformTypeIdentifiers

let captureW: CGFloat = 260, captureH: CGFloat = 240, scale: CGFloat = 2

func windowList() -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
}
func bounds(_ w: [String: Any]) -> CGRect? {
    guard let d = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: d as CFDictionary)
}
func owner(_ w: [String: Any]) -> String { (w[kCGWindowOwnerName as String] as? String) ?? "" }
func layer(_ w: [String: Any]) -> Int { (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0 }
func number(_ w: [String: Any]) -> UInt32 { (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0 }

func chromeWindow(_ list: [[String: Any]]) -> CGRect? {
    list.filter { owner($0) == "Google Chrome" && layer($0) == 0 }
        .compactMap(bounds).max { $0.width * $0.height < $1.width * $1.height }
}

struct Sample: Sendable { var t: Double; var revealH: Double; var revealY: Double; var sidebarTop: Double; var sidebarH: Double; var stile: String; var mouseY: Double = -1 }

func sample(chrome: CGRect) -> Sample {
    let list = windowList()
    var s = Sample(t: CACurrentMediaTime(), revealH: -1, revealY: -1, sidebarTop: -1, sidebarH: -1, stile: "")
    for w in list {
        guard let b = bounds(w) else { continue }
        let o = owner(w)
        if o == "Google Chrome", layer(w) > 0, abs(b.minX - chrome.minX) <= 1, abs(b.width - chrome.width) <= 1,
           b.minY <= chrome.minY + 1, b.height < 300 {
            s.revealH = b.height; s.revealY = b.minY
        }
        if o == "Stile" || o == "StileApp" {
            s.stile += "\(number(w)):\(Int(b.minX)),\(Int(b.minY)),\(Int(b.width)),\(Int(b.height));"
            // The sidebar panel: tall, at Chrome's left edge.
            if b.height > 200, b.minX <= chrome.minX + 40, b.minY < chrome.minY + 300, s.sidebarTop < 0 || b.height > s.sidebarH {
                s.sidebarTop = b.minY; s.sidebarH = b.height
            }
        }
    }
    // Pointer, top-left origin like the window bounds.
    if let loc = CGEvent(source: nil)?.location { s.mouseY = loc.y }
    return s
}

final class Recorder: NSObject, SCStreamOutput {
    let dir: URL
    let writeQ = DispatchQueue(label: "write")
    var n = 0
    init(dir: URL) { self.dir = dir }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = atts.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
        let data = Data(bytes: CVPixelBufferGetBaseAddress(pb)!, count: bpr * h)
        CVPixelBufferUnlockBaseAddress(pb, .readOnly)
        n += 1
        let url = dir.appendingPathComponent(String(format: "frames/%05d_%.4f.png", n, t))
        writeQ.async {
            let cs = CGColorSpace(name: CGColorSpace.sRGB)!
            guard let provider = CGDataProvider(data: data as CFData),
                  let img = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bpr, space: cs,
                                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
                  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
            CGImageDestinationAddImage(dest, img, nil)
            CGImageDestinationFinalize(dest)
        }
    }
}

@main
struct Main {
    static func main() async throws {
        let args = CommandLine.arguments
        let duration = args.count > 1 ? Double(args[1]) ?? 20 : 20
        let dir = URL(fileURLWithPath: args.count > 2 ? args[2] : "dev/fs-rec-out")
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("frames"), withIntermediateDirectories: true)

        print("Waiting for a full-screen Chrome window (switch to it now)…")
        var chrome: CGRect?
        let waitStart = Date()
        while Date().timeIntervalSince(waitStart) < 30 {
            if let c = chromeWindow(windowList()),
               NSScreen.screens.contains(where: { abs($0.frame.width - c.width) < 1 && abs($0.frame.height - c.height) < 1 }) {
                chrome = c; break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard let chrome else { print("No full-screen Chrome window found."); exit(1) }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(CGPoint(x: chrome.midX, y: chrome.midY)) })
        else { print("No display for Chrome."); exit(1) }
        let db = CGDisplayBounds(display.displayID)
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.sourceRect = CGRect(x: chrome.minX - db.minX, y: chrome.minY - db.minY, width: captureW, height: captureH)
        cfg.width = Int(captureW * scale); cfg.height = Int(captureH * scale)
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 240)
        cfg.queueDepth = 8
        cfg.showsCursor = true
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.colorSpaceName = CGColorSpace.sRGB

        let rec = Recorder(dir: dir)
        let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
        try stream.addStreamOutput(rec, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames", qos: .userInteractive))

        final class Box: @unchecked Sendable { var samples: [Sample] = []; let lock = NSLock() }
        let box = Box()
        let end = CACurrentMediaTime() + duration
        let poller = Thread {
            var last = ""
            while CACurrentMediaTime() < end {
                let s = sample(chrome: chrome)
                let key = "\(s.revealH) \(s.revealY) \(s.sidebarTop) \(s.sidebarH) \(Int(s.mouseY))"
                if key != last { box.lock.lock(); box.samples.append(s); box.lock.unlock(); last = key }
                usleep(2000)
            }
        }
        poller.qualityOfService = .userInteractive
        try await stream.startCapture()
        poller.start()
        let refresh = NSScreen.screens.first { $0.frame.width == chrome.width }?.maximumFramesPerSecond ?? 0
        print("Recording \(Int(duration)) s: reveal and hide Chrome's toolbar a few times (pointer to the top and away; ⌘L then Esc).")
        try await Task.sleep(nanoseconds: UInt64(duration * 1e9))
        try await stream.stopCapture()
        rec.writeQ.sync {}

        var csv = "t,revealY,revealH,sidebarTop,sidebarH,mouseY,stile\n"
        let samples = box.lock.withLock { box.samples }
        for s in samples { csv += String(format: "%.4f,%.1f,%.1f,%.1f,%.1f,%.0f,", s.t, s.revealY, s.revealH, s.sidebarTop, s.sidebarH, s.mouseY) + s.stile + "\n" }
        try csv.write(to: dir.appendingPathComponent("windows.csv"), atomically: true, encoding: .utf8)
        let meta = "chrome=\(chrome)\ndisplay=\(db) refresh=\(refresh)Hz\ncapture=\(captureW)x\(captureH)pt @\(scale)x from the Chrome window's top-left\nframes=\(rec.n)\n"
        try meta.write(to: dir.appendingPathComponent("meta.txt"), atomically: true, encoding: .utf8)
        print("Done: \(rec.n) frames, \(samples.count) window samples → \(dir.path)")
    }
}
