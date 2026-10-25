import CoreGraphics
import XCTest
@testable import StileCore

final class CountTests: XCTestCase {
    func testCounterPlacesResetsAndOverrides() {
        var c = CountCounter()
        XCTAssertEqual(c.place(), 1)
        XCTAssertEqual(c.place(), 2)
        XCTAssertEqual(c.next, 3)
        c.reset()
        XCTAssertEqual(c.next, 1)
        XCTAssertEqual(c.place(), 1)               // a new count starts over; earlier badges keep theirs
        XCTAssertEqual(c.override(7), 7)           // typing a badge's number: the next one continues from it
        XCTAssertEqual(c.next, 8)
        XCTAssertEqual(c.place(), 8)
    }

    func testCounterClampsToPositiveAndMax() {
        var c = CountCounter()
        XCTAssertEqual(c.override(0), 1)
        XCTAssertEqual(c.override(-5), 1)
        XCTAssertEqual(c.override(5000), 999)
        XCTAssertEqual(c.next, 999)
        XCTAssertEqual(c.place(), 999)
        XCTAssertEqual(c.place(), 999)
    }

    func testCounterStartsAfterExistingBadgesAndUndoIsAValueCopy() {
        var existing = ann(.count, .zero, .zero, number: 4)
        existing.id = 2
        var c = CountCounter(existing: [existing, ann(.rect, .zero, .zero, number: 50)])
        XCTAssertEqual(c.next, 5)
        let snapshot = c                           // what an undo step keeps
        _ = c.place(); c.reset()
        XCTAssertNotEqual(c, snapshot)
        c = snapshot
        XCTAssertEqual(c.next, 5)
    }

    let size = CGSize(width: 1000, height: 500)

    func ann(_ kind: VideoAnnotation.Kind, _ a: CGPoint, _ b: CGPoint, number: Int = 0, size s: Int = 1) -> VideoAnnotation {
        VideoAnnotation(id: 1, kind: kind, a: a, b: b, color: 0xe5322d, size: s, start: 0, length: 4, number: number)
    }

    func testNextNumberFollowsTheHighestLikeTheScreenshotEditor() {
        func count(_ id: Int, _ n: Int) -> VideoAnnotation { var c = ann(.count, .zero, .zero, number: n); c.id = id; return c }
        XCTAssertEqual(VideoAnnotation.nextNumber(in: []), 1)
        XCTAssertEqual(VideoAnnotation.nextNumber(in: [ann(.rect, .zero, .zero, number: 9)]), 1)   // only counts count
        // deleting the middle one leaves the gap; deleting the highest frees its number
        XCTAssertEqual(VideoAnnotation.nextNumber(in: [count(1, 1), count(3, 3)]), 4)
        XCTAssertEqual(VideoAnnotation.nextNumber(in: [count(1, 1), count(2, 2)]), 3)
    }

    func testBadgeBounds() {
        let c = ann(.count, CGPoint(x: 0.5, y: 0.5), CGPoint(x: 0.5, y: 0.5), number: 1)
        let r = AnnotationStyle.badgeRadius(1, size)
        XCTAssertEqual(r, 14)   // ref = min(1000, 1250) -> round(1000 * 0.014)
        XCTAssertEqual(AnnotationRenderer.bounds(of: c, size: size), CGRect(x: 500 - r, y: 250 - r, width: r * 2, height: r * 2))
    }

    func testBadgeRadiusSteps() {
        let s = CGSize(width: 1000, height: 1000)
        XCTAssertEqual(AnnotationStyle.badgeRadius(0, s), 9)
        XCTAssertEqual(AnnotationStyle.badgeRadius(1, s), 14)
        XCTAssertEqual(AnnotationStyle.badgeRadius(2, s), 20)
        XCTAssertEqual(AnnotationStyle.badgeRadius(1, CGSize(width: 200, height: 100)), 12)   // the minimum
    }

    func testCountMovesAsOnePointAndStaysOnTheVideo() {
        let c = ann(.count, CGPoint(x: 0.9, y: 0.1), CGPoint(x: 0.9, y: 0.1), number: 2)
        let m = c.moved(by: CGVector(dx: 0.5, dy: -0.5))
        XCTAssertEqual(m.a, CGPoint(x: 1, y: 0))
        XCTAssertEqual(m.number, 2)
    }

    func testCountIsDrawnAtOneToThreeDigits() throws {
        func render(_ a: VideoAnnotation) throws -> [UInt8] {
            let w = 200, h = 100
            var p = [UInt8](repeating: 0, count: w * h * 4)
            let ctx = try XCTUnwrap(CGContext(data: &p, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            ctx.translateBy(x: 0, y: CGFloat(h))
            ctx.scaleBy(x: 1, y: -1)
            AnnotationRenderer.draw(a, in: ctx, size: CGSize(width: w, height: h))
            return p
        }
        let count = try render(ann(.count, CGPoint(x: 0.5, y: 0.5), CGPoint(x: 0.5, y: 0.5), number: 7, size: 2))
        XCTAssertTrue(count.contains { $0 != 0 })
        // a badge's rim is the colour, away from the glyph: the left edge of the circle
        let r = Int(AnnotationStyle.badgeRadius(2, CGSize(width: 200, height: 100)))
        let i = (50 * 200 + (100 - r + 2)) * 4
        XCTAssertEqual(count[i], 0xe5)
        XCTAssertEqual(count[i + 3], 255)
        for n in [12, 345] {
            let px = try render(ann(.count, CGPoint(x: 0.5, y: 0.5), CGPoint(x: 0.5, y: 0.5), number: n, size: 2))
            XCTAssertTrue(px.contains { $0 != 0 })
            // the glyphs stay inside the circle: nothing drawn outside its radius
            let rr = Int(AnnotationStyle.badgeRadius(2, CGSize(width: 200, height: 100))) + 4
            for y in 0..<100 { for x in 0..<200 where (x - 100) * (x - 100) + (y - 50) * (y - 50) > rr * rr { XCTAssertEqual(px[(y * 200 + x) * 4 + 3], 0) } }
        }
    }
}
