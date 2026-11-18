# アノマロカリスの PS1 版・元のまま版を作るスクリプト

アプリと同じ処理（`src/` のコード）を Node で動かして、FBX から `.kpoly` / `.glb` を作る。

| ファイル | 中身 |
| --- | --- |
| `makeps1.ts` | 生成の本体。読み込み → 口器の複製を削除 → 複眼の殻を分離（50%半透明）→ 鰭・尾鰭の高さ合わせ → 偽瞳孔 → テクスチャ → ポリゴン削減 → 書き出し |
| `finfix.ts` | 鰭・尾鰭を胴の断面の真ん中の高さへ移す（ボーンとアニメのキーも一緒に）、偽瞳孔を殻の中心・殻の50%に合わせる |
| `animchk.ts` | 書き出した `.kpoly` で、アニメ再生中も瞳が殻の中心にあるかを確かめる |
| `finchk.ts` | 鰭の付け根から胴の面までの距離を確かめる |

## 入力

- `Anomalocaris_v06.FBX`（3ds Max から書き出したもの）
- 水彩テクスチャを 2000×2000 の生の RGBA にしたもの（`tex2000.rgba`、16,000,000 バイト）

```sh
# 例: Python + Pillow でテクスチャ画像を生の RGBA にする
python3 -c "from PIL import Image; Image.open('anomalo-texture.jpg').convert('RGBA').resize((2000,2000)).save('tex2000.rgba', 'raw')" 
```

## 実行

```sh
npm install
npx rolldown tools/anomalocaris/makeps1.ts --platform node -o node_modules/.cache/makeps1.mjs
OUT=出力先フォルダ

# PS1 版（今の設定: 約6000三角形・512×512・64色・殻480三角形）
TRIS=6000 TEX=512 COLORS=64 EYE_SHELL=480 node --max-old-space-size=8000 node_modules/.cache/makeps1.mjs Anomalocaris_v06.FBX tex2000.rgba $OUT

# 元のまま版（削減なし・2000×2000・減色なし）
ORIG=1 node --max-old-space-size=8000 node_modules/.cache/makeps1.mjs Anomalocaris_v06.FBX tex2000.rgba $OUT
```

環境変数（PS1 版）: `TRIS`（合計三角形、既定 2000）、`TEX`（テクスチャの一辺、既定 256）、`COLORS`（色数、既定 32）、`EYE_SHELL`（複眼の殻の三角形、既定 240）。
`PROBE=1` で書き出さずに測定結果だけ表示。

確認:

```sh
npx rolldown tools/anomalocaris/animchk.ts --platform node -o node_modules/.cache/animchk.mjs
node --max-old-space-size=8000 node_modules/.cache/animchk.mjs $OUT/Anomalocaris_PS1.kpoly
```

## 修正内容の要点（なぜそうしたか）

- **口器の複製 `tooth001` / `tooth002`**: 頭の横に浮いていた複製なので削除。円錐状の本体 `tooth` は残す。
- **複眼の殻**: 胴体の UV の島（左右）を選んで分離し、不透明度 50%。中の黒い瞳が偽瞳孔として透けて見える。
- **灰色の下地**: FBX の材質色（0.3）が頂点カラーに入り、テクスチャが暗くなっていたので白に戻す（`assignTexture`）。
- **鰭・尾鰭**: 付け根が胴の断面の中央より 0.9〜1.7 高かった。移動量を前後位置 z の関数にして（各鰭の付け根で「胴の中央 − 付け根」）、重なった鰭どうしの上下が入れ替わらないようにした。尾鰭は全部同じ量。鰭用のボーンとアニメの移動キーも同じだけずらす。
- **偽瞳孔**: 片目の殻の 50%（横・縦・奥行き）、殻の中心へ。右の瞳は元データで基準姿勢だけ 1.43 上にずれていた（再生中は正しい位置）ので、頂点と一緒にボーンの基準姿勢もずらし、アニメのキーは変えない。
- **削減**: 目は別枠で削減し、継ぎ目を崩す設定（Permissive）は使わない。小さな部品が潰れないように。
