import { readFileSync } from 'node:fs';
import { deserialize } from '../../src/io/project';
import { samplePose, skinnedPositions } from '../../src/core/skeleton';
// 鰭の付け根の頂点から胴の「面」までの距離（点と三角形の距離）
const ptTri = (p: number[], a: number[], b: number[], c: number[]) => {
  const sub = (x: number[], y: number[]) => x.map((v, i) => v - y[i]); const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return Math.hypot(...sub(p, a.map((x, i) => x + ab[i] * v))); }
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return Math.hypot(...sub(p, a.map((x, i) => x + ac[i] * w))); }
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return Math.hypot(...sub(p, b.map((x, i) => x + (c[i] - b[i]) * w))); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; return Math.hypot(...sub(p, a.map((x, i) => x + ab[i] * v + ac[i] * w)));
};
for (const f of process.argv.slice(2)) {
  const doc = deserialize(readFileSync(f, 'utf8'));
  const get = (n: string) => doc.objects.find((o) => o.name === n)!;
  const fin = get('fin'), body = get('anomalogaris001');
  const restFin = fin.verts, minAx = Math.min(...restFin.map((p) => Math.abs(p[0])));
  const out: string[] = [];
  for (const fr of (process.env.FR ?? "-1,0,200,400,600").split(",").map(Number)) {
    const pose = fr < 0 ? null : samplePose(doc, doc.clips[0], fr);
    const fp = pose ? skinnedPositions(doc, fin, pose) : fin.verts, bp = pose ? skinnedPositions(doc, body, pose) : body.verts;
    const tris = body.faces.flatMap((fc) => fc.v.slice(1, -1).map((_, k) => [bp[fc.v[0]], bp[fc.v[k + 1]], bp[fc.v[k + 2]]]));
    let worst = 0;
    for (let i = 0; i < fp.length; i++) if (Math.abs(restFin[i][0]) < minAx + 0.6) { let d = 1e9; for (const t of tris) d = Math.min(d, ptTri(fp[i], t[0], t[1], t[2])); worst = Math.max(worst, d); }
    out.push(`${fr < 0 ? '基準' : 'f' + fr}:${worst.toFixed(2)}`);
  }
  console.log(f.split('/').pop(), f.includes('prev') ? '(前の版)' : '(新)', '付け根→胴の面 最大距離', out.join(' '));
}
