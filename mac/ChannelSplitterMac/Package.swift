// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ChannelSplitter",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "ChannelSplitter",
            path: "Sources/ChannelSplitter",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("Accelerate"),
                .linkedFramework("CoreMedia"),
            ]
        )
    ]
)
