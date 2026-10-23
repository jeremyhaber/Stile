import AppKit

/// Samples the real colour of Chrome's tab rail with a window-only capture (our own panel is never in it).
enum ChromeColor {
    private typealias CreateImageFn = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    /// CGWindowListCreateImage is deprecated (and marked unavailable in some newer SDKs) but still works at
    /// runtime, so it is looked up dynamically; a missing symbol simply means "no sample".
    private static let createImage: CreateImageFn? = {
        guard let handle = dlopen(nil, RTLD_NOW), let sym = dlsym(handle, "CGWindowListCreateImage") else { return nil }
        return unsafeBitCast(sym, to: CreateImageFn.self)
    }()

    /// `rect` is in global screen coordinates (top-left origin). Returns "#rrggbb" (median of the pixels) or nil.
    static func sample(windowID: CGWindowID, rect: CGRect) -> String? {
        guard windowID != 0, Permissions.screenCaptureGranted, let create = createImage else { return nil }
        let opts = CGWindowImageOption([.boundsIgnoreFraming, .nominalResolution])
        guard let img = create(rect, CGWindowListOption.optionIncludingWindow.rawValue, windowID, opts.rawValue)?
            .takeRetainedValue() else { return nil }
        let w = img.width, h = img.height
        guard w > 0, h > 0, let cs = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ok: Bool = data.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                      bytesPerRow: w * 4, space: cs,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        var r: [UInt8] = [], g: [UInt8] = [], b: [UInt8] = []
        var i = 0
        while i + 3 < data.count {
            if data[i + 3] > 200 {
                r.append(data[i]); g.append(data[i + 1]); b.append(data[i + 2])
            }
            i += 4
        }
        guard !r.isEmpty else { return nil }
        func median(_ a: [UInt8]) -> UInt8 { a.sorted()[a.count / 2] }
        return String(format: "#%02x%02x%02x", Int(median(r)), Int(median(g)), Int(median(b)))
    }
}
