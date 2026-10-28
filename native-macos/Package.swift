// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HandCashShell",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "HandCashShell",
            path: "Sources/HandCashShell"
        ),
    ]
)
