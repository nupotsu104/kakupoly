import XCTest
@testable import KakuPolyCore

final class CoreTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    private struct Expected: Decodable {
        struct Frame: Decodable {
            let f: Float
            let joints: [[Float]]
            let verts: [[Float]]
        }
        let restJoints: [[Float]]
        let frames: [Frame]
    }

    private func assertClose(_ a: V3, _ b: [Float], _ eps: Float = 1e-4, _ msg: String, file: StaticString = #filePath, line: UInt = #line) {
        for k in 0..<3 {
            XCTAssertEqual(a[k], b[k], accuracy: eps, "\(msg) [\(k)]", file: file, line: line)
        }
    }

    func testWeb版のkpolyを読める() throws {
        let doc = try Doc.load(fixture("sample.kpoly"))
        XCTAssertEqual(doc.name, "サンプル人型")
        XCTAssertEqual(doc.objects.count, 1)
        XCTAssertEqual(doc.objects[0].verts.count, 111)
        XCTAssertEqual(doc.objects[0].faces.count, 84)
        XCTAssertEqual(doc.bones.count, 11)
        XCTAssertEqual(doc.bones[3].name, "arm.L")
        XCTAssertEqual(doc.clips.map(\.name), ["歩き", "待機"])
        XCTAssertEqual(doc.textures[0].w, 64)
        XCTAssertEqual(doc.textures[0].data.count, 64 * 64 * 4)
    }

    func test書き出して読み戻すと同じ() throws {
        let doc = try Doc.load(fixture("sample.kpoly"))
        let again = try Doc.load(doc.save())
        XCTAssertEqual(doc, again)
    }

    func test骨格とスキニングがWeb版と一致する() throws {
        let doc = try Doc.load(fixture("sample.kpoly"))
        let exp = try JSONDecoder().decode(Expected.self, from: fixture("expected.json"))
        for (i, m) in Skeleton.restWorld(doc.bones).enumerated() {
            assertClose(m.position, exp.restJoints[i], 1e-5, "rest joint \(i)")
        }
        for fr in exp.frames {
            let pose = Skeleton.samplePose(doc, doc.clips[0], fr.f)
            for (i, m) in Skeleton.worldMatrices(doc.bones, pose).enumerated() {
                assertClose(m.position, fr.joints[i], 1e-4, "frame \(fr.f) joint \(i)")
            }
            let vs = Skeleton.skinnedPositions(doc, doc.objects[0], pose)
            for (i, v) in vs.enumerated() {
                assertClose(v, fr.verts[i], 1e-4, "frame \(fr.f) vert \(i)")
            }
        }
    }

    func test行列の分解と逆行列() {
        let q = Q.axisAngle(V3(0.3, 1, 0.2), 1.1)
        let m = Mat4.compose(V3(1, 2, 3), q, V3(2, 2, 2))
        let d = m.decompose()
        let m2 = Mat4.compose(d.pos, d.rot, d.scl)
        for i in 0..<16 { XCTAssertEqual(m.m[i], m2.m[i], accuracy: 1e-5) }
        let id = m * m.inverse
        for i in 0..<16 { XCTAssertEqual(id.m[i], Mat4.identity.m[i], accuracy: 1e-5) }
        let v = V3(0.5, -1, 2)
        let r = Q.rotate(q, v)
        let r2 = Mat4.compose(V3(0, 0, 0), q, V3(1, 1, 1)).point(v)
        for k in 0..<3 { XCTAssertEqual(r[k], r2[k], accuracy: 1e-5) }
    }

    func test正面からのレイが顔に当たる() throws {
        let doc = try Doc.load(fixture("sample.kpoly"))
        var cam = OrbitCamera()
        cam.yaw = 0
        cam.pitch = 0
        cam.target = V3(0, 1.64, 0)
        cam.distance = 3
        let r = cam.ray(nx: 0.5, ny: 0.5, aspect: 4 / 3)
        let hit = try XCTUnwrap(Geometry.raycast(doc, origin: r.origin, dir: r.dir))
        // 頭の箱の前面は z=0.15
        XCTAssertEqual(hit.point.z, 0.15, accuracy: 1e-4)
        XCTAssertEqual(hit.point.y, 1.64, accuracy: 1e-4)
        // 顔のテクスチャ（左上 24x24）の中
        XCTAssertLessThan(hit.uv.x, 24.0 / 64)
        XCTAssertLessThan(hit.uv.y, 24.0 / 64)
    }

    func test描画用の三角形() throws {
        let doc = try Doc.load(fixture("sample.kpoly"))
        let t = Geometry.triangles(doc.objects[0])
        let tris = doc.objects[0].faces.reduce(0) { $0 + $1.v.count - 2 }
        XCTAssertEqual(t.verts.count, tris * 3)
        XCTAssertEqual(t.triFace.count, tris)
        XCTAssertEqual(MemoryLayout<Geometry.RenderVertex>.stride, 64)
    }

    func test透視投影は手前が0奥が1() {
        let p = Mat4.perspective(fovY: 1, aspect: 1, near: 1, far: 10)
        func depth(_ z: Float) -> Float {
            let m = p.m
            let cz = m[10] * z + m[14], cw = m[11] * z + m[15]
            return cz / cw
        }
        XCTAssertEqual(depth(-1), 0, accuracy: 1e-5)
        XCTAssertEqual(depth(-10), 1, accuracy: 1e-5)
    }
}
