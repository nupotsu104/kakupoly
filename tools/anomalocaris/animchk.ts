import { readFileSync } from 'node:fs';
import { deserialize } from '../../src/io/project';
import { samplePose, skinnedPositions } from '../../src/core/skeleton';
for (const f of process.argv.slice(2)) {
  const doc = deserialize(readFileSync(f, 'utf8'));
  const clip = doc.clips[0];
  const get = (n: string) => doc.objects.find((o) => o.name === n)!;
  const ctr = (ps: number[][]) => [0, 1, 2].map((k) => (Math.min(...ps.map((p) => p[k])) + Math.max(...ps.map((p) => p[k]))) / 2);
  let worst = 0, finWorst = 0;
  for (let fr = 0; fr <= clip.length; fr += Math.max(1, Math.floor(clip.length / 40))) {
    const pose = samplePose(doc, clip, fr);
    const shell = skinnedPositions(doc, get('eye_shell'), pose);
    for (const [n, side] of [['L_pupil', 1], ['R_pupil', -1]] as const) {
      const sc = ctr(shell.filter((_, i) => get('eye_shell').verts[i][0] * side > 0));
      const pc = ctr(skinnedPositions(doc, get(n), pose));
      worst = Math.max(worst, Math.hypot(sc[0] - pc[0], sc[1] - pc[1], sc[2] - pc[2]));
    }
    // 鰭の付け根（|x| が最小の頂点）と胴体の距離（最も近い胴の頂点まで）
    const fin = skinnedPositions(doc, get('fin'), pose), body = skinnedPositions(doc, get('anomalogaris001'), pose);
    const restFin = get('fin').verts;
    const minAx = Math.min(...restFin.map((p) => Math.abs(p[0])));
    for (let i = 0; i < fin.length; i += 7) if (Math.abs(restFin[i][0]) < minAx + 1.5) {
      let d = 1e9; for (const b of body) d = Math.min(d, Math.hypot(b[0] - fin[i][0], b[1] - fin[i][1], b[2] - fin[i][2]));
      finWorst = Math.max(finWorst, d);
    }
  }
  console.log(f.split('/').pop(), `フレーム数 ${clip.length}`, `瞳と殻の中心のずれ 最大 ${worst.toFixed(3)}`, `鰭の付け根から胴までの距離 最大 ${finWorst.toFixed(2)}`);
}
