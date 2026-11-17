// 最小限の数学（Linux でも動くよう simd モジュールに頼らない）。行列は列優先で Web版・Metal と同じ並び。
import Foundation

@inline(__always) public func vDot(_ a: V3, _ b: V3) -> Float { (a * b).sum() }
@inline(__always) public func vCross(_ a: V3, _ b: V3) -> V3 {
    V3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
}
@inline(__always) public func vLength(_ a: V3) -> Float { vDot(a, a).squareRoot() }
@inline(__always) public func vNormalize(_ a: V3) -> V3 {
    let l = vLength(a)
    return l > 1e-12 ? a / l : V3(0, 0, 0)
}
@inline(__always) public func vMix(_ a: V3, _ b: V3, _ t: Float) -> V3 { a + (b - a) * t }

// ---------- クォータニオン ----------
public enum Q {
    public static let identity = Quat(0, 0, 0, 1)

    public static func mul(_ a: Quat, _ b: Quat) -> Quat {
        Quat(
            a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
        )
    }

    public static func normalized(_ q: Quat) -> Quat {
        let l = (q * q).sum().squareRoot()
        return l > 1e-12 ? q / l : identity
    }

    public static func axisAngle(_ axis: V3, _ angle: Float) -> Quat {
        let a = vNormalize(axis) * sin(angle / 2)
        return Quat(a.x, a.y, a.z, cos(angle / 2))
    }

    public static func rotate(_ q: Quat, _ v: V3) -> V3 {
        let u = V3(q.x, q.y, q.z)
        let t = vCross(u, v) * 2
        return v + t * q.w + vCross(u, t)
    }

    public static func slerp(_ a: Quat, _ b0: Quat, _ t: Float) -> Quat {
        var b = b0
        var c = (a * b).sum()
        if c < 0 {
            c = -c
            b = -b
        }
        if c > 0.9995 { return normalized(a + (b - a) * t) }
        let th = acos(c)
        let s = sin(th)
        return a * (sin((1 - t) * th) / s) + b * (sin(t * th) / s)
    }
}

// ---------- 4x4 行列（列優先） ----------
public struct Mat4: Equatable {
    public var m: [Float]

    public init(_ m: [Float]) {
        precondition(m.count == 16)
        self.m = m
    }

    public static let identity = Mat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

    public static func compose(_ p: V3, _ q: Quat, _ s: V3) -> Mat4 {
        let x = q.x, y = q.y, z = q.z, w = q.w
        let x2 = x + x, y2 = y + y, z2 = z + z
        let xx = x * x2, xy = x * y2, xz = x * z2
        let yy = y * y2, yz = y * z2, zz = z * z2
        let wx = w * x2, wy = w * y2, wz = w * z2
        return Mat4([
            (1 - (yy + zz)) * s.x, (xy + wz) * s.x, (xz - wy) * s.x, 0,
            (xy - wz) * s.y, (1 - (xx + zz)) * s.y, (yz + wx) * s.y, 0,
            (xz + wy) * s.z, (yz - wx) * s.z, (1 - (xx + yy)) * s.z, 0,
            p.x, p.y, p.z, 1,
        ])
    }

    public static func * (a: Mat4, b: Mat4) -> Mat4 {
        var o = [Float](repeating: 0, count: 16)
        for c in 0..<4 {
            for r in 0..<4 {
                o[c * 4 + r] = a.m[r] * b.m[c * 4] + a.m[4 + r] * b.m[c * 4 + 1] + a.m[8 + r] * b.m[c * 4 + 2] + a.m[12 + r] * b.m[c * 4 + 3]
            }
        }
        return Mat4(o)
    }

    public func point(_ p: V3) -> V3 {
        V3(
            m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
            m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
            m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]
        )
    }

    public func direction(_ p: V3) -> V3 {
        V3(
            m[0] * p.x + m[4] * p.y + m[8] * p.z,
            m[1] * p.x + m[5] * p.y + m[9] * p.z,
            m[2] * p.x + m[6] * p.y + m[10] * p.z
        )
    }

    public var position: V3 { V3(m[12], m[13], m[14]) }

    public var inverse: Mat4 {
        let a = m
        var inv = [Float](repeating: 0, count: 16)
        inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10]
        inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10]
        inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9]
        inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9]
        inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10]
        inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10]
        inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9]
        inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9]
        inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6]
        inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6]
        inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5]
        inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5]
        inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6]
        inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6]
        inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5]
        inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5]
        let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12]
        if abs(det) < 1e-20 { return .identity }
        return Mat4(inv.map { $0 / det })
    }

    /// 透視投影（右手系・Metal の深度範囲 0...1）
    public static func perspective(fovY: Float, aspect: Float, near: Float, far: Float) -> Mat4 {
        let f = 1 / tan(fovY / 2)
        return Mat4([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, far / (near - far), -1,
            0, 0, near * far / (near - far), 0,
        ])
    }

    /// 平行投影（Metal の深度範囲 0...1）
    public static func orthographic(halfW: Float, halfH: Float, near: Float, far: Float) -> Mat4 {
        Mat4([
            1 / halfW, 0, 0, 0,
            0, 1 / halfH, 0, 0,
            0, 0, 1 / (near - far), 0,
            0, 0, near / (near - far), 1,
        ])
    }

    public static func lookAt(eye: V3, target: V3, up: V3) -> Mat4 {
        let z = vNormalize(eye - target)
        var x = vNormalize(vCross(up, z))
        if vLength(x) == 0 { x = V3(1, 0, 0) }
        let y = vCross(z, x)
        return Mat4([
            x.x, y.x, z.x, 0,
            x.y, y.y, z.y, 0,
            x.z, y.z, z.z, 0,
            -vDot(x, eye), -vDot(y, eye), -vDot(z, eye), 1,
        ])
    }

    /// 位置・回転・拡縮に分解（せん断は無視）
    public func decompose() -> (pos: V3, rot: Quat, scl: V3) {
        var sx = vLength(V3(m[0], m[1], m[2]))
        let sy = vLength(V3(m[4], m[5], m[6]))
        let sz = vLength(V3(m[8], m[9], m[10]))
        let det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5])
        if det < 0 { sx = -sx }
        let ix = sx != 0 ? 1 / sx : 0, iy = sy != 0 ? 1 / sy : 0, iz = sz != 0 ? 1 / sz : 0
        let m11 = m[0] * ix, m21 = m[1] * ix, m31 = m[2] * ix
        let m12 = m[4] * iy, m22 = m[5] * iy, m32 = m[6] * iy
        let m13 = m[8] * iz, m23 = m[9] * iz, m33 = m[10] * iz
        let tr = m11 + m22 + m33
        var q: Quat
        if tr > 0 {
            let s = 0.5 / (tr + 1).squareRoot()
            q = Quat((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s)
        } else if m11 > m22 && m11 > m33 {
            let s = 2 * (1 + m11 - m22 - m33).squareRoot()
            q = Quat(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s)
        } else if m22 > m33 {
            let s = 2 * (1 + m22 - m11 - m33).squareRoot()
            q = Quat((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s)
        } else {
            let s = 2 * (1 + m33 - m11 - m22).squareRoot()
            q = Quat((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)
        }
        return (position, Q.normalized(q), V3(sx, sy, sz))
    }
}
