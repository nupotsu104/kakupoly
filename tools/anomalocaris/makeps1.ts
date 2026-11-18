// アノマロカリス PS1風（約2000三角形・256×256テクスチャ・複眼の殻50%）を、アプリと同じ処理で作る
import { readFileSync, writeFileSync } from 'node:fs';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { sceneToDoc, DEFAULT_IMPORT } from '../../src/io/import';
import { simplifyDoc, simplifyObject, triCount } from '../../src/core/simplify';
import { resizeBox, quantize, to15bit, usedColors } from '../../src/core/quantize';
import { selectLinkedUV, separateSelection } from '../../src/core/mesh-ops';
import { emptySelection, newTexture, assignTexture } from '../../src/core/doc';
import { serialize } from '../../src/io/project';
import { exportGLB } from '../../src/io/gltf-export';
import { alignFins, eyeInfo, fitPupils, stackingFlips } from './finfix';
import { samplePose, skinnedPositions } from '../../src/core/skeleton';
import { encodePNG } from '../../src/io/png';

const [fbxPath, texPath, outDir] = process.argv.slice(2);
const buf = readFileSync(fbxPath);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const doc = await sceneToDoc(root, (root as any).animations ?? [], { ...DEFAULT_IMPORT }, true);
const TRIS = Number(process.env.TRIS ?? 2000), TEX = Number(process.env.TEX ?? 256), COLORS = Number(process.env.COLORS ?? 32);
const ORIG = !!process.env.ORIG; // 元のまま版: ポリゴンも色も減らさない
const NAME = ORIG ? 'Anomalocaris_original' : 'Anomalocaris_PS1';
doc.name = NAME;

// 複眼の殻: 胴体の UV の島（左右）を選んで分離 → 50%
const body = doc.objects.find((o) => o.name === 'anomalogaris001')!;
const pip = (p: number[], poly: number[][]) => { let r = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) r = !r; } return r; };
const sel = emptySelection('face');
for (const pt of [[0.13, 0.245], [0.375, 0.245]]) {
  const one = emptySelection('face');
  one.faces.add(body.faces.findIndex((f) => pip(pt, f.uv)));
  selectLinkedUV(body, one);
  for (const fi of one.faces) sel.faces.add(fi);
}
const shell = separateSelection(doc, body, sel)!;
shell.name = 'eye_shell';
shell.opacity = 0.5;
console.log('殻', shell.faces.length, '面');

// 頭の横に浮いている口器の複製（tooth001/002）は使わないので消す
doc.objects = doc.objects.filter((o) => o.name !== 'tooth001' && o.name !== 'tooth002');
console.log('減らす前', doc.objects.map((o) => `${o.name}:${triCount(o)}`).join(' '));
const bbox = (o: typeof body) => { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (const f of o.faces) for (const vi of f.v) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], o.verts[vi][k]); mx[k] = Math.max(mx[k], o.verts[vi][k]); } return mx.map((v, k) => +(v - mn[k]).toFixed(3)); };
const eyes = ['eye_shell', 'L_pupil', 'R_pupil'];
for (const n of eyes) console.log('形(前)', n, bbox(doc.objects.find((o) => o.name === n)!));
// 鰭と尾鰭を胴体の断面の真ん中の高さへ（ボーンとアニメのキーも一緒に）。尾鰭は重なりを保つため同じ量で
const docBefore = structuredClone(doc);
const chk = ['fin', 'tail', 'headfin'].map((n) => doc.objects.find((o) => o.name === n)!);
const chkBefore = chk.map((o) => o.verts.map((p) => [...p] as [number, number, number]));
console.log(alignFins(doc, ['fin', 'tail'], 'anomalogaris001', true, ['tail']).join('\n'));
console.log('重なり順の入れ替わり（鰭・尾鰭・頭の鰭）', stackingFlips(chk, chkBefore), '鰭と尾鰭だけ', stackingFlips(chk.slice(0, 2), chkBefore.slice(0, 2)), '鰭だけ', stackingFlips(chk.slice(0, 1), chkBefore.slice(0, 1)));
{ // 再生中も基準姿勢と同じだけ下がっているか（鰭・尾鰭）
  let worst = 0;
  for (const n of ['fin', 'tail']) {
    const a = docBefore.objects.find((o) => o.name === n)!, b = doc.objects.find((o) => o.name === n)!;
    for (let fr = 0; fr <= doc.clips[0].length; fr += 37) {
      const pa = skinnedPositions(docBefore, a, samplePose(docBefore, docBefore.clips[0], fr));
      const pb = skinnedPositions(doc, b, samplePose(doc, doc.clips[0], fr));
      for (let i = 0; i < a.verts.length; i += 5) {
        const rest = Math.abs(b.verts[i][1] - a.verts[i][1]);
        const anim = Math.hypot(pb[i][0] - pa[i][0], pb[i][1] - pa[i][1], pb[i][2] - pa[i][2]);
        worst = Math.max(worst, Math.abs(anim - rest));
      }
    }
  }
  console.log('再生中の移動量と基準姿勢の移動量の差 最大', worst.toFixed(3));
}
// 偽瞳孔: 殻の中心へ・殻の縦横奥行きの 50%
console.log(fitPupils(doc, 0.5).join('\n'));
console.log(eyeInfo(doc).join('\n'));
if (process.env.PROBE) process.exit(0);
// テクスチャ: 2000×2000 → 256×256・32色・ディザ・15bit
const raw = new Uint8ClampedArray(readFileSync(texPath));
let img = { w: 2000, h: 2000, data: raw };
if (!ORIG) { img = resizeBox(img, TEX, TEX); img = to15bit(quantize(img, COLORS, true).img); }
const tex = newTexture(doc, ORIG ? 'anomalocaris' : 'anomalocaris_ps1', img.w, img.h);
tex.data = new Uint8ClampedArray(img.data);
for (const o of doc.objects) assignTexture(o, 0); // FBX の材質の灰色(0.3)を外す
doc.palette = [...new Set([...usedColors(img, Math.min(COLORS, 48)), ...doc.palette])].slice(0, 48);
console.log('テクスチャ', img.w, img.h, usedColors(img, 999).length, '色');

if (process.env.FULL) { writeFileSync(`${outDir}/full.glb`, await exportGLB(doc, { flat: true, animations: false })); process.exit(0); }
// 目は別枠: 殻は左右で EYE_SHELL 三角形（片目あたり半分）、瞳はそのまま。継ぎ目を崩す設定は使わない
if (ORIG) {
  writeFileSync(`${outDir}/${NAME}.kpoly`, serialize(doc));
  writeFileSync(`${outDir}/${NAME}.glb`, await exportGLB(doc, { flat: false, smoothTex: true, animations: true }));
  console.log('元のまま 三角形', doc.objects.map((o) => `${o.name}:${triCount(o)}`).join(' '));
  process.exit(0);
}
const EYE_SHELL = Number(process.env.EYE_SHELL ?? 240);
await simplifyObject(doc.objects.find((o) => o.name === 'eye_shell')!, EYE_SHELL, { permissive: false });
for (const n of eyes) console.log('形(後)', n, bbox(doc.objects.find((o) => o.name === n)!), triCount(doc.objects.find((o) => o.name === n)!));
const eyeTris = doc.objects.filter((o) => eyes.includes(o.name)).reduce((t, o) => t + triCount(o), 0);
const rest = doc.objects.map((o, i) => (eyes.includes(o.name) ? -1 : i)).filter((i) => i >= 0);
// ポリゴンを減らす（目以外で残りの予算を分ける）
const r = await simplifyDoc(doc, TRIS - eyeTris, rest);
console.log('三角形', r.before, '→', r.after, doc.objects.map((o) => `${o.name}:${triCount(o)}`).join(' '));

writeFileSync(`${outDir}/Anomalocaris_PS1.kpoly`, serialize(doc));
writeFileSync(`${outDir}/Anomalocaris_PS1.glb`, await exportGLB(doc, { flat: true, animations: true }));
writeFileSync(`${outDir}/Anomalocaris_PS1_texture.png`, await encodePNG(img.w, img.h, img.data));
console.log('書き出し完了');
