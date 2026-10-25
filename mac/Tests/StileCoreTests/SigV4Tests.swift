import XCTest
@testable import StileCore

/// AWS's documented SigV4 examples (the same vectors `tools/capture-build/test/sigv4.test.ts` checks s3.js against), then
/// signatures cross-checked against s3.js for the multipart requests, and the request shapes.
final class SigV4Tests: XCTestCase {
    let creds = S3Credentials(accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1")
    let d2013 = Date(timeIntervalSince1970: 1_369_353_600)   // 2013-05-24T00:00:00Z

    func testAmzDate() {
        XCTAssertEqual(SigV4.amzDate(d2013), "20130524T000000Z")
    }

    func testPresignedGetFromAWSDocs() {
        let r = SigV4.presign(url: URL(string: "https://examplebucket.s3.amazonaws.com/test.txt")!, credentials: creds, expires: 86400, date: d2013)
        XCTAssertEqual(r.signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")
        XCTAssertEqual(r.url.absoluteString,
            "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")
    }

    func testGetWithRangeFromAWSDocs() {
        let r = SigV4.sign(method: "GET", url: URL(string: "https://examplebucket.s3.amazonaws.com/test.txt")!, headers: ["range": "bytes=0-9"],
                           payloadHash: SigV4.emptyPayloadHash, credentials: creds, date: d2013)
        XCTAssertEqual(r.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")
    }

    func testPutWithStorageClassFromAWSDocs() {
        let hash = SigV4.sha256Hex("Welcome to Amazon S3.")
        XCTAssertEqual(hash, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072")
        let r = SigV4.sign(method: "PUT", url: URL(string: "https://examplebucket.s3.amazonaws.com/test$file.text")!,
                           headers: ["date": "Fri, 24 May 2013 00:00:00 GMT", "x-amz-date": "20130524T000000Z", "x-amz-storage-class": "REDUCED_REDUNDANCY"],
                           payloadHash: hash, credentials: creds, date: d2013)
        XCTAssertEqual(r.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd")
    }

    // Signatures computed with extension/capture/s3.js (itself checked against the aws4 library) for the same requests.
    let odd = S3Config.make(endpoint: "http://127.0.0.1:9123", region: "auto", bucket: "b", style: "path")
    let oddKey = "recordings/2026/10/Recording — Slack (1)!.mp4"
    let d2026 = Date(timeIntervalSince1970: 1_792_764_202)   // 2026-10-23T14:03:22Z
    var autoCreds: S3Credentials { S3Credentials(accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, region: "auto") }

    func testObjectURLEncoding() {
        XCTAssertEqual(odd.objectURL(key: oddKey)?.absoluteString, "http://127.0.0.1:9123/b/recordings/2026/10/Recording%20%E2%80%94%20Slack%20%281%29%21.mp4")
    }

    func testPutObjectMatchesJS() {
        let url = odd.objectURL(key: oddKey)!
        let r = S3Requests.putObject(url, contentType: "video/mp4", payloadHash: SigV4.sha256Hex(Data([1, 2, 3, 4])), credentials: autoCreds, date: d2026)
        XCTAssertEqual(r.signature, "71768068b255c392c4e3c25574215617f15766b798947c398b25674fbd16c253")
        XCTAssertEqual(r.headers["content-type"], "video/mp4")
        XCTAssertNil(r.urlRequest.value(forHTTPHeaderField: "host"))
        XCTAssertTrue(r.urlRequest.value(forHTTPHeaderField: "Authorization")!.contains("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"))
    }

    func testCreateMultipartUpload() {
        let url = odd.objectURL(key: oddKey)!
        let r = S3Requests.createMultipartUpload(url, contentType: "video/mp4", credentials: autoCreds, date: d2026)
        XCTAssertEqual(r.method, "POST")
        XCTAssertEqual(r.url.query, "uploads=")
        XCTAssertEqual(r.signature, "b5bec326174ff78691125a36de6bf1d08183e008017f48e6e6006ceb819dba23")
    }

    func testUploadPartSortsAndEncodesQuery() {
        let url = odd.objectURL(key: oddKey)!
        let r = S3Requests.uploadPart(url, uploadId: "abc+def=", partNumber: 2, payloadHash: SigV4.sha256Hex(Data([9, 9])), credentials: autoCreds, date: d2026)
        XCTAssertEqual(r.url.query, "partNumber=2&uploadId=abc%2Bdef%3D")
        XCTAssertEqual(r.method, "PUT")
        XCTAssertEqual(r.signature, "a92a3faa93a39edec97514a54e249a4dae5201d186f830d79e204832e18a6d41")
    }

    func testCompleteMultipartUploadBodyAndSignature() {
        let url = odd.objectURL(key: oddKey)!
        let r = S3Requests.completeMultipartUpload(url, uploadId: "abc+def=", parts: [(2, "\"e2\""), (1, "\"e1\"")], credentials: autoCreds, date: d2026)
        XCTAssertEqual(String(data: r.body!, encoding: .utf8),
            "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part></CompleteMultipartUpload>")
        // s3.js signed the same XML with the quotes unescaped, so check the shape here and the signature below with a plain ETag
        let plain = S3Requests.completeMultipartUpload(url, uploadId: "abc+def=", parts: [(1, "e1")], credentials: autoCreds, date: d2026)
        XCTAssertEqual(plain.headers["x-amz-content-sha256"], SigV4.sha256Hex(plain.body!))
        XCTAssertEqual(plain.method, "POST")
        XCTAssertEqual(plain.headers["content-type"], "application/xml")
    }

    func testCompleteSignatureMatchesJS() {
        // the body s3.js signed (raw quotes in the ETag text)
        let url = odd.objectURL(key: oddKey)!
        let body = "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>\"e1\"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>\"e2\"</ETag></Part></CompleteMultipartUpload>"
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.percentEncodedQuery = "uploadId=abc%2Bdef%3D"
        let r = SigV4.sign(method: "POST", url: c.url!, headers: ["content-type": "application/xml"], payloadHash: SigV4.sha256Hex(body), credentials: autoCreds, date: d2026)
        XCTAssertEqual(r.signature, "2c2a279dd81219177aac78941be38e26c2429d94245c5d065b0931a77a9a116c")
    }

    func testAbortMultipartUpload() {
        let url = odd.objectURL(key: oddKey)!
        let r = S3Requests.abortMultipartUpload(url, uploadId: "abc+def=", credentials: autoCreds, date: d2026)
        XCTAssertEqual(r.method, "DELETE")
        XCTAssertEqual(r.url.query, "uploadId=abc%2Bdef%3D")
        XCTAssertEqual(r.signature, "83ab6d81e18289c81e7c8366ab035ec7cec19ac3a4fe761a8fff726a7ef05e06")
    }

    func testPresignMatchesJS() {
        let r = SigV4.presign(url: odd.objectURL(key: oddKey)!, credentials: autoCreds, expires: 3600, date: d2026)
        XCTAssertEqual(r.signature, "ff3a52b05b44c122147e9763f33267de1a89551c6198a3f7bf94a65e2deef92b")
    }

    func testParsingS3Responses() {
        XCTAssertEqual(S3Requests.parseUploadId("<?xml version=\"1.0\"?><InitiateMultipartUploadResult><Bucket>b</Bucket><UploadId>XYZ.123</UploadId></InitiateMultipartUploadResult>"), "XYZ.123")
        XCTAssertEqual(S3Requests.errorText("<Error><Code>AccessDenied</Code><Message>Nope</Message></Error>"), "AccessDenied: Nope")
        XCTAssertNil(S3Requests.errorText("ok"))
    }

    func testFileHashingWithOffsetAndLength() throws {
        let f = FileManager.default.temporaryDirectory.appendingPathComponent("sigv4-\(UUID().uuidString).bin")
        defer { try? FileManager.default.removeItem(at: f) }
        var data = Data(); for i in 0..<3_000_000 { data.append(UInt8(truncatingIfNeeded: i &* 7)) }
        try data.write(to: f)
        XCTAssertEqual(try SigV4.sha256Hex(file: f), SigV4.sha256Hex(data))
        XCTAssertEqual(try SigV4.sha256Hex(file: f, offset: 1_500_000, length: 1_200_000), SigV4.sha256Hex(data.subdata(in: 1_500_000..<2_700_000)))
        XCTAssertEqual(try SigV4.sha256Hex(file: f, offset: 2_900_000, length: 500_000), SigV4.sha256Hex(data.subdata(in: 2_900_000..<3_000_000)))
    }

    // MARK: Keys, regions and links (s3.js rules)

    func testRegionAndStyleFromEndpoint() {
        XCTAssertEqual(S3Config.region(fromEndpoint: "https://s3.eu-west-1.amazonaws.com"), "eu-west-1")
        XCTAssertEqual(S3Config.region(fromEndpoint: "https://abc.r2.cloudflarestorage.com"), "auto")
        XCTAssertEqual(S3Config.region(fromEndpoint: "https://nyc3.digitaloceanspaces.com"), "nyc3")
        XCTAssertEqual(S3Config.region(fromEndpoint: "https://s3.amazonaws.com"), "us-east-1")
        XCTAssertNil(S3Config.region(fromEndpoint: "https://minio.local:9000"))
        XCTAssertEqual(S3Config.make(endpoint: "https://s3.eu-west-1.amazonaws.com", region: "", bucket: "bkt").effectiveStyle, "virtual")
        XCTAssertEqual(S3Config.make(endpoint: "https://x.r2.cloudflarestorage.com", region: "", bucket: "bkt").effectiveStyle, "path")
        XCTAssertEqual(S3Config.make(endpoint: "https://s3.eu-west-1.amazonaws.com", region: "", bucket: "bkt").effectiveRegion, "eu-west-1")
    }

    func testObjectURLStyles() {
        XCTAssertEqual(S3Config.make(endpoint: "https://s3.eu-west-1.amazonaws.com", region: "eu-west-1", bucket: "bkt", style: "virtual").objectURL(key: "a b/c.mp4")?.absoluteString,
                       "https://bkt.s3.eu-west-1.amazonaws.com/a%20b/c.mp4")
        XCTAssertEqual(S3Config.make(endpoint: "https://x.r2.cloudflarestorage.com", region: "auto", bucket: "bkt", style: "path").objectURL(key: "a/c.mp4")?.absoluteString,
                       "https://x.r2.cloudflarestorage.com/bkt/a/c.mp4")
    }

    func testObjectKeyLayout() {
        var cal = DateComponents(); cal.year = 2026; cal.month = 10; cal.day = 3; cal.hour = 4; cal.minute = 5; cal.second = 6
        let d = Calendar.current.date(from: cal)!
        var c = S3Config.make(endpoint: "https://e.example", region: "auto", bucket: "b", prefix: "shots/{yyyy}/{mm}/", naming: "timestamp")
        XCTAssertEqual(c.objectKey(date: d, timestampName: "Recording 2026-10-03 at 04.05.06"), "shots/2026/10/Recording 2026-10-03 at 04.05.06.mp4")
        c.naming = "random"; c.prefix = ""
        XCTAssertEqual(c.objectKey(date: d, id: "abc", timestampName: "x"), "abc.mp4")
        c.prefix = "/x"
        XCTAssertEqual(c.objectKey(date: d, id: "abc", timestampName: "x"), "x/abc.mp4")
        c.prefix = "screenshots/{yyyy}/{mm}/"
        XCTAssertEqual(c.objectKey(date: d, id: "abc", timestampName: "x"), "recordings/2026/10/abc.mp4")
        XCTAssertEqual(c.objectKey(date: d, id: "abc", timestampName: "x", recordings: false), "screenshots/2026/10/abc.mp4")
    }

    func testShareLinks() {
        var c = S3Config.make(endpoint: "https://e.example", region: "auto", bucket: "b", publicBase: "https://shots.example.com")
        c.accessKeyId = "AK"; c.secretAccessKey = "SK"
        XCTAssertEqual(c.publicLink(key: "a b/c.mp4"), "https://shots.example.com/a%20b/c.mp4")
        c.linkType = "public"
        XCTAssertEqual(c.shareLink(key: "a/c.mp4"), "https://shots.example.com/a/c.mp4")
        c.linkType = "presigned"
        let l = c.shareLink(key: "a/c.mp4", date: d2013)!
        XCTAssertTrue(l.hasPrefix("https://e.example/b/a/c.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256"))
        XCTAssertTrue(l.contains("X-Amz-Expires=604800"))
    }
}

extension S3Config {
    static func make(endpoint: String, region: String, bucket: String, style: String = "auto", prefix: String = "screenshots/{yyyy}/{mm}/",
                     naming: String = "random", publicBase: String = "") -> S3Config {
        var c = S3Config()
        c.endpoint = endpoint; c.region = region; c.bucket = bucket; c.style = style; c.prefix = prefix; c.naming = naming; c.publicBase = publicBase
        return c
    }
}
