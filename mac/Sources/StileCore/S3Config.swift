import Foundation

/// v3.6: the S3 setup and the key / URL rules, ported from `extension/capture/s3.js` so a recording uploaded from the app
/// lands at the same place and gets the same link as a screenshot uploaded from the extension.
public struct S3Config: Sendable {
    public var endpoint = ""
    public var region = ""
    public var bucket = ""
    public var accessKeyId = ""
    public var secretAccessKey = ""
    public var prefix = "screenshots/{yyyy}/{mm}/"
    public var style = "auto"            // auto | path | virtual
    public var naming = "random"         // random | timestamp
    public var linkType = "presigned"    // presigned | public
    public var publicBase = ""
    public var expiry = 604_800          // seconds; SigV4 caps a presigned link at 7 days
    public var recordingShare = "page"   // page | file: what a recording's link opens

    public init() {}

    public var configured: Bool { !endpoint.isEmpty && !bucket.isEmpty && !accessKeyId.isEmpty && !secretAccessKey.isEmpty }

    private static func host(of endpoint: String) -> String {
        URL(string: endpoint.trimmingCharacters(in: .whitespaces))?.host?.lowercased() ?? ""
    }

    /// The region an endpoint implies (R2 -> auto, s3.<region>.amazonaws.com, ...), or nil.
    public static func region(fromEndpoint endpoint: String) -> String? {
        let h = host(of: endpoint)
        if h.isEmpty { return nil }
        if h.hasSuffix("r2.cloudflarestorage.com") { return "auto" }
        let patterns = [
            #"(?:^|\.)s3[.-](?:dualstack\.)?([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$"#,
            #"(?:^|\.)([a-z0-9-]+)\.digitaloceanspaces\.com$"#,
            #"(?:^|\.)s3\.([a-z0-9-]+)\.backblazeb2\.com$"#,
            #"(?:^|\.)s3\.([a-z0-9-]+)\.wasabisys\.com$"#,
            #"(?:^|\.)s3\.([a-z0-9-]+)\.idrivee2-[a-z0-9-]+\.com$"#,
        ]
        for p in patterns {
            if let re = try? NSRegularExpression(pattern: p), let m = re.firstMatch(in: h, range: NSRange(h.startIndex..., in: h)),
               let r = Range(m.range(at: 1), in: h) { return String(h[r]) }
        }
        if h == "s3.amazonaws.com" || h.hasSuffix(".s3.amazonaws.com") { return "us-east-1" }
        return nil
    }

    /// Region to sign with: what the user entered, else what the endpoint implies, else us-east-1.
    public var effectiveRegion: String {
        let r = region.trimmingCharacters(in: .whitespaces)
        return r.isEmpty ? (Self.region(fromEndpoint: endpoint) ?? "us-east-1") : r
    }
    /// Automatic addressing: virtual-hosted for amazonaws.com, path-style for everything else.
    public var effectiveStyle: String {
        if style == "path" || style == "virtual" { return style }
        let h = Self.host(of: endpoint)
        return h.hasSuffix("amazonaws.com") || h.hasSuffix("amazonaws.com.cn") ? "virtual" : "path"
    }
    public var credentials: S3Credentials { S3Credentials(accessKeyId: accessKeyId, secretAccessKey: secretAccessKey, region: effectiveRegion) }

    // MARK: Keys and URLs

    static func expand(prefix: String, _ d: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return prefix.replacingOccurrences(of: "{yyyy}", with: String(format: "%04d", c.year ?? 0))
            .replacingOccurrences(of: "{mm}", with: String(format: "%02d", c.month ?? 0))
            .replacingOccurrences(of: "{dd}", with: String(format: "%02d", c.day ?? 0))
    }

    public static func randomId(_ n: Int = 10) -> String {
        let a = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<n).map { _ in a[Int.random(in: 0..<a.count)] })
    }

    /// The key of a recording: the prefix (date tokens expanded) plus a random id or `timestampName`, then `.ext`.
    /// A default screenshots prefix becomes recordings so the two kinds stay apart in the bucket.
    public func objectKey(date: Date = Date(), id: String? = nil, timestampName: String, ext: String = "mp4", recordings: Bool = true) -> String {
        var p = prefix
        if recordings, p.hasPrefix("screenshots/") { p = "recordings/" + p.dropFirst("screenshots/".count) }
        var e = Self.expand(prefix: p, date)
        while e.hasPrefix("/") { e.removeFirst() }
        if !e.isEmpty && !e.hasSuffix("/") { e += "/" }
        return e + (naming == "timestamp" ? timestampName : (id ?? Self.randomId())) + "." + ext
    }

    /// The URL of an object on the endpoint, with the configured addressing style.
    public func objectURL(key: String) -> URL? {
        guard let ep = URL(string: endpoint.trimmingCharacters(in: .whitespaces)), let scheme = ep.scheme,
              var hostPart = ep.host else { return nil }
        if let port = ep.port { hostPart += ":\(port)" }
        let keyPath = SigV4.encodePath(key)
        if effectiveStyle == "virtual" { return URL(string: "\(scheme)://\(bucket).\(hostPart)/\(keyPath)") }
        var basePath = ep.path
        while basePath.hasSuffix("/") { basePath.removeLast() }
        return URL(string: "\(scheme)://\(hostPart)\(SigV4.encodePath(basePath))/\(SigV4.encodePath(bucket))/\(keyPath)")
    }

    public func publicLink(key: String) -> String {
        var base = publicBase.trimmingCharacters(in: .whitespaces)
        while base.hasSuffix("/") { base.removeLast() }
        return base + "/" + SigV4.encodePath(key)
    }

    /// The link to share: the public base URL's, or a presigned GET.
    public func shareLink(key: String, date: Date = Date()) -> String? {
        if linkType == "presigned" {
            guard let u = objectURL(key: key) else { return nil }
            return SigV4.presign(url: u, credentials: credentials, expires: min(604_800, max(1, expiry)), date: date).url.absoluteString
        }
        return publicLink(key: key)
    }
}
