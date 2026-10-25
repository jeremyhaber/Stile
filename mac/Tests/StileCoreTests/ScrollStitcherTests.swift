import XCTest
@testable import StileCore

/// Synthetic scrolling: a tall "page" of random rows is cut into overlapping viewport frames.
final class ScrollStitcherTests: XCTestCase {
    static let W = 100

    struct Rng {
        var s: UInt64
        mutating func next() -> UInt8 {
            s = s &* 6364136223846793005 &+ 1442695040888963407
            return UInt8(truncatingIfNeeded: s >> 33)
        }
    }

    /// `rows` random, never flat rows (BGRA, opaque).
    func page(rows: Int, seed: UInt64) -> [UInt8] {
        var r = Rng(s: seed)
        var d = [UInt8](repeating: 255, count: rows * Self.W * 4)
        for y in 0..<rows {
            for x in 0..<Self.W {
                let o = (y * Self.W + x) * 4
                d[o] = r.next(); d[o + 1] = r.next(); d[o + 2] = r.next()
            }
        }
        return d
    }

    func rows(_ a: [UInt8], _ from: Int, _ to: Int) -> [UInt8] { Array(a[(from * Self.W * 4)..<(to * Self.W * 4)]) }

    func frame(_ page: [UInt8], top: Int, height: Int, header: [UInt8] = [], footer: [UInt8] = []) -> PixelFrame {
        let hr = header.count / (Self.W * 4), fr = footer.count / (Self.W * 4)
        var d = header
        d += rows(page, top, top + height - hr - fr)
        d += footer
        return PixelFrame(width: Self.W, height: height, data: d)
    }

    func run(_ s: inout ScrollStitcher, _ frames: [PixelFrame]) -> [ScrollStitcher.Outcome] {
        frames.map { s.add($0) }
    }

    func testStitchesVariedOffsets() {
        let p = page(rows: 1500, seed: 1)
        let tops = [0, 90, 200, 230, 420, 600, 777, 900]
        var s = ScrollStitcher()
        _ = run(&s, tops.map { frame(p, top: $0, height: 300) })
        let out = s.finish()!
        XCTAssertEqual(out.height, 900 + 300)
        XCTAssertEqual(out.data, rows(p, 0, 1200))
        XCTAssertEqual(s.frameCount, tops.count)
    }

    func testUnchangedFramesIgnored() {
        let p = page(rows: 600, seed: 2)
        var s = ScrollStitcher()
        let f0 = frame(p, top: 0, height: 200), f1 = frame(p, top: 50, height: 200)
        XCTAssertEqual(s.add(f0), .started)
        XCTAssertEqual(s.add(f0), .unchanged)
        XCTAssertEqual(s.add(f1), .appended(50))
        XCTAssertEqual(s.add(f1), .unchanged)
        XCTAssertEqual(s.finish()!.data, rows(p, 0, 250))
    }

    func testStickyHeaderAndFooterKeptOnce() {
        let p = page(rows: 1500, seed: 3)
        let header = page(rows: 30, seed: 40), footer = page(rows: 20, seed: 41)
        let tops = [0, 100, 210, 400, 520]
        var s = ScrollStitcher()
        _ = run(&s, tops.map { frame(p, top: $0, height: 300, header: header, footer: footer) })
        let out = s.finish()!
        // body rows seen: page rows 0 ..< 520 + (300 - 50)
        let bodyEnd = 520 + 250
        XCTAssertEqual(out.height, 30 + bodyEnd + 20)
        XCTAssertEqual(out.data, header + rows(p, 0, bodyEnd) + footer)
    }

    func testScrollingUpPrepends() {
        let p = page(rows: 1500, seed: 4)
        let tops = [800, 700, 560, 500, 300]
        var s = ScrollStitcher()
        let o = run(&s, tops.map { frame(p, top: $0, height: 300) })
        XCTAssertEqual(o[1], .prepended(100))
        XCTAssertEqual(s.finish()!.data, rows(p, 300, 1100))
    }

    func testBackAndForthDoesNotDuplicate() {
        let p = page(rows: 1500, seed: 5)
        let tops = [0, 150, 300, 120, 0, 250, 450]
        var s = ScrollStitcher()
        _ = run(&s, tops.map { frame(p, top: $0, height: 300) })
        XCTAssertEqual(s.finish()!.data, rows(p, 0, 750))
    }

    func testStickyWithScrollUp() {
        let p = page(rows: 1500, seed: 6)
        let header = page(rows: 40, seed: 50)
        let tops = [500, 420, 300]
        var s = ScrollStitcher()
        _ = run(&s, tops.map { frame(p, top: $0, height: 300, header: header) })
        XCTAssertEqual(s.finish()!.data, header + rows(p, 300, 500 + 260))
    }

    func testJumpIsSkippedThenRecovers() {
        let p = page(rows: 3000, seed: 7)
        var s = ScrollStitcher()
        XCTAssertEqual(s.add(frame(p, top: 0, height: 300)), .started)
        XCTAssertEqual(s.add(frame(p, top: 100, height: 300)), .appended(100))
        // a jump of 2000 rows: no overlap with anything seen
        XCTAssertEqual(s.add(frame(p, top: 2100, height: 300)), .skipped)
        XCTAssertEqual(s.frameCount, 2)
        XCTAssertEqual(s.add(frame(p, top: 250, height: 300)), .appended(150))
        XCTAssertEqual(s.finish()!.data, rows(p, 0, 550))
    }

    func testBlankFramesDoNotMatch() {
        var s = ScrollStitcher()
        let blank = PixelFrame(width: Self.W, height: 200, data: [UInt8](repeating: 255, count: Self.W * 200 * 4))
        let p = page(rows: 400, seed: 8)
        XCTAssertEqual(s.add(frame(p, top: 0, height: 200)), .started)
        XCTAssertEqual(s.add(blank), .skipped)
    }

    func testHeightCap() {
        let p = page(rows: 3000, seed: 9)
        var cfg = ScrollStitcher.Config()
        cfg.maxHeight = 500
        var s = ScrollStitcher(config: cfg)
        XCTAssertEqual(s.add(frame(p, top: 0, height: 300)), .started)
        XCTAssertEqual(s.add(frame(p, top: 150, height: 300)), .appended(150))
        XCTAssertEqual(s.add(frame(p, top: 300, height: 300)), .capReached)
        XCTAssertEqual(s.height, 500)
        XCTAssertEqual(s.add(frame(p, top: 450, height: 300)), .capReached)
        XCTAssertEqual(s.finish()!.data, rows(p, 0, 500))
    }

    func testSingleFrameAndImageRoundTrip() {
        let p = page(rows: 100, seed: 10)
        var s = ScrollStitcher()
        _ = s.add(frame(p, top: 0, height: 100))
        let img = s.finishImage()
        XCTAssertEqual(img?.width, Self.W)
        XCTAssertEqual(img?.height, 100)
        let back = PixelFrame(cgImage: img!, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        XCTAssertEqual(back?.data, rows(p, 0, 100))
    }
}
