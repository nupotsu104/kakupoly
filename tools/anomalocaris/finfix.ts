// 鰭・尾鰭を胴体の断面の真ん中の高さへ移す（ボーンとアニメのキーも一緒に）
import type { Doc, MeshObj, V3 } from '../../src/core/types';
import { restWorld } from '../../src/core/skeleton';
import { mDir, mInvert, mIdent } from '../../src/core/vec';

export function components(o: MeshObj): number[][] {
  const par = o.verts.map((_, i) => i);
  const f = (i: number): number => (par[i] === i ? i : (par[i] = f(par[i])));
  for (const fc of o.faces) for (let k = 1; k < fc.v.length; k++) par[f(fc.v[k])] = f(fc.v[0]);
  const m = new Map<number, Set<number>>();
  for (const fc of o.faces) for (const v of fc.v) { const r = f(v); if (!m.has(r)) m.set(r, new Set()); m.get(r)!.add(v); }
  return [...m.values()].map((s) => [...s]);
}

/** 胴体の z 付近の断面: 上端・下端・左右の幅 */
function slice(body: MeshObj, z0: number, z1: number) {
  let lo = 1e9, hi = -1e9, w = 0;
  for (const p of body.verts) if (p[2] >= z0 && p[2] <= z1) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); w = Math.max(w, Math.abs(p[0])); }
  return { lo, hi, mid: (lo + hi) / 2, w };
}

export function alignFins(doc: Doc, names: string[], bodyName: string, apply: boolean, sameDelta: string[] = []) {
  const body = doc.objects.find((o) => o.name === bodyName)!;
  const trunk = { ...body, verts: body.verts.filter((p) => p[1] > -3 || p[2] < 14) }; // 大付属肢（前の下向き）を除く
  const bodyBones = new Set<number>();
  for (const s of body.skin) for (const [b, w] of s) if (w > 0.01) bodyBones.add(b);
  const report: string[] = [];
  // 各鰭の付け根: 前後位置 z と、胴の断面の真ん中までの差
  const ctrl: [number, number][] = [];
  for (const name of names) {
    const o = doc.objects.find((x) => x.name === name)!;
    const plan: [number, number][] = [];
    for (const c of components(o)) {
      const ps = c.map((i) => o.verts[i]);
      const ax = ps.map((p) => Math.abs(p[0]));
      const minAx = Math.min(...ax);
      const root = ps.filter((p, k) => ax[k] <= minAx + 0.6);
      const rz0 = Math.min(...root.map((p) => p[2])), rz1 = Math.max(...root.map((p) => p[2]));
      const rootY = root.reduce((t, p) => t + p[1], 0) / root.length;
      const s = slice(trunk as MeshObj, rz0 - 0.3, rz1 + 0.3);
      const d = s.mid - rootY;
      const cx = ps.reduce((t, p) => t + p[0], 0) / ps.length;
      report.push(`${name} x${cx.toFixed(1)} z${((rz0 + rz1) / 2).toFixed(1)}: 付け根y ${rootY.toFixed(2)} 胴 ${s.lo.toFixed(2)}〜${s.hi.toFixed(2)} 中央 ${s.mid.toFixed(2)} → ${d >= 0 ? '+' : ''}${d.toFixed(2)}`);
      if (cx >= -0.5) plan.push([(rz0 + rz1) / 2, d]); // 左右対称なので片側(+中央)だけ使う
    }
    if (sameDelta.includes(name)) {
      const m = plan.reduce((t, x) => t + x[1], 0) / plan.length;
      const zs = names.map((n) => doc.objects.find((x) => x.name === n)!).filter((x) => x.name === name).flatMap((x) => x.verts.map((p) => p[2]));
      // その部品の前端から後ろは全部同じ量
      ctrl.push([Math.max(...zs), m], [Math.min(...zs) - 1, m]);
      report.push(`${name}: 全部 ${m.toFixed(2)} で揃える`);
    } else ctrl.push(...plan);
  }
  // 同じ z に複数あれば平均
  const byZ = new Map<number, number[]>();
  for (const [z, d] of ctrl) { const k = Math.round(z * 100) / 100; byZ.set(k, [...(byZ.get(k) ?? []), d]); }
  const pts = [...byZ.entries()].map(([z, ds]) => [z, ds.reduce((t, x) => t + x, 0) / ds.length]).sort((x, y) => x[0] - y[0]);
  const field = (z: number): number => {
    if (z <= pts[0][0]) return pts[0][1];
    if (z >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) if (z <= pts[i][0]) { const t = (z - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); return pts[i - 1][1] * (1 - t) + pts[i][1] * t; }
    return 0;
  };
  report.push('移動量(z→y): ' + pts.map(([z, d]) => `${z.toFixed(1)}→${d.toFixed(2)}`).join(' '));
  if (!apply) return report;
  const finBones = new Set<number>();
  for (const name of names) {
    const o = doc.objects.find((x) => x.name === name)!;
    o.verts = o.verts.map((p) => [p[0], p[1] + field(p[2]), p[2]] as V3);
    for (const sk of o.skin) for (const [b, w] of sk) if (w > 0.01 && !bodyBones.has(b)) finBones.add(b);
  }
  // ボーン: 鰭だけに使われるボーンを、その位置の移動量だけ下げる。親との差分を親の座標系に直してローカル位置とキーに足す
  const rw = restWorld(doc.bones);
  const dw = doc.bones.map((_, i) => (finBones.has(i) ? field(rw[i][14]) : 0));
  let moved = 0;
  doc.bones.forEach((b, i) => {
    const diff = dw[i] - (b.parent >= 0 ? dw[b.parent] : 0);
    if (Math.abs(diff) < 1e-6) return;
    const local = mDir(mInvert(b.parent >= 0 ? rw[b.parent] : mIdent()), [0, diff, 0]) as V3;
    b.pos = [b.pos[0] + local[0], b.pos[1] + local[1], b.pos[2] + local[2]];
    for (const cl of doc.clips) for (const tr of cl.tracks) if (tr.bone === i) for (const k of tr.keys) k.pos = [k.pos[0] + local[0], k.pos[1] + local[1], k.pos[2] + local[2]];
    moved++;
  });
  report.push(`動かしたボーン ${moved}本（鰭用 ${finBones.size}本）`);
  return report;
}

export function bodyComps(doc: Doc, bodyName: string): string[] {
  const o = doc.objects.find((x) => x.name === bodyName)!;
  return components(o).sort((a, b) => b.length - a.length).map((c) => {
    const ps = c.map((i) => o.verts[i]);
    const r = (k: number) => `${Math.min(...ps.map((p) => p[k])).toFixed(1)}〜${Math.max(...ps.map((p) => p[k])).toFixed(1)}`;
    return `${c.length}頂点 x ${r(0)} y ${r(1)} z ${r(2)}`;
  });
}

export function sectionProfile(doc: Doc, bodyName: string, z: number): string {
  const o = doc.objects.find((x) => x.name === bodyName)!;
  const bins = new Map<number, [number, number]>();
  for (const p of o.verts) if (Math.abs(p[2] - z) < 0.3) { const b = Math.round(p[0]); const e = bins.get(b) ?? [1e9, -1e9]; e[0] = Math.min(e[0], p[1]); e[1] = Math.max(e[1], p[1]); bins.set(b, e); }
  return `z=${z}: ` + [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([x, [lo, hi]]) => `x${x}:${lo.toFixed(1)}〜${hi.toFixed(1)}`).join(' ');
}

export function eyeInfo(doc: Doc): string[] {
  const shell = doc.objects.find((x) => x.name === 'eye_shell')!;
  const out: string[] = [];
  const bb = (ps: V3[]) => { const mn = [0, 1, 2].map((k) => Math.min(...ps.map((p) => p[k]))), mx = [0, 1, 2].map((k) => Math.max(...ps.map((p) => p[k]))); return { size: mx.map((v, k) => +(v - mn[k]).toFixed(3)), c: mx.map((v, k) => +((v + mn[k]) / 2).toFixed(3)) }; };
  for (const side of [1, -1]) {
    const ps = [...new Set(shell.faces.flatMap((f) => f.v))].map((i) => shell.verts[i]).filter((p) => p[0] * side > 0);
    out.push(`殻 ${side > 0 ? '+x' : '-x'} ${JSON.stringify(bb(ps))} 骨 ${[...new Set([...new Set(shell.faces.flatMap((f) => f.v))].filter((i) => shell.verts[i][0] * side > 0).flatMap((i) => shell.skin[i].map(([b]) => doc.bones[b].name)))].join(',')}`);
  }
  for (const n of ['L_pupil', 'R_pupil']) { const o = doc.objects.find((x) => x.name === n)!; out.push(`${n} ${JSON.stringify(bb(o.verts))} 骨 ${[...new Set(o.skin.flatMap((s) => s.map(([b]) => doc.bones[b].name)))]}`); }
  return out;
}

/** 重なった鰭どうしの上下の順番が入れ替わった所を数える */
export function stackingFlips(objs: MeshObj[], befores: V3[][]): string {
  const o = { verts: objs.flatMap((x) => x.verts) } as MeshObj; const before = befores.flat(); let off = 0;
  const cs = objs.flatMap((x) => { const r = components(x).map((c) => c.map((i) => i + off)); off += x.verts.length; return r; });
  const yAt = (vs: V3[], c: number[], x: number, z: number) => { let t = 0, n = 0; for (const i of c) { const p = vs[i]; if (Math.hypot(p[0] - x, p[2] - z) < 0.35) { t += p[1]; n++; } } return n ? t / n : null; };
  let flips = 0, tested = 0;
  for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
    for (const i of cs[a]) {
      const p = before[i];
      const ya0 = yAt(before, cs[a], p[0], p[2]), yb0 = yAt(before, cs[b], p[0], p[2]);
      if (ya0 === null || yb0 === null || Math.abs(ya0 - yb0) < 0.03) continue;
      const ya1 = yAt(o.verts, cs[a], p[0], p[2])!, yb1 = yAt(o.verts, cs[b], p[0], p[2])!;
      tested++;
      if (Math.sign(ya0 - yb0) !== Math.sign(ya1 - yb1)) flips++;
    }
  }
  return `${flips}/${tested}`;
}

/** 瞳を殻（片目）の中心に置き、大きさを殻の ratio 倍にする */
export function fitPupils(doc: Doc, ratio: number): string[] {
  const shell = doc.objects.find((x) => x.name === 'eye_shell')!;
  const used = [...new Set(shell.faces.flatMap((f) => f.v))];
  const out: string[] = [];
  for (const [n, side] of [['L_pupil', 1], ['R_pupil', -1]] as const) {
    const ps = used.map((i) => shell.verts[i]).filter((p) => p[0] * side > 0);
    const smn = [0, 1, 2].map((k) => Math.min(...ps.map((p) => p[k]))), smx = [0, 1, 2].map((k) => Math.max(...ps.map((p) => p[k])));
    const sc = smx.map((v, k) => (v + smn[k]) / 2), ss = smx.map((v, k) => v - smn[k]);
    const o = doc.objects.find((x) => x.name === n)!;
    const pmn = [0, 1, 2].map((k) => Math.min(...o.verts.map((p) => p[k]))), pmx = [0, 1, 2].map((k) => Math.max(...o.verts.map((p) => p[k])));
    const pc = pmx.map((v, k) => (v + pmn[k]) / 2), psz = pmx.map((v, k) => v - pmn[k]);
    const f = ss.map((v, k) => (v * ratio) / psz[k]);
    o.verts = o.verts.map((p) => p.map((v, k) => sc[k] + (v - pc[k]) * f[k]) as V3);
    // 瞳のボーンの基準姿勢も同じだけずらす（アニメのキーは変えないので、再生中の位置は元のまま正しい）
    const bones = [...new Set(o.skin.flatMap((sk) => sk.map(([b]) => b)))];
    for (const bi of bones) {
      const users = boneUsers(doc, bi);
      if (users.length !== 1) throw new Error(`${doc.bones[bi].name} は ${users.join(',')} でも使われている`);
      shiftBoneRest(doc, bi, [sc[0] - pc[0], sc[1] - pc[1], sc[2] - pc[2]]);
    }
    out.push(`${n}: 中心 ${pc.map((v) => v.toFixed(2))} → ${sc.map((v) => v.toFixed(2))}, 大きさ ${psz.map((v) => v.toFixed(2))} → ${ss.map((v) => (v * ratio).toFixed(2))}`);
  }
  return out;
}

/** ボーンの基準姿勢（rest）だけをワールドで delta ずらす。子のワールド位置と、アニメのキーはそのまま */
export function shiftBoneRest(doc: Doc, i: number, delta: V3): void {
  const rw = restWorld(doc.bones);
  const b = doc.bones[i];
  const inv = mInvert(b.parent >= 0 ? rw[b.parent] : mIdent());
  const l = mDir(inv, delta);
  b.pos = [b.pos[0] + l[0], b.pos[1] + l[1], b.pos[2] + l[2]];
  // 子: 親が delta 動いた分を打ち消す（子のワールドは変えない）
  const back = mDir(mInvert(rw[i]), delta);
  doc.bones.forEach((c) => { if (c.parent === i) c.pos = [c.pos[0] - back[0], c.pos[1] - back[1], c.pos[2] - back[2]]; });
}

export function boneUsers(doc: Doc, bi: number): string[] {
  return doc.objects.filter((o) => o.skin.some((s) => s.some(([b, w]) => b === bi && w > 0))).map((o) => o.name);
}
