// 動作確認用: ブラウザで開いてスクリーンショットとコンソールエラーを集める
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const url = process.argv[2] ?? 'http://localhost:4173/';
const out = process.argv[3] ?? 'shots/app.png';
const steps = process.argv[4] ? JSON.parse(process.argv[4]) : [];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1376, height: 1032 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForTimeout(1500);
for (const s of steps) {
  if (s.key) await page.keyboard.press(s.key);
  if (s.click) await page.mouse.click(s.click[0], s.click[1]);
  if (s.text) await page.getByText(s.text, { exact: true }).first().click();
  if (s.eval) console.log('eval:', JSON.stringify(await page.evaluate(s.eval)));
  if (s.drag) { const [x0, y0, x1, y1] = s.drag; await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10); await page.mouse.up(); }
  if (s.shot) await page.screenshot({ path: s.shot });
  await page.waitForTimeout(s.wait ?? 300);
}
await page.screenshot({ path: out });
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
