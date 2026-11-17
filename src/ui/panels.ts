// 右側パネル（モードごとの操作・設定）
import { state, notify, checkpoint, activeObject, activeTexture, activeClip, dropCheckpoint } from '../state';
import { actions, runAction, ctx as actx } from '../actions';
import { bindingsFor, prettyCombo } from '../input/keymap';
import { h, button, numberInput, select, checkbox, clear, toast } from './dom';
import { docStats } from '../core/doc';
import { selVerts, selFaces, joinObjects } from '../core/mesh-ops';
import { reparentBone, newClip } from '../core/skeleton';
import { resizeTexture } from '../core/paint';
import { boneColor } from '../view/builders';
import { openImageImport, openTextureResize } from './dialogs';
import { withHelp } from './longpress';

/** 操作ボタン（ショートカットがあれば併記） */
function act(id: string, label?: string, cls = ''): HTMLButtonElement {
  const a = actions.get(id);
  const b = bindingsFor(id).find((x) => !x.mode || x.mode === state.mode);
  const el = withHelp(button(label ?? a?.label ?? id, () => runAction(id), { title: `${a?.label ?? id}${b ? `（${prettyCombo(b.combo)}）` : ''}`, cls }), `action:${id}`);
  if (b) el.append(h('kbd', {}, prettyCombo(b.combo)));
  return el;
}

const section = (title: string, ...body: (Node | null | false)[]) => h('section', { class: 'psec' }, h('h3', {}, title), ...body);
const row = (...c: (Node | string | null | false)[]) => h('div', { class: 'prow' }, ...c);
const grid = (...c: Node[]) => h('div', { class: 'pgrid' }, ...c);

export function renderPanel(root: HTMLElement): void {
  const scroll = root.scrollTop;
  clear(root);
  const m = state.mode;
  if (m === 'model') modelPanel(root);
  else if (m === 'texture') texturePanel(root);
  else if (m === 'rig') rigPanel(root);
  else animPanel(root);
  root.append(objectsSection());
  root.scrollTop = scroll;
}

function selModeRow(): HTMLElement {
  const s = state.sel.mode;
  return row(
    h('span', { class: 'lbl' }, '選択'),
    h('div', { class: 'seg' }, act('sel-vert', '頂点', s === 'vert' ? 'active' : ''), act('sel-edge', '辺', s === 'edge' ? 'active' : ''), act('sel-face', '面', s === 'face' ? 'active' : '')),
  );
}

function selOpRow(): HTMLElement {
  const set = (v: typeof state.selOp) => () => ((state.selOp = v), notify('ui'));
  return withHelp(row(
    h('span', { class: 'lbl' }, 'タップで'),
    h(
      'div',
      { class: 'seg' },
      button('置換', set('set'), { active: state.selOp === 'set' }),
      button('追加', set('add'), { active: state.selOp === 'add' }),
      button('解除', set('sub'), { active: state.selOp === 'sub' }),
    ),
  ), 'panel:selop');
}

function axisRow(): HTMLElement {
  return withHelp(row(
    h('span', { class: 'lbl', title: 'TourBox のダイヤルや ＋/− キーで動く軸' }, '微調整の軸'),
    h('div', { class: 'seg' }, ...(['X', 'Y', 'Z'] as const).map((n, i) => button(n, () => ((state.axis = i as 0 | 1 | 2), notify('ui', 'view')), { active: state.axis === i, cls: `axis${i}` }))),
    h('div', { class: 'seg' }, act('nudge-minus', '−'), act('nudge-plus', '＋')),
  ), 'panel:axis');
}

function paletteSection(): HTMLElement {
  const pal = state.doc.palette;
  const sw = h(
    'div',
    { class: 'palette' },
    ...pal.map((c, i) => {
      const replace = () => {
        checkpoint();
        pal[i] = state.color;
        notify('ui');
      };
      const b = h('button', {
        class: `swatch ${c.toLowerCase() === state.color.toLowerCase() ? 'active' : ''}`,
        style: `background:${c}`,
        title: c,
        oncontextmenu: (e: Event) => {
          e.preventDefault();
          replace();
        },
      });
      // iPad の Safari では長押しで contextmenu が来ないので、自前で長押しを判定する
      let timer = 0;
      let long = false;
      b.addEventListener('pointerdown', () => {
        long = false;
        timer = window.setTimeout(() => {
          long = true;
          replace();
        }, 500);
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => clearTimeout(timer));
      b.addEventListener('click', () => {
        if (!long) {
          state.color = c;
          notify('ui');
        }
      });
      return b;
    }),
  );
  const picker = h('input', { type: 'color', value: state.color, class: 'colorpick' });
  picker.addEventListener('input', () => {
    state.color = picker.value;
    notify('ui');
  });
  return section(
    '色',
    row(picker, h('code', {}, state.color), button('パレットに追加', () => {
      if (!pal.includes(state.color)) {
        checkpoint();
        pal.push(state.color);
        notify('ui');
      }
    })),
    sw,
    h('p', { class: 'hint' }, 'マスを長押しすると、そのマスを今の色に置き換えます'),
  );
}

// ---------------- モデリング ----------------
function modelPanel(root: HTMLElement): void {
  const o = activeObject();
  const nv = o ? selVerts(o, state.sel).size : 0;
  const nf = o ? selFaces(o, state.sel).size : 0;
  root.append(
    section('選択', selModeRow(), selOpRow(), grid(act('sel-all', 'すべて'), act('sel-none', '解除'), act('sel-invert', '反転'), act('sel-linked', 'つながり')), h('p', { class: 'hint' }, `選択中: 頂点 ${nv} / 面 ${nf}`)),
    section(
      '形を作る',
      grid(
        act('extrude', '押し出し'),
        act('inset', 'インセット'),
        act('loopcut', 'ループカット'),
        act('subdivide', '細分化'),
        act('split-edge', '辺を分割'),
        act('connect', '頂点を結ぶ'),
        act('make-face', '面を張る'),
        act('merge', '結合'),
        act('weld', '溶接'),
        act('dissolve', '辺の溶解'),
        act('duplicate', '複製'),
        act('mirror-x', 'Xミラー'),
        act('flip', '面を反転'),
        act('triangulate', '三角形化'),
        act('separate', '分離'),
        act('delete', '削除', 'danger'),
      ),
    ),
    section('追加', grid(act('add-cube', '立方体'), act('add-plane', '板'), act('add-cylinder', '円柱'), act('add-cone', '円すい'), act('add-sphere', '球'))),
    section(
      '変形',
      axisRow(),
      row(
        withHelp(checkbox('グリッド吸着', state.snap, (v) => ((state.snap = v), notify('ui'))), 'panel:snap'),
        h('span', { class: 'lbl' }, '刻み'),
        numberInput(state.gridStep, (v) => ((state.gridStep = Math.max(0.001, v)), notify('ui')), { step: 0.01, min: 0.001, width: '5em' }),
      ),
      row(withHelp(checkbox('左右対称モード', state.symmetryX, (v) => ((state.symmetryX = v), notify('ui', 'view')), '片側の操作が反対側にも効く'), 'panel:symmetry')),
      grid(act('snap-grid', '頂点をグリッドへ')),
    ),
    paletteSection(),
    section('色を塗る', grid(act('paint-sel', '選択部分を塗る'), act('tool-model-vpaint', '色塗りツール')), h('p', { class: 'hint' }, 'テクスチャを使わない、頂点カラーだけのPS1風モデルも作れます')),
  );
}

// ---------------- テクスチャ ----------------
function texturePanel(root: HTMLElement): void {
  const t = activeTexture();
  const o = activeObject();
  const texOpts: [string, string][] = [['-1', '（なし：頂点カラーのみ）'], ...state.doc.textures.map((x, i): [string, string] => [String(i), `${x.name}（${x.w}×${x.h}）`])];
  root.append(
    section(
      'テクスチャ',
      row(
        h('span', { class: 'lbl' }, '編集中'),
        select(String(state.activeTex), texOpts.slice(1), (v) => {
          state.activeTex = Number(v);
          notify('ui', 'tex');
        }),
      ),
      o
        ? row(
            h('span', { class: 'lbl' }, `${o.name} に使う`),
            select(String(o.tex), texOpts, (v) => {
              checkpoint();
              o.tex = Number(v);
              if (o.tex >= 0) state.activeTex = o.tex;
              notify('doc', 'ui', 'tex');
            }),
          )
        : null,
      grid(
        act('new-texture', '新規 64×64'),
        button('画像を読み込む（PS1化）', () => openImageImport()),
        button('大きさを変える', () => t && openTextureResize(t)),
        button('2倍に拡大', () => {
          if (!t) return;
          checkpoint();
          resizeTexture(t, t.w * 2, t.h * 2);
          notify('doc', 'tex', 'ui');
        }),
      ),
      t
        ? row(
            h('span', { class: 'lbl' }, '名前'),
            (() => {
              const i = h('input', { value: t.name, class: 'txt' });
              i.addEventListener('change', () => {
                checkpoint();
                t.name = i.value || t.name;
                notify('ui');
              });
              return i;
            })(),
          )
        : null,
      h('p', { class: 'hint' }, 'PS1のテクスチャは1枚最大256×256、16色か256色のパレットが基本でした。64×64〜128×128程度がそれらしく見えます。'),
    ),
    section(
      'ブラシ',
      row(
        h('span', { class: 'lbl' }, '太さ'),
        h('div', { class: 'seg' }, ...[1, 2, 3, 4].map((n) => button(`${n}px`, () => ((state.brushSize = n), notify('ui')), { active: state.brushSize === n }))),
      ),
      row(checkbox('矩形を塗りつぶす', state.rectFill, (v) => ((state.rectFill = v), notify('ui')))),
    ),
    paletteSection(),
    section(
      'UV（貼り方）',
      h('p', { class: 'hint' }, '3Dビューで面を選んでから展開します（選択なしなら全体）。UVツールでテクスチャ画面の網目を直接動かせます。'),
      grid(act('uv-view', '画面から'), act('uv-box', '箱型'), act('uv-x', 'X方向'), act('uv-y', 'Y方向'), act('uv-z', 'Z方向'), act('uv-reset', '各面いっぱい')),
      row(
        checkbox('UVの網目を表示', state.showUV, (v) => ((state.showUV = v), notify('ui'))),
        checkbox('ピクセルに吸着', state.uvSnap, (v) => ((state.uvSnap = v), notify('ui'))),
      ),
    ),
  );
}

// ---------------- リグ ----------------
function boneTree(onPick: (i: number) => void): HTMLElement {
  const bones = state.doc.bones;
  const depth = (i: number) => {
    let d = 0;
    for (let p = bones[i].parent; p >= 0 && d < 64; p = bones[p].parent) d++;
    return d;
  };
  // 親→子の順で並べる
  const order: number[] = [];
  const visit = (p: number) => bones.forEach((b, i) => b.parent === p && (order.push(i), visit(i)));
  visit(-1);
  bones.forEach((_, i) => !order.includes(i) && order.push(i));
  const anim = activeClip();
  return h(
    'div',
    { class: 'tree' },
    ...order.map((i) => {
      const c = boneColor(i).map((x) => Math.round(x * 255)).join(',');
      const keyed = state.mode === 'anim' && anim?.tracks.some((t) => t.bone === i && t.keys.some((k) => k.f === state.frame));
      return h(
        'button',
        { class: `tree-item ${state.activeBone === i ? 'active' : ''}`, style: `padding-left:${8 + depth(i) * 14}px`, onclick: () => onPick(i) },
        h('i', { class: 'dot', style: `background:rgb(${c})` }),
        bones[i].name,
        keyed ? h('span', { class: 'keyed' }, '◆') : null,
      );
    }),
  );
}

function rigPanel(root: HTMLElement): void {
  const bones = state.doc.bones;
  const b = bones[state.activeBone];
  const parts: (HTMLElement | null)[] = [
    section(
      'ボーン',
      bones.length ? boneTree((i) => ((state.activeBone = i), notify('ui', 'view'))) : h('p', { class: 'hint' }, 'まだボーンがありません。「ボーン追加」ツールでモデルをタップすると、体の中心にジョイントが置かれます。'),
      grid(act('tool-rig-bone-add', '追加ツール'), act('bone-root', 'ルートを追加'), act('bone-mirror', '左右対称に複製'), act('bone-delete', '削除', 'danger')),
      row(checkbox('親を動かしても子は動かさない', state.keepChildren, (v) => ((state.keepChildren = v), notify('ui')))),
    ),
    b
      ? section(
          '選択中のボーン',
          row(
            h('span', { class: 'lbl' }, '名前'),
            (() => {
              const i = h('input', { value: b.name, class: 'txt' });
              i.addEventListener('change', () => {
                const n = i.value.trim();
                if (!n || bones.some((x, j) => x.name === n && j !== state.activeBone)) return toast('同じ名前のボーンがあります');
                checkpoint();
                b.name = n;
                notify('doc', 'ui');
              });
              return i;
            })(),
          ),
          row(
            h('span', { class: 'lbl' }, '親'),
            select(String(b.parent), [['-1', '（なし）'], ...bones.map((x, i): [string, string] => [String(i), x.name]).filter(([i]) => Number(i) !== state.activeBone)], (v) => {
              checkpoint();
              if (!reparentBone(state.doc, state.activeBone, Number(v))) {
                dropCheckpoint();
                return toast('親子が循環するので設定できません');
              }
              notify('doc', 'ui', 'pose');
            }),
          ),
          h('p', { class: 'hint' }, '左右対称にするなら名前の末尾を .L / .R にしておくと、ミラー機能が対応を見つけます。'),
        )
      : null,
    section(
      'ウェイト（どの頂点がどのボーンで動くか）',
      grid(act('weights-auto', '自動で割り当て'), act('tool-rig-weights', '頂点を選ぶ'), act('weights-assign', '選択頂点→このボーン'), act('weights-view', state.view.weights ? '色表示をやめる' : '色で表示')),
      h('p', { class: 'hint' }, '自動割り当ては「1頂点＝1ボーン」の硬い方式です。部位ごとにカクッと動く、PS1らしい動きになります。'),
    ),
  ];
  for (const p of parts) if (p) root.append(p);
}

// ---------------- アニメ ----------------
function animPanel(root: HTMLElement): void {
  const c = activeClip();
  const clips = state.doc.clips;
  root.append(
    section(
      'アニメーション',
      row(
        select(String(state.clip), clips.length ? clips.map((x, i): [string, string] => [String(i), x.name]) : [['0', '（なし）']], (v) => {
          state.clip = Number(v);
          state.frame = 0;
          state.poseOverride = null;
          notify('ui', 'frame', 'pose');
        }),
        button('新規', () => {
          checkpoint();
          newClip(state.doc);
          state.clip = state.doc.clips.length - 1;
          state.frame = 0;
          notify('doc', 'ui', 'frame', 'pose');
        }),
        c
          ? button('複製', () => {
              checkpoint();
              const d = structuredClone(c);
              d.name = `${c.name}のコピー`;
              state.doc.clips.push(d);
              state.clip = state.doc.clips.length - 1;
              notify('doc', 'ui');
            })
          : null,
        c
          ? button(
              '削除',
              () => {
                checkpoint();
                state.doc.clips.splice(state.clip, 1);
                state.clip = Math.max(0, state.clip - 1);
                state.frame = 0;
                notify('doc', 'ui', 'frame', 'pose');
              },
              { cls: 'danger' },
            )
          : null,
      ),
      c
        ? h(
            'div',
            {},
            row(
              h('span', { class: 'lbl' }, '名前'),
              (() => {
                const i = h('input', { value: c.name, class: 'txt' });
                i.addEventListener('change', () => (checkpoint(), (c.name = i.value || c.name), notify('ui')));
                return i;
              })(),
            ),
            row(
              h('span', { class: 'lbl' }, 'コマ数'),
              numberInput(c.length, (v) => (checkpoint(), (c.length = Math.max(1, Math.round(v))), notify('doc', 'ui', 'frame')), { min: 1, width: '4.5em' }),
              h('span', { class: 'lbl' }, 'fps'),
              numberInput(c.fps, (v) => (checkpoint(), (c.fps = Math.max(1, Math.min(60, Math.round(v)))), notify('doc', 'ui')), { min: 1, max: 60, width: '4em' }),
            ),
            row(
              h('span', { class: 'lbl' }, '補間'),
              select(c.interp, [['linear', 'なめらか（直線補間）'], ['step', 'カクカク（次のキーまで止める）']], (v) => (checkpoint(), (c.interp = v), notify('doc', 'pose', 'ui'))),
            ),
            row(checkbox('ループ再生', c.loop, (v) => (checkpoint(), (c.loop = v), notify('ui')))),
          )
        : h('p', { class: 'hint' }, 'ボーンを動かすと自動でアニメが作られます。'),
    ),
    section(
      'ポーズ',
      state.doc.bones.length ? boneTree((i) => ((state.activeBone = i), notify('ui', 'view'))) : h('p', { class: 'hint' }, '先にリグモードでボーンを入れてください。'),
      row(checkbox('動かしたら自動でキー', state.autoKey, (v) => ((state.autoKey = v), notify('ui')))),
      row(checkbox('回転の軸をボーン基準に', state.localAxes, (v) => ((state.localAxes = v), notify('ui', 'view')))),
      axisRow(),
      grid(
        act('key-insert', 'キー（このボーン）'),
        act('key-insert-all', 'キー（全ボーン）'),
        act('key-delete', 'キーを消す'),
        act('pose-reset', '初期姿勢に'),
        act('pose-copy', 'ポーズをコピー'),
        act('pose-paste', '貼り付け'),
        act('pose-paste-mirror', '左右反転で貼る'),
      ),
    ),
  );
}

// ---------------- オブジェクト一覧 ----------------
function objectsSection(): HTMLElement {
  const objs = state.doc.objects;
  const s = docStats(state.doc);
  return section(
    `オブジェクト（${s.tris} 三角形）`,
    h(
      'div',
      { class: 'tree' },
      ...objs.map((o, i) =>
        h(
          'div',
          { class: `tree-item ${state.activeObj === i ? 'active' : ''}` },
          h(
            'button',
            {
              class: 'eye',
              title: '表示/非表示',
              onclick: () => {
                o.visible = !o.visible;
                notify('doc', 'ui');
              },
            },
            o.visible ? '●' : '○',
          ),
          h(
            'button',
            {
              class: 'name',
              onclick: () => {
                if (state.activeObj !== i) {
                  state.activeObj = i;
                  state.sel.verts.clear();
                  state.sel.edges.clear();
                  state.sel.faces.clear();
                  if (o.tex >= 0) state.activeTex = o.tex;
                  notify('sel', 'ui', 'tex');
                }
              },
              ondblclick: () => {
                const n = prompt('オブジェクト名', o.name);
                if (n) {
                  checkpoint();
                  o.name = n;
                  notify('ui');
                }
              },
            },
            `${o.name}`,
            h('small', {}, ` ${o.faces.length}面`),
          ),
        ),
      ),
    ),
    grid(
      button('名前変更', () => {
        const o = activeObject();
        const n = o && prompt('オブジェクト名', o.name);
        if (o && n) {
          checkpoint();
          o.name = n;
          notify('ui');
        }
      }),
      button('両面表示 切替', () => {
        const o = activeObject();
        if (!o) return;
        checkpoint();
        o.doubleSided = !o.doubleSided;
        notify('doc', 'ui');
      }),
      button('下と結合', () => {
        const i = state.activeObj;
        const a = objs[i],
          b = objs[i + 1];
        if (!a || !b) return toast('下にオブジェクトがありません');
        checkpoint();
        joinObjects(a, b);
        objs.splice(i + 1, 1);
        notify('doc', 'ui', 'sel');
      }),
      button(
        '削除',
        () => {
          if (!activeObject()) return;
          checkpoint();
          objs.splice(state.activeObj, 1);
          state.activeObj = Math.max(0, state.activeObj - 1);
          state.sel.verts.clear();
          state.sel.edges.clear();
          state.sel.faces.clear();
          notify('doc', 'ui', 'sel');
        },
        { cls: 'danger' },
      ),
    ),
  );
}

void actx;
