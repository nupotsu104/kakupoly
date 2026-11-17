// swift-tools-version: 5.9

// Swift Playgrounds（iPad）と Xcode（Mac）のどちらでも開けるアプリパッケージ。
// Core/ フォルダは native/Core の複製（scripts/sync-native.mjs で更新する）。

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "KakuPoly",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "KakuPoly",
            targets: ["AppModule"],
            bundleIdentifier: "io.github.nupotsu104.kakupoly",
            teamIdentifier: "",
            displayVersion: "0.1",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .palette),
            accentColor: .presetColor(.orange),
            supportedDeviceFamilies: [
                .pad
            ],
            supportedInterfaceOrientations: [
                .landscapeRight,
                .landscapeLeft,
                .portrait,
                .portraitUpsideDown
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
