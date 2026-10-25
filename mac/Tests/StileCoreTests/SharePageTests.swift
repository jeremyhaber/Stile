import XCTest
@testable import StileCore

final class SharePageTests: XCTestCase {
    private func input(title: String = "Demo") -> SharePage.Input {
        SharePage.Input(title: title, videoURL: "https://cdn.example.com/r/a.mp4?X-Amz-Signature=1&X-Amz-Expires=9",
                        posterURL: "https://cdn.example.com/r/a.jpg", pageURL: "https://cdn.example.com/r/a.html",
                        duration: 62, date: Date(timeIntervalSince1970: 1_792_000_000), width: 1920, height: 1080,
                        timeZone: TimeZone(identifier: "UTC")!)
    }

    func testEscapesTitleEverywhere() {
        let evil = "A \"quoted\" </script><script>alert(1)</script> & 'x' <b>"
        let html = SharePage.html(input(title: evil))
        XCTAssertFalse(html.contains("<script"))
        XCTAssertFalse(html.contains("</script>"))
        XCTAssertFalse(html.contains("<b>"))
        XCTAssertTrue(html.contains("A &quot;quoted&quot; &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;x&#39; &lt;b&gt;"))
        XCTAssertTrue(html.contains("<meta property=\"og:title\" content=\"A &quot;quoted&quot;"))
    }

    func testOpenGraphAndTwitterTags() {
        let html = SharePage.html(input())
        for t in ["og:type\" content=\"video.other", "og:image\" content=\"https://cdn.example.com/r/a.jpg", "og:image:width\" content=\"1920",
                  "og:image:height\" content=\"1080", "og:video:type\" content=\"video/mp4", "og:video:width\" content=\"1920",
                  "og:url\" content=\"https://cdn.example.com/r/a.html", "twitter:card\" content=\"summary_large_image",
                  "twitter:image\" content=\"https://cdn.example.com/r/a.jpg"] {
            XCTAssertTrue(html.contains(t), t)
        }
        // query separators in the signed URL are escaped for the attribute
        XCTAssertTrue(html.contains("og:video\" content=\"https://cdn.example.com/r/a.mp4?X-Amz-Signature=1&amp;X-Amz-Expires=9"))
        XCTAssertTrue(html.contains("og:video:secure_url"))
    }

    func testSelfContained() {
        let html = SharePage.html(input())
        XCTAssertFalse(html.contains("<script"))
        XCTAssertFalse(html.contains("<link"))
        XCTAssertFalse(html.contains("@import"))
        XCTAssertFalse(html.contains("url("))
        // the only absolute URLs outside meta tags are the two media files
        let refs = html.components(separatedBy: "\n").filter { !$0.hasPrefix("<meta") && $0.contains("http") }
        for l in refs { XCTAssertTrue(l.contains("cdn.example.com"), l) }
        XCTAssertTrue(html.contains("controls playsinline preload=\"metadata\""))
        XCTAssertTrue(html.contains("Made with Stile"))
        XCTAssertTrue(html.contains("prefers-color-scheme:dark"))
    }

    func testDurationAndDate() {
        XCTAssertEqual(SharePage.formatDuration(62), "1:02")
        XCTAssertEqual(SharePage.formatDuration(3723), "1:02:03")
        let html = SharePage.html(input())
        XCTAssertTrue(html.contains("<span>1:02</span>"))
        XCTAssertTrue(html.contains("datetime=\"2026-10-"))
    }
}
