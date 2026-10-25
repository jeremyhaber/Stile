import Foundation

/// v3.7: the self-contained HTML share page uploaded next to a recording. A pure function (no I/O) so it can be tested:
/// inline CSS, no script, no external fonts or trackers; everything the page loads is the two URLs it is given.
public enum SharePage {
    public struct Input: Sendable {
        public var title: String
        public var videoURL: String      // absolute
        public var posterURL: String     // absolute
        public var pageURL: String       // absolute (og:url)
        public var duration: Double      // seconds; <= 0 hides it
        public var date: Date
        public var width: Int
        public var height: Int
        public var posterWidth: Int?     // the poster may be scaled down; defaults to the video's size
        public var posterHeight: Int?
        public var timeZone: TimeZone

        public init(title: String, videoURL: String, posterURL: String, pageURL: String, duration: Double, date: Date,
                    width: Int, height: Int, posterWidth: Int? = nil, posterHeight: Int? = nil, timeZone: TimeZone = .current) {
            self.title = title; self.videoURL = videoURL; self.posterURL = posterURL; self.pageURL = pageURL
            self.duration = duration; self.date = date; self.width = width; self.height = height
            self.posterWidth = posterWidth; self.posterHeight = posterHeight; self.timeZone = timeZone
        }
    }

    /// Escapes text for element content and double- or single-quoted attributes.
    public static func escape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }

    /// "0:42", "12:05", "1:02:03"
    public static func formatDuration(_ seconds: Double) -> String {
        let t = Int(seconds.rounded())
        let h = t / 3600, m = (t % 3600) / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    public static func formatDate(_ d: Date, timeZone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = timeZone
        f.dateFormat = "MMMM d, yyyy"
        return f.string(from: d)
    }

    public static func html(_ i: Input) -> String {
        let title = escape(i.title.isEmpty ? "Recording" : i.title)
        let video = escape(i.videoURL), poster = escape(i.posterURL), page = escape(i.pageURL)
        let w = max(1, i.width), h = max(1, i.height)
        let pw = max(1, i.posterWidth ?? i.width), ph = max(1, i.posterHeight ?? i.height)
        var meta: [String] = []
        if i.duration > 0 { meta.append("<span>\(formatDuration(i.duration))</span>") }
        meta.append("<time datetime=\"\(isoDay(i.date, i.timeZone))\">\(escape(formatDate(i.date, timeZone: i.timeZone)))</time>")
        let desc = escape("A screen recording" + (i.duration > 0 ? " (\(formatDuration(i.duration)))" : "") + ", shared with Stile.")
        return """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="light dark">
        <meta name="robots" content="noindex">
        <title>\(title)</title>
        <meta name="description" content="\(desc)">
        <meta property="og:type" content="video.other">
        <meta property="og:site_name" content="Stile">
        <meta property="og:title" content="\(title)">
        <meta property="og:description" content="\(desc)">
        <meta property="og:url" content="\(page)">
        <meta property="og:image" content="\(poster)">
        <meta property="og:image:width" content="\(pw)">
        <meta property="og:image:height" content="\(ph)">
        <meta property="og:video" content="\(video)">
        <meta property="og:video:secure_url" content="\(video)">
        <meta property="og:video:type" content="video/mp4">
        <meta property="og:video:width" content="\(w)">
        <meta property="og:video:height" content="\(h)">
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="\(title)">
        <meta name="twitter:description" content="\(desc)">
        <meta name="twitter:image" content="\(poster)">
        <style>
        :root{--bg:#f6f6f4;--fg:#1c1c1e;--muted:#6b6b70;--line:#dcdcd8;--card:#fff;--accent:#1c1c1e;--accent-fg:#fff}
        @media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#f2f2f4;--muted:#9a9aa1;--line:#2c2c30;--card:#1b1b1e;--accent:#f2f2f4;--accent-fg:#121214}}
        *{box-sizing:border-box}
        html{-webkit-text-size-adjust:100%}
        body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);
          font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
          -webkit-font-smoothing:antialiased;overflow-x:hidden}
        main{flex:1;width:100%;max-width:1040px;margin:0 auto;padding:40px 16px 24px}
        h1{margin:0 0 16px;font-size:clamp(1.35rem,1.1rem + 1.2vw,1.9rem);line-height:1.2;font-weight:650;letter-spacing:-.015em;overflow-wrap:anywhere}
        .player{background:#000;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--line),0 12px 40px -16px rgba(0,0,0,.35)}
        video{display:block;width:100%;height:auto;max-height:78vh;aspect-ratio:\(w) / \(h);background:#000;object-fit:contain}
        .bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}
        .meta{display:flex;gap:10px;color:var(--muted);font-size:.9rem;font-variant-numeric:tabular-nums}
        .meta span+time::before{content:"\\00b7";margin-right:10px}
        .dl{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:999px;background:var(--accent);color:var(--accent-fg);
          font-size:.9rem;font-weight:600;text-decoration:none}
        .dl:hover{opacity:.88}
        .dl:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
        .dl svg{width:14px;height:14px}
        footer{padding:16px;text-align:center;color:var(--muted);font-size:.8rem}
        @media (max-width:520px){main{padding-top:24px}.player{border-radius:8px}}
        </style>
        </head>
        <body>
        <main>
        <h1>\(title)</h1>
        <div class="player"><video controls playsinline preload="metadata" poster="\(poster)" src="\(video)">Your browser can’t play this video. <a href="\(video)">Download it</a>.</video></div>
        <div class="bar">
        <div class="meta">\(meta.joined())</div>
        <a class="dl" href="\(video)" download><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>Download</a>
        </div>
        </main>
        <footer>Made with Stile</footer>
        </body>
        </html>
        """
    }

    private static func isoDay(_ d: Date, _ tz: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = tz
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
}
