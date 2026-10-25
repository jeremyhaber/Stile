import Foundation

/// v3.6: the small pure parts of the recorder, kept here so they can be unit-tested.
public enum RecordingMath {
    /// Output pixel size for a capture of `width` x `height` pixels: scaled down (never up) so the longer side is at most
    /// `maxLongSide` (nil = native), then rounded down to even numbers, which H.264 / HEVC need. At least 2 x 2.
    public static func outputSize(width: Double, height: Double, maxLongSide: Double?) -> (width: Int, height: Int) {
        var w = max(width, 1), h = max(height, 1)
        if let m = maxLongSide, m > 0, max(w, h) > m {
            let k = m / max(w, h)
            w *= k
            h *= k
        }
        func even(_ v: Double) -> Int { max(2, Int(v.rounded(.down)) & ~1) }
        return (even(w), even(h))
    }

    /// The "max resolution" setting as a longer-side cap: 1080p = 1920, 1440p = 2560, native = nil.
    public static func maxLongSide(forSetting s: String) -> Double? {
        switch s {
        case "1080p": return 1920
        case "1440p": return 2560
        default: return nil
        }
    }

    /// "0:07", "12:03", "1:02:03".
    public static func timer(_ seconds: Double) -> String {
        let t = max(0, Int(seconds))
        let h = t / 3600, m = (t % 3600) / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// "0:07.4", "12:03.0": the timer with tenths, for the trim timeline where a second is too coarse.
    public static func preciseTimer(_ seconds: Double) -> String {
        let tenths = Int((max(0, seconds) * 10).rounded())
        return timer(Double(tenths / 10)) + ".\(tenths % 10)"
    }

    /// Moves one trim edge, keeping at least `minLength` between start and end and both within 0...duration.
    /// Returns the new (start, end).
    public static func trim(start: Double, end: Double, duration: Double, moving edge: TrimEdge, to t: Double,
                            minLength: Double = 0.5) -> (start: Double, end: Double) {
        let d = max(0, duration), gap = min(minLength, d)
        switch edge {
        case .start: return (min(max(0, t), end - gap), end)
        case .end: return (start, max(min(d, t), start + gap))
        }
    }
    public enum TrimEdge: Sendable { case start, end }

    /// 0...1 meter level from a peak amplitude (0...1): -50 dB..0 dB mapped linearly, so quiet speech still moves it.
    public static func meterLevel(peak: Float) -> Float {
        guard peak > 0.000_01 else { return 0 }
        let db = 20 * log10(peak)
        return min(1, max(0, (db + 50) / 50))
    }

    /// A Chrome page area (global Quartz points, e.g. an `AXWebArea` frame) relative to its window's top-left, clipped
    /// to the window. Nil when it doesn't overlap the window or is tiny.
    public static func relativeRect(_ area: CGRect, in window: CGRect) -> CGRect? {
        let r = area.offsetBy(dx: -window.minX, dy: -window.minY)
            .intersection(CGRect(origin: .zero, size: window.size))
        guard !r.isNull, r.width >= 16, r.height >= 16 else { return nil }
        return r
    }

    /// Which web area is the page: the largest (a docked DevTools or side panel is another web area, smaller).
    public static func pickPage(_ frames: [CGRect]) -> CGRect? {
        frames.max { $0.width * $0.height < $1.width * $1.height }
    }
}
