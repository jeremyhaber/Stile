import XCTest
@testable import StileCore

final class ExtensionInstallTests: XCTestCase {
    private let id = "ffblekellgdmlecjablfojaaadpkmdgg"

    private func prefs(_ id: String, _ entry: [String: Any]) -> [String: Any] {
        ["extensions": ["settings": [id: entry]]]
    }

    private func kind(_ p: [String: Any]?, _ s: [String: Any]?, ids: [String]? = nil) -> ExtensionInstallKind? {
        ExtensionInstall.installKind(preferences: p, securePreferences: s, ids: ids ?? [id])
    }

    func testStoreLocations() {
        XCTAssertEqual(kind(nil, prefs(id, ["location": 1])), .store)
        XCTAssertEqual(kind(nil, prefs(id, ["location": 6])), .store)
    }

    func testUnpackedLocations() {
        XCTAssertEqual(kind(nil, prefs(id, ["location": 4])), .unpacked)
        XCTAssertEqual(kind(nil, prefs(id, ["location": 8])), .unpacked)
    }

    func testMissingLocationOrPartialEntry() {
        XCTAssertNil(kind(prefs(id, ["active_permissions": [:]]), nil))
        XCTAssertNil(kind(prefs(id, ["location": "4"]), nil))
        XCTAssertNil(kind(prefs(id, ["location": true]), nil))
        XCTAssertNil(kind(prefs(id, [:]), prefs(id, [:])))
    }

    func testPartialPreferencesMergedWithSecure() {
        XCTAssertEqual(kind(prefs(id, ["state": 1]), prefs(id, ["location": 4])), .unpacked)
    }

    func testEntryOnlyInSecurePreferences() {
        XCTAssertEqual(kind(["other": 1], prefs(id, ["location": 1])), .store)
    }

    func testNilDicts() {
        XCTAssertNil(kind(nil, nil))
        XCTAssertNil(kind([:], [:]))
    }

    func testExternalUninstallsMeansNotInstalled() {
        var p = prefs(id, ["location": 6])
        p["extensions"] = ["settings": [id: ["location": 6]], "external_uninstalls": [id]]
        XCTAssertNil(kind(p, nil))
        XCTAssertNil(kind(nil, p))
        XCTAssertEqual(kind(prefs(id, ["location": 6]), ["extensions": ["external_uninstalls": ["zzz", id]]]), nil)
    }

    func testBothKindsUnpackedWins() {
        let store = String(repeating: "a", count: 32)
        let p = ["extensions": ["settings": [id: ["location": 4], store: ["location": 1]]]]
        XCTAssertEqual(kind(nil, p, ids: [store, id]), .unpacked)
        XCTAssertEqual(kind(nil, p, ids: [store]), .store)
    }

    func testIDValidity() {
        XCTAssertTrue(ExtensionInstall.isValidID(id))
        XCTAssertFalse(ExtensionInstall.isValidID("REPLACE_WITH_STORE_ID"))
        XCTAssertFalse(ExtensionInstall.isValidID(String(repeating: "q", count: 32)))
        XCTAssertFalse(ExtensionInstall.isValidID(String(repeating: "a", count: 31)))
    }

    // MARK: File writer

    private func tempDir() -> String {
        NSTemporaryDirectory() + "stile-ext-\(UUID().uuidString)/External Extensions"
    }

    func testWritesWhenMissingAndCreatesDir() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(atPath: (dir as NSString).deletingLastPathComponent) }
        XCTAssertFalse(ExtensionInstall.externalFileExists(dir: dir, id: id))
        XCTAssertEqual(ExtensionInstall.writeExternalExtensionFile(dir: dir, id: id), .written)
        XCTAssertTrue(ExtensionInstall.externalFileExists(dir: dir, id: id))
        let data = try XCTUnwrap(FileManager.default.contents(atPath: dir + "/" + id + ".json"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(obj, ["external_update_url": "https://clients2.google.com/service/update2/crx"])
    }

    func testNeverOverwrites() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(atPath: (dir as NSString).deletingLastPathComponent) }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = dir + "/" + id + ".json"
        try Data("custom".utf8).write(to: URL(fileURLWithPath: path))
        XCTAssertEqual(ExtensionInstall.writeExternalExtensionFile(dir: dir, id: id), .alreadyPresent)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "custom")
    }

    func testInvalidIDFails() {
        let dir = tempDir()
        if case .failed = ExtensionInstall.writeExternalExtensionFile(dir: dir, id: "REPLACE_WITH_STORE_ID") {} else {
            XCTFail("expected failure")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir))
    }
}
