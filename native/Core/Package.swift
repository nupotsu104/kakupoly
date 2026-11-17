// swift-tools-version: 5.9
// 画面に依存しない計算部分（データ形式・数学・骨格・スキニング・レイ判定）。
// Linux でもビルド・テストできるようにしてある。アプリ本体（KakuPoly.swiftpm）にはこのソースを複製して入れる。
import PackageDescription

let package = Package(
    name: "KakuPolyCore",
    products: [.library(name: "KakuPolyCore", targets: ["KakuPolyCore"])],
    targets: [
        .target(name: "KakuPolyCore"),
        .testTarget(name: "KakuPolyCoreTests", dependencies: ["KakuPolyCore"], resources: [.copy("Fixtures")]),
    ]
)
