import MetalKit
import simd

/// GPU に渡す共通の値（シェーダーの Uniforms と同じ並び）
private struct Uniforms {
    var viewProj: simd_float4x4
    var lightDir: SIMD4<Float>
    var res: SIMD2<Float>
    var jitter: Float
    var affine: Float
    var shade: Float
    var hasTex: Float
    var pad: SIMD2<Float> = .zero
}

private extension Mat4 {
    var simd: simd_float4x4 {
        simd_float4x4(columns: (
            SIMD4(m[0], m[1], m[2], m[3]),
            SIMD4(m[4], m[5], m[6], m[7]),
            SIMD4(m[8], m[9], m[10], m[11]),
            SIMD4(m[12], m[13], m[14], m[15])
        ))
    }
}

/// PS1風の描画: 低解像度の画面に描いてから、ディザをかけて拡大する
final class Renderer: NSObject, MTKViewDelegate {
    let model: AppModel
    private var device: MTLDevice!
    private var queue: MTLCommandQueue!
    private var scenePipeline: MTLRenderPipelineState!
    private var postPipeline: MTLRenderPipelineState!
    private var depthState: MTLDepthStencilState!
    private var textures: [MTLTexture] = []
    private var white: MTLTexture!
    private var lowColor: MTLTexture?
    private var lowDepth: MTLTexture?
    private var builtVersion = -1
    private var lastTime = CACurrentMediaTime()

    init(model: AppModel) {
        self.model = model
        super.init()
    }

    func attach(_ view: MTKView) {
        guard let dev = view.device ?? MTLCreateSystemDefaultDevice() else {
            model.diagMetal = "Metal: 使えません"
            model.diagError = "この環境では Metal が使えません"
            return
        }
        model.diagMetal = "Metal: \(dev.name)"
        device = dev
        view.device = dev
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .invalid
        view.preferredFramesPerSecond = 60
        view.delegate = self
        queue = dev.makeCommandQueue()
        do {
            let lib = try dev.makeLibrary(source: shaderSource, options: nil)
            let sd = MTLRenderPipelineDescriptor()
            sd.vertexFunction = lib.makeFunction(name: "scene_vs")
            sd.fragmentFunction = lib.makeFunction(name: "scene_fs")
            sd.colorAttachments[0].pixelFormat = .rgba8Unorm
            sd.depthAttachmentPixelFormat = .depth32Float
            scenePipeline = try dev.makeRenderPipelineState(descriptor: sd)
            let pd = MTLRenderPipelineDescriptor()
            pd.vertexFunction = lib.makeFunction(name: "post_vs")
            pd.fragmentFunction = lib.makeFunction(name: "post_fs")
            pd.colorAttachments[0].pixelFormat = view.colorPixelFormat
            postPipeline = try dev.makeRenderPipelineState(descriptor: pd)
            model.diagShader = "シェーダー: OK"
        } catch {
            model.diagShader = "シェーダー: 失敗"
            model.diagError = "\(error)"
        }
        let ds = MTLDepthStencilDescriptor()
        ds.depthCompareFunction = .less
        ds.isDepthWriteEnabled = true
        depthState = dev.makeDepthStencilState(descriptor: ds)
        white = makeTexture(w: 1, h: 1, rgba: [255, 255, 255, 255])
    }

    private func makeTexture(w: Int, h: Int, rgba: [UInt8]) -> MTLTexture? {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: w, height: h, mipmapped: false)
        d.usage = .shaderRead
        guard let t = device.makeTexture(descriptor: d) else { return nil }
        rgba.withUnsafeBytes { p in
            t.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: p.baseAddress!, bytesPerRow: w * 4)
        }
        return t
    }

    private func rebuildIfNeeded() {
        guard builtVersion != model.docVersion else { return }
        builtVersion = model.docVersion
        textures = model.doc.textures.compactMap { makeTexture(w: $0.w, h: $0.h, rgba: $0.data) }
    }

    private func ensureTargets(width: Int, height: Int) {
        if let c = lowColor, c.width == width, c.height == height { return }
        let cd = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: false)
        cd.usage = [.renderTarget, .shaderRead]
        cd.storageMode = .private
        lowColor = device.makeTexture(descriptor: cd)
        let dd = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .depth32Float, width: width, height: height, mipmapped: false)
        dd.usage = .renderTarget
        dd.storageMode = .private
        lowDepth = device.makeTexture(descriptor: dd)
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        model.drawableSize = view.drawableSize
        guard scenePipeline != nil, postPipeline != nil else { model.drawSkip = "シェーダーが準備できていない"; return }
        guard let drawable = view.currentDrawable else { model.drawSkip = "描画先（drawable）がない"; return }
        guard let pass = view.currentRenderPassDescriptor else { model.drawSkip = "描画の設定（pass）がない"; return }
        guard let cmd = queue.makeCommandBuffer() else { model.drawSkip = "コマンドを作れない"; return }
        let now = CACurrentMediaTime()
        model.advance(dt: Float(min(0.1, now - lastTime)))
        lastTime = now
        rebuildIfNeeded()

        let ds = view.drawableSize
        guard ds.width > 0, ds.height > 0 else { model.drawSkip = "画面の大きさが0"; return }
        let aspect = Float(ds.width / ds.height)
        // PS1表示なら縦240ライン、そうでなければ端末の解像度のまま
        let h = model.ps1 ? 240 : Int(ds.height)
        let w = model.ps1 ? max(1, Int((240 * Double(aspect)).rounded())) : Int(ds.width)
        ensureTargets(width: w, height: h)
        guard let lowColor, let lowDepth else { model.drawSkip = "低解像度の描画先を作れない"; return }

        // ---- シーン（低解像度） ----
        let sp = MTLRenderPassDescriptor()
        sp.colorAttachments[0].texture = lowColor
        sp.colorAttachments[0].loadAction = .clear
        sp.colorAttachments[0].storeAction = .store
        sp.colorAttachments[0].clearColor = MTLClearColor(red: 0.227, green: 0.247, blue: 0.345, alpha: 1)
        sp.depthAttachment.texture = lowDepth
        sp.depthAttachment.loadAction = .clear
        sp.depthAttachment.storeAction = .dontCare
        sp.depthAttachment.clearDepth = 1
        if let enc = cmd.makeRenderCommandEncoder(descriptor: sp) {
            enc.setRenderPipelineState(scenePipeline)
            enc.setDepthStencilState(depthState)
            let vp = model.camera.projection(aspect: aspect) * model.camera.view
            let pose = model.currentPose()
            for o in model.doc.objects where o.visible && !o.faces.isEmpty {
                let pos = Skeleton.skinnedPositions(model.doc, o, pose)
                let tri = Geometry.triangles(o, positions: pos)
                guard !tri.verts.isEmpty,
                      let buf = device.makeBuffer(bytes: tri.verts, length: MemoryLayout<Geometry.RenderVertex>.stride * tri.verts.count) else { continue }
                let tex = o.tex >= 0 && o.tex < textures.count ? textures[o.tex] : nil
                var u = Uniforms(
                    viewProj: vp.simd,
                    lightDir: SIMD4(vNormalize(V3(0.4, 0.8, 0.45)), 0),
                    res: SIMD2(Float(w), Float(h)),
                    jitter: model.ps1 && model.jitter ? 1 : 0,
                    affine: model.ps1 && model.affine ? 1 : 0,
                    shade: 1,
                    hasTex: tex != nil ? 1 : 0
                )
                // 表裏の判定は実機で確かめてから有効にする（逆だと何も映らないため、最初は両面描画）
                enc.setCullMode(.none)
                enc.setVertexBuffer(buf, offset: 0, index: 0)
                enc.setVertexBytes(&u, length: MemoryLayout<Uniforms>.stride, index: 1)
                enc.setFragmentBytes(&u, length: MemoryLayout<Uniforms>.stride, index: 1)
                enc.setFragmentTexture(tex ?? white, index: 0)
                enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: tri.verts.count)
            }
            enc.endEncoding()
        }

        // ---- 拡大＋ディザ ----
        if let enc = cmd.makeRenderCommandEncoder(descriptor: pass) {
            enc.setRenderPipelineState(postPipeline)
            var params = SIMD4<Float>(Float(w), Float(h), model.ps1 && model.dither ? 1 : 0, 0)
            enc.setFragmentBytes(&params, length: MemoryLayout<SIMD4<Float>>.stride, index: 0)
            enc.setFragmentTexture(lowColor, index: 0)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            enc.endEncoding()
        }
        cmd.present(drawable)
        cmd.commit()
        model.drawCount += 1
        model.drawSkip = ""
    }
}
