import Darwin
import Foundation

/// Connector mode: Chrome launches the app's executable as the native messaging host
/// (argument `chrome-extension://<id>/`). Nothing here touches AppKit: it is a byte pipe between
/// stdio and the app's host.sock, launching the app hidden when the socket is missing.
enum Connector {
    static func isConnectorLaunch() -> Bool {
        CommandLine.arguments.dropFirst().contains { $0.hasPrefix("chrome-extension://") }
    }

    private static func log(_ message: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let line = "\(stamp) [\(getpid())] \(message)\n"
        let path = NSHomeDirectory() + "/Library/Logs/Sidebar-connector.log"
        let fm = FileManager.default
        try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if let attrs = try? fm.attributesOfItem(atPath: path), let size = attrs[.size] as? NSNumber, size.intValue > 1_000_000 {
            try? fm.removeItem(atPath: path + ".1")
            try? fm.moveItem(atPath: path, toPath: path + ".1")
        }
        if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil) }
        if let h = FileHandle(forWritingAtPath: path) {
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: Data(line.utf8))
            try? h.close()
        }
    }

    private static func connectOnce(_ path: String) -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return -1 }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        if bytes.count > capacity {
            Darwin.close(fd)
            return -1
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, len)
            }
        }
        if result != 0 {
            Darwin.close(fd)
            return -1
        }
        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        return fd
    }

    /// Path of the .app bundle this executable lives in, if it is in one.
    private static func ownAppPath() -> String? {
        let bundle = Bundle.main.bundlePath
        if bundle.hasSuffix(".app") { return bundle }
        if let exe = Bundle.main.executablePath {
            let url = URL(fileURLWithPath: exe).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            if url.path.hasSuffix(".app") { return url.path }
        }
        return nil
    }

    private static func launchApp() {
        guard let app = ownAppPath() else {
            log("not running from an .app bundle; cannot launch the app")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-g", "-a", app]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            log("launched app hidden: \(app)")
        } catch {
            log("cannot launch app: \(error.localizedDescription)")
        }
    }

    private static func writeAll(_ fd: Int32, _ buf: [UInt8], _ count: Int) -> Bool {
        var offset = 0
        while offset < count {
            let n = buf.withUnsafeBytes { raw -> Int in
                Darwin.write(fd, raw.baseAddress! + offset, count - offset)
            }
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            if n == 0 { return false }
            offset += n
        }
        return true
    }

    static func run() -> Never {
        signal(SIGPIPE, SIG_IGN)
        let path = HostPaths.hostSocketPath()
        log("started for \(CommandLine.arguments.dropFirst().joined(separator: " ")); socket \(path)")

        var fd = connectOnce(path)
        if fd < 0 && FileManager.default.fileExists(atPath: HostPaths.quitFlagPath) {
            // The user quit Sidebar from its settings: don't relaunch it behind their back.
            log("app was quit by the user; not launching it")
            exit(1)
        }
        if fd < 0 {
            launchApp()
            let deadline = Date().addingTimeInterval(10)
            while fd < 0 && Date() < deadline {
                usleep(100_000)
                fd = connectOnce(path)
            }
        }
        if fd < 0 {
            log("could not connect to \(path) within 10 s; exiting")
            exit(1)
        }
        log("connected")
        let sock = fd

        // socket -> stdout on a background thread
        let t = Thread {
            var buf = [UInt8](repeating: 0, count: 65536)
            while true {
                let n = Darwin.read(sock, &buf, buf.count)
                if n > 0 {
                    if !writeAll(1, buf, n) {
                        log("stdout closed; exiting")
                        exit(0)
                    }
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            log("app closed the connection; exiting")
            exit(0)
        }
        t.start()

        // stdin -> socket on the main thread
        var buf = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = Darwin.read(0, &buf, buf.count)
            if n > 0 {
                if !writeAll(sock, buf, n) {
                    log("socket write failed; exiting")
                    exit(0)
                }
            } else if n < 0 && errno == EINTR {
                continue
            } else {
                break
            }
        }
        log("stdin closed; exiting")
        exit(0)
    }
}
