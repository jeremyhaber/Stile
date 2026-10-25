import Foundation
import CoreGraphics

/// v3.5b: the pure part of scrolling capture. Frames of a scrolling area go in one at a time; the stitcher finds how far
/// each moved against the previous accepted frame and grows one tall picture. No AppKit, no ScreenCaptureKit, so it can be
/// unit-tested with synthetic frames (`Tests/StileCoreTests`).
///
/// How it matches: every row of a frame gets a 64-bit hash of a coarse grayscale sample (about 96 columns, so a Retina
/// frame costs little), then every vertical offset d (up to `searchFraction` of the height, both signs) is scored by the
/// number of rows where `new[y] == previous[y + d]`. Flat rows (one colour) are ignored: they match at any offset. The best
/// offset must cover enough of the overlap, and is then confirmed on full-resolution rows. Rows that are identical at the
/// top (or bottom) of both frames are a sticky header (footer): found on the first matched pair, kept once.

/// A frame as tightly packed BGRA bytes (premultiplied, little-endian 32-bit: what ScreenCaptureKit hands out).
public struct PixelFrame {
    public let width: Int
    public let height: Int
    public var data: [UInt8]

    public init(width: Int, height: Int, data: [UInt8]) {
        precondition(data.count == width * height * 4)
        self.width = width
        self.height = height
        self.data = data
    }

    /// Copies a BGRA buffer with a row stride (an `CVPixelBuffer`'s base address).
    public init(bgra base: UnsafeRawPointer, width: Int, height: Int, bytesPerRow: Int) {
        var d = [UInt8](repeating: 0, count: width * height * 4)
        d.withUnsafeMutableBytes { dst in
            for y in 0..<height {
                memcpy(dst.baseAddress! + y * width * 4, base + y * bytesPerRow, width * 4)
            }
        }
        self.init(width: width, height: height, data: d)
    }

    /// Draws any CGImage into BGRA.
    public init?(cgImage: CGImage, colorSpace: CGColorSpace? = nil) {
        let w = cgImage.width, h = cgImage.height
        guard w > 0, h > 0 else { return nil }
        var d = [UInt8](repeating: 0, count: w * h * 4)
        let cs = colorSpace ?? cgImage.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
        let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        let ok = d.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: cs, bitmapInfo: info) else { return false }
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        self.init(width: w, height: h, data: d)
    }

    public func makeCGImage(colorSpace: CGColorSpace? = nil) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(data) as CFData) else { return nil }
        let cs = colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
        let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: cs,
                       bitmapInfo: CGBitmapInfo(rawValue: info), provider: provider, decode: nil, shouldInterpolate: false,
                       intent: .defaultIntent)
    }
}

public struct ScrollStitcher {
    public struct Config {
        /// Stop growing at this many pixels of total height.
        public var maxHeight = 30_000
        /// Largest offset tried, as a fraction of the frame height.
        public var searchFraction = 0.9
        /// Fewest matching rows an offset needs (lowered for short overlaps).
        public var minMatchRows = 24
        /// Matching rows / non-flat rows in the overlap an offset needs.
        public var minMatchRatio = 0.4
        /// Rows compared at full resolution to confirm an offset.
        public var confirmRows = 16
        public init() {}
    }

    public enum Outcome: Equatable {
        case started             // first frame
        case unchanged           // same picture as before: nothing to do
        case appended(Int)       // rows added at the bottom (0: scrolled back over rows already held)
        case prepended(Int)      // rows added at the top
        case skipped             // no reliable offset ("Scroll slower")
        case capReached          // hit `maxHeight`; this and later frames are ignored
    }

    public let config: Config
    /// Frames accepted (the first counts).
    public private(set) var frameCount = 0
    public private(set) var capReached = false

    private var width = 0
    private var frameHeight = 0
    private var prev: PixelFrame?
    private var prevSig: RowSignatures?

    // Canvas, built on the first matched pair: sticky top rows + body + sticky bottom rows.
    private var stickyKnown = false
    private var head: [UInt8] = []
    private var foot: [UInt8] = []
    private var stickyTop = 0, stickyBottom = 0
    private var downChunks: [[UInt8]] = []   // body rows, in order (the first frame's body first)
    private var upChunks: [[UInt8]] = []     // rows prepended later, latest last (= topmost)
    private var bodyStart = 0, bodyEnd = 0   // body extent in "scroll" coordinates; the first frame's body is 0..<mh
    private var pos = 0                      // top of the viewport's moving region in the same coordinates
    private var colorSpace: CGColorSpace?

    public init(config: Config = Config()) { self.config = config }

    /// Pixel height of the picture so far.
    public var height: Int {
        stickyKnown ? stickyTop + (bodyEnd - bodyStart) + stickyBottom : frameHeight
    }

    public mutating func add(cgImage: CGImage) -> Outcome {
        if colorSpace == nil { colorSpace = cgImage.colorSpace }
        guard let f = PixelFrame(cgImage: cgImage, colorSpace: colorSpace) else { return .skipped }
        return add(f)
    }

    public mutating func add(_ f: PixelFrame) -> Outcome {
        if capReached { return .capReached }
        let sig = RowSignatures(f)
        guard let p = prev, let psig = prevSig else {
            prev = f; prevSig = sig
            width = f.width; frameHeight = f.height
            frameCount = 1
            return .started
        }
        guard f.width == width, f.height == frameHeight else { return .skipped }

        // identical (or nearly: a blinking caret) to the previous frame
        var same = 0
        for y in 0..<f.height where sig.hashes[y] == psig.hashes[y] { same += 1 }
        if same * 100 >= f.height * 99 { return .unchanged }

        guard let d = findOffset(p, psig, f, sig) else { return .skipped }

        if !stickyKnown {
            var t = 0
            while t < f.height, sig.hashes[t] == psig.hashes[t] { t += 1 }
            while t > 0, sig.flat[t - 1] { t -= 1 }          // a sticky band ends on real content
            var b = 0
            while b < f.height, sig.hashes[f.height - 1 - b] == psig.hashes[f.height - 1 - b] { b += 1 }
            while b > 0, sig.flat[f.height - b] { b -= 1 }
            let cap = Int(Double(f.height) * 0.4)
            t = min(t, cap); b = min(b, cap)
            guard abs(d) < f.height - t - b else { return .skipped }
            // split the previous (first) frame into header / body / footer
            let rb = width * 4
            head = Array(p.data[0..<(t * rb)])
            foot = Array(p.data[((p.height - b) * rb)...])
            downChunks = [Array(p.data[(t * rb)..<((p.height - b) * rb)])]
            stickyTop = t; stickyBottom = b
            bodyStart = 0; bodyEnd = p.height - t - b; pos = 0
            stickyKnown = true
        }

        let mh = frameHeight - stickyTop - stickyBottom
        guard abs(d) < mh else { return .skipped }
        pos += d
        let rb = width * 4
        var outcome = Outcome.appended(0)
        var capped = false
        var room = config.maxHeight - height
        if pos + mh > bodyEnd {
            var n = pos + mh - bodyEnd
            let from = frameHeight - stickyBottom - n   // the n rows that entered at the bottom
            if n > room { n = max(0, room); capped = true }
            if n > 0 { downChunks.append(Array(f.data[(from * rb)..<((from + n) * rb)])) }
            bodyEnd += n
            room -= n
            outcome = .appended(n)
        } else if pos < bodyStart {
            var n = bodyStart - pos
            let from = stickyTop + n   // rows [stickyTop, from) entered at the top; with a cap keep the ones nearest the body
            var take = n
            if take > room { take = max(0, room); capped = true }
            if take > 0 { upChunks.append(Array(f.data[((from - take) * rb)..<(from * rb)])) }
            bodyStart -= take
            n = take
            outcome = .prepended(n)
            if capped { pos = bodyStart }
        }
        prev = f; prevSig = sig
        frameCount += 1
        if capped || height >= config.maxHeight { capReached = true; return .capReached }
        return outcome
    }

    /// The stitched picture so far (nil before the first frame).
    public func finish() -> PixelFrame? {
        guard let p = prev else { return nil }
        guard stickyKnown else { return frameCount > 0 ? firstFrame(p) : nil }
        var out: [UInt8] = []
        out.reserveCapacity(height * width * 4)
        out.append(contentsOf: head)
        for c in upChunks.reversed() { out.append(contentsOf: c) }
        for c in downChunks { out.append(contentsOf: c) }
        out.append(contentsOf: foot)
        return PixelFrame(width: width, height: height, data: out)
    }

    public func finishImage() -> CGImage? { finish()?.makeCGImage(colorSpace: colorSpace) }

    private func firstFrame(_ p: PixelFrame) -> PixelFrame { p }

    // MARK: Matching

    private func findOffset(_ p: PixelFrame, _ ps: RowSignatures, _ f: PixelFrame, _ fs: RowSignatures) -> Int? {
        let h = f.height
        let maxD = min(h - 1, Int(Double(h) * config.searchFraction))
        guard maxD >= 1 else { return nil }
        // prefix sums of non-flat rows in the new frame, for the ratio test
        var nonFlat = [Int](repeating: 0, count: h + 1)
        for y in 0..<h { nonFlat[y + 1] = nonFlat[y] + (fs.flat[y] ? 0 : 1) }

        var bestD = 0, best = 0
        fs.hashes.withUnsafeBufferPointer { a in
            ps.hashes.withUnsafeBufferPointer { b in
                fs.flat.withUnsafeBufferPointer { flat in
                    // smallest |d| first, so ties keep the smaller move
                    for m in 1...maxD {
                        for sign in 0..<2 {
                            let d = sign == 0 ? m : -m
                            let y0 = max(0, -d), y1 = min(h, h - d)
                            if y1 - y0 <= best { continue }   // can't beat the best
                            var c = 0
                            var y = y0
                            while y < y1 {
                                if a[y] == b[y + d] && !flat[y] { c += 1 }
                                y += 1
                            }
                            if c > best { best = c; bestD = d }
                        }
                    }
                }
            }
        }
        guard bestD != 0 else { return nil }
        let y0 = max(0, -bestD), y1 = min(h, h - bestD)
        let overlapNonFlat = nonFlat[y1] - nonFlat[y0]
        let need = max(4, min(config.minMatchRows, overlapNonFlat / 4))
        guard best >= need, Double(best) >= config.minMatchRatio * Double(overlapNonFlat) else { return nil }

        // confirm on full-resolution rows: evenly spread among the matching ones
        var matching: [Int] = []
        for y in y0..<y1 where !fs.flat[y] && fs.hashes[y] == ps.hashes[y + bestD] { matching.append(y) }
        let k = min(config.confirmRows, matching.count)
        guard k > 0 else { return nil }
        var ok = 0
        let rb = f.width * 4
        for i in 0..<k {
            let y = matching[i * matching.count / k]
            if rowsClose(f.data, y * rb, p.data, (y + bestD) * rb, rb) { ok += 1 }
        }
        return ok * 4 >= k * 3 ? bestD : nil
    }

    /// Mean absolute difference per byte of two rows, small enough to call them the same.
    private func rowsClose(_ a: [UInt8], _ ao: Int, _ b: [UInt8], _ bo: Int, _ n: Int) -> Bool {
        var sum = 0
        a.withUnsafeBufferPointer { pa in
            b.withUnsafeBufferPointer { pb in
                for i in 0..<n { sum += abs(Int(pa[ao + i]) - Int(pb[bo + i])) }
            }
        }
        return sum <= 3 * n
    }
}

/// Per-row 64-bit hashes of a coarse grayscale sample, plus whether the sampled row is one flat colour.
struct RowSignatures {
    var hashes: [UInt64]
    var flat: [Bool]

    init(_ f: PixelFrame) {
        let w = f.width, h = f.height
        let step = max(1, w / 96)
        hashes = [UInt64](repeating: 0, count: h)
        flat = [Bool](repeating: false, count: h)
        f.data.withUnsafeBufferPointer { p in
            for y in 0..<h {
                var hash: UInt64 = 0xcbf29ce484222325
                var first: UInt8 = 0
                var isFlat = true
                var x = step / 2
                var i = 0
                while x < w {
                    let o = (y * w + x) * 4
                    // BGRA: gray = 0.299 R + 0.587 G + 0.114 B, quantised to ignore tiny noise
                    let g = UInt8(truncatingIfNeeded: (Int(p[o + 2]) * 77 + Int(p[o + 1]) * 150 + Int(p[o]) * 29) >> 10)
                    if i == 0 { first = g } else if g != first { isFlat = false }
                    hash = (hash ^ UInt64(g)) &* 0x100000001b3
                    x += step
                    i += 1
                }
                hashes[y] = hash
                flat[y] = isFlat
            }
        }
    }
}
