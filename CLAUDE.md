# KakuPoly — 作業メモ（Claude Code 用）

iPad Pro（M4）で PS1 風のローポリ 3D を作る・直すためのアプリ。モデリング、ドット絵風テクスチャ、ボーン、アニメ、書き出し（GLB/OBJ/.kpoly）まで。
Apple Pencil（編集）と指（視点操作）、TourBox Elite Plus（キー割り当て、iPad では Bluetooth キーボードとして動く）を前提にする。

- 公開先: GitHub Pages（PWA）。`main` に push すると `.github/workflows/pages.yml` がビルド・テスト・公開まで行う
- 自動更新: `version.json` とアプリ内の版を比べて切り替える（`src/update.ts`、`public/sw.js`）

## やりとりの約束

- 質問の形で終わるメッセージには、作業を始めずにまず説明する
- 科学・技術の情報は確かな公開資料を根拠にし、出典を書く
- 落ち着いた話し方で、対等に。違うと思うことは遠慮なく指摘する
- ホーム画面のアイコンを消す案内はしない（端末に保存した作品が消えるため）

## 構成

- `src/core` — データ型と編集処理（UI に依存しない）。`types.ts` / `mesh-ops.ts` / `symmetry.ts` / `simplify.ts` / `skeleton.ts` / `quantize.ts` / `doc.ts`
- `src/view` — three.js の表示。`ps1-material.ts`（頂点のガタつき・アフィン・グーロー・15bit＋ディザ）
- `src/io` — 読み込み（glTF/FBX/OBJ）、書き出し（`gltf-export.ts` は自前の GLB 書き出し）、`.kpoly`（`project.ts`、端末内は IndexedDB に gzip で保存）
- `src/ui` — 画面。長押しで説明（`help-texts.ts`）
- `native/` — Swift/Metal 版（保留中。iPadOS 27 の Swift Playgrounds の不具合 FB24936489 で実機起動できないため）
- `tools/anomalocaris/` — ユーザーのアノマロカリス（FBX）から PS1 版・元のまま版を作るスクリプト。詳細は同フォルダの README

## コマンド

```sh
npm install
npm run dev        # 開発サーバー
npm test           # vitest
npm run build      # 型チェック + ビルド
```

ブラウザでの確認は Playwright（iPad Pro 11 横の端末設定）で行ってきた。

## 現在の状態と残り

- アノマロカリス PS1 版: 約6000三角形・512×512・60色。元のまま版: 61,534三角形・2000×2000
  - 鰭・尾鰭は胴の断面の中央へ、偽瞳孔は殻の50%、口器の複製は削除、複眼の殻は50%半透明
  - 一番前の鰭が頭の鰭の下に潜る形になっている（ユーザー未確認）
- ユーザー未確認: iPad での保存・一覧の修正、自動更新が実機で動くか
- 未回答の提案: リモートブランチ `wip/fbx-uv-flip` の削除、PS1 の他の半透明モード（加算など）への対応
