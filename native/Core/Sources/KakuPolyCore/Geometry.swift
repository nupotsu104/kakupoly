// 描画用の頂点配列づくりと、レイとの当たり判定
import Foundation

public enum Geometry {
    /// 面の法線（ニューウェル法。多角形でも安定）
    public static func faceNormal(_ f: Face, _ verts: [V3]) -> V3 {
        var n = V3(0, 0, 0)
        for i in f.v.indices {
            let a = verts[f.v[i]], b = verts[f.v[(i + 1) % f.v.count]]
            n.x += (a.y - b.y) * (a.z + b.z)
            n.y += (a.z - b.z) * (a.x + b.x)
            n.z += (a.x - b.x) * (a.y + b.y)
        }
        return vNormalize(n)
    }

    /// GPU に渡す1頂点（Metal 側の構造体と同じ並び。16バイト境界にそろえる）
    public struct RenderVertex: Equatable {
        public var position: SIMD4<Float>
        public var normal: SIMD4<Float>
        public var color: SIMD4<Float>
        public var uv: SIMD4<Float>

        public init(position: V3, normal: V3, color: V3, uv: V2) {
            self.position = SIMD4(position.x, position.y, position.z, 1)
            self.normal = SIMD4(normal.x, normal.y, normal.z, 0)
            self.color = SIMD4(color.x, color.y, color.z, 1)
            self.uv = SIMD4(uv.x, uv.y, 0, 0)
        }
    }

    /// 面を三角形に分けて、コーナーごとの頂点配列にする。triFace[三角形] = 元の面番号
    public static func triangles(_ o: MeshObj, positions: [V3]? = nil, smooth: Bool = false) -> (verts: [RenderVertex], triFace: [Int]) {
        let P = positions ?? o.verts
        var smoothN: [V3]? = nil
        if smooth {
            var s = [V3](repeating: V3(0, 0, 0), count: P.count)
            for f in o.faces {
                let n = faceNormal(f, P)
                for v in f.v { s[v] += n }
            }
            smoothN = s.map { vNormalize($0) }
        }
        var out: [RenderVertex] = []
        var triFace: [Int] = []
        out.reserveCapacity(o.faces.count * 6)
        for (fi, f) in o.faces.enumerated() where f.v.count >= 3 {
            let fn = faceNormal(f, P)
            for k in 1..<(f.v.count - 1) {
                for c in [0, k, k + 1] {
                    let vi = f.v[c]
                    out.append(RenderVertex(position: P[vi], normal: smoothN?[vi] ?? fn, color: f.col[c], uv: f.uv[c]))
                }
                triFace.append(fi)
            }
        }
        return (out, triFace)
    }

    public struct Hit: Equatable {
        public var object: Int
        public var face: Int
        public var t: Float
        public var point: V3
        public var uv: V2
    }

    /// レイ（原点 o・向き d）と全オブジェクトの交差。いちばん手前を返す
    public static func raycast(_ doc: Doc, origin: V3, dir: V3, positions: ((Int) -> [V3])? = nil) -> Hit? {
        var best: Hit? = nil
        for (oi, o) in doc.objects.enumerated() where o.visible {
            let P = positions?(oi) ?? o.verts
            for (fi, f) in o.faces.enumerated() where f.v.count >= 3 {
                let a = P[f.v[0]]
                for k in 1..<(f.v.count - 1) {
                    let b = P[f.v[k]], c = P[f.v[k + 1]]
                    let e1 = b - a, e2 = c - a
                    let pv = vCross(dir, e2)
                    let det = vDot(e1, pv)
                    if o.doubleSided ? abs(det) < 1e-12 : det < 1e-12 { continue }
                    let inv = 1 / det
                    let tv = origin - a
                    let u = vDot(tv, pv) * inv
                    if u < -1e-6 || u > 1 + 1e-6 { continue }
                    let qv = vCross(tv, e1)
                    let v = vDot(dir, qv) * inv
                    if v < -1e-6 || u + v > 1 + 1e-6 { continue }
                    let t = vDot(e2, qv) * inv
                    if t <= 1e-6 || (best != nil && t >= best!.t) { continue }
                    let w = 1 - u - v
                    let uv = f.uv[0] * w + f.uv[k] * u + f.uv[k + 1] * v
                    best = Hit(object: oi, face: fi, t: t, point: origin + dir * t, uv: uv)
                }
            }
        }
        return best
    }

    /// 全体の外接箱
    public static func bounds(_ doc: Doc) -> (min: V3, max: V3)? {
        var mn = V3(repeating: .infinity), mx = V3(repeating: -.infinity)
        for o in doc.objects where o.visible {
            for p in o.verts {
                mn = pointwiseMin(mn, p)
                mx = pointwiseMax(mx, p)
            }
        }
        return mn.x.isFinite ? (mn, mx) : nil
    }
}
