import AVFoundation
import Foundation
import ImageIO
import StileCore
import UniformTypeIdentifiers

/// v3.6: uploads a recording to the configured S3-compatible storage with URLSession. Under 100 MB one signed PUT;
/// above, a multipart upload (10 MB parts, three at a time, each retried three times, aborted on cancel or failure) so the
/// progress bar means something and a dropped connection costs one part. The key layout and link rules are
/// `S3Config`'s, the Swift port of `extension/capture/s3.js`. Cancelling the calling `Task` cancels the transfer.
enum S3Upload {
    static let singleLimit: UInt64 = 100 * 1024 * 1024
    static let partSize = 10 * 1024 * 1024
    static let concurrency = 3
    static let attempts = 3

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// The app's S3 setup (the secret from the Keychain), or nil when something is missing.
    @MainActor static func currentConfig() -> S3Config? {
        let s = CaptureSettings.shared.publicDict(full: true)["s3"] as? [String: Any] ?? [:]
        var c = S3Config()
        c.endpoint = s["endpoint"] as? String ?? ""
        c.region = s["region"] as? String ?? ""
        c.bucket = s["bucket"] as? String ?? ""
        c.accessKeyId = s["accessKeyId"] as? String ?? ""
        c.secretAccessKey = s["secretAccessKey"] as? String ?? ""
        c.prefix = s["prefix"] as? String ?? c.prefix
        c.style = s["style"] as? String ?? "auto"
        c.naming = s["naming"] as? String ?? "random"
        c.linkType = s["linkType"] as? String ?? "presigned"
        c.publicBase = s["publicBase"] as? String ?? ""
        c.expiry = (s["expiry"] as? Int) ?? c.expiry
        c.recordingShare = (s["recordingShare"] as? String) == "file" ? "file" : "page"
        return c.configured ? c : nil
    }

    /// Uploads `file` and returns the link to share. `progress` gets 0...1 (from any thread).
    static func upload(file: URL, name: String, config: S3Config, date: Date = Date(),
                       progress: @escaping @Sendable (Double) -> Void) async throws -> (key: String, link: String, note: String?) {
        guard config.configured else { throw Failure(message: "Upload isn’t set up. Add your storage details in Settings → Screenshots.") }
        if config.linkType != "presigned" && config.publicBase.trimmingCharacters(in: .whitespaces).isEmpty {
            throw Failure(message: "Add a public base URL in Settings → Screenshots, or switch the link type to “Presigned link”.")
        }
        let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? UInt64) ?? 0
        guard size > 0 else { throw Failure(message: "The recording is empty") }
        let key = config.objectKey(date: date, timestampName: name, ext: file.pathExtension.isEmpty ? "mp4" : file.pathExtension)
        guard let object = config.objectURL(key: key) else { throw Failure(message: "The storage endpoint isn’t a valid URL") }
        let creds = config.credentials
        let page = config.recordingShare != "file"
        Log.write("recording: upload \(key) (\(size) bytes, \(size > singleLimit ? "multipart" : "single PUT")\(page ? ", share page" : ""))")
        // with a share page the video is ~92% of the bar; the poster and the page are small
        let videoShare = page ? 0.92 : 1.0
        let videoProgress: @Sendable (Double) -> Void = { progress($0 * videoShare) }
        if size <= singleLimit {
            try await putSingle(file: file, size: size, object: object, creds: creds, progress: videoProgress)
        } else {
            try await putMultipart(file: file, size: size, object: object, creds: creds, progress: videoProgress)
        }
        guard let direct = config.shareLink(key: key, date: date) else { throw Failure(message: "Couldn’t build the link") }
        guard page else { progress(1); return (key, direct, nil) }
        do {
            let link = try await uploadSharePage(file: file, title: name, videoKey: key, config: config, date: date, progress: progress)
            progress(1)
            return (key, link, nil)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            Log.write("recording: share page failed, linking the video: \(error.localizedDescription)")
            progress(1)
            return (key, direct, "Share page failed, linked the video file instead")
        }
    }

    /// Poster (.jpg) and page (.html) beside the video (same key stem); returns the page link.
    private static func uploadSharePage(file: URL, title: String, videoKey: String, config: S3Config, date: Date,
                                        progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let stem = (videoKey as NSString).deletingPathExtension
        let posterKey = stem + ".jpg", pageKey = stem + ".html"
        let info = try await mediaInfo(file)
        guard let posterURL = config.shareLink(key: posterKey, date: date), let videoURL = config.shareLink(key: videoKey, date: date),
              let pageURL = config.shareLink(key: pageKey, date: date) else { throw Failure(message: "Couldn’t build the page links") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("stile-share-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let posterFile = dir.appendingPathComponent("poster.jpg")
        let posterSize = try info.writePoster(to: posterFile)
        let html = SharePage.html(.init(title: title, videoURL: videoURL, posterURL: posterURL, pageURL: pageURL, duration: info.duration,
                                        date: date, width: info.width, height: info.height, posterWidth: posterSize.width, posterHeight: posterSize.height))
        let htmlFile = dir.appendingPathComponent("index.html")
        try Data(html.utf8).write(to: htmlFile)
        let creds = config.credentials
        func put(_ f: URL, _ key: String, _ type: String, _ cache: String) async throws {
            guard let obj = config.objectURL(key: key) else { throw Failure(message: "The storage endpoint isn’t a valid URL") }
            let n = (try FileManager.default.attributesOfItem(atPath: f.path)[.size] as? UInt64) ?? 0
            try await putSingle(file: f, size: n, object: obj, creds: creds, contentType: type, extra: ["cache-control": cache], progress: { _ in })
        }
        try await put(posterFile, posterKey, "image/jpeg", "public, max-age=3600")
        progress(0.96)
        try await put(htmlFile, pageKey, "text/html; charset=utf-8", "public, max-age=300")
        return pageURL
    }

    private struct MediaInfo {
        let asset: AVURLAsset
        let duration: Double, width: Int, height: Int

        /// A JPEG frame about 1 s in (or 10% in, for short clips), at most 1280 px wide; returns its size.
        func writePoster(to url: URL) throws -> (width: Int, height: Int) {
            let gen = AVAssetImageGenerator(asset: asset)
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: 1280, height: 4096)
            gen.requestedTimeToleranceBefore = .positiveInfinity
            gen.requestedTimeToleranceAfter = .positiveInfinity
            let t = duration > 10 ? 1.0 : duration * 0.1
            let image = try gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil)
            guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
                throw Failure(message: "Couldn’t write the poster")
            }
            CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { throw Failure(message: "Couldn’t write the poster") }
            return (image.width, image.height)
        }
    }

    private static func mediaInfo(_ file: URL) async throws -> MediaInfo {
        let asset = AVURLAsset(url: file)
        let duration = try await asset.load(.duration).seconds
        var w = 1280, h = 720
        if let track = try await asset.loadTracks(withMediaType: .video).first {
            let size = try await track.load(.naturalSize)
            let box = size.applying(try await track.load(.preferredTransform))
            if abs(box.width) >= 1, abs(box.height) >= 1 { w = Int(abs(box.width).rounded()); h = Int(abs(box.height).rounded()) }
        }
        return MediaInfo(asset: asset, duration: duration.isFinite ? duration : 0, width: w, height: h)
    }

    // MARK: Single PUT

    private static func putSingle(file: URL, size: UInt64, object: URL, creds: S3Credentials, contentType: String = "video/mp4",
                                  extra: [String: String] = [:], progress: @escaping @Sendable (Double) -> Void) async throws {
        let hash = try SigV4.sha256Hex(file: file)
        var lastError: Error?
        for attempt in 1...attempts {
            try Task.checkCancellation()
            let signed = S3Requests.putObject(object, contentType: contentType, payloadHash: hash, extra: extra, credentials: creds)
            do {
                let delegate = ProgressDelegate { sent in progress(min(0.99, Double(sent) / Double(size))) }
                let (data, resp) = try await URLSession.shared.upload(for: signed.urlRequest, fromFile: file, delegate: delegate)
                try check(resp, data)
                return
            } catch {
                if error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
                lastError = error
                Log.write("recording: upload attempt \(attempt) failed: \(error.localizedDescription)")
                if let f = error as? Failure, f.message.hasPrefix("4"), !f.message.hasPrefix("408"), !f.message.hasPrefix("429") { throw error }
                try await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000)
            }
        }
        throw lastError ?? Failure(message: "Upload failed")
    }

    // MARK: Multipart

    private static func putMultipart(file: URL, size: UInt64, object: URL, creds: S3Credentials, progress: @escaping @Sendable (Double) -> Void) async throws {
        let create = S3Requests.createMultipartUpload(object, contentType: "video/mp4", credentials: creds)
        let (cdata, cresp) = try await URLSession.shared.data(for: create.urlRequest)
        try check(cresp, cdata)
        guard let uploadId = S3Requests.parseUploadId(String(decoding: cdata, as: UTF8.self)) else {
            throw Failure(message: "The storage didn’t start a multipart upload")
        }
        let count = Int((size + UInt64(partSize) - 1) / UInt64(partSize))
        let tally = Tally(total: size)
        do {
            let parts = try await withThrowingTaskGroup(of: (Int, String).self) { group -> [(number: Int, etag: String)] in
                var next = 1, done: [(number: Int, etag: String)] = []
                func add() {
                    let n = next; next += 1
                    group.addTask {
                        let offset = UInt64(n - 1) * UInt64(partSize)
                        let length = min(UInt64(partSize), size - offset)
                        return (n, try await putPart(file: file, offset: offset, length: length, number: n, uploadId: uploadId,
                                                     object: object, creds: creds, tally: tally, progress: progress))
                    }
                }
                while next <= min(concurrency, count) { add() }
                while let (n, etag) = try await group.next() {
                    done.append((n, etag))
                    if next <= count { add() }
                }
                return done
            }
            let complete = S3Requests.completeMultipartUpload(object, uploadId: uploadId, parts: parts, credentials: creds)
            var req = complete.urlRequest
            req.httpBody = complete.body
            let (data, resp) = try await URLSession.shared.data(for: req)
            try check(resp, data)
            // S3 can answer 200 with an <Error> body
            if let e = S3Requests.errorText(String(decoding: data, as: UTF8.self)) { throw Failure(message: e) }
        } catch {
            // best effort, even when cancelled: unfinished parts cost storage until aborted
            let abort = S3Requests.abortMultipartUpload(object, uploadId: uploadId, credentials: creds)
            let req = abort.urlRequest
            Task.detached { _ = try? await URLSession.shared.data(for: req) }
            Log.write("recording: multipart upload aborted (\(error.localizedDescription))")
            throw error
        }
    }

    private static func putPart(file: URL, offset: UInt64, length: UInt64, number: Int, uploadId: String, object: URL, creds: S3Credentials,
                                tally: Tally, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let fh = try FileHandle(forReadingFrom: file)
        try fh.seek(toOffset: offset)
        let data = try fh.read(upToCount: Int(length)) ?? Data()
        try? fh.close()
        guard data.count == Int(length) else { throw Failure(message: "Couldn’t read the recording") }
        let hash = SigV4.sha256Hex(data)
        var lastError: Error?
        for attempt in 1...attempts {
            try Task.checkCancellation()
            let signed = S3Requests.uploadPart(object, uploadId: uploadId, partNumber: number, payloadHash: hash, credentials: creds)
            do {
                let delegate = ProgressDelegate { sent in
                    Task { progress(min(0.99, await tally.set(number, sent))) }
                }
                let (body, resp) = try await URLSession.shared.upload(for: signed.urlRequest, from: data, delegate: delegate)
                try check(resp, body)
                guard let etag = (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "ETag") else { throw Failure(message: "The storage returned no ETag for part \(number)") }
                progress(min(0.99, await tally.set(number, Int64(length))))
                return etag
            } catch {
                if error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
                lastError = error
                Log.write("recording: part \(number) attempt \(attempt) failed: \(error.localizedDescription)")
                await tally.set(number, 0)
                try await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000)
            }
        }
        throw lastError ?? Failure(message: "Part \(number) failed")
    }

    // MARK: Helpers

    private static func check(_ resp: URLResponse, _ data: Data) throws {
        guard let h = resp as? HTTPURLResponse else { throw Failure(message: "No response from the storage") }
        guard (200..<300).contains(h.statusCode) else {
            let detail = S3Requests.errorText(String(decoding: data.prefix(2000), as: UTF8.self))
            throw Failure(message: "\(h.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: h.statusCode))\(detail.map { " – " + $0 } ?? "")")
        }
    }

    /// Bytes sent per part, as a fraction of the file.
    private actor Tally {
        private var sent: [Int: Int64] = [:]
        private let total: UInt64
        init(total: UInt64) { self.total = total }
        @discardableResult func set(_ part: Int, _ n: Int64) -> Double {
            sent[part] = n
            return Double(sent.values.reduce(0, +)) / Double(total)
        }
    }

    private final class ProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let onSent: @Sendable (Int64) -> Void
        init(_ onSent: @escaping @Sendable (Int64) -> Void) { self.onSent = onSent }
        func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                        totalBytesExpectedToSend: Int64) {
            onSent(totalBytesSent)
        }
    }
}
