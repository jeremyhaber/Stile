// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Stile",
    platforms: [.macOS("15.0")],
    products: [
        .executable(name: "StileApp", targets: ["StileApp"])
    ],
    targets: [
        // Pure logic with unit tests (the scrolling-capture stitcher); StileApp depends on it.
        .target(name: "StileCore", path: "Sources/StileCore"),
        .testTarget(name: "StileCoreTests", dependencies: ["StileCore"], path: "Tests/StileCoreTests"),
        .executableTarget(
            name: "StileApp",
            dependencies: ["StileCore"],
            path: "Sources/StileApp",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Carbon"),
                .linkedFramework("ServiceManagement"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        )
    ]
)
