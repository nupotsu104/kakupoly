import MetalKit
import SwiftUI
import UIKit

/// 3D表示と入力。Apple Pencil と指を区別して扱う。
///  - Pencil: タップで当たった面を表示（編集機能は次の段階で）、ドラッグで視点回転
///  - 指: 1本で視点回転、2本でズーム・移動、2本タップ/3本タップを検出
///  - キーボード（TourBox）: 押されたキーを表示
///  - Pencil のダブルタップ・スクイーズ・ホバーを表示
final class InputView: MTKView, UIPencilInteractionDelegate {
    weak var model: AppModel?

    private var pencil: UITouch?
    private var pencilStart: CGPoint = .zero
    private var pencilMoved = false
    private var fingers: [UITouch: CGPoint] = [:]
    private var gestureMax = 0
    private var gestureMoved = false
    private var gestureStart = Date()
    private var lastPinch: (dist: CGFloat, mid: CGPoint)?

    override init(frame: CGRect, device: MTLDevice?) {
        super.init(frame: frame, device: device)
        isMultipleTouchEnabled = true
        let pi = UIPencilInteraction()
        pi.delegate = self
        addInteraction(pi)
        addGestureRecognizer(UIHoverGestureRecognizer(target: self, action: #selector(hover(_:))))
    }

    required init(coder: NSCoder) {
        fatalError("init(coder:) は使いません")
    }

    // ---------- キーボード（TourBox もここに来る） ----------

    override var canBecomeFirstResponder: Bool { true }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        becomeFirstResponder()
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for p in presses {
            guard let key = p.key else { continue }
            var mods: [String] = []
            if key.modifierFlags.contains(.command) { mods.append("⌘") }
            if key.modifierFlags.contains(.control) { mods.append("Ctrl") }
            if key.modifierFlags.contains(.alternate) { mods.append("⌥") }
            if key.modifierFlags.contains(.shift) { mods.append("⇧") }
            let ch = key.charactersIgnoringModifiers.isEmpty ? "?" : key.charactersIgnoringModifiers
            model?.note("キー: \((mods + [ch]).joined(separator: " "))（HID \(key.keyCode.rawValue)）")
            handled = true
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }

    // ---------- Apple Pencil のダブルタップ・スクイーズ ----------

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        model?.note("Pencil: ダブルタップ")
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        if squeeze.phase == .ended { model?.note("Pencil: スクイーズ") }
    }

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        model?.note("Pencil: ダブルタップ（旧方式）")
    }

    // ---------- ホバー ----------

    @objc private func hover(_ g: UIHoverGestureRecognizer) {
        let p = g.location(in: self)
        switch g.state {
        case .began, .changed:
            model?.hoverPoint = p
        default:
            model?.hoverPoint = nil
        }
        if g.state == .began {
            if #available(iOS 16.1, *) {
                model?.note(String(format: "ホバー開始（高さ %.2f）", g.zOffset))
            } else {
                model?.note("ホバー開始")
            }
        }
    }

    // ---------- タッチ ----------

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        becomeFirstResponder()
        for t in touches {
            if t.type == .pencil {
                pencil = t
                pencilStart = t.location(in: self)
                pencilMoved = false
                // ペンを使い始めたら、置いている指（手のひら）は無視する
                fingers.removeAll()
                lastPinch = nil
            } else if pencil == nil {
                if fingers.isEmpty {
                    gestureMax = 0
                    gestureMoved = false
                    gestureStart = Date()
                }
                fingers[t] = t.location(in: self)
                gestureMax = max(gestureMax, fingers.count)
                resetPinch()
            }
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let model else { return }
        if let p = pencil, touches.contains(p) {
            let loc = p.location(in: self), prev = p.previousLocation(in: self)
            if hypot(loc.x - pencilStart.x, loc.y - pencilStart.y) > 8 { pencilMoved = true }
            if pencilMoved { model.camera.orbit(dx: Float(loc.x - prev.x), dy: Float(loc.y - prev.y)) }
            return
        }
        for t in touches where fingers[t] != nil {
            let loc = t.location(in: self), prev = fingers[t]!
            fingers[t] = loc
            if hypot(loc.x - prev.x, loc.y - prev.y) > 0.5 { gestureMoved = gestureMoved || Date().timeIntervalSince(gestureStart) > 0.05 }
            if fingers.count == 1 && gestureMax == 1 {
                model.camera.orbit(dx: Float(loc.x - prev.x), dy: Float(loc.y - prev.y))
            }
        }
        if fingers.count >= 2 {
            let pts = Array(fingers.values.prefix(2))
            let dist = hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
            let mid = CGPoint(x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2)
            if let lp = lastPinch, dist > 0 {
                model.camera.zoom(Float(lp.dist / dist))
                model.camera.pan(dx: Float(mid.x - lp.mid.x), dy: Float(mid.y - lp.mid.y), viewHeight: Float(bounds.height))
            }
            lastPinch = (dist, mid)
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        finish(touches, cancelled: false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        finish(touches, cancelled: true)
    }

    private func finish(_ touches: Set<UITouch>, cancelled: Bool) {
        guard let model else { return }
        if let p = pencil, touches.contains(p) {
            if !pencilMoved && !cancelled { pencilTap(p) }
            pencil = nil
            return
        }
        for t in touches { fingers.removeValue(forKey: t) }
        if fingers.isEmpty {
            let quick = Date().timeIntervalSince(gestureStart) < 0.35
            if !cancelled && quick && !gestureMoved {
                if gestureMax == 2 { model.note("指2本タップ（Web版では取り消し）") }
                if gestureMax == 3 { model.note("指3本タップ（Web版ではやり直し）") }
            }
        } else {
            resetPinch()
        }
    }

    private func resetPinch() {
        let pts = Array(fingers.values.prefix(2))
        lastPinch = pts.count == 2
            ? (hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), CGPoint(x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2))
            : nil
    }

    private func pencilTap(_ t: UITouch) {
        guard let model else { return }
        let loc = t.location(in: self)
        let aspect = Float(bounds.width / max(1, bounds.height))
        let r = model.camera.ray(nx: Float(loc.x / bounds.width), ny: Float(loc.y / bounds.height), aspect: aspect)
        let pose = model.currentPose()
        let doc = model.doc
        let hit = Geometry.raycast(doc, origin: r.origin, dir: r.dir) { oi in Skeleton.skinnedPositions(doc, doc.objects[oi], pose) }
        let force = t.maximumPossibleForce > 0 ? t.force / t.maximumPossibleForce : 0
        let tilt = String(format: "傾き%.0f° 筆圧%.2f", Double(90 - t.altitudeAngle * 180 / .pi), Double(force))
        if let h = hit {
            model.note(String(format: "ペン: %@ の面#%d に当たり UV(%.2f, %.2f) %@", doc.objects[h.object].name, h.face, Double(h.uv.x), Double(h.uv.y), tilt))
        } else {
            model.note("ペン: 何もない所（\(tilt)）")
        }
    }
}

/// SwiftUI から使うための包み
struct MetalViewport: UIViewRepresentable {
    @ObservedObject var model: AppModel

    func makeCoordinator() -> Renderer { Renderer(model: model) }

    func makeUIView(context: Context) -> InputView {
        let v = InputView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        v.model = model
        context.coordinator.attach(v)
        return v
    }

    func updateUIView(_ uiView: InputView, context: Context) {}
}
