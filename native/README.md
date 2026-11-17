# KakuPoly ネイティブ版（Swift / Metal）

Web版をそのまま Swift で作り直す（C案）ための場所です。段階的に進めます。

| 段階 | 内容 | 状態 |
|---|---|---|
| 1 | 計算部分（データ形式・数学・骨格・スキニング・当たり判定）を Swift へ移植。Web版と同じ結果になることをテスト | 済 |
| 1 | 実機確認用アプリ: `.kpoly` を開いて PS1風に表示・アニメ再生、Pencil／指／キー（TourBox）／ダブルタップ・スクイーズの届き方を表示 | 実機確認待ち |
| 2 | モデリング（選択・ギズモ・押し出し等・左右対称）・取り消し | 未着手 |
| 3 | テクスチャ（ドット描き・UV）・PS1化取り込み | 未着手 |
| 4 | リグ・アニメ・GLB 読み書き・ファイル保存 | 未着手 |

## iPad で開く

1. Safari で https://nupotsu104.github.io/kakupoly/KakuPoly.swiftpm.zip を開いてダウンロード
2. 「ファイル」アプリでダウンロードした zip をタップして展開
3. できた `KakuPoly.swiftpm` をタップすると Swift Playgrounds で開く（App Store の Swift Playgrounds が必要）
4. 右上の ▶（実行）

### KakuPoly.swiftpm が「Prewarm failed」で起動しないとき

Swift Playgrounds で新規作成した「App」に、ファイルを入れて動かす方法です。

1. Swift Playgrounds で新しい「App」を作り、そのまま ▶ で動くことを確認（動かなければ Swift Playgrounds 側の問題）
2. 最初からある `MyApp.swift` と `ContentView.swift` を削除
3. 「挿入元」→ `kakupoly-main/native/PlaygroundsFiles` の 12 個の .swift をすべて追加
4. ▶

## 構成

- `Core/` … 画面に依存しない計算部分。Linux でもビルド・テストできる（`cd native/Core && swift test`）
- `KakuPoly.swiftpm/App/` … 画面・Metal 描画・入力
- `KakuPoly.swiftpm/Core/` … `Core/` の複製。`node scripts/sync-native.mjs` で更新（直接編集しない）
- `PlaygroundsFiles/` … アプリの全ソースを1つのフォルダにまとめた複製（同じスクリプトで更新）
- テストの「答え」は Web版のコードから作る: `npx rolldown scripts/gen-native-fixtures.ts --platform node -o /tmp/gen.mjs && node /tmp/gen.mjs`
