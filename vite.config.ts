import { defineConfig, type Plugin } from 'vite';

// 版の番号（ビルドした時刻）。公開ページの version.json と比べて、新しい版が出たかを判定する
const APP_VERSION = new Date().toISOString();
const versionFile = (): Plugin => ({
  name: 'kakupoly-version',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: APP_VERSION }) });
  },
});
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode single` で全部入りの単一HTML(dist-single/index.html)を作る。
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile()] : [versionFile()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
}));
