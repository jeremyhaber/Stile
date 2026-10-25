#!/usr/bin/env node
// Rebuilds the README demo GIFs (docs/demos/*.gif).
//   node tools/demos/build.mjs                 every scene
//   node tools/demos/build.mjs favourites zap  just these
//   node tools/demos/build.mjs --list          list scenes and what a plain run would do (nothing is built)
// Native scenes (`native: true`, macOS only, they briefly open a debug Stile.app window and capture only that window) are skipped by a
// plain run; build them by naming them (`recording`), or with --native / DEMO_NATIVE=1 to include them in a full run.
// See tools/demos/README.md for the knobs, prerequisites and how to add a scene. Fake data only (fixtures.mjs).
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { SITES, TABS } from './fixtures.mjs';
import { Stage } from './lib/stage.mjs';
import { KNOBS, ROOT, sleep, until, makeEnv, mouse, Recorder, startSites, cleanupScratch } from './lib/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = (id) => `[data-testid="${id}"]`;

// discover scenes: one file per demo in scenes/
const scenes = [];
for (const f of fs.readdirSync(path.join(here, 'scenes')).filter((x) => x.endsWith('.mjs')).sort()) {
  const mod = (await import(pathToFileURL(path.join(here, 'scenes', f)).href)).default;
  if (mod) scenes.push({ ...mod, file: f });
}
const args = process.argv.slice(2);
const want = args.filter((a) => !a.startsWith('--'));
const nativeOn = args.includes('--native') || process.env.DEMO_NATIVE === '1';
const unknown = want.filter((w) => !scenes.some((s) => s.name === w));
if (unknown.length) { console.error(`unknown scene(s): ${unknown.join(', ')} (have: ${scenes.map((s) => s.name).join(', ')})`); process.exit(2); }
// named scenes always run (naming a native scene is the explicit opt-in); a plain run skips native ones unless --native / DEMO_NATIVE=1
const skipNative = (s) => s.native && !want.length && !nativeOn;
if (args.includes('--list')) {
  for (const s of scenes) console.log(`${s.name}${s.native ? '  (native)' : ''}${skipNative(s) ? '  -> skipped by a plain run (use --native or name it)' : ''}`);
  process.exit(0);
}
const todo = (want.length ? scenes.filter((s) => want.includes(s.name)) : scenes).filter((s) => {
  if (!skipNative(s)) return true;
  console.log(`> ${s.name}: native scene, skipped (opens a debug Stile.app window briefly; run \`build.mjs ${s.name}\` or pass --native / DEMO_NATIVE=1)`);
  return false;
});

const sites = await startSites(SITES);
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.round(b / 1024) + ' KB');
let failed = 0;

for (const scene of todo) {
  console.log(`> ${scene.name}`);
  const cleanups = [];
  let env, shooters = [], stage = null;
  try {
    env = await makeEnv({
      sites: { SITES, U: sites.U, mapRules: sites.mapRules },
      tabs: scene.tabs || TABS.standard, panelW: scene.panelW, panelH: scene.panelH,
    });
    const ctx = {
      env, panel: env.panel, pages: env.pages, browser: env.ctx, cmd: env.cmd, swEval: env.swEval, tid: env.tid,
      SITES, U: sites.U, T, sleep, until,
      // mouse helpers are guarded: every target must lie inside the clip of each shooter recording that page
      mouse: (page) => mouse(page, { scene: scene.name, shooters: () => [...shooters, ...(stage ? stage.guardShooters() : [])] }),
      // captions: true in the scene reserves a caption bar under the picture; ctx.caption('text') sets it, ctx.caption(null) clears it
      caption: (text) => { if (!stage || !scene.captions) throw new Error(`scene "${scene.name}": set captions: true to use ctx.caption`); return stage.caption(text); },
      pause: (ms) => sleep(ms ?? KNOBS.pause),
      row: (title) => env.panel.locator(`${T('today-row')}:has-text("${title}")`).first(),
      pin: async (key, target, extra = {}) => env.cmd({ cmd: 'pinTab', tabId: await env.tid(key), target, ...extra }),
      activate: async (key) => env.swEval(async (id) => chrome.tabs.update(id, { active: true }), await env.tid(key)),
      onCleanup: (fn) => cleanups.push(fn),
    };
    // composited scenes (scene.stage = { width, height }) get a stage page; so does any scene with captions
    if (scene.stage) { stage = await Stage.launch({ ...scene.stage, captions: !!scene.captions }); ctx.stage = stage; }
    await scene.setup?.(ctx);
    shooters = scene.stage ? [] : scene.shooters ? scene.shooters(ctx) : [{ page: env.panel, clip: scene.clip }];
    if (scene.captions && !scene.stage) { stage = await Stage.auto(shooters, { height: scene.height || 720, captions: true, finalWidth: scene.width }); ctx.stage = stage; }
    const output = scene.output || `${scene.name}.gif`;
    const rec = new Recorder(path.basename(output, '.gif'), shooters, { width: scene.width, height: scene.height, fps: scene.fps, colors: scene.colors, stage: stage && stage.built !== false ? stage : null });
    rec.start();
    try { await sleep(scene.lead ?? KNOBS.pause); await scene.run(ctx); }
    catch (e) { rec.running = false; await rec.loop; throw e; }
    const r = await rec.finish(scene.hold);
    console.log(`  ${path.relative(ROOT, r.out)}  ${fmtSize(r.bytes)}  ${r.seconds.toFixed(1)}s  ${r.width}x${r.height}${r.dropped ? `  (${r.dropped} garbled captures retaken)` : ''}`);
    if (r.bytes > 5 * 1048576) console.log('  WARNING: over the 5 MB cap');
  } catch (e) {
    failed++; console.log(`  FAILED ${scene.name}: ${(e && e.stack) || e}`);
  } finally {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* ignore */ } }
    if (stage) await stage.close();
    if (env) await env.close();
  }
}
sites.close();
cleanupScratch();
process.exit(failed ? 1 : 0);
