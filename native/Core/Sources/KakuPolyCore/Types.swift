// 作品データ。Web版の .kpoly（JSON）と同じ形で読み書きする。
import Foundation

public typealias V2 = SIMD2<Float>
public typealias V3 = SIMD3<Float>
/// クォータニオン (x, y, z, w)
public typealias Quat = SIMD4<Float>

public struct Face: Codable, Equatable {
    /// 頂点番号（反時計回りが表）
    public var v: [Int]
    /// コーナーごとのUV。(0,0)=画像の左上、v は下向き（glTF と同じ）
    public var uv: [V2]
    /// コーナーごとの頂点カラー 0...1
    public var col: [V3]

    public init(v: [Int], uv: [V2], col: [V3]) {
        self.v = v
        self.uv = uv
        self.col = col
    }
}

/// 頂点1つ分のスキン: [ボーン番号, 重み]。JSON では 2要素の配列
public struct Influence: Codable, Equatable {
    public var bone: Int
    public var weight: Float

    public init(bone: Int, weight: Float) {
        self.bone = bone
        self.weight = weight
    }

    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        bone = try c.decode(Int.self)
        weight = try c.decode(Float.self)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(bone)
        try c.encode(weight)
    }
}

public struct MeshObj: Codable, Equatable {
    public var id: Int
    public var name: String
    public var verts: [V3]
    public var faces: [Face]
    public var skin: [[Influence]]
    /// 使うテクスチャ番号。-1 はテクスチャなし
    public var tex: Int
    public var visible: Bool
    public var doubleSided: Bool
    /// 不透明度 0...1（1 未満なら半透明）
    public var opacity: Float

    public init(id: Int, name: String, verts: [V3] = [], faces: [Face] = [], skin: [[Influence]] = [], tex: Int = -1, visible: Bool = true, doubleSided: Bool = false, opacity: Float = 1) {
        self.id = id
        self.name = name
        self.verts = verts
        self.faces = faces
        self.skin = skin
        self.tex = tex
        self.visible = visible
        self.doubleSided = doubleSided
        self.opacity = opacity
    }

    enum CodingKeys: String, CodingKey { case id, name, verts, faces, skin, tex, visible, doubleSided, opacity }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        verts = try c.decode([V3].self, forKey: .verts)
        faces = try c.decode([Face].self, forKey: .faces)
        skin = try c.decodeIfPresent([[Influence]].self, forKey: .skin) ?? []
        tex = try c.decodeIfPresent(Int.self, forKey: .tex) ?? -1
        visible = try c.decodeIfPresent(Bool.self, forKey: .visible) ?? true
        doubleSided = try c.decodeIfPresent(Bool.self, forKey: .doubleSided) ?? false
        opacity = try c.decodeIfPresent(Float.self, forKey: .opacity) ?? 1
        while skin.count < verts.count { skin.append([]) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(verts, forKey: .verts)
        try c.encode(faces, forKey: .faces)
        try c.encode(skin, forKey: .skin)
        try c.encode(tex, forKey: .tex)
        try c.encode(visible, forKey: .visible)
        try c.encode(doubleSided, forKey: .doubleSided)
        if opacity < 1 { try c.encode(opacity, forKey: .opacity) }
    }
}

public struct Texture: Codable, Equatable {
    public var id: Int
    public var name: String
    public var w: Int
    public var h: Int
    /// RGBA 8bit
    public var data: [UInt8]

    public init(id: Int, name: String, w: Int, h: Int, data: [UInt8]) {
        self.id = id
        self.name = name
        self.w = w
        self.h = h
        self.data = data
    }

    enum CodingKeys: String, CodingKey { case id, name, w, h, data }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        w = try c.decode(Int.self, forKey: .w)
        h = try c.decode(Int.self, forKey: .h)
        let b64 = try c.decode(String.self, forKey: .data)
        guard let d = Data(base64Encoded: b64), d.count == w * h * 4 else {
            throw DecodingError.dataCorruptedError(forKey: .data, in: c, debugDescription: "テクスチャ \(name) のデータが壊れています")
        }
        data = [UInt8](d)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(w, forKey: .w)
        try c.encode(h, forKey: .h)
        try c.encode(Data(data).base64EncodedString(), forKey: .data)
    }
}

public struct Bone: Codable, Equatable {
    public var name: String
    /// -1 = ルート
    public var parent: Int
    /// レスト（初期）姿勢のローカル変形
    public var pos: V3
    public var rot: Quat
    public var scl: V3

    public init(name: String, parent: Int, pos: V3, rot: Quat = Quat(0, 0, 0, 1), scl: V3 = V3(1, 1, 1)) {
        self.name = name
        self.parent = parent
        self.pos = pos
        self.rot = rot
        self.scl = scl
    }
}

public struct Key: Codable, Equatable {
    public var f: Float
    public var pos: V3
    public var rot: Quat
    public var scl: V3

    public init(f: Float, pos: V3, rot: Quat, scl: V3) {
        self.f = f
        self.pos = pos
        self.rot = rot
        self.scl = scl
    }
}

public struct Track: Codable, Equatable {
    public var bone: Int
    public var keys: [Key]

    public init(bone: Int, keys: [Key]) {
        self.bone = bone
        self.keys = keys
    }
}

public enum Interp: String, Codable { case linear, step }

public struct Clip: Codable, Equatable {
    public var name: String
    public var fps: Float
    public var length: Float
    public var interp: Interp
    public var loop: Bool
    public var tracks: [Track]

    public init(name: String, fps: Float = 15, length: Float = 30, interp: Interp = .linear, loop: Bool = true, tracks: [Track] = []) {
        self.name = name
        self.fps = fps
        self.length = length
        self.interp = interp
        self.loop = loop
        self.tracks = tracks
    }
}

public struct Doc: Codable, Equatable {
    public var version: Int = 1
    public var name: String
    public var objects: [MeshObj]
    public var textures: [Texture]
    public var bones: [Bone]
    public var clips: [Clip]
    public var palette: [String]
    public var nextId: Int

    public init(name: String = "無題", objects: [MeshObj] = [], textures: [Texture] = [], bones: [Bone] = [], clips: [Clip] = [], palette: [String] = [], nextId: Int = 1) {
        self.name = name
        self.objects = objects
        self.textures = textures
        self.bones = bones
        self.clips = clips
        self.palette = palette
        self.nextId = nextId
    }

    enum CodingKeys: String, CodingKey { case format, version, name, objects, textures, bones, clips, palette, nextId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let format = try c.decodeIfPresent(String.self, forKey: .format)
        let ver = try c.decodeIfPresent(Int.self, forKey: .version)
        guard format == "kakupoly", ver == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .format, in: c, debugDescription: "KakuPoly のファイルではありません")
        }
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "無題"
        objects = try c.decodeIfPresent([MeshObj].self, forKey: .objects) ?? []
        textures = try c.decodeIfPresent([Texture].self, forKey: .textures) ?? []
        bones = try c.decodeIfPresent([Bone].self, forKey: .bones) ?? []
        clips = try c.decodeIfPresent([Clip].self, forKey: .clips) ?? []
        palette = try c.decodeIfPresent([String].self, forKey: .palette) ?? []
        nextId = try c.decodeIfPresent(Int.self, forKey: .nextId) ?? 1
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("kakupoly", forKey: .format)
        try c.encode(1, forKey: .version)
        try c.encode(name, forKey: .name)
        try c.encode(objects, forKey: .objects)
        try c.encode(textures, forKey: .textures)
        try c.encode(bones, forKey: .bones)
        try c.encode(clips, forKey: .clips)
        try c.encode(palette, forKey: .palette)
        try c.encode(nextId, forKey: .nextId)
    }

    /// .kpoly（JSON）を読む
    public static func load(_ data: Data) throws -> Doc {
        try JSONDecoder().decode(Doc.self, from: data)
    }

    /// .kpoly（JSON）に書く
    public func save() throws -> Data {
        try JSONEncoder().encode(self)
    }
}
