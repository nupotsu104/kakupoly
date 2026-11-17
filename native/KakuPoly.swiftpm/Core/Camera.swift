// このファイルは native/Core からの複製です。直接編集せず native/Core を直して scripts/sync-native.mjs を実行してください。
// 注視点のまわりを回る視点（Web版のビューポートと同じ操作感）
import Foundation

public struct OrbitCamera: Equatable {
    public var target = V3(0, 0.95, 0)
    public var yaw: Float = 0.6
    public var pitch: Float = 0.16
    public var distance: Float = 4.6
    public var fovY: Float = 40 * .pi / 180
    public var ortho = false

    public init() {}

    public var eye: V3 {
        let cp = cos(pitch)
        return target + V3(distance * cp * sin(yaw), distance * sin(pitch), distance * cp * cos(yaw))
    }

    public var view: Mat4 { Mat4.lookAt(eye: eye, target: target, up: V3(0, 1, 0)) }

    public func projection(aspect: Float) -> Mat4 {
        let near = max(0.01, distance / 100), far = max(50, distance * 40)
        if ortho {
            let hh = distance * tan(fovY / 2)
            return Mat4.orthographic(halfW: hh * aspect, halfH: hh, near: -far, far: far)
        }
        return Mat4.perspective(fovY: fovY, aspect: aspect, near: near, far: far)
    }

    /// 右・上・前（視線）方向
    public var basis: (right: V3, up: V3, fwd: V3) {
        let fwd = vNormalize(target - eye)
        var right = vNormalize(vCross(fwd, V3(0, 1, 0)))
        if vLength(right) == 0 { right = V3(1, 0, 0) }
        return (right, vNormalize(vCross(right, fwd)), fwd)
    }

    public mutating func orbit(dx: Float, dy: Float) {
        yaw -= dx * 0.008
        pitch = min(1.55, max(-1.55, pitch + dy * 0.008))
    }

    /// 画面の高さ viewHeight（ポイント）に対する平行移動
    public mutating func pan(dx: Float, dy: Float, viewHeight: Float) {
        let b = basis
        let k = 2 * distance * tan(fovY / 2) / max(1, viewHeight)
        target += b.right * (-dx * k) + b.up * (dy * k)
    }

    public mutating func zoom(_ factor: Float) {
        distance = min(500, max(0.05, distance * factor))
    }

    /// 全体が収まるように合わせる
    public mutating func frame(_ bounds: (min: V3, max: V3)?) {
        guard let b = bounds else { return }
        target = (b.min + b.max) / 2
        let r = max(0.1, vLength(b.max - b.min) / 2)
        distance = r / tan(fovY / 2) * 1.15
    }

    /// 画面上の点（0...1 の正規化座標、左上原点）からのレイ
    public func ray(nx: Float, ny: Float, aspect: Float) -> (origin: V3, dir: V3) {
        let b = basis
        let hh = tan(fovY / 2)
        let sx = (nx * 2 - 1) * hh * aspect, sy = (1 - ny * 2) * hh
        if ortho {
            let o = target + b.right * (sx * distance) + b.up * (sy * distance)
            return (o - b.fwd * (distance * 20), b.fwd)
        }
        return (eye, vNormalize(b.fwd + b.right * sx + b.up * sy))
    }
}
