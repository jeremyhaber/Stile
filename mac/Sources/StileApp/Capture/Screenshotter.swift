import AppKit
import ScreenCaptureKit

/// v3.5a: single-frame captures through ScreenCaptureKit (`SCScreenshotManager`), replacing the old `screencapture`
/// shell-out. Every capture excludes this app's own windows (the selection overlay, highlight borders, countdown badge),
/// so none of the capture UI ends up in the picture, except (v3.6.1) the sidebar panels over Chrome: they are what the
/// user sees there, and leaving them out showed Chrome's own tab rail instead. All rects are global display coordinates in points with the origin at the
/// top-left of the primary display (the Quartz / ScreenCaptureKit convention), not AppKit's bottom-left.
struct ScreenshotResult {
    let png: Data
    /// pixels per point (2 on Retina)
    let dpr: Double
    let width: Int    // pixels
    let height: Int
}

enum ScreenshotError: Error, LocalizedError {
    case noDisplay, noWindow, encodeFailed
    var errorDescription: String? {
        switch self {
        case .noDisplay: return "no display"
        case .noWindow: return "no window"
        case .encodeFailed: return "PNG encoding failed"
        }
    }
}

enum Screenshotter {
    // MARK: Shareable content

    /// Windows and displays right now. `onScreenOnly` drops minimised and other-Space windows.
    static func shareableContent(onScreenOnly: Bool = true) async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: onScreenOnly)
    }

    /// This app's `SCRunningApplication` entries (to exclude from captures).
    static func ownApplications(in content: SCShareableContent) -> [SCRunningApplication] {
        content.applications.filter { $0.processID == getpid() }
    }

    /// v3.6.1: Stile's panels drawn over Chrome windows (sidebar, header, little-window pill), keyed by the Chrome window's
    /// id. Set by the app; empty in capture-only mode or with the overlay off.
    @MainActor static var overlayPanels: () -> [CGWindowID: [CGWindowID]] = { [:] }
    /// v3.9: more of our windows captures show wherever they are (the camera bubble while recording with the camera).
    @MainActor static var extraCaptureWindows: () -> [CGWindowID] = { [] }

    /// The ids `overlayWindows(over:)` stands for: the panels over a Chrome window (all of them for nil) and the extras.
    @MainActor static func shownIDs(over chrome: CGWindowID? = nil) -> Set<CGWindowID> {
        let map = overlayPanels()
        return Set(chrome.map { map[$0] ?? [] } ?? map.values.flatMap { $0 }).union(extraCaptureWindows().filter { $0 != 0 })
    }

    /// Our windows that captures show, in `content`: the overlay panels (over one Chrome window, or over all of them) and
    /// the extras.
    @MainActor static func overlayWindows(in content: SCShareableContent, over chrome: CGWindowID? = nil) -> [SCWindow] {
        let ids = shownIDs(over: chrome)
        guard !ids.isEmpty else { return [] }
        return content.windows.filter { ids.contains($0.windowID) }
    }

    /// A whole display without our own windows, except the overlay panels.
    @MainActor static func displayFilter(_ display: SCDisplay, content: SCShareableContent) -> SCContentFilter {
        SCContentFilter(display: display, excludingApplications: ownApplications(in: content), exceptingWindows: overlayWindows(in: content))
    }

    /// A window together with the overlay panels over it, composited from its display, and the window's rect on that
    /// display (display-local points, clipped). Nil when no panel is over the window, or it isn't on a display.
    @MainActor static func windowWithOverlay(_ window: SCWindow, content: SCShareableContent)
        -> (filter: SCContentFilter, rect: CGRect, displayID: CGDirectDisplayID)? {
        let panels = overlayWindows(in: content, over: window.windowID)
        guard !panels.isEmpty, let wf = ScreenGeometry.frame(ofWindow: window.windowID),
              let did = ScreenGeometry.displayID(containing: wf), let d = display(did, in: content),
              let local = ScreenGeometry.local(wf, on: did) else { return nil }
        return (SCContentFilter(display: d, including: [window] + panels), local, did)
    }

    /// The SCDisplay for a CGDirectDisplayID.
    static func display(_ id: CGDirectDisplayID, in content: SCShareableContent) -> SCDisplay? {
        content.displays.first { $0.displayID == id }
    }

    // MARK: Captures (PNG)

    /// A whole display.
    static func display(_ display: SCDisplay) async throws -> ScreenshotResult {
        let content = try await shareableContent()
        let filter = await displayFilter(display, content: content)
        let cfg = configuration(for: filter)
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        return try encode(image, pointsWide: filter.contentRect.width)
    }

    /// One window, even when other windows cover it. `shadow` keeps macOS's drop shadow and transparent corners.
    /// A Chrome window with Stile's panels over it is composited from its display instead (with them, without the shadow).
    static func window(_ window: SCWindow, shadow: Bool) async throws -> ScreenshotResult {
        let content = try await shareableContent()
        if let c = await windowWithOverlay(window, content: content) {
            let cfg = SCStreamConfiguration()
            let scale = CGFloat(c.filter.pointPixelScale)
            cfg.sourceRect = c.rect
            cfg.width = max(1, Int((c.rect.width * scale).rounded()))
            cfg.height = max(1, Int((c.rect.height * scale).rounded()))
            cfg.showsCursor = false
            cfg.shouldBeOpaque = false   // the window's rounded corners stay transparent
            let image = try await SCScreenshotManager.captureImage(contentFilter: c.filter, configuration: cfg)
            return try encode(image, pointsWide: c.rect.width)
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let cfg = configuration(for: filter)
        cfg.ignoreShadowsSingleWindow = !shadow
        cfg.shouldBeOpaque = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        return try encode(image, pointsWide: filter.contentRect.width)
    }

    /// A whole display as a CGImage, from content already fetched (the selection overlay's loupe backdrop).
    static func displayImage(_ display: SCDisplay, content: SCShareableContent) async throws -> CGImage {
        let filter = await displayFilter(display, content: content)
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration(for: filter))
    }

    /// A rect (global top-left points) on one display, at that display's native pixel scale.
    static func rect(_ rect: CGRect, displayID: CGDirectDisplayID) async throws -> ScreenshotResult {
        let image = try await rectImage(rect, displayID: displayID)
        return try encode(image, pointsWide: rect.width)
    }

    /// The raw CGImage of a rect (used by the overlay's loupe and, later, scrolling capture).
    static func rectImage(_ rect: CGRect, displayID: CGDirectDisplayID) async throws -> CGImage {
        let content = try await shareableContent()
        guard let d = display(displayID, in: content) else { throw ScreenshotError.noDisplay }
        let filter = await displayFilter(d, content: content)
        let cfg = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        // sourceRect is relative to the display's top-left, in points
        guard let local = ScreenGeometry.local(rect, on: displayID, minSize: 1) else { throw ScreenshotError.noDisplay }
        cfg.sourceRect = local
        cfg.width = max(1, Int((local.width * scale).rounded()))
        cfg.height = max(1, Int((local.height * scale).rounded()))
        cfg.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    }

    // MARK: Helpers

    /// Full-size configuration for a filter: the filter's content rect times its point/pixel scale.
    private static func configuration(for filter: SCContentFilter) -> SCStreamConfiguration {
        let cfg = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        cfg.width = max(1, Int((filter.contentRect.width * scale).rounded()))
        cfg.height = max(1, Int((filter.contentRect.height * scale).rounded()))
        cfg.showsCursor = false
        return cfg
    }

    static func encode(_ image: CGImage, pointsWide: CGFloat) throws -> ScreenshotResult {
        let rep = NSBitmapImageRep(cgImage: image)
        let dpr = pointsWide > 0 ? (Double(image.width) / Double(pointsWide) * 100).rounded() / 100 : 1
        // size in points, so the PNG carries 144 dpi on Retina like the old screencapture output
        if dpr > 0 { rep.size = NSSize(width: Double(image.width) / dpr, height: Double(image.height) / dpr) }
        guard let png = rep.representation(using: .png, properties: [:]) else { throw ScreenshotError.encodeFailed }
        return ScreenshotResult(png: png, dpr: dpr, width: image.width, height: image.height)
    }
}

// MARK: - Coordinate helpers shared by the capture code

enum ScreenGeometry {
    /// Height of the primary display: the pivot between AppKit (bottom-left) and Quartz (top-left) global coordinates.
    static var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    /// AppKit global rect (bottom-left origin) -> Quartz global rect (top-left origin).
    static func quartz(fromAppKit r: CGRect) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// Quartz global rect -> AppKit global rect.
    static func appKit(fromQuartz r: CGRect) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// Quartz global point -> AppKit global point.
    static func appKit(fromQuartz p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: primaryHeight - p.y) }

    static func displayID(of screen: NSScreen) -> CGDirectDisplayID? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    /// The screen under an AppKit global point (the main screen as a fallback).
    static func screen(at p: CGPoint) -> NSScreen? {
        NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main
    }

    /// The display whose bounds hold the center of a Quartz rect (the one with the most overlap would be overkill).
    static func displayID(containing quartz: CGRect) -> CGDirectDisplayID? {
        let c = CGPoint(x: quartz.midX, y: quartz.midY)
        for s in NSScreen.screens {
            guard let id = displayID(of: s) else { continue }
            if CGDisplayBounds(id).contains(c) { return id }
        }
        return nil
    }

    /// A global Quartz rect relative to a display's top-left (what `sourceRect` means for a display filter), clipped to
    /// the display. Nil when what's left is smaller than `minSize`.
    static func local(_ quartz: CGRect, on displayID: CGDirectDisplayID, minSize: CGFloat = 8) -> CGRect? {
        let bounds = CGDisplayBounds(displayID)
        let r = quartz.offsetBy(dx: -bounds.minX, dy: -bounds.minY).intersection(CGRect(origin: .zero, size: bounds.size))
        guard !r.isNull, r.width >= minSize, r.height >= minSize else { return nil }
        return r
    }

    /// Visible windows front to back (Quartz order) with their frames; used to rank SCWindows by z-order and to track one.
    static func onScreenWindowOrder() -> [CGWindowID: Int] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [:] }
        var order: [CGWindowID: Int] = [:]
        for (i, w) in list.enumerated() {
            if let n = w[kCGWindowNumber as String] as? NSNumber { order[CGWindowID(n.uint32Value)] = i }
        }
        return order
    }

    /// Current Quartz frame of a window, or nil when it's gone / off screen.
    static func frame(ofWindow id: CGWindowID) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], let w = list.first,
              let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return nil }
        if let onscreen = w[kCGWindowIsOnscreen as String] as? NSNumber, !onscreen.boolValue { return nil }
        return r
    }
}
