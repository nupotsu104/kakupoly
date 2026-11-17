// Metal シェーダー（実行時にコンパイルする。Swift Playgrounds では .metal ファイルを使えないため）
let shaderSource = """
#include <metal_stdlib>
using namespace metal;

struct VIn { float4 position; float4 normal; float4 color; float4 uv; };

struct Uniforms {
    float4x4 viewProj;
    float4 lightDir;
    float2 res;
    float jitter;
    float affine;
    float shade;
    float hasTex;
    float2 pad;
};

struct VOut {
    float4 position [[position]];
    float3 color;
    float3 uvw;
};

// PS1風: 頂点を画面のピクセル格子に吸着（ガタつき）、遠近補正なしのUV（ゆがみ）、頂点単位の陰影
vertex VOut scene_vs(uint vid [[vertex_id]],
                     const device VIn* verts [[buffer(0)]],
                     constant Uniforms& u [[buffer(1)]]) {
    VIn v = verts[vid];
    float4 p = u.viewProj * float4(v.position.xyz, 1.0);
    if (u.jitter > 0.5 && p.w > 0.0) {
        float2 h = u.res * 0.5;
        float2 ndc = p.xy / p.w;
        ndc = floor(ndc * h + 0.5) / h;
        p.xy = ndc * p.w;
    }
    VOut o;
    o.position = p;
    float w = mix(1.0, max(p.w, 0.0001), u.affine);
    o.uvw = float3(v.uv.xy * w, w);
    float l = 1.0;
    if (u.shade > 0.5) {
        l = 0.55 + 0.45 * max(dot(normalize(v.normal.xyz), u.lightDir.xyz), 0.0) * 1.25;
    }
    o.color = v.color.rgb * l;
    return o;
}

fragment float4 scene_fs(VOut in [[stage_in]],
                         texture2d<float> tex [[texture(0)]],
                         constant Uniforms& u [[buffer(1)]]) {
    constexpr sampler s(filter::nearest, address::repeat);
    float3 c = in.color;
    if (u.hasTex > 0.5) {
        float4 t = tex.sample(s, in.uvw.xy / in.uvw.z);
        if (t.a < 0.5) discard_fragment();
        c *= t.rgb;
    }
    return float4(c, 1.0);
}

struct PostOut {
    float4 position [[position]];
    float2 uv;
};

// 画面いっぱいの三角形
vertex PostOut post_vs(uint vid [[vertex_id]]) {
    float2 p = float2((vid << 1) & 2, vid & 2);
    PostOut o;
    o.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv = float2(p.x, 1.0 - p.y);
    return o;
}

// 低解像度の絵を拡大し、15bitカラー＋4x4ディザ（PS1のGPUと同じ並び）をかける
fragment float4 post_fs(PostOut in [[stage_in]],
                        texture2d<float> src [[texture(0)]],
                        constant float4& params [[buffer(0)]]) {
    constexpr sampler s(filter::nearest, address::clamp_to_edge);
    float2 res = params.xy;
    float2 px = floor(in.uv * res);
    float3 c = src.sample(s, (px + 0.5) / res).rgb;
    if (params.z > 0.5) {
        const float m[16] = { -4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2 };
        int i = int(fmod(px.y, 4.0)) * 4 + int(fmod(px.x, 4.0));
        float3 c8 = clamp(c * 255.0 + m[i], 0.0, 255.0);
        c = floor(c8 / 8.0) * 8.0 / 248.0;
    }
    return float4(c, 1.0);
}
"""
