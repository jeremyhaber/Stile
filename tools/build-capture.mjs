// Builds the screenshot editor: extension/capture/src/main.tsx -> extension/capture/dist/capture.{js,css}
// Usage: cd tools/capture-build && npm install && npm run build   (the built files are committed)
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, 'capture-build', 'package.json'));
const esbuild = require('esbuild');
const root = path.resolve(here, '..', 'extension', 'capture');
const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: [path.join(root, 'src', 'main.tsx')],
  outdir: path.join(root, 'dist'),
  entryNames: 'capture',
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome116',
  jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.css': 'css' },
  nodePaths: [path.join(here, 'capture-build', 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
};
fs.mkdirSync(opts.outdir, { recursive: true });
if (watch) { const ctx = await esbuild.context(opts); await ctx.watch(); console.log('watching…'); }
else {
  const r = await esbuild.build(opts);
  for (const f of fs.readdirSync(opts.outdir)) console.log(f, (fs.statSync(path.join(opts.outdir, f)).size / 1024).toFixed(1) + ' KB');
  void r;
}
