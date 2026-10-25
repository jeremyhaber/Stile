import Foundation
import CoreGraphics

/// v3.1: a dedicated thread with its own run loop for the app's CGEvent taps. A tap callback makes the whole
/// system wait for it, so it must never wait for the main thread: the callbacks decide from lock-protected
/// snapshots and hand every side effect to the main queue.
final class TapThread: @unchecked Sendable {
    static let shared = TapThread()

    private var runLoop: CFRunLoop?
    private var started = false
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)

    private func ensureStarted() {
        lock.lock()
        defer { lock.unlock() }
        if started { return }
        started = true
        let t = Thread { [self] in
            runLoop = CFRunLoopGetCurrent()
            // A run loop with no sources returns immediately; this one only keeps it alive.
            var ctx = CFRunLoopSourceContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil,
                                             equal: nil, hash: nil, schedule: nil, cancel: nil, perform: nil)
            if let keepAlive = CFRunLoopSourceCreate(nil, 0, &ctx) {
                CFRunLoopAddSource(CFRunLoopGetCurrent(), keepAlive, .defaultMode)
            }
            ready.signal()
            CFRunLoopRun()
        }
        t.name = "ca.simplistics.stile.taps"
        t.qualityOfService = .userInteractive
        t.start()
        ready.wait()
    }

    /// Creates an enabled tap whose source runs on the tap thread.
    func install(mask: CGEventMask, callback: @escaping CGEventTapCallBack, refcon: UnsafeMutableRawPointer)
        -> (tap: CFMachPort, source: CFRunLoopSource)? {
        ensureStarted()
        guard let rl = runLoop,
              let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                           eventsOfInterest: mask, callback: callback, userInfo: refcon) else { return nil }
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)!
        CFRunLoopAddSource(rl, src, .commonModes)
        CFRunLoopWakeUp(rl)
        CGEvent.tapEnable(tap: port, enable: true)
        return (port, src)
    }

    func remove(tap: CFMachPort, source: CFRunLoopSource) {
        CGEvent.tapEnable(tap: tap, enable: false)
        if let rl = runLoop { CFRunLoopRemoveSource(rl, source, .commonModes) }
        CFMachPortInvalidate(tap)
    }
}

/// Lag and duration of tap callbacks; slow ones are logged (at most once a second per tap).
enum TapMetrics {
    private static let lock = NSLock()
    private static var lastLog: [String: Date] = [:]

    static func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }

    static func finish(_ name: String, event: CGEvent, started: UInt64) {
        let end = now()
        let ts = UInt64(event.timestamp)
        let lag = started > ts ? Double(started - ts) / 1_000_000 : 0
        let took = Double(end - started) / 1_000_000
        guard lag > 50 || took > 20 else { return }
        lock.lock()
        let last = lastLog[name] ?? .distantPast
        let log = Date().timeIntervalSince(last) > 1
        if log { lastLog[name] = Date() }
        lock.unlock()
        if log { Log.write("tap: slow \(name) lag=\(Int(lag))ms took=\(Int(took))ms") }
    }
}
