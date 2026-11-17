// ダイアログ: 画像のPS1化取り込み / テクスチャの大きさ / ファイル / キー割り当て / 使い方
import type { Texture } from '../core/types';
import { state, notify, checkpoint, setDoc, activeObject, currentPose, changeCounter } from '../state';
import { actions, ctx as actx } from '../actions';
import { h, button, modal, select, checkbox, numberInput, pickFile, downloadBlob, toast, clear } from './dom';
import { quantize, resizeBox, resizeNearest, to15bit, usedColors, type Img } from '../core/quantize';
import { newDoc, newTexture, assignTexture } from '../core/doc';
import { resizeTexture } from '../core/paint';
import { loadImageFile, importFiles, DEFAULT_IMPORT, type ImportOptions } from '../io/import';
import { inspectModelFile } from '../io/inspect';
import { checkForUpdate, versionLabel } from '../update';
import { simplifyDoc, triCount } from '../core/simplify';
import { exportGLB, exportOBJ } from '../io/gltf-export';
import { encodePNG } from '../io/png';
import { serialize, deserialize, storage, requestPersistence, packDoc, unpackDoc, storageEstimate } from '../io/project';
import { sampleDoc } from '../core/sample';
import { skinnedPositions } from '../core/skeleton';
import { bindings, setBindings, resetBindings, prettyCombo, learnNextKey, TOURBOX_PRESET, pencilSettings, savePencil, type Binding } from '../input/keymap';

// ---------------- 画像 → PS1風テクスチャ ----------------
export async function openImageImport(target?: Texture): Promise<void> {
  const [file] = await pickFile('image/*');
  if (!file) return;
  let src: Img;
  try {
    src = await loadImageFile(file);
  } catch {
    return toast('画像を読み込めませんでした');
  }
  const MAX_ORIGINAL = 4096; // 元の大きさのまま使う時の上限（iPad のメモリのため）
  const objs = state.doc.objects;
  const opt = {
    size: Math.min(128, nearestPow2(Math.max(src.w, src.h))), // 0 = 元の大きさ
    colors: 16,
    dither: true,
    bit15: true,
    crop: true,
    allParts: objs.length > 1 && objs.every((o) => o.tex < 0),
  };
  const preview = h('canvas', { class: 'qpreview' });
  const info = h('p', { class: 'hint' });
  let result: Img | null = null;
  const compute = () => {
    let img: Img;
    if (opt.size === 0) {
      // 元の大きさ（大きすぎる時だけ縮める）
      const k = Math.min(1, MAX_ORIGINAL / Math.max(src.w, src.h));
      img = k < 1 ? resizeBox(src, Math.round(src.w * k), Math.round(src.h * k)) : { w: src.w, h: src.h, data: new Uint8ClampedArray(src.data) };
    } else {
      // 縦横比を保ったまま、長辺を指定サイズに（短辺も2のべき乗にそろえる）
      const s = opt.size / Math.max(src.w, src.h);
      let w = opt.size,
        hh = opt.size;
      if (!opt.crop) {
        w = Math.max(8, nearestPow2(Math.round(src.w * s)));
        hh = Math.max(8, nearestPow2(Math.round(src.h * s)));
      }
      img = resizeBox(src, w, hh);
    }
    if (opt.colors > 0) img = quantize(img, opt.colors, opt.dither).img;
    if (opt.bit15) img = to15bit(img);
    result = img;
    preview.width = img.w;
    preview.height = img.h;
    preview.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
    const colors = img.w * img.h <= 512 * 512 ? `・${usedColors(img, 999).length}色` : '';
    info.textContent = `${img.w}×${img.h}${colors}`;
  };
  const form = h('div', { class: 'form' });
  const drawForm = () => {
    clear(form);
    form.append(
      h(
        'div',
        { class: 'seg' },
        button('PS1風にする', () => (Object.assign(opt, { size: 128, colors: 16, dither: true, bit15: true, crop: true }), drawForm(), compute()), {
          active: opt.size > 0 && opt.colors > 0,
        }),
        button('元のまま', () => (Object.assign(opt, { size: 0, colors: 0, dither: false, bit15: false, crop: false }), drawForm(), compute()), {
          active: opt.size === 0 && opt.colors === 0 && !opt.bit15,
        }),
      ),
      h(
        'label',
        {},
        '大きさ',
        select(String(opt.size), [['32', '32'], ['64', '64'], ['128', '128'], ['256', '256（PS1の上限）'], ['512', '512'], ['0', `元の大きさ（${src.w}×${src.h}）`]], (v) => ((opt.size = Number(v)), compute())),
      ),
      h(
        'label',
        {},
        '色数',
        select(String(opt.colors), [['4', '4色'], ['16', '16色（4bit・PS1で一般的）'], ['32', '32色'], ['64', '64色'], ['256', '256色（8bit）'], ['0', '減色しない']], (v) => ((opt.colors = Number(v)), compute())),
      ),
      checkbox('ディザ（網点）', opt.dither, (v) => ((opt.dither = v), compute())),
      checkbox('15bitカラーに丸める', opt.bit15, (v) => ((opt.bit15 = v), compute()), 'PS1の色は各色5bit（計32768色）'),
      checkbox('正方形にする', opt.crop, (v) => ((opt.crop = v), compute())),
    );
    if (objs.length > 1) form.append(checkbox(`全部のパーツ（${objs.length}個）に貼る`, opt.allParts, (v) => (opt.allParts = v), '1枚の画像を全パーツで共有するモデル向け'));
  };
  drawForm();
  const body = h(
    'div',
    { class: 'qdialog' },
    h('div', { class: 'qprev-wrap' }, preview),
    info,
    form,
    h(
      'div',
      { class: 'actions' },
      button(
        target ? 'このテクスチャを置き換え' : '新しいテクスチャとして追加',
        () => {
          if (!result) return;
          checkpoint();
          let t = target;
          if (!t) {
            t = newTexture(state.doc, file.name.replace(/\.[^.]+$/, '').slice(0, 24), result.w, result.h);
            state.activeTex = state.doc.textures.length - 1;
            const o = activeObject();
            if (o && o.tex < 0) assignTexture(o, state.activeTex);
          }
          t.w = result.w;
          t.h = result.h;
          t.data = new Uint8ClampedArray(result.data);
          const ti = state.doc.textures.indexOf(t);
          if (opt.allParts) for (const o of state.doc.objects) assignTexture(o, ti);
          // 使った色をパレットの先頭に（大きな画像は数えるのに時間がかかるので小さく縮めてから）
          const small = result.w * result.h > 256 * 256 ? resizeNearest(result, 128, 128) : result;
          state.doc.palette = [...new Set([...usedColors(small, 32), ...state.doc.palette])].slice(0, 48);
          notify('doc', 'tex', 'ui');
          m.close();
        },
        { cls: 'primary' },
      ),
    ),
  );
  const m = modal('画像をテクスチャにする', body);
  compute();
}

const nearestPow2 = (n: number) => Math.pow(2, Math.max(3, Math.min(8, Math.round(Math.log2(Math.max(1, n))))));

export function openTextureResize(t: Texture): void {
  let w = t.w,
    hh = t.h;
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'hint' }, `いまの大きさ: ${t.w}×${t.h}。UVは0〜1の割合なので、大きさを変えても貼り方は保たれます。`),
    h('label', {}, '幅', select(String(w), [8, 16, 32, 64, 128, 256].map((n): [string, string] => [String(n), String(n)]), (v) => (w = Number(v)))),
    h('label', {}, '高さ', select(String(hh), [8, 16, 32, 64, 128, 256].map((n): [string, string] => [String(n), String(n)]), (v) => (hh = Number(v)))),
    h(
      'div',
      { class: 'actions' },
      button(
        '変更',
        () => {
          checkpoint();
          resizeTexture(t, w, hh);
          notify('doc', 'tex', 'ui');
          m.close();
        },
        { cls: 'primary' },
      ),
    ),
  );
  const m = modal('テクスチャの大きさ', body);
}

// ---------------- ファイル ----------------
let currentId: string | null = null;
let savedCounter = -1;
export const isDirty = (): boolean => changeCounter() !== savedCounter;

let autosaveFailShown = false;
export async function saveToLibrary(silent = false, thumb?: string): Promise<boolean> {
  currentId ??= `p${Date.now().toString(36)}`;
  let size = 0;
  try {
    const data = await packDoc(state.doc);
    size = data.byteLength;
    await storage.put({ id: currentId, name: state.doc.name, updated: Date.now(), thumb, data, size });
    savedCounter = changeCounter();
    if (!silent) toast(`この端末に保存しました（${mb(size)}）`);
    return true;
  } catch (e) {
    // 失敗は消える通知ではなく、消えない画面で知らせる（自動保存の失敗は1回だけ）
    if (silent && autosaveFailShown) return false;
    if (silent) autosaveFailShown = true;
    const est = await storageEstimate();
    const err = e as Error;
    modal(
      '保存できませんでした',
      h(
        'div',
        {},
        h('p', {}, silent ? '自動保存に失敗しました。このままアプリを閉じると、最近の変更が失われます。' : '端末内への保存に失敗しました。'),
        h('pre', { class: 'errreport' }, [`エラー: ${err?.name ?? ''} ${err?.message ?? String(e)}`, `作品の大きさ（圧縮後）: ${size ? mb(size) : '不明'}`, est ? `保存領域: ${mb(est.usage)} 使用 / 上限 ${mb(est.quota)}` : '保存領域: 不明'].join('\n')),
        h('p', { class: 'hint' }, '作品を失わないよう、「ファイル」→「.kpoly を書き出す」で「ファイル」アプリに保存してください。この画面のスクリーンショットを送ってもらえれば原因を調べます。'),
        h('div', { class: 'actions' }, button('.kpoly を書き出す', () => downloadBlob(new Blob([serialize(state.doc)], { type: 'application/json' }), `${safe(state.doc.name)}.kpoly`), { cls: 'primary' })),
      ),
    );
    return false;
  }
}

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

export async function openLatestFromLibrary(): Promise<boolean> {
  try {
    const list = await storage.list();
    if (!list.length) return false;
    const p = await storage.get(list[0].id);
    if (!p?.data) return false;
    setDoc(await unpackDoc(p.data));
    currentId = p.id;
    savedCounter = changeCounter();
    return true;
  } catch {
    return false;
  }
}

export function openFileMenu(snapshot: () => string): void {
  const body = h('div', { class: 'filemenu' });
  const m = modal('ファイル', body, { wide: true });
  const name = h('input', { class: 'txt', value: state.doc.name });
  name.addEventListener('change', () => {
    state.doc.name = name.value || '無題';
    notify('ui');
  });
  const lib = h('div', { class: 'library' }, h('p', { class: 'hint' }, '読み込み中…'));
  body.append(
    // よく使う操作は一番上に大きく（下の方はスクロールしないと見えないことがあるため）
    h(
      'div',
      { class: 'bigbtns' },
      button('📂 モデルを読み込む（.glb .obj .fbx）', () => doImport(false, m.close), { cls: 'primary big' }),
      button('📄 .kpoly を開く', () => openKpoly(m.close), { cls: 'big' }),
      button('💾 この端末に保存', () => saveToLibrary(false, snapshot()).then(refresh), { cls: 'big' }),
    ),
    h('div', { class: 'prow' }, h('span', { class: 'lbl' }, '作品名'), name),
    h('div', { class: 'prow' }, h('span', { class: 'lbl' }, `アプリの版: ${versionLabel()}`), button('更新を確認', () => checkForUpdate(true))),
    h(
      'div',
      { class: 'cols' },
      h(
        'div',
        {},
        h('h3', {}, '保存・開く'),
        h(
          'div',
          { class: 'pgrid' },
          button('この端末に保存', () => saveToLibrary(false, snapshot()).then(refresh), { cls: 'primary' }),
          button('別名で保存', () => {
            currentId = null;
            state.doc.name = `${state.doc.name}のコピー`;
            saveToLibrary(false, snapshot()).then(refresh);
          }),
          button('.kpoly を書き出す', () => downloadBlob(new Blob([serialize(state.doc)], { type: 'application/json' }), `${safe(state.doc.name)}.kpoly`)),
          button('.kpoly を開く', () => openKpoly(m.close)),
          button('新規（空）', () => {
            if (isDirty() && !confirm('保存していない変更は失われます。新規にしますか？')) return;
            setDoc(newDoc());
            currentId = null;
            m.close();
          }),
          button('サンプルを開く', () => {
            if (isDirty() && !confirm('保存していない変更は失われます。サンプルを開きますか？')) return;
            setDoc(sampleDoc());
            currentId = null;
            m.close();
            actx.vp?.frame();
          }),
        ),
        h('h3', {}, '他のソフトのモデルを読み込む（下の青いボタンを押す）'),
        h('p', { class: 'hint' }, '.glb / .gltf / .obj / .fbx に対応。OBJ は .mtl と画像も一緒に選んでください。三角形は四角形にまとめ直し、大きい画像は縮めます。'),
        importOptionsForm(),
        h(
          'div',
          { class: 'pgrid' },
          button('読み込んで開く', () => doImport(false, m.close), { cls: 'primary' }),
          button('今の作品に追加', () => doImport(true, m.close)),
        ),
        h('h3', {}, '書き出す'),
        exportForm(),
      ),
      h('div', {}, h('h3', {}, 'この端末の作品'), lib),
    ),
  );
  async function refresh() {
    clear(lib);
    let list: Awaited<ReturnType<typeof storage.list>> = [];
    try {
      list = await storage.list();
    } catch {
      lib.append(h('p', { class: 'hint' }, '端末内の保存領域が使えません（プライベートブラウズ等）'));
      return;
    }
    const est = await storageEstimate();
    if (est) lib.append(h('p', { class: 'hint' }, `保存領域: ${mb(est.usage)} 使用 / 上限 ${mb(est.quota)}`));
    if (!list.length) lib.append(h('p', { class: 'hint' }, 'まだありません'));
    for (const p of list)
      lib.append(
        h(
          'div',
          { class: `libitem ${p.id === currentId ? 'active' : ''}` },
          p.thumb ? h('img', { src: p.thumb }) : h('div', { class: 'nothumb' }),
          h('div', { class: 'meta' }, h('b', {}, p.name), h('small', {}, `${new Date(p.updated).toLocaleString()}${p.size ? `・${mb(p.size)}` : ''}`)),
          button('開く', async () => {
            if (isDirty() && !confirm('保存していない変更は失われます。開きますか？')) return;
            const d = await storage.get(p.id);
            if (!d?.data) return toast('この作品の中身が見つかりませんでした');
            setDoc(await unpackDoc(d.data));
            currentId = p.id;
            savedCounter = changeCounter();
            m.close();
            actx.vp?.frame();
          }),
          button(
            '削除',
            async () => {
              if (!confirm(`「${p.name}」を削除しますか？`)) return;
              await storage.remove(p.id);
              if (currentId === p.id) currentId = null;
              refresh();
            },
            { cls: 'danger' },
          ),
        ),
      );
  }
  refresh();
}

/** 読み込めなかった理由を、消えない画面で詳しく出す（そのまま送ってもらえば原因が分かるように） */
async function showImportError(files: File[], e: unknown): Promise<void> {
  const err = e as Error;
  const lines = [`エラー: ${err?.message ?? String(e)}`];
  if (err?.stack) lines.push(...err.stack.split('\n').slice(0, 3).map((l) => `  ${l.trim()}`));
  for (const f of files) {
    lines.push('');
    lines.push(...(await inspectModelFile(f)));
  }
  lines.push('', `端末: ${navigator.userAgent}`);
  const text = lines.join('\n');
  const pre = h('pre', { class: 'errreport' }, text);
  const body = h(
    'div',
    {},
    h('p', {}, '読み込めませんでした。下の内容をそのまま（スクリーンショットか「コピー」で）送ってもらえれば、原因を調べられます。'),
    pre,
    h(
      'div',
      { class: 'actions' },
      button('コピー', async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('コピーしました');
        } catch {
          toast('コピーできませんでした。スクリーンショットを撮ってください');
        }
      }),
    ),
  );
  modal('読み込めませんでした', body, { wide: true });
}

/** ポリゴンを減らすダイアログ */
export function openSimplify(): void {
  const objs = state.doc.objects;
  const total = objs.reduce((t, o) => t + triCount(o), 0);
  const active = objs[state.activeObj];
  const opt = { target: Math.min(2000, Math.max(12, Math.round(total / 2))), scope: 'all' as 'all' | 'active' };
  const info = h('p', { class: 'hint' });
  const updateInfo = () => {
    const now = opt.scope === 'all' ? total : active ? triCount(active) : 0;
    info.textContent = `今: ${now.toLocaleString()} 三角形 → 目標: ${opt.target.toLocaleString()} 三角形（ボーンの割り当てとUVは残ります。取り消しで元に戻せます）`;
  };
  const body = h(
    'div',
    { class: 'form' },
    h('label', {}, '対象', select(opt.scope, [['all', `全部（${objs.length}個）`], ['active', `選択中のオブジェクト（${active?.name ?? 'なし'}）`]], (v) => ((opt.scope = v), updateInfo()))),
    h(
      'label',
      {},
      '目標の三角形数',
      select(
        String(opt.target),
        [...new Set([opt.target, 20000, 10000, 5000, 3000, 2000, 1000, 500, 300])]
          .filter((n) => n < total || n === opt.target)
          .sort((a, b) => b - a)
          .map((n): [string, string] => [String(n), n.toLocaleString()]),
        (v) => ((opt.target = Number(v)), updateInfo()),
      ),
    ),
    info,
    h('p', { class: 'hint' }, 'PS1風なら、キャラクター1体で 1,000〜2,000 くらいが目安です。元のまま残したい場合は、先に「ファイル」→「別名で保存」しておくと安心です。'),
    h(
      'div',
      { class: 'actions' },
      button(
        '減らす',
        async () => {
          checkpoint();
          toast('ポリゴンを減らしています…', 10000);
          const r = await simplifyDoc(state.doc, opt.target, opt.scope === 'active' ? [state.activeObj] : undefined);
          state.sel.verts.clear();
          state.sel.edges.clear();
          state.sel.faces.clear();
          notify('doc', 'sel', 'ui');
          toast(`${r.before.toLocaleString()} → ${r.after.toLocaleString()} 三角形にしました`, 4000);
          m.close();
        },
        { cls: 'primary' },
      ),
    ),
  );
  updateInfo();
  const m = modal('ポリゴンを減らす', body);
}

async function openKpoly(close: () => void): Promise<void> {
  const [f] = await pickFile('.kpoly,application/json');
  if (!f) return;
  try {
    setDoc(deserialize(await f.text()));
    currentId = null;
    close();
    actx.vp?.frame();
  } catch (e) {
    toast((e as Error).message);
  }
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_') || 'model';

const importOpts: ImportOptions = { ...DEFAULT_IMPORT };
function importOptionsForm(): HTMLElement {
  return h(
    'div',
    { class: 'form inline' },
    h(
      'label',
      {},
      'ポリゴン数',
      select(
        String(importOpts.targetTris),
        [
          ['0', 'そのまま（元のまま）'],
          ['20000', '2万三角形まで減らす'],
          ['5000', '5000まで減らす'],
          ['2000', '2000まで減らす（PS1風）'],
          ['1000', '1000まで減らす（PS1風・粗め）'],
        ],
        (v) => (importOpts.targetTris = Number(v)),
      ),
    ),
    checkbox('三角形→四角形', importOpts.quads, (v) => (importOpts.quads = v)),
    checkbox('重なった頂点を溶接', importOpts.weld, (v) => (importOpts.weld = v)),
    h('label', {}, '画像の最大', select(String(importOpts.maxTex), [['128', '128'], ['256', '256'], ['512', '512'], ['0', '縮めない']], (v) => (importOpts.maxTex = Number(v)))),
    h('label', {}, 'アニメ fps', select(String(importOpts.fps), [['12', '12'], ['15', '15'], ['24', '24'], ['30', '30']], (v) => (importOpts.fps = Number(v)))),
  );
}

async function doImport(append: boolean, close: () => void): Promise<void> {
  const files = await pickFile('.glb,.gltf,.obj,.mtl,.fbx,.bin,image/*', true);
  if (!files.length) return;
  toast('読み込み中…', 10000);
  try {
    const d = await importFiles(files, importOpts);
    if (append) {
      checkpoint();
      const doc = state.doc;
      const texBase = doc.textures.length;
      const boneBase = doc.bones.length;
      doc.textures.push(...d.textures);
      for (const b of d.bones) doc.bones.push({ ...b, parent: b.parent >= 0 ? b.parent + boneBase : -1 });
      for (const o of d.objects) {
        o.id = doc.nextId++;
        if (o.tex >= 0) o.tex += texBase;
        o.skin = o.skin.map((inf) => inf.map(([b, w]) => [b + boneBase, w] as [number, number]));
        doc.objects.push(o);
      }
      for (const c of d.clips) {
        for (const t of c.tracks) t.bone += boneBase;
        doc.clips.push(c);
      }
      notify('doc', 'ui', 'tex', 'pose');
    } else {
      setDoc(d);
      currentId = null;
    }
    close();
    actx.vp?.frame();
    const tris = d.objects.reduce((s, o) => s + o.faces.reduce((t, f) => t + f.v.length - 2, 0), 0);
    toast(`読み込みました: ${d.objects.length}個・${tris}三角形・ボーン${d.bones.length}本・アニメ${d.clips.length}個`, 4000);
    if (tris > 20000) setTimeout(() => toast('重いモデルです。PS1風にするなら、右パネルの「ポリゴンを減らす」で軽くできます', 6000), 4200);
  } catch (e) {
    console.error(e);
    document.getElementById('toast')?.classList.remove('show');
    await showImportError(files, e);
  }
}

function exportForm(): HTMLElement {
  const o = { scale: 1, flat: true, anim: true };
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'form inline' },
      checkbox('カクカク陰影（面ごとの法線）', o.flat, (v) => (o.flat = v)),
      checkbox('アニメも含める', o.anim, (v) => (o.anim = v)),
      h('label', {}, '倍率', numberInput(o.scale, (v) => (o.scale = v), { step: 0.01, width: '5em' })),
    ),
    h(
      'div',
      { class: 'pgrid' },
      button(
        'GLB（ボーン・アニメ込み）',
        async () => {
          const b = await exportGLB(state.doc, { scale: o.scale, flat: o.flat, animations: o.anim });
          downloadBlob(new Blob([b as BlobPart], { type: 'model/gltf-binary' }), `${safe(state.doc.name)}.glb`);
        },
        { cls: 'primary' },
      ),
      button('OBJ（今のポーズ）', async () => {
        const base = safe(state.doc.name);
        const pose = currentPose();
        const r = exportOBJ(state.doc, base, (ob) => skinnedPositions(state.doc, ob, pose).map((p) => p.map((v) => v * o.scale) as [number, number, number]));
        await downloadBlob(new Blob([r.obj], { type: 'text/plain' }), `${base}.obj`);
        await downloadBlob(new Blob([r.mtl], { type: 'text/plain' }), `${base}.mtl`);
        for (const t of state.doc.textures) await downloadBlob(new Blob([(await encodePNG(t.w, t.h, t.data)) as BlobPart], { type: 'image/png' }), `${base}_${t.name}.png`);
      }),
      button('テクスチャPNG', async () => {
        const t = state.doc.textures[state.activeTex];
        if (!t) return toast('テクスチャがありません');
        downloadBlob(new Blob([(await encodePNG(t.w, t.h, t.data)) as BlobPart], { type: 'image/png' }), `${safe(t.name)}.png`);
      }),
      button('テクスチャPNG（4倍・ドット拡大）', async () => {
        const t = state.doc.textures[state.activeTex];
        if (!t) return toast('テクスチャがありません');
        const big = resizeNearest(t, t.w * 4, t.h * 4);
        downloadBlob(new Blob([(await encodePNG(big.w, big.h, big.data)) as BlobPart], { type: 'image/png' }), `${safe(t.name)}_x4.png`);
      }),
    ),
  );
}

// ---------------- キー割り当て・Apple Pencil ----------------
export function openSettings(): void {
  const body = h('div', { class: 'settings' });
  const m = modal('キー割り当て・TourBox・Apple Pencil', body, { wide: true });
  let filter = '';
  const list = h('div', { class: 'keylist' });
  const draw = () => {
    clear(list);
    const groups = new Map<string, string[]>();
    for (const a of actions.values()) {
      if (filter && !a.label.includes(filter) && !a.id.includes(filter)) continue;
      const g = groups.get(a.group) ?? [];
      g.push(a.id);
      groups.set(a.group, g);
    }
    for (const [g, ids] of groups) {
      list.append(h('h4', {}, g));
      for (const id of ids) {
        const a = actions.get(id)!;
        const bs = bindings.filter((b) => b.action === id);
        list.append(
          h(
            'div',
            { class: 'keyrow' },
            h('span', { class: 'kname' }, a.label),
            h(
              'span',
              { class: 'kbinds' },
              ...bs.map((b) =>
                h(
                  'button',
                  {
                    class: 'kbd-chip',
                    title: 'タップで削除',
                    onclick: () => {
                      setBindings(bindings.filter((x) => x !== b));
                      draw();
                    },
                  },
                  prettyCombo(b.combo),
                  b.mode ? h('small', {}, ` ${modeName(b.mode)}`) : null,
                  ' ×',
                ),
              ),
            ),
            button('＋キー', () => learn(id)),
          ),
        );
      }
    }
  };
  const learn = (id: string) => {
    const msg = h('div', { class: 'learn' }, h('b', {}, `「${actions.get(id)!.label}」`), h('p', {}, 'キーボードのキー、または TourBox のボタン・ダイヤルを操作してください'));
    const scope = { mode: '' as '' | typeof state.mode };
    msg.append(h('label', {}, '有効なモード ', select(scope.mode, [['', 'すべて'], ['model', 'モデリング'], ['texture', 'テクスチャ'], ['rig', 'リグ'], ['anim', 'アニメ']], (v) => (scope.mode = v))));
    const lm = modal('キーを覚えさせる', msg, { onClose: () => cancel() });
    const cancel = learnNextKey((combo) => {
      const b: Binding = { combo, action: id, ...(scope.mode ? { mode: scope.mode } : {}) };
      // 同じキー・同じ範囲の割り当ては置き換える
      setBindings([...bindings.filter((x) => !(x.combo === combo && (x.mode ?? '') === (b.mode ?? ''))), b]);
      lm.root.remove();
      toast(`${prettyCombo(combo)} → ${actions.get(id)!.label}`);
      draw();
    });
  };
  const search = h('input', { class: 'txt', placeholder: '操作を検索' });
  search.addEventListener('input', () => {
    filter = search.value.trim();
    draw();
  });
  const actionOpts = [...actions.values()].map((a): [string, string] => [a.id, `${a.group}: ${a.label}`]);
  body.append(
    h(
      'div',
      { class: 'cols' },
      h(
        'div',
        {},
        h('h3', {}, 'Apple Pencil'),
        h(
          'div',
          { class: 'form' },
          checkbox('指でも編集する（オフ: 指は視点操作だけ）', pencilSettings.fingerEdit, (v) => ((pencilSettings.fingerEdit = v), savePencil())),
          h('label', {}, 'ダブルタップ', select(pencilSettings.doubleTap, actionOpts, (v) => ((pencilSettings.doubleTap = v), savePencil()))),
          h('label', {}, 'スクイーズ（Pro）', select(pencilSettings.squeeze, actionOpts, (v) => ((pencilSettings.squeeze = v), savePencil()))),
        ),
        h('p', { class: 'hint' }, 'ダブルタップとスクイーズは、Safari やホーム画面版ではOSからページへ届きません。ネイティブアプリとして包んだ場合にだけ使えます（この設定はその時のためのものです）。'),
        h('ul', { class: 'hint' }, h('li', {}, 'ペン: 選択・変形・描画'), h('li', {}, '指1本: 視点を回す／2本: ズームと移動'), h('li', {}, '指2本タップ: 取り消し／3本タップ: やり直し'), h('li', {}, 'ペンをかざす（ホバー）: 描く位置を表示')),
        h('h3', {}, 'TourBox Elite Plus の使い方'),
        h(
          'ol',
          { class: 'hint' },
          h('li', {}, 'TourBox を iPad とBluetoothでつなぎ、iPad版 TourBox Console を開く'),
          h('li', {}, '各ボタン・ダイヤルに好きなキーを割り当てる（何のキーでもよい。他のアプリと重ならないもの推奨）'),
          h('li', {}, 'このアプリに戻り、右の一覧で操作の「＋キー」を押してから TourBox を操作する'),
        ),
        h('table', { class: 'preset' }, h('tr', {}, h('th', {}, '場所'), h('th', {}, 'おすすめの操作')), ...TOURBOX_PRESET.map((p) => h('tr', {}, h('td', {}, p.control), h('td', {}, p.note)))),
        button('割り当てを初期状態に戻す', () => {
          if (!confirm('キー割り当てを初期状態に戻しますか？')) return;
          resetBindings();
          draw();
        }, { cls: 'danger' }),
      ),
      h('div', {}, h('h3', {}, '操作とキー'), search, list),
    ),
  );
  draw();
  void m;
}

const modeName = (m: string) => ({ model: 'モデル', texture: 'テクスチャ', rig: 'リグ', anim: 'アニメ' })[m] ?? m;

// ---------------- 使い方 ----------------
const TUTORIAL: [string, string[]][] = [
  ['基本の操作', [
    'ペン: 選ぶ・動かす・描く。指: 1本で視点を回す、2本でズーム・移動。',
    '指2本でトンとタップ＝取り消し、3本＝やり直し。',
    'ボタンを長押しすると、そのボタンの説明が出ます。',
    '迷子になったら右上の ⛶（全体を表示）。',
  ]],
  ['1. 形を作る（モデリング）', [
    'ファイル →「新規（空）」で白紙にする（サンプルの人形を直してもOK）。',
    '右パネル「追加 → 立方体」。',
    '右パネルで「面」を選び、左の「選択」ツールで箱の上の面をタップ（オレンジになる）。',
    '「押し出し」を押す → 緑の矢印を上へドラッグ。首や体が伸びます。',
    '形を整えるときは「頂点」に切り替え、頂点を選んで「移動」ツールの矢印で動かす。',
    '左右対称の体は、上の「⇋ 左右対称」をオンにすると片側の操作が両側に効きます（片側だけ作って「Xミラー」でも可）。',
  ]],
  ['2. 色・絵を付ける（テクスチャ）', [
    '上の「テクスチャ」タブ → 右パネル「新規 64×64」。',
    '3D側で面を選んでから（何も選ばなければ全体）「UV展開: 箱型」か「画面から」。',
    '左の「ペン」で、3Dモデルの上か右の画像にドットを描く。色は右のパレットで選ぶ。',
    '写真を使うなら「画像を読み込む（PS1化）」で、小さく・少ない色に変換して取り込めます。',
    'テクスチャなしでよければ、モデリングの「色塗り」ツールで面に色を塗るだけでもPS1風になります。',
  ]],
  ['3. 骨を入れる（リグ）', [
    '上の「リグ」タブ → 左の「ボーン追加」。',
    '腰 → 胸 → 頭の順にモデルをタップ（体の中心にジョイントが置かれ、自動で親子になる）。',
    '腕は、胸のジョイントの丸をタップして選び直してから、肩 → ひじ → 手首。脚は腰を選び直してから。',
    '「⇋ 左右対称」をオンにしておくと、片腕を置くだけで反対の腕も .L / .R の名前で作られます。',
    '最後に必ず「自動で割り当て」。これで体がボーンに付きます。',
  ]],
  ['4. 動かす（アニメ）', [
    '上の「アニメ」タブ。最初のコマ（0）で「キー（全ボーン）」を押しておく。',
    'ジョイントの丸、または動かしたい体の部分をタップ → 色付きのリングをドラッグで回す。',
    '下のタイムラインで次のコマ（例: 4）をタップ → また回す。これを繰り返す。',
    '▶ で再生。コマ数や速さ（fps）は右パネルで変えられます。',
  ]],
  ['5. 書き出す', [
    'ファイル →「GLB（ボーン・アニメ込み）」。「ファイル」アプリに保存されます。',
    'GLB は Blender・Unity・Godot などで開けます。',
    '作業は自動で iPad の中に保存されますが、大事な作品は「.kpoly を書き出す」でも残してください。',
  ]],
  ['他のAIで作ったモデルを直すとき', [
    'GLB で書き出して「ファイル」アプリに保存 → ファイル →「読み込んで開く」。',
    '三角形は自動で四角形にまとめ直されます。ボーンやアニメが入っていればそのまま使えます。',
  ]],
];

export function openHelp(): void {
  modal(
    '使い方',
    h(
      'div',
      { class: 'help' },
      ...TUTORIAL.map(([title, steps]) => h('section', {}, h('h3', {}, title), h('ul', {}, ...steps.map((x) => h('li', {}, x))))),
    ),
    { wide: true },
  );
}

void actx;
