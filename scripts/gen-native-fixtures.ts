// Swift版の計算がWeb版と同じ結果になるかを確かめるための「答え」を作る。
// 実行（リポジトリ直下で）: npx rolldown scripts/gen-native-fixtures.ts --platform node -o /tmp/gen.mjs && node /tmp/gen.mjs
import { writeFileSync } from 'node:fs';
import { sampleDoc } from '../src/core/sample';
import { serialize } from '../src/io/project';
import { samplePose, skinnedPositions, worldMatrices, restPose } from '../src/core/skeleton';

const out = new URL('native/Core/Tests/KakuPolyCoreTests/Fixtures/', `file://${process.cwd()}/`); // リポジトリ直下で実行する
const doc = sampleDoc();
writeFileSync(new URL('sample.kpoly', out), serialize(doc));
const walk = doc.clips[0];
const frames = [0, 3, 4, 7.5, 12];
const expected = {
  restJoints: worldMatrices(doc.bones, restPose(doc.bones)).map((m) => [m[12], m[13], m[14]]),
  frames: frames.map((f) => {
    const pose = samplePose(doc, walk, f);
    return {
      f,
      joints: worldMatrices(doc.bones, pose).map((m) => [m[12], m[13], m[14]]),
      verts: skinnedPositions(doc, doc.objects[0], pose),
    };
  }),
};
writeFileSync(new URL('expected.json', out), JSON.stringify(expected));
console.log('fixtures written');
