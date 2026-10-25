// Shared pieces of the demo runner: knobs, cursor overlay, frame recorder, throwaway browser + fake Mac app, mouse helpers.
// Fake data only: nothing here reads a real Chrome profile, Stile.app or its caches, or the real screen.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { pageHtml } from './sites.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { HostServer, writeHostManifest } = require('../../fake-app/host-server.js');

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
export const EXT = path.join(ROOT, 'extension');
export const OUT = process.env.DEMO_OUT || path.join(ROOT, 'docs', 'demos');
export const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// ---- tuning knobs (environment variables; see tools/demos/README.md)
const num = (k, d) => (process.env[k] && Number.isFinite(+process.env[k]) ? +process.env[k] : d);
export const KNOBS = {
  fps: num('DEMO_FPS', 12),               // GIF frame rate
  width: num('DEMO_WIDTH', 0),            // force every GIF to this width in px (0 = each scene's own width)
  pause: num('DEMO_PAUSE', 900),          // default pause between steps, ms (ctx.pause())
  hold: num('DEMO_HOLD', 1100),           // how long the last frame stays, ms
  colors: num('DEMO_COLORS', 128),        // palette size
  dither: process.env.DEMO_DITHER || 'bayer:bayer_scale=5',
  keepFrames: process.env.DEMO_KEEP_FRAMES === '1',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
}

// Frames go to a fresh temp dir (never inside the repo) unless DEMO_SCRATCH says otherwise.
let scratch = null, scratchOwned = false;
export function scratchDir() {
  if (scratch) return scratch;
  if (process.env.DEMO_SCRATCH) { scratch = process.env.DEMO_SCRATCH; fs.mkdirSync(scratch, { recursive: true }); }
  else { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stile-demos-')); scratchOwned = true; }
  return scratch;
}
export function cleanupScratch() {
  if (KNOBS.keepFrames || !scratch) return;
  if (scratchOwned) fs.rmSync(scratch, { recursive: true, force: true });
}

// ---- fake sites: one local server, Chromium maps each fake host to it
export async function startSites(SITES) {
  const srv = http.createServer((req, res) => {
    const key = Object.keys(SITES).find((k) => (req.headers.host || '').startsWith(SITES[k].host)) || Object.keys(SITES)[0];
    const sub = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pageHtml(SITES[key], sub));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    U: (k, sub = '') => `http://${SITES[k].host}/${sub}`,
    mapRules: Object.values(SITES).map((s) => `MAP ${s.host} 127.0.0.1:${port}`).join(','),
    close: () => srv.close(),
  };
}

// Cursor + click pulse, injected into every page of the context (extension pages included).
export const CURSOR_JS = `(() => {
  const mk = () => {
    if (document.getElementById('__demo_cursor')) return;
    const st = document.createElement('style');
    st.textContent = '@keyframes __dp{0%{transform:translate(-50%,-50%) scale(.3);opacity:.9}100%{transform:translate(-50%,-50%) scale(2.2);opacity:0}}';
    const c = document.createElement('div'); c.id = '__demo_cursor';
    c.style.cssText = 'position:fixed;left:-50px;top:-50px;width:0;height:0;z-index:2147483647;pointer-events:none';
    c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26" style="position:absolute;left:-2px;top:-1px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M2 1.5v18l4.6-4.2 3.2 7.2 3.3-1.5-3.2-7H17z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    (document.documentElement).append(st, c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px';
      const p = document.createElement('div');
      p.style.cssText = 'position:absolute;left:0;top:0;width:34px;height:34px;border-radius:50%;background:rgba(37,99,235,.35);border:2px solid rgba(37,99,235,.9);animation:__dp .55s ease-out forwards';
      c.append(p); setTimeout(() => p.remove(), 600);
    }, true);
  };
  if (document.documentElement) mk(); else addEventListener('DOMContentLoaded', mk);
  new MutationObserver(() => { if (document.documentElement && !document.getElementById('__demo_cursor')) mk(); }).observe(document, { childList: true });
})();`;


// ---- frame validation
// Chromium sometimes hands back a screenshot of the right size but with garbage content: the page drawn as a 2x2 grid of
// shrunken copies (seen when the page's surface is resized/re-composited, e.g. while an extension injects UI). The size is
// correct, so a dimension check cannot catch it. Detect it from the pixels: in a tiled frame the left half repeats in the
// right half and the top half in the bottom half, which no real page does.
function decodePngRows(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), d = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12] !== 0) return null; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[ct]; if (!bpp) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, px: out };
}
// true when the PNG is tiled (or cannot be decoded sensibly)
export function isTiledFrame(file) {
  let img; try { img = decodePngRows(fs.readFileSync(file)); } catch { return false; }
  if (!img || img.w < 8 || img.h < 8) return false;
  const { w, h, bpp, px } = img, hw = w >> 1, hh = h >> 1;
  const same = (ax, ay, bx, by, n, m) => {   // fraction of sampled pixels equal between two regions
    let eq = 0, tot = 0;
    for (let y = 0; y < m; y += 3) for (let x = 0; x < n; x += 3) {
      const i = ((ay + y) * w + ax + x) * bpp, j = ((by + y) * w + bx + x) * bpp;
      if (Math.abs(px[i] - px[j]) + Math.abs(px[i + 1] - px[j + 1]) + Math.abs(px[i + 2] - px[j + 2]) < 6) eq++; tot++;
    }
    return eq / tot;
  };
  return same(0, 0, hw, 0, hw, h) > 0.97 && same(0, 0, 0, hh, w, hh) > 0.97 && same(0, hh, hw, hh, hw, hh) > 0.97;
}

// ------------------------------------------------------------------ frame recording -> gif
// A recorder grabs frames from one or more "shooters" (page + optional clip) in a loop, timestamps them, and encodes
// with ffmpeg (palettegen/paletteuse). With two shooters the frames are placed side by side. With opts.stage (lib/stage.mjs)
// each frame is one composited stage screenshot instead (windows, zoom, captions), so there is a single stream.
export class Recorder {
  constructor(name, shooters, opts = {}) {
    this.name = name; this.shooters = shooters; this.opts = opts;
    this.dir = fs.mkdtempSync(path.join(scratchDir(), `frames-${name}-`));
    this.frames = []; this.running = false;
  }
  start() {
    this.running = true; this.t0 = Date.now();
    this.loop = (async () => {
      let i = 0;
      while (this.running) {
        const t = Date.now() - this.t0;
        try {
          if (this.opts.stage) { this.frames.push({ t, files: [await this.opts.stage.frame(this.dir, i)] }); i++; continue; }
          const shots = await Promise.all(this.shooters.map(async (s, k) => {
            const f = path.join(this.dir, `${String(i).padStart(5, '0')}-${k}.png`);
            // retake a garbled (tiled) capture; if it stays bad, skip the whole frame rather than ship it
            for (let tries = 0; tries < 3; tries++) {
              await s.page.screenshot({ path: f, clip: s.clip, animations: 'allow', caret: 'initial' });
              if (!isTiledFrame(f)) return f;
              this.dropped = (this.dropped || 0) + 1;
            }
            throw new Error('tiled frame');
          }));
          this.frames.push({ t, files: shots }); i++;
        } catch { /* page navigating: skip a frame */ }
      }
    })();
  }
  async stop(holdMs = KNOBS.hold) {
    this.running = false; await this.loop;
    this.holdMs = holdMs;
  }
  // stop recording, then write the GIF
  async finish(holdMs) {
    await this.stop(holdMs);
    try { return this.encode(); } finally { if (!KNOBS.keepFrames) fs.rmSync(this.dir, { recursive: true, force: true }); }
  }
  encode() {
    const width = KNOBS.width || this.opts.width || 480, fps = this.opts.fps || KNOBS.fps;
    const fr = this.frames; if (fr.length < 3) throw new Error(`${this.name}: only ${fr.length} frames`);
    const n = fr[0].files.length;
    const lists = [];
    for (let k = 0; k < n; k++) {
      const lines = fr.map((f, i) => `file '${f.files[k]}'\nduration ${(((fr[i + 1]?.t ?? (f.t + 80)) - f.t) / 1000).toFixed(3)}`);
      lines.push(`file '${fr[fr.length - 1].files[k]}'\nduration ${(this.holdMs / 1000).toFixed(3)}`, `file '${fr[fr.length - 1].files[k]}'`);
      const lf = path.join(this.dir, `list-${k}.txt`); fs.writeFileSync(lf, lines.join('\n')); lists.push(lf);
    }
    fs.mkdirSync(OUT, { recursive: true });
    const out = path.join(OUT, `${this.name}.gif`);
    const inputs = lists.flatMap((l) => ['-f', 'concat', '-safe', '0', '-i', l]);
    let pre;
    if (n === 1) pre = `[0:v]fps=${fps},scale=${width}:-1:flags=lanczos[v]`;
    else {
      const H = this.opts.height || 720;
      pre = lists.map((_, k) => `[${k}:v]fps=${fps},scale=-2:${H}:flags=lanczos[s${k}]`).join(';') + ';' + lists.map((_, k) => `[s${k}]`).join('') + `hstack=inputs=${n},scale=${width}:-1:flags=lanczos[v]`;
    }
    const graph = `${pre};[v]split[a][b];[a]palettegen=stats_mode=diff:max_colors=${this.opts.colors || KNOBS.colors}[p];[b][p]paletteuse=dither=${this.opts.dither || KNOBS.dither}:diff_mode=rectangle`;
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-loop', '0', out]);
    const bytes = fs.statSync(out).size;
    const hdr = fs.readFileSync(out).subarray(0, 10);
    return { out, bytes, dropped: (this.dropped || 0) + (this.opts.stage?.dropped || 0), seconds: (fr[fr.length - 1].t + this.holdMs) / 1000, frames: fr.length, width: hdr.readUInt16LE(6), height: hdr.readUInt16LE(8) };
  }
}


// ------------------------------------------------------------------ environment (one throwaway browser + fake Mac app per demo)
export async function makeEnv(opts = {}) {
  const WEB = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-web-')) + '/web';
  execFileSync('bash', [path.join(ROOT, 'mac/copy-web.sh'), EXT, WEB]);
  const { SITES, U, mapRules } = opts.sites;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-prof-'));
  const udd = path.join(tmp, 'udd'), appDir = path.join(tmp, 'app');
  fs.mkdirSync(path.join(udd, 'NativeMessagingHosts'), { recursive: true });
  writeHostManifest(path.join(udd, 'NativeMessagingHosts'), path.join(ROOT, 'tools/fake-app/connector.js'));
  const localState = path.join(tmp, 'Local State');
  const profiles = opts.profiles || [{ dir: 'Default', name: 'Personal', color: -12627531 }];
  fs.writeFileSync(localState, JSON.stringify({ profile: { profiles_order: profiles.map((p) => p.dir), info_cache: Object.fromEntries(profiles.map((p) => [p.dir, { name: p.name, user_name: '', profile_highlight_color: p.color }])) } }));
  for (const p of profiles) {
    const pf = path.join(tmp, p.dir, 'Preferences'); fs.mkdirSync(path.dirname(pf), { recursive: true });
    fs.writeFileSync(pf, JSON.stringify({ browser: { theme: { user_color: p.theme ?? (0xff2e7d32 | 0) } } }));
  }
  const fakeChrome = path.join(tmp, 'fake-chrome.sh'); fs.writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n'); fs.chmodSync(fakeChrome, 0o755);
  const refApp = new HostServer({ appDir, localState, chromeBin: fakeChrome });
  await refApp.listen();

  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const app = { sse: new Set(), host: { state: 'peek', compact: false, railWidth: 48, chromeColor: null, screenCapture: true, railFound: true, railControllable: true, launchAtLogin: false,accessibility: true, appVersion: '3.5.0' } };
  const toSse = (obj) => { const d = `data: ${JSON.stringify(obj)}\n\n`; for (const r of app.sse) r.write(d); };
  const setHost = (patch) => { if (patch.state && !('compact' in patch)) patch = { ...patch, compact: patch.state === 'collapsed' }; Object.assign(app.host, patch); toSse({ type: 'hostState', ...app.host }); refApp.setAppState(app.host); };
  refApp.on('fromExt', ({ msg }) => { if (msg.type === 'bridgeResult' || msg.type === 'bridgeEvent') toSse(msg); });
  const appSrv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n'); app.sse.add(res); req.on('close', () => app.sse.delete(res)); return;
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let m; try { m = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        if (m.type === 'bridge') { res.writeHead(refApp.sendBridge('Default', m) ? 204 : 503).end(); return; }
        if (m.type === 'host') {
          if (m.action === 'ready') toSse({ type: 'hostState', ...app.host });
          if (m.action === 'setPinned') setHost({ state: m.value ? 'pinned' : 'peek' });
          res.writeHead(204).end(); return;
        }
        res.writeHead(400).end();
      });
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    const rel = url.pathname === '/' ? '/sidepanel.html' : url.pathname;
    const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('nope'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => appSrv.listen(0, '127.0.0.1', r));
  const APP = `http://127.0.0.1:${appSrv.address().port}`;

  const ctx = await chromium.launchPersistentContext(udd, {
    channel: 'chromium', headless: true, viewport: { width: 900, height: 760 }, deviceScaleFactor: 2,
    env: { ...process.env, SIDEBAR_APP_DIR: appDir },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=${mapRules}`],
  });
  await ctx.addInitScript(CURSOR_JS);
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const swEval = (fn, arg) => sw.evaluate(fn, arg);

  const env = { ctx, sw, swEval, refApp, app, setHost, APP, tmp, appSrv, WEB };
  env.close = async () => {
    try { await ctx.close(); } catch { /* ignore */ }
    for (const r of app.sse) r.end();
    appSrv.close(); await refApp.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(path.dirname(WEB), { recursive: true, force: true });
  };

  // open site tabs
  const tabsToOpen = opts.tabs || Object.keys(SITES).slice(0, 8);
  const first = ctx.pages()[0] || await ctx.newPage();
  env.pages = {};
  await first.goto(U(tabsToOpen[0])); env.pages[tabsToOpen[0]] = first;
  for (const k of tabsToOpen.slice(1)) { const p = await ctx.newPage(); await p.goto(U(k)); env.pages[k] = p; }
  await sleep(500);
  env.mainWin = await swEval(async () => (await chrome.windows.getAll())[0].id);
  await until(() => refApp.isConnected('Default'), 20000, 200);
  await until(async () => (await swEval(async () => (await chrome.storage.session.get('helper')).helper))?.profiles?.length, 8000, 200);

  const pageUrl = `${APP}/sidepanel.html?mode=overlay&windowId=${env.mainWin}&bridgeHttp=${encodeURIComponent(APP)}`;
  const before = new Set(ctx.pages());
  await swEval(async (u) => chrome.windows.create({ url: u, type: 'popup', width: 320, height: 860 }), pageUrl);
  const panel = await until(() => ctx.pages().find((p) => !before.has(p) && p.url().startsWith(APP)), 8000, 100);
  await panel.setViewportSize({ width: opts.panelW || 320, height: opts.panelH || 720 });
  env.panel = panel;
  env.cmd = (m) => panel.evaluate((x) => new Promise((res) => chrome.runtime.sendMessage(x, res)), m);
  await until(async () => (await panel.locator('[data-testid="today-row"]').count()) >= Math.min(5, tabsToOpen.length));
  setHost({ state: 'pinned', accessibility: true, screenCapture: true, appVersion: '3.5.0' });
  await env.cmd({ cmd: 'ensureRoots' });
  env.tid = async (k) => (await swEval(async (h) => (await chrome.tabs.query({})).find((t) => (t.url || '').includes(h))?.id, SITES[k].host));
  env.roots = await swEval(async () => (await chrome.storage.local.get('roots')).roots);
  await sleep(600);
  env.panel.on('pageerror', (e) => console.log('  [panel error]', String(e).slice(0, 160)));
  return env;
}


// ------------------------------------------------------------------ mouse helpers (glide + click) with a clip guard
// Every action that targets an element or a point is checked against the clip of every shooter recording that page
// (no clip = the whole viewport). Anything outside the frame throws, so a GIF can never click something the viewer
// cannot see. Scenes must act only through these helpers (never page.mouse / page.keyboard directly).
// Coordinates are CSS pixels of the page viewport, the same space Playwright uses for both page.mouse and screenshot clips.
const ease = (t) => t * t * (3 - 2 * t);
const fmtBox = (b) => `{x:${Math.round(b.x)}, y:${Math.round(b.y)}, w:${Math.round(b.width)}, h:${Math.round(b.height)}}`;
// Only one fake cursor may be visible at a time (a composited frame shows several pages): the page being driven owns it.
let cursorPage = null;
async function claimCursor(page) {
  if (cursorPage === page) return;
  const set = (p, show) => p.evaluate((show) => { const c = document.getElementById('__demo_cursor'); if (c) c.style.display = show ? '' : 'none'; }, show).catch(() => {});
  if (cursorPage) await set(cursorPage, false);
  cursorPage = page; await set(page, true);
}
export const mouse = (page, guard = {}) => {
  let cx = 160, cy = 360, dragging = false;
  // During a native HTML5 drag the browser stops sending mousemove, so the injected cursor would freeze at the drag source.
  // While dragging, move the cursor overlay ourselves.
  const syncCursor = (x, y) => page.evaluate(([x, y]) => { const c = document.getElementById('__demo_cursor'); if (c) { c.style.left = x + 'px'; c.style.top = y + 'px'; } }, [x, y]);
  const scene = guard.scene || '(unnamed scene)';
  // Throws unless `box` lies fully inside the clip of every shooter that records `page`.
  const check = async (action, box, what = '') => {
    await claimCursor(page);
    const shooters = (guard.shooters?.() || []).filter((s) => s.page === page);
    if (!shooters.length) throw new Error(`[demo guard] scene "${scene}": ${action}${what} acts on a page that no shooter records`);
    let vp = null;
    for (const s of shooters) {
      // composited scenes: the stage says where this page really appears (window shown, zoom, covered by another window)
      if (s.visible) { const why = await s.visible(box); if (why) throw new Error(`[demo guard] scene "${scene}": ${action}${what} target ${fmtBox(box)} is not visible in the composited frame: ${why}`); continue; }
      let c = s.clip;
      if (!c) { vp ||= await page.evaluate(() => ({ w: innerWidth, h: innerHeight })); c = { x: 0, y: 0, width: vp.w, height: vp.h }; }
      const eps = 0.5;
      if (box.x < c.x - eps || box.y < c.y - eps || box.x + box.width > c.x + c.width + eps || box.y + box.height > c.y + c.height + eps) {
        throw new Error(`[demo guard] scene "${scene}": ${action}${what} target ${fmtBox(box)} is outside the recorded clip ${fmtBox(c)}`);
      }
    }
  };
  const boxOf = async (loc, action) => {
    const b = await loc.boundingBox();
    if (!b) throw new Error(`[demo guard] scene "${scene}": ${action} target has no bounding box (not visible)`);
    await check(action, b, ` on ${String(loc)}`);
    return b;
  };
  const m = {
    check,
    async to(x, y, ms = 420) {
      await check('move', { x, y, width: 0, height: 0 });
      const n = Math.max(6, Math.round(ms / 28));
      const x0 = cx, y0 = cy;
      for (let i = 1; i <= n; i++) { const e = ease(i / n); await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e); if (dragging) await syncCursor(x0 + (x - x0) * e, y0 + (y - y0) * e); await sleep(ms / n); }
      cx = x; cy = y;
    },
    async center(loc, ms, action = 'move') { const b = await boxOf(loc, action); await m.to(b.x + b.width / 2, b.y + b.height / 2, ms); return b; },
    async hover(loc, ms) { return m.center(loc, ms, 'hover'); },
    async click(loc, ms) { await m.center(loc, ms, 'click'); await sleep(120); await page.mouse.down(); await sleep(90); await page.mouse.up(); await sleep(140); },
    async dblclick(loc, ms) { await m.center(loc, ms, 'dblclick'); await sleep(120); await page.mouse.dblclick(cx, cy); await sleep(200); },
    async rightClick(loc, ms) { await m.center(loc, ms, 'rightClick'); await sleep(120); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await sleep(200); },
    // glide to a point and click it (for things with no locator, e.g. a closed shadow root or a canvas)
    async clickAt(x, y, ms) { await m.to(x, y, ms); await sleep(120); await page.mouse.down(); await sleep(90); await page.mouse.up(); await sleep(140); },
    // raw press / release at the current position (hand-rolled drags on a canvas); position was checked by to()
    async down() { await check('mousedown', { x: cx, y: cy, width: 0, height: 0 }); await page.mouse.down(); },
    async up() { await check('mouseup', { x: cx, y: cy, width: 0, height: 0 }); await page.mouse.up(); },
    // type into whatever is focused; the focused element must be inside the clip
    async type(text, opts) {
      const b = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      if (b) await check('type', b, ' into the focused element');
      else throw new Error(`[demo guard] scene "${scene}": type with nothing focused`);
      await page.keyboard.type(text, opts);
    },
    async press(key) {
      const b = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      if (b) await check('press ' + key, b, ' on the focused element');
      await page.keyboard.press(key);
    },
    // press, wiggle past the drag threshold, glide to target, release. Source and target (or tx/ty) must both be in frame.
    async drag(src, tgt, { ms = 700, tx, ty } = {}) {
      await m.center(src, 380, 'drag source');
      await sleep(120); await page.mouse.down(); await sleep(100); dragging = true;
      await page.mouse.move(cx + 10, cy + 10, { steps: 4 }); cx += 10; cy += 10; await syncCursor(cx, cy);
      await sleep(450);
      // measure the target only now: starting a drag can reveal drop zones and shift the layout
      const b = await tgt.boundingBox();
      if (!b) throw new Error(`[demo guard] scene "${scene}": drag target has no bounding box`);
      await check('drag target', b, ` on ${String(tgt)}`);
      await m.to(tx ?? b.x + b.width / 2, ty ?? b.y + b.height / 2, ms);
      await sleep(350); await page.mouse.up(); dragging = false; await sleep(250);
    },
    pos: () => [cx, cy],
  };
  return m;
};
