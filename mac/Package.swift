// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Stile",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "StileApp", targets: ["StileApp"])
    ],
    targets: [
        .executableTarget(
            name: "StileApp",
            path: "Sources/StileApp",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Carbon"),
                .linkedFramework("ServiceManagement"),
            ]
        )
    ]
)
