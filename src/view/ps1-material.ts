// PS1風の見た目を作るシェーダー
//  - 頂点を画面のピクセル格子に吸着（ポリゴンのガタつき）
//  - アフィン・テクスチャマッピング（遠近補正なし → テクスチャのゆがみ）
//  - 頂点単位のライティング（グーロー）
//  - 最近傍サンプリング・アルファ抜き
import * as THREE from 'three';

export interface SharedUniforms {
  uRes: { value: THREE.Vector2 };
  uJitter: { value: number };
  uAffine: { value: number };
  uShade: { value: number };
  uLightDir: { value: THREE.Vector3 };
  uAmbient: { value: number };
}

export const makeSharedUniforms = (): SharedUniforms => ({
  uRes: { value: new THREE.Vector2(320, 240) },
  uJitter: { value: 0 },
  uAffine: { value: 0 },
  uShade: { value: 1 },
  uLightDir: { value: new THREE.Vector3(0.4, 0.8, 0.45).normalize() },
  uAmbient: { value: 0.75 },
});

const VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform vec2 uRes;
uniform float uJitter;
uniform float uAffine;
uniform float uShade;
uniform vec3 uLightDir;
uniform float uAmbient;
attribute vec3 acol;
varying vec3 vCol;
varying vec3 vUvw;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
  vec4 p = projectionMatrix * mv;
  if (uJitter > 0.5 && p.w > 0.0) {
    vec2 h = uRes * 0.5;
    vec2 ndc = p.xy / p.w;
    ndc = floor(ndc * h + 0.5) / h;
    p.xy = ndc * p.w;
  }
  gl_Position = p;
  float w = mix(1.0, max(p.w, 0.0001), uAffine);
  vUvw = vec3(uv * w, w);
  float l = 1.0;
  if (uShade > 0.5) {
    vec3 n = normalize(mat3(modelMatrix) * objectNormal);
    l = uAmbient + (1.0 - uAmbient) * max(dot(n, uLightDir), 0.0) * 1.25;
  }
  vCol = acol * l;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform float uHasTex;
uniform float uOpacity;
varying vec3 vCol;
varying vec3 vUvw;
void main() {
  vec3 c = vCol;
  if (uHasTex > 0.5) {
    vec4 t = texture2D(uTex, vUvw.xy / vUvw.z);
    if (t.a < 0.5) discard;
    c *= t.rgb;
  }
  gl_FragColor = vec4(c, uOpacity);
}`;

export function makePs1Material(shared: SharedUniforms, tex: THREE.Texture | null, doubleSided: boolean, opacity = 1): THREE.ShaderMaterial {
  const translucent = opacity < 1;
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uTex: { value: tex }, uHasTex: { value: tex ? 1 : 0 }, uOpacity: { value: translucent ? Math.max(0, opacity) : 1 } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    // 半透明: 不透明なものを描いた後に重ね、奥のもの（例: 殻の中の目）が見えるよう深度は書かない
    transparent: translucent,
    depthWrite: !translucent,
  });
}

// 低解像度で描いた絵を拡大表示するときの後処理: 15bitカラー化 + PS1と同じ4x4ディザ行列
const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const POST_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uDither;
varying vec2 vUv;
float dmat(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = y * 4 + x;
  float m[16];
  m[0] = -4.0; m[1] = 0.0; m[2] = -3.0; m[3] = 1.0;
  m[4] = 2.0; m[5] = -2.0; m[6] = 3.0; m[7] = -1.0;
  m[8] = -3.0; m[9] = 1.0; m[10] = -4.0; m[11] = 0.0;
  m[12] = 3.0; m[13] = -1.0; m[14] = 2.0; m[15] = -2.0;
  return m[i];
}
void main() {
  vec2 px = floor(vUv * uRes);
  vec3 c = texture2D(uSrc, (px + 0.5) / uRes).rgb;
  if (uDither > 0.5) {
    vec3 c8 = clamp(c * 255.0 + dmat(px), 0.0, 255.0);
    c = floor(c8 / 8.0) * 8.0 / 248.0;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

export function makePostMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSrc: { value: null }, uRes: { value: new THREE.Vector2(320, 240) }, uDither: { value: 1 } },
    vertexShader: POST_VERT,
    fragmentShader: POST_FRAG,
    depthTest: false,
    depthWrite: false,
  });
}
