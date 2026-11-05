// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CompanionMacHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "CompanionMacHelper",
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
                .linkedFramework("ScreenCaptureKit"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/CompanionMacHelper/Info.plist"
                ])
            ]
        )
    ]
)
