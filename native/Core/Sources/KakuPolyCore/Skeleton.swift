// 骨格・アニメの評価とスキニング（Web版 src/core/skeleton.ts と同じ計算）
import Foundation

public struct Pose: Equatable {
    public var pos: V3
    public var rot: Quat
    public var scl: V3

    public init(pos: V3, rot: Quat, scl: V3) {
        self.pos = pos
        self.rot = rot
        self.scl = scl
    }
}

public enum Skeleton {
    public static func restPose(_ bones: [Bone]) -> [Pose] {
        bones.map { Pose(pos: $0.pos, rot: $0.rot, scl: $0.scl) }
    }

    /// ローカル姿勢 → ワールド行列（親が子より後ろに並んでいても可）
    public static func worldMatrices(_ bones: [Bone], _ pose: [Pose]) -> [Mat4] {
        var out = [Mat4?](repeating: nil, count: bones.count)
        func get(_ i: Int, _ depth: Int) -> Mat4 {
            if let c = out[i] { return c }
            let local = Mat4.compose(pose[i].pos, pose[i].rot, pose[i].scl)
            let p = bones[i].parent
            let w = (p >= 0 && p < bones.count && p != i && depth < 256) ? get(p, depth + 1) * local : local
            out[i] = w
            return w
        }
        for i in bones.indices { _ = get(i, 0) }
        return out.map { $0! }
    }

    public static func restWorld(_ bones: [Bone]) -> [Mat4] {
        worldMatrices(bones, restPose(bones))
    }

    public static func sampleTrack(_ keys: [Key], _ f: Float, _ interp: Interp) -> Pose? {
        guard let first = keys.first, let last = keys.last else { return nil }
        if f <= first.f { return Pose(pos: first.pos, rot: first.rot, scl: first.scl) }
        if f >= last.f { return Pose(pos: last.pos, rot: last.rot, scl: last.scl) }
        var i = 0
        while i < keys.count - 1 && keys[i + 1].f <= f { i += 1 }
        let a = keys[i], b = keys[i + 1]
        if interp == .step || b.f == a.f { return Pose(pos: a.pos, rot: a.rot, scl: a.scl) }
        let t = (f - a.f) / (b.f - a.f)
        return Pose(pos: vMix(a.pos, b.pos, t), rot: Q.slerp(a.rot, b.rot, t), scl: vMix(a.scl, b.scl, t))
    }

    /// クリップを f コマ目で評価（キーのないボーンはレスト姿勢）
    public static func samplePose(_ doc: Doc, _ clip: Clip?, _ f: Float) -> [Pose] {
        var pose = restPose(doc.bones)
        guard let clip else { return pose }
        for t in clip.tracks where t.bone >= 0 && t.bone < pose.count {
            if let p = sampleTrack(t.keys, f, clip.interp) { pose[t.bone] = p }
        }
        return pose
    }

    /// 各ボーンの「レスト → ポーズ」変形行列
    public static func skinMatrices(_ doc: Doc, _ pose: [Pose]) -> [Mat4] {
        let rw = restWorld(doc.bones)
        let pw = worldMatrices(doc.bones, pose)
        return zip(pw, rw).map { $0 * $1.inverse }
    }

    /// スキニング後の頂点位置（CPU）
    public static func skinnedPositions(_ doc: Doc, _ o: MeshObj, _ pose: [Pose]) -> [V3] {
        if doc.bones.isEmpty { return o.verts }
        let mats = skinMatrices(doc, pose)
        return o.verts.enumerated().map { vi, v in
            let inf = vi < o.skin.count ? o.skin[vi] : []
            if inf.isEmpty { return v }
            var out = V3(0, 0, 0)
            for x in inf where x.bone >= 0 && x.bone < mats.count {
                out += mats[x.bone].point(v) * x.weight
            }
            return out
        }
    }
}
