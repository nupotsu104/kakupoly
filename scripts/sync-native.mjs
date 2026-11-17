// native/Core の Swift ソースをアプリ（KakuPoly.swiftpm/Core）へ複製し、
// サンプル作品を埋め込んだ SampleData.swift を作る。--check なら差分があれば失敗する（CI用）。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const src = join(root, 'native/Core/Sources/KakuPolyCore');
const dst = join(root, 'native/KakuPoly.swiftpm/Core');
// Swift Playgrounds の新規アプリに「挿入」で入れられるよう、全ソースを普通のフォルダにも置く
const flat = join(root, 'native/PlaygroundsFiles');
const appDir = join(root, 'native/KakuPoly.swiftpm/App');
const sample = join(root, 'native/Core/Tests/KakuPolyCoreTests/Fixtures/sample.kpoly');
const header = '// このファイルは native/Core からの複製です。直接編集せず native/Core を直して scripts/sync-native.mjs を実行してください。\n';

const want = new Map();
for (const f of readdirSync(src).filter((f) => f.endsWith('.swift'))) want.set(f, header + readFileSync(join(src, f), 'utf8'));
want.set('SampleData.swift', `${header}// 起動時に開くサンプル作品（.kpoly を base64 にしたもの）\nlet sampleKpolyBase64 = "${readFileSync(sample).toString('base64')}"\n`);

const wantFlat = new Map(want);
for (const f of readdirSync(appDir).filter((f) => f.endsWith('.swift'))) wantFlat.set(f, readFileSync(join(appDir, f), 'utf8'));

const targets = [
  [dst, want],
  [flat, wantFlat],
];
if (process.argv.includes('--check')) {
  let bad = 0;
  for (const [dir, files] of targets)
    for (const [f, text] of files) {
      let cur = '';
      try {
        cur = readFileSync(join(dir, f), 'utf8');
      } catch {}
      if (cur !== text) (bad++, console.error(`同期されていません: ${join(dir, f)}`));
    }
  process.exit(bad ? 1 : 0);
}
for (const [dir, files] of targets) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of files) writeFileSync(join(dir, f), text);
}
console.log(`synced ${want.size} + ${wantFlat.size} files`);
