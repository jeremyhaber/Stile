// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Sidebar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "SidebarApp", targets: ["SidebarApp"])
    ],
    targets: [
        .executableTarget(
            name: "SidebarApp",
            path: "Sources/SidebarApp",
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
