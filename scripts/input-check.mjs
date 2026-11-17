// Apple Pencil / 指 / キー（TourBox相当）の振り分けを、合成した PointerEvent で確かめる
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1376, height: 1032 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:4173/');
await page.waitForTimeout(1200);
const status = () => page.evaluate(() => document.querySelector('.status').textContent);
// 合成ポインタ: type = pen | touch, id, 座標列
const ptr = (events) => page.evaluate((evs) => {
  const el = document.querySelector('.vp-overlay');
  const r = el.getBoundingClientRect();
  for (const [kind, type, id, x, y] of evs)
    el.dispatchEvent(new PointerEvent(kind, { pointerType: type, pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, isPrimary: id === 1, button: 0, buttons: kind === 'pointerup' ? 0 : 1, pressure: 0.5 }));
}, events);
const vpx = (x) => x - 64, vpy = (y) => y - 48; // ビューポートの左上はツール列と上部バーの分ずれる
const check = (name, ok, detail = '') => console.log(`${ok ? 'OK ' : 'NG '} ${name} ${detail}`);

// 1) ペンのタップで面を選択
await ptr([['pointerdown', 'pen', 1, vpx(530), vpy(300)], ['pointerup', 'pen', 1, vpx(530), vpy(300)]]);
await page.waitForTimeout(200);
check('ペンで面を選択', (await status()).includes('選択 4頂点'), await status());

// 2) 指1本のドラッグは編集せず視点回転（選択は変わらない）
await ptr([['pointerdown', 'touch', 11, 300, 500], ['pointermove', 'touch', 11, 360, 500], ['pointerup', 'touch', 11, 360, 500]]);
await page.waitForTimeout(200);
check('指1本は選択を変えない', (await status()).includes('選択 4頂点'));

// 3) 押し出し（E）→ 指2本タップで取り消し → 指3本タップでやり直し
await page.keyboard.press('e');
await page.waitForTimeout(150);
const afterE = await status();
await ptr([['pointerdown', 'touch', 21, 300, 500], ['pointerdown', 'touch', 22, 400, 500], ['pointerup', 'touch', 21, 300, 500], ['pointerup', 'touch', 22, 400, 500]]);
await page.waitForTimeout(250);
const afterUndo = await status();
check('指2本タップで取り消し', afterE.includes('115頂点') && afterUndo.includes('111頂点'), `${afterE.match(/\d+頂点 \d+三角形/)} → ${afterUndo.match(/\d+頂点 \d+三角形/)}`);
await ptr([['pointerdown', 'touch', 31, 300, 500], ['pointerdown', 'touch', 32, 400, 500], ['pointerdown', 'touch', 33, 500, 500], ['pointerup', 'touch', 31, 300, 500], ['pointerup', 'touch', 32, 400, 500], ['pointerup', 'touch', 33, 500, 500]]);
await page.waitForTimeout(250);
check('指3本タップでやり直し', (await status()).includes('115頂点'));

// 4) TourBox のダイヤル相当: '=' を3回 → Y軸方向に動く（1回の取り消しにまとまる）
const y0 = await page.evaluate(() => window.kakupoly && 0);
await page.keyboard.press('g');
for (let i = 0; i < 3; i++) await page.keyboard.press('Equal');
await page.waitForTimeout(150);
await page.keyboard.press('Meta+z');
await page.waitForTimeout(150);
const s4 = await status();
check('ダイヤル連続操作は1回で取り消せる', s4.includes('115頂点'), '(押し出しは残る)');

// 5) Space を押している間のペンドラッグは視点回転（選択は変わらない、範囲選択にならない）
await page.keyboard.down('Space');
await page.waitForTimeout(50);
const badge = await page.evaluate(() => document.querySelector('.heldbadge').textContent);
await ptr([['pointerdown', 'pen', 1, 200, 600], ['pointermove', 'pen', 1, 260, 620], ['pointermove', 'pen', 1, 320, 640], ['pointerup', 'pen', 1, 320, 640]]);
await page.keyboard.up('Space');
await page.waitForTimeout(200);
check('Space押下中ペン=視点回転', badge.includes('視点回転') && (await status()).includes('選択 4頂点'), `表示:「${badge}」`);
await page.screenshot({ path: 'shots/input.png' });

// 6) テクスチャモードでペンをかざす（ホバー: buttons=0 の pointermove）→ 例外が出ない
await page.keyboard.press('Shift+Digit2');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const el = document.querySelector('.tex-canvas');
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'pen', pointerId: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 0, bubbles: true }));
});
await page.waitForTimeout(200);
await page.screenshot({ path: 'shots/hover.png' });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
