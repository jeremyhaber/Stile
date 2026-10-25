import CryptoKit
import Foundation

/// v3.6: AWS Signature Version 4 for S3-compatible storage, pure and unit-tested. A port of `extension/capture/s3.js`
/// (checked against AWS's documented examples), plus builders for the requests a multipart upload needs.
public struct S3Credentials: Sendable {
    public var accessKeyId: String
    public var secretAccessKey: String
    public var region: String
    public init(accessKeyId: String, secretAccessKey: String, region: String) {
        self.accessKeyId = accessKeyId
        self.secretAccessKey = secretAccessKey
        self.region = region
    }
}

/// A request ready to hand to URLSession: `headers` excludes Host (URLSession sets it itself) but it was signed.
public struct SignedRequest: Sendable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    public var authorization: String
    public var signature: String
    public var canonicalRequest: String
    public var stringToSign: String

    public var urlRequest: URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        for (k, v) in headers where k != "host" { r.setValue(v, forHTTPHeaderField: k) }
        r.setValue(authorization, forHTTPHeaderField: "Authorization")
        return r
    }
}

public enum SigV4 {
    public static let emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    // MARK: Hashing

    public static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
    public static func sha256Hex(_ data: Data) -> String { hex(SHA256.hash(data: data)) }
    public static func sha256Hex(_ s: String) -> String { sha256Hex(Data(s.utf8)) }

    /// SHA-256 of `length` bytes of a file from `offset`, read in 1 MB steps (parts are up to tens of MB).
    public static func sha256Hex(file url: URL, offset: UInt64 = 0, length: UInt64? = nil) throws -> String {
        let fh = try FileHandle(forReadingFrom: url)
        defer { try? fh.close() }
        try fh.seek(toOffset: offset)
        var hasher = SHA256()
        var left = length ?? UInt64.max
        while left > 0 {
            let n = Int(min(left, 1 << 20))
            guard let chunk = try fh.read(upToCount: n), !chunk.isEmpty else { break }
            hasher.update(data: chunk)
            left -= UInt64(chunk.count)
        }
        return hex(hasher.finalize())
    }

    static func hmac(_ key: Data, _ message: String) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: key)))
    }

    static func signingKey(secret: String, date8: String, region: String, service: String) -> Data {
        let kDate = hmac(Data(("AWS4" + secret).utf8), date8)
        let kRegion = hmac(kDate, region)
        let kService = hmac(kRegion, service)
        return hmac(kService, "aws4_request")
    }

    // MARK: Encoding

    private static let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~".utf8)

    /// RFC 3986 as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ is %XX (uppercase hex).
    public static func uriEncode(_ s: String) -> String {
        var out = ""
        for b in s.utf8 { out += unreserved.contains(b) ? String(UnicodeScalar(b)) : String(format: "%%%02X", b) }
        return out
    }
    public static func encodePath(_ p: String) -> String {
        p.split(separator: "/", omittingEmptySubsequences: false).map { uriEncode(String($0)) }.joined(separator: "/")
    }

    /// 20130524T000000Z
    public static func amzDate(_ d: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: d)
        return String(format: "%04d%02d%02dT%02d%02d%02dZ", c.year!, c.month!, c.day!, c.hour!, c.minute!, c.second!)
    }

    /// Host as a client sends it: a non-default port is included.
    static func hostHeader(_ url: URL) -> String {
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let host = c?.host ?? url.host ?? ""
        guard let port = c?.port else { return host }
        if (url.scheme == "https" && port == 443) || (url.scheme == "http" && port == 80) { return host }
        return "\(host):\(port)"
    }

    /// The path decoded and re-encoded the SigV4 way (S3 signs the path once-encoded).
    static func canonicalPath(_ url: URL) -> String {
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        let decoded = raw.removingPercentEncoding ?? raw
        return decoded.isEmpty ? "/" : encodePath(decoded)
    }

    /// Query pairs decoded, re-encoded, sorted by name then value.
    static func canonicalQuery(_ pairs: [(String, String)]) -> String {
        pairs.map { (uriEncode($0.0), uriEncode($0.1)) }
            .sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
            .map { "\($0.0)=\($0.1)" }.joined(separator: "&")
    }
    static func queryPairs(_ url: URL) -> [(String, String)] {
        (URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQueryItems ?? []).map {
            (($0.name.removingPercentEncoding ?? $0.name), (($0.value ?? "").removingPercentEncoding ?? ($0.value ?? "")))
        }
    }

    // MARK: Signing

    /// Header-based signing. `headers` are the request headers to sign (host, x-amz-date and x-amz-content-sha256 are
    /// added when missing).
    public static func sign(method: String, url: URL, headers: [String: String] = [:], payloadHash: String,
                            credentials c: S3Credentials, service: String = "s3", date: Date = Date()) -> SignedRequest {
        var h: [String: String] = [:]
        for (k, v) in headers {
            h[k.lowercased()] = v.trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
        }
        let stamp = amzDate(date)
        if h["host"] == nil { h["host"] = hostHeader(url) }
        if h["x-amz-date"] == nil && h["date"] == nil { h["x-amz-date"] = stamp }
        if h["x-amz-content-sha256"] == nil { h["x-amz-content-sha256"] = payloadHash }
        let names = h.keys.sorted()
        let canonicalHeaders = names.map { "\($0):\(h[$0]!)\n" }.joined()
        let signedHeaders = names.joined(separator: ";")
        let canonicalRequest = [method, canonicalPath(url), canonicalQuery(queryPairs(url)), canonicalHeaders, signedHeaders,
                                h["x-amz-content-sha256"]!].joined(separator: "\n")
        let date8 = String(stamp.prefix(8))
        let scope = "\(date8)/\(c.region)/\(service)/aws4_request"
        let stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].joined(separator: "\n")
        let key = signingKey(secret: c.secretAccessKey, date8: date8, region: c.region, service: service)
        let signature = hex(hmac(key, stringToSign))
        let auth = "AWS4-HMAC-SHA256 Credential=\(c.accessKeyId)/\(scope), SignedHeaders=\(signedHeaders), Signature=\(signature)"
        return SignedRequest(method: method, url: url, headers: h, body: nil, authorization: auth, signature: signature,
                             canonicalRequest: canonicalRequest, stringToSign: stringToSign)
    }

    /// Query-string signing (a presigned URL), `expires` in seconds.
    public static func presign(method: String = "GET", url: URL, credentials c: S3Credentials, service: String = "s3",
                               expires: Int = 3600, date: Date = Date()) -> (url: URL, signature: String, canonicalRequest: String) {
        let stamp = amzDate(date), date8 = String(stamp.prefix(8))
        let scope = "\(date8)/\(c.region)/\(service)/aws4_request"
        var pairs = queryPairs(url)
        pairs += [("X-Amz-Algorithm", "AWS4-HMAC-SHA256"), ("X-Amz-Credential", "\(c.accessKeyId)/\(scope)"),
                  ("X-Amz-Date", stamp), ("X-Amz-Expires", String(expires)), ("X-Amz-SignedHeaders", "host")]
        let cq = canonicalQuery(pairs)
        let canonicalRequest = [method, canonicalPath(url), cq, "host:\(hostHeader(url))\n", "host", "UNSIGNED-PAYLOAD"].joined(separator: "\n")
        let stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].joined(separator: "\n")
        let signature = hex(hmac(signingKey(secret: c.secretAccessKey, date8: date8, region: c.region, service: service), stringToSign))
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.percentEncodedQuery = "\(cq)&X-Amz-Signature=\(signature)"
        return (comps.url!, signature, canonicalRequest)
    }
}

/// The requests of a PutObject / multipart upload, signed. `object` is the object's URL (see `S3Config.objectURL`).
public enum S3Requests {
    private static func with(_ url: URL, query: [(String, String)]) -> URL {
        guard !query.isEmpty else { return url }
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.percentEncodedQuery = SigV4.canonicalQuery(query)
        return c.url!
    }

    /// PutObject with the body's SHA-256 already computed (the body itself is streamed from a file by the caller).
    public static func putObject(_ object: URL, contentType: String, payloadHash: String, contentLength: UInt64? = nil,
                                 extra: [String: String] = [:], credentials: S3Credentials, date: Date = Date()) -> SignedRequest {
        var h = ["content-type": contentType]
        for (k, v) in extra { h[k.lowercased()] = v }
        return SigV4.sign(method: "PUT", url: object, headers: h, payloadHash: payloadHash, credentials: credentials, date: date)
    }

    /// POST ?uploads
    public static func createMultipartUpload(_ object: URL, contentType: String, credentials: S3Credentials, date: Date = Date()) -> SignedRequest {
        SigV4.sign(method: "POST", url: with(object, query: [("uploads", "")]), headers: ["content-type": contentType],
                   payloadHash: SigV4.emptyPayloadHash, credentials: credentials, date: date)
    }

    /// PUT ?partNumber=N&uploadId=ID
    public static func uploadPart(_ object: URL, uploadId: String, partNumber: Int, payloadHash: String,
                                  credentials: S3Credentials, date: Date = Date()) -> SignedRequest {
        SigV4.sign(method: "PUT", url: with(object, query: [("partNumber", String(partNumber)), ("uploadId", uploadId)]),
                   payloadHash: payloadHash, credentials: credentials, date: date)
    }

    /// The XML body CompleteMultipartUpload wants; parts in ascending order.
    public static func completeBody(parts: [(number: Int, etag: String)]) -> String {
        "<CompleteMultipartUpload>" + parts.sorted { $0.number < $1.number }
            .map { "<Part><PartNumber>\($0.number)</PartNumber><ETag>\(xmlEscape($0.etag))</ETag></Part>" }.joined()
            + "</CompleteMultipartUpload>"
    }
    private static func xmlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// POST ?uploadId=ID with the part list as the body
    public static func completeMultipartUpload(_ object: URL, uploadId: String, parts: [(number: Int, etag: String)],
                                               credentials: S3Credentials, date: Date = Date()) -> SignedRequest {
        let body = Data(completeBody(parts: parts).utf8)
        var r = SigV4.sign(method: "POST", url: with(object, query: [("uploadId", uploadId)]), headers: ["content-type": "application/xml"],
                           payloadHash: SigV4.sha256Hex(body), credentials: credentials, date: date)
        r.body = body
        return r
    }

    /// DELETE ?uploadId=ID
    public static func abortMultipartUpload(_ object: URL, uploadId: String, credentials: S3Credentials, date: Date = Date()) -> SignedRequest {
        SigV4.sign(method: "DELETE", url: with(object, query: [("uploadId", uploadId)]), payloadHash: SigV4.emptyPayloadHash,
                   credentials: credentials, date: date)
    }

    /// <UploadId> from the CreateMultipartUpload response
    public static func parseUploadId(_ xml: String) -> String? { tag("UploadId", in: xml) }
    /// <Code>: <Message> from an S3 error body
    public static func errorText(_ xml: String) -> String? {
        let parts = [tag("Code", in: xml), tag("Message", in: xml)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ": ")
    }
    private static func tag(_ name: String, in xml: String) -> String? {
        guard let a = xml.range(of: "<\(name)>"), let b = xml.range(of: "</\(name)>", range: a.upperBound..<xml.endIndex) else { return nil }
        return String(xml[a.upperBound..<b.lowerBound])
    }
}
