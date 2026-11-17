// native/Core の Swift ソースをアプリ（KakuPoly.swiftpm/Core）へ複製し、
// サンプル作品を埋め込んだ SampleData.swift を作る。--check なら差分があれば失敗する（CI用）。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const src = join(root, 'native/Core/Sources/KakuPolyCore');
const dst = join(root, 'native/KakuPoly.swiftpm/Core');
const sample = join(root, 'native/Core/Tests/KakuPolyCoreTests/Fixtures/sample.kpoly');
const header = '// このファイルは native/Core からの複製です。直接編集せず native/Core を直して scripts/sync-native.mjs を実行してください。\n';

const want = new Map();
for (const f of readdirSync(src).filter((f) => f.endsWith('.swift'))) want.set(f, header + readFileSync(join(src, f), 'utf8'));
want.set('SampleData.swift', `${header}// 起動時に開くサンプル作品（.kpoly を base64 にしたもの）\nlet sampleKpolyBase64 = "${readFileSync(sample).toString('base64')}"\n`);

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const [f, text] of want) {
    let cur = '';
    try {
      cur = readFileSync(join(dst, f), 'utf8');
    } catch {}
    if (cur !== text) (bad++, console.error(`同期されていません: ${f}`));
  }
  process.exit(bad ? 1 : 0);
}
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const [f, text] of want) writeFileSync(join(dst, f), text);
console.log(`synced ${want.size} files`);
