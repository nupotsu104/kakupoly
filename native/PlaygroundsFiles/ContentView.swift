import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @ObservedObject var model: AppModel
    @State private var importing = false
    @State private var started = false

    var body: some View {
        if started { editor } else { startScreen }
    }

    /// 最初の画面: 文字とボタンだけ。ここが出なければアプリ自体が起動していない
    private var startScreen: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("KakuPoly ネイティブ版（試作）").font(.largeTitle.bold())
            Text("この画面が見えていれば、アプリの起動はできています。下のボタンを順に押してください。")
            ForEach(Array(model.stages.enumerated()), id: \.offset) { _, s in
                Text(s).font(.system(.body, design: .monospaced))
            }
            HStack(spacing: 12) {
                Button("① サンプルを読み込む") { model.loadSampleStage() }
                    .buttonStyle(.borderedProminent)
                Button("② 3D表示を始める") {
                    if model.doc.objects.isEmpty { model.loadSampleStage() }
                    model.startDiag()
                    started = true
                }
                .buttonStyle(.borderedProminent)
            }
            Spacer()
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(red: 0.2, green: 0.22, blue: 0.3))
        .foregroundStyle(.white)
    }

    private var editor: some View {
        VStack(spacing: 0) {
            topBar
            ZStack(alignment: .bottomLeading) {
                MetalViewport(model: model)
                    .ignoresSafeArea(edges: .bottom)
                if let p = model.hoverPoint {
                    Circle()
                        .stroke(Color.white, lineWidth: 1.5)
                        .frame(width: 14, height: 14)
                        .position(p)
                        .allowsHitTesting(false)
                }
                inputLog
                diagnostics
            }
        }
        .background(Color(red: 0.08, green: 0.08, blue: 0.12))
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
            if case let .success(url) = result { model.open(url) }
        }
        .alert("エラー", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button("開く（.kpoly）") { importing = true }
            Button("サンプル") { model.openSample() }
            Text(model.doc.name).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            if !model.doc.clips.isEmpty {
                Picker("アニメ", selection: $model.clipIndex) {
                    ForEach(model.doc.clips.indices, id: \.self) { i in Text(model.doc.clips[i].name).tag(i) }
                }
                .pickerStyle(.menu)
                Button(model.playing ? "■ 停止" : "▶ 再生") { model.playing.toggle() }
            }
            Toggle("PS1表示", isOn: $model.ps1).toggleStyle(.button)
            Toggle("ガタつき", isOn: $model.jitter).toggleStyle(.button).disabled(!model.ps1)
            Toggle("ゆがみ", isOn: $model.affine).toggleStyle(.button).disabled(!model.ps1)
            Toggle("ディザ", isOn: $model.dither).toggleStyle(.button).disabled(!model.ps1)
            Button("全体表示") { model.camera.frame(Geometry.bounds(model.doc)) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(red: 0.11, green: 0.12, blue: 0.17))
    }

    /// 右下: アプリ自身の状態（黒い画面の原因を調べるため）
    private var diagnostics: some View {
        VStack(alignment: .trailing, spacing: 2) {
            ForEach(Array(model.diag.enumerated()), id: \.offset) { _, line in
                Text(line).font(.system(.caption2, design: .monospaced))
            }
        }
        .padding(8)
        .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        .allowsHitTesting(false)
    }

    private var inputLog: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("入力の確認（ネイティブ版 試作）").font(.caption.bold())
            Text("ペンでタップ / 指でドラッグ・ピンチ / TourBox を操作 / Pencil をダブルタップ・スクイーズ").font(.caption2).foregroundStyle(.secondary)
            ForEach(Array(model.log.enumerated()), id: \.offset) { _, line in
                Text(line).font(.system(.caption, design: .monospaced))
            }
        }
        .padding(10)
        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
        .padding(12)
        .allowsHitTesting(false)
    }
}
