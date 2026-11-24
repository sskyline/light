// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Light",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "LightCore", targets: ["LightCore"]),
        .executable(name: "Light", targets: ["LightApp"]),
        .executable(name: "light-hook", targets: ["LightHook"])
    ],
    targets: [
        .target(
            name: "LightCore",
            path: "Sources/LightCore",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Network"),
                .linkedLibrary("sqlite3")
            ]
        ),
        .executableTarget(
            name: "LightApp",
            dependencies: ["LightCore"],
            path: "Sources/LightApp",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("SwiftUI")
            ]
        ),
        .executableTarget(
            name: "LightHook",
            path: "Sources/LightHook"
        ),
        .executableTarget(
            name: "LightTests",
            dependencies: ["LightCore"],
            path: "tests/LightCoreTests"
        )
    ]
)
