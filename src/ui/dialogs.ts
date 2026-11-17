// ダイアログ: 画像のPS1化取り込み / テクスチャの大きさ / ファイル / キー割り当て / 使い方
import type { Texture } from '../core/types';
import { state, notify, checkpoint, setDoc, activeObject, currentPose, changeCounter } from '../state';
import { actions, ctx as actx } from '../actions';
import { h, button, modal, select, checkbox, numberInput, pickFile, downloadBlob, toast, clear } from './dom';
import { quantize, resizeBox, resizeNearest, to15bit, usedColors, type Img } from '../core/quantize';
import { newDoc, newTexture } from '../core/doc';
import { resizeTexture } from '../core/paint';
import { loadImageFile, importFiles, DEFAULT_IMPORT, type ImportOptions } from '../io/import';
import { exportGLB, exportOBJ } from '../io/gltf-export';
import { encodePNG } from '../io/png';
import { serialize, deserialize, storage, requestPersistence } from '../io/project';
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
  const opt = { size: Math.min(128, nearestPow2(Math.max(src.w, src.h))), colors: 16, dither: true, bit15: true, crop: true };
  const preview = h('canvas', { class: 'qpreview' });
  const info = h('p', { class: 'hint' });
  let result: Img | null = null;
  const compute = () => {
    // 縦横比を保ったまま、長辺を指定サイズに（短辺も2のべき乗にそろえる）
    const s = opt.size / Math.max(src.w, src.h);
    let w = opt.size,
      hh = opt.size;
    if (!opt.crop) {
      w = Math.max(8, nearestPow2(Math.round(src.w * s)));
      hh = Math.max(8, nearestPow2(Math.round(src.h * s)));
    }
    let img = resizeBox(src, w, hh);
    if (opt.colors > 0) img = quantize(img, opt.colors, opt.dither).img;
    if (opt.bit15) img = to15bit(img);
    result = img;
    preview.width = img.w;
    preview.height = img.h;
    preview.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
    info.textContent = `${img.w}×${img.h}・${usedColors(img, 999).length}色`;
  };
  const body = h(
    'div',
    { class: 'qdialog' },
    h('div', { class: 'qprev-wrap' }, preview),
    info,
    h(
      'div',
      { class: 'form' },
      h('label', {}, '大きさ', select(String(opt.size), [['32', '32'], ['64', '64'], ['128', '128'], ['256', '256（PS1の上限）']], (v) => ((opt.size = Number(v)), compute()))),
      h(
        'label',
        {},
        '色数',
        select(String(opt.colors), [['4', '4色'], ['16', '16色（4bit・PS1で一般的）'], ['32', '32色'], ['64', '64色'], ['256', '256色（8bit）'], ['0', '減色しない']], (v) => ((opt.colors = Number(v)), compute())),
      ),
      checkbox('ディザ（網点）', opt.dither, (v) => ((opt.dither = v), compute())),
      checkbox('15bitカラーに丸める', opt.bit15, (v) => ((opt.bit15 = v), compute()), 'PS1の色は各色5bit（計32768色）'),
      checkbox('正方形にする', opt.crop, (v) => ((opt.crop = v), compute())),
    ),
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
            if (o && o.tex < 0) o.tex = state.activeTex;
          }
          t.w = result.w;
          t.h = result.h;
          t.data = new Uint8ClampedArray(result.data);
          // 使った色をパレットの先頭に
          state.doc.palette = [...new Set([...usedColors(result, 32), ...state.doc.palette])].slice(0, 48);
          notify('doc', 'tex', 'ui');
          m.close();
        },
        { cls: 'primary' },
      ),
    ),
  );
  const m = modal('画像をPS1風テクスチャにする', body);
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

export async function saveToLibrary(silent = false, thumb?: string): Promise<void> {
  currentId ??= `p${Date.now().toString(36)}`;
  try {
    await storage.put({ id: currentId, name: state.doc.name, updated: Date.now(), thumb, data: serialize(state.doc) });
    savedCounter = changeCounter();
    if (!silent) toast('この端末に保存しました');
  } catch (e) {
    toast(`保存できませんでした: ${(e as Error).message}`);
  }
}

export async function openLatestFromLibrary(): Promise<boolean> {
  try {
    const list = await storage.list();
    if (!list.length) return false;
    const p = await storage.get(list[0].id);
    if (!p) return false;
    setDoc(deserialize(p.data));
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
    h('div', { class: 'prow' }, h('span', { class: 'lbl' }, '作品名'), name),
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
          button('.kpoly を開く', async () => {
            const [f] = await pickFile('.kpoly,application/json');
            if (!f) return;
            try {
              setDoc(deserialize(await f.text()));
              currentId = null;
              m.close();
              actx.vp?.frame();
            } catch (e) {
              toast((e as Error).message);
            }
          }),
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
        h('h3', {}, '他のソフトのモデルを読み込む'),
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
    if (!list.length) lib.append(h('p', { class: 'hint' }, 'まだありません'));
    for (const p of list)
      lib.append(
        h(
          'div',
          { class: `libitem ${p.id === currentId ? 'active' : ''}` },
          p.thumb ? h('img', { src: p.thumb }) : h('div', { class: 'nothumb' }),
          h('div', { class: 'meta' }, h('b', {}, p.name), h('small', {}, new Date(p.updated).toLocaleString())),
          button('開く', async () => {
            if (isDirty() && !confirm('保存していない変更は失われます。開きますか？')) return;
            const d = await storage.get(p.id);
            if (!d) return;
            setDoc(deserialize(d.data));
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

const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_') || 'model';

const importOpts: ImportOptions = { ...DEFAULT_IMPORT };
function importOptionsForm(): HTMLElement {
  return h(
    'div',
    { class: 'form inline' },
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
    if (tris > 3000) setTimeout(() => toast('ポリゴンがPS1の1キャラとしては多めです（当時は数百〜千数百程度が目安）', 5000), 4200);
  } catch (e) {
    console.error(e);
    toast(`読み込めませんでした: ${(e as Error).message}`, 5000);
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
export function openHelp(): void {
  const li = (...t: string[]) => h('ul', {}, ...t.map((x) => h('li', {}, x)));
  modal(
    '使い方',
    h(
      'div',
      { class: 'help' },
      h('h3', {}, '流れ'),
      h(
        'ol',
        {},
        h('li', {}, 'モデリング: 立方体などを追加 → 頂点/辺/面を選んで押し出し・ループカットで形を作る'),
        h('li', {}, 'テクスチャ: 新規テクスチャを作り、UV展開 → 3Dモデルの上か、右の画面にドットで描く'),
        h('li', {}, 'リグ: 「ボーン追加」でモデルをタップしてジョイントを置く → 自動ウェイト'),
        h('li', {}, 'アニメ: ボーンをタップして回転リングをドラッグ → タイムラインでコマを進めて繰り返す'),
        h('li', {}, 'ファイル → GLB で書き出し（Blender / Unity / Godot などで読めます）'),
      ),
      h('h3', {}, '操作'),
      li('ペン（マウス左）: 選択・ギズモ操作・描画', '指1本ドラッグ: 視点回転、指2本: ズームと移動、2本タップ: 取り消し、3本タップ: やり直し', 'ペンで何もない所をドラッグ: 範囲選択（モデリング）／視点回転（リグ・アニメ）', '右上の ⟲ ✥ ⊕ ボタンをペンでドラッグしても視点を動かせます'),
      h('h3', {}, 'PS1らしさのコツ'),
      li('キャラクター1体は数百〜千数百の三角形が目安', 'テクスチャは64×64〜128×128、16色程度', '上部「表示」でPS1表示（低解像度・頂点のガタつき・テクスチャのゆがみ）を確認'),
    ),
    { wide: true },
  );
}

void actx;
