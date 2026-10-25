// Prints every change in the on-screen bounds of Chrome's windows near the top of the screen, at 120 Hz, for 20 s.
// Run with Chrome in full screen, then reveal and hide its toolbar a few times.
import CoreGraphics
import Foundation

let start = Date()
var last: [UInt32: String] = [:]
while Date().timeIntervalSince(start) < 20 {
    let arr = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    var seen = Set<UInt32>()
    for w in arr where (w["kCGWindowOwnerName"] as? String) == "Google Chrome" {
        guard let n = (w["kCGWindowNumber"] as? NSNumber)?.uint32Value,
              let b = w["kCGWindowBounds"] as? [String: Any],
              let y = (b["Y"] as? NSNumber)?.doubleValue, let h = (b["Height"] as? NSNumber)?.doubleValue,
              y < 300, h < 400 else { continue }
        seen.insert(n)
        let s = "x=\(b["X"]!) y=\(Int(y)) w=\(b["Width"]!) h=\(Int(h)) layer=\(w["kCGWindowLayer"]!) alpha=\(w["kCGWindowAlpha"] ?? 1)"
        if last[n] != s { print(String(format: "%6.0f ms", Date().timeIntervalSince(start) * 1000), "win \(n):", s); last[n] = s }
    }
    for n in last.keys where !seen.contains(n) { print(String(format: "%6.0f ms", Date().timeIntervalSince(start) * 1000), "win \(n): gone"); last[n] = nil }
    usleep(8000)
}
