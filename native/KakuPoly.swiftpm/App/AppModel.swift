import Foundation
import SwiftUI

/// アプリ全体の状態。描画（Renderer）と画面（SwiftUI）の両方から使う。
final class AppModel: ObservableObject {
    @Published var doc: Doc
    /// doc を差し替えたら増やす（描画側がテクスチャ等を作り直す合図）
    @Published var docVersion = 0
    @Published var clipIndex = 0
    @Published var playing = false
    @Published var ps1 = true
    @Published var jitter = true
    @Published var affine = true
    @Published var dither = true
    /// 入力の確認用ログ（新しい順）
    @Published var log: [String] = []
    @Published var hoverPoint: CGPoint? = nil
    @Published var errorMessage: String? = nil
    /// 画面に常に出す診断（Metal の状態・描画回数・エラー）
    @Published var diag: [String] = ["起動中…"]
    /// 描画側が書き込む診断の元データ（毎フレーム SwiftUI を更新しないよう、1秒ごとに diag へ写す）
    var diagMetal = "Metal: 未確認"
    var diagShader = "シェーダー: 未確認"
    var diagError: String? = nil
    var drawCount = 0
    var drawSkip = ""
    var drawableSize = CGSize.zero
    private var diagTimer: Timer?

    /// 視点（毎フレーム変わるので @Published にしない）
    var camera = OrbitCamera()
    var frame: Float = 0

    /// 起動の段階ごとの結果（どこで止まるかを画面で確かめるため）
    @Published var stages: [String] = ["1. アプリ起動: OK"]

    init() {
        // 起動直後は何もしない（重い処理で最初の画面が出ないことがないように）
        doc = Doc(name: "（未読み込み）")
    }

    /// 段階2: 埋め込みのサンプル作品を読む
    func loadSampleStage() {
        guard let data = Data(base64Encoded: sampleKpolyBase64) else {
            stages.append("2. サンプル読み込み: 失敗（base64 を戻せない）")
            return
        }
        do {
            let d = try Doc.load(data)
            setDoc(d)
            stages.append("2. サンプル読み込み: OK（頂点 \(d.objects.reduce(0) { $0 + $1.verts.count })・ボーン \(d.bones.count)）")
        } catch {
            stages.append("2. サンプル読み込み: 失敗 \(error)")
        }
    }

    /// 段階3: 3D表示を始める（診断の更新もここから）
    func startDiag() {
        stages.append("3. 3D表示を開始")
        diagTimer?.invalidate()
        diagTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refreshDiag() }
    }

    func refreshDiag() {
        var d = [
            diagMetal,
            diagShader,
            "描画: \(drawCount)回  画面 \(Int(drawableSize.width))×\(Int(drawableSize.height))",
            "作品: \(doc.name)  オブジェクト\(doc.objects.count) 頂点\(doc.objects.reduce(0) { $0 + $1.verts.count })",
        ]
        if !drawSkip.isEmpty { d.append("描画を飛ばした理由: \(drawSkip)") }
        if let e = diagError { d.append("エラー: \(e)") }
        if d != diag { diag = d }
    }

    var clip: Clip? { doc.clips.indices.contains(clipIndex) ? doc.clips[clipIndex] : nil }

    func open(_ url: URL) {
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        do {
            let d = try Doc.load(Data(contentsOf: url))
            setDoc(d)
            note("開きました: \(url.lastPathComponent)")
        } catch {
            errorMessage = "開けませんでした: \(error.localizedDescription)"
        }
    }

    func openSample() {
        if let data = Data(base64Encoded: sampleKpolyBase64), let d = try? Doc.load(data) { setDoc(d) }
    }

    func setDoc(_ d: Doc) {
        doc = d
        docVersion += 1
        clipIndex = 0
        frame = 0
        playing = false
        camera.frame(Geometry.bounds(d))
    }

    /// 入力確認ログに1行足す（最新8件）
    func note(_ s: String) {
        let apply = {
            self.log.insert(s, at: 0)
            if self.log.count > 8 { self.log.removeLast(self.log.count - 8) }
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }

    /// 再生中ならコマを進める（描画のたびに呼ぶ）
    func advance(dt: Float) {
        guard playing, let c = clip else { return }
        frame += dt * c.fps
        if frame > c.length { frame = c.loop ? frame.truncatingRemainder(dividingBy: max(1, c.length)) : c.length }
    }

    func currentPose() -> [Pose] {
        Skeleton.samplePose(doc, clip, frame)
    }
}
