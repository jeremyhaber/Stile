// v3.0 screenshots (settings window, Zap/Code, groups, folders, footer; light + dark). Same harness as overlay-e2e.mjs.
// Overlay end-to-end (original header): the extension in Chromium, wired through connector.js to the Node reference host
// (tools/fake-app/host-server.js), which this test uses as the "Mac app":
//  - the reference HostServer runs in-process and relays bridge envelopes over each profile's connection,
//  - a small HTTP server serves extension/ files and implements the bridgeHttp test transport
//    (POST /send, GET /events as SSE) plus the host messages (setPinned, setLaunchAtLogin, ...) and `hostState`.
// The overlay page (sidepanel.html?mode=overlay) runs against that transport via bridge-shim.js.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { HostServer, writeHostManifest } = require('./fake-app/host-server.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(ROOT, 'extension');
// The page is served from the same web root Stile.app ships (mac/copy-web.sh), not the raw extension folder,
// so a file missing from the app bundle fails here too.
const WEB = fs.mkdtempSync(path.join(os.tmpdir(), 'sbweb-')) + '/web';
execFileSync('bash', [path.join(ROOT, 'mac/copy-web.sh'), EXT, WEB]);
const SHOTS = process.env.V3_SHOTS || path.join(os.tmpdir(), 'v3-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbov-'));
const udd = path.join(tmp, 'udd');
const appDir = path.join(tmp, 'app');
fs.mkdirSync(path.join(udd, 'NativeMessagingHosts'), { recursive: true });
writeHostManifest(path.join(udd, 'NativeMessagingHosts'), path.join(ROOT, 'tools/fake-app/connector.js'));
const localState = path.join(tmp, 'Local State');
// One profile so the extension resolves its directory without identity.
fs.writeFileSync(localState, JSON.stringify({ profile: { profiles_order: ['Default'], info_cache: {
  Default: { name: 'Personal', user_name: '', profile_highlight_color: -12627531 },
} } }));
// The profile's Chrome theme: a green user colour (signed ARGB int), colour scheme "system".
const prefsFile = path.join(tmp, 'Default', 'Preferences');
const writePrefs = (theme) => { fs.mkdirSync(path.dirname(prefsFile), { recursive: true }); fs.writeFileSync(prefsFile, JSON.stringify({ browser: { theme } })); };
const GREEN = 0xff2e7d32 | 0;
writePrefs({ user_color: GREEN });
const fakeChrome = path.join(tmp, 'fake-chrome.sh');
fs.writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n');
fs.chmodSync(fakeChrome, 0o755);
const refApp = new HostServer({ appDir, localState, chromeBin: fakeChrome });
await refApp.listen();

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drag with a real gesture: press, move past the drag threshold, wait for empty Favourites/Pinned to be revealed (v2.5), then drop.
async function dragReveal(page, src, tgt) {
  await src.hover();
  const b = await src.boundingBox();
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 8, { steps: 4 });
  await sleep(400);
  await tgt.hover();
  await page.mouse.up();
}
async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
}

// ------------------------------------------------------------------ site pages (the "browsing" tabs)
const siteSrv = http.createServer((req, res) => {
  const n = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '').replace(/\.html$/, '') || 'index';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${n[0].toUpperCase() + n.slice(1)} page</title><h1>${n}</h1>`);
});
await new Promise((r) => siteSrv.listen(0, '127.0.0.1', r));
const SITE = siteSrv.address().port;
const U = (n) => `http://127.0.0.1:${SITE}/${n}.html`;

// ------------------------------------------------------------------ the "Mac app"
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const app = {
  fromExt: [], bridgeEvents: [], bridgeCalls: [], sse: new Set(), hostLog: [],
  host: { state: 'peek', compact: false, railWidth: 48, chromeColor: null, screenCapture: false, railFound: true, railControllable: true, launchAtLogin: false, lockstep: true, accessibility: true, appVersion: '2.1.0-test' },
};
// TEST-ONLY split hook: Chromium 141 has no split API, so tabs served to the page through this test transport can be stamped with a
// splitViewId (app.splitMap: tabId -> splitViewId). Production code paths are untouched.
app.splitMap = {};
// TEST-ONLY incognito hook (v2.6): the harness cannot enable "Allow in Incognito", so windows listed in app.incWins are served to the page as
// incognito (window.incognito / tab.incognito = true). Production code paths are untouched.
app.incWins = new Set();
const stampSplit = (o) => {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { o.forEach(stampSplit); return; }
  if (typeof o.id === 'number' && 'windowId' in o && 'index' in o) {
    o.splitViewId = app.splitMap[o.id] ?? -1;
    if (app.incWins.size) o.incognito = app.incWins.has(o.windowId);
  } else {
    if (app.incWins.size && typeof o.id === 'number' && 'focused' in o && 'state' in o) o.incognito = app.incWins.has(o.id);
    for (const v of Object.values(o)) stampSplit(v);
  }
};
const toSse = (obj) => {
  if ((Object.keys(app.splitMap).length || app.incWins.size) && (obj.type === 'bridgeResult' || obj.type === 'bridgeEvent')) { obj = JSON.parse(JSON.stringify(obj)); stampSplit(obj.result); stampSplit(obj.args); }
  const d = `data: ${JSON.stringify(obj)}\n\n`; for (const r of app.sse) r.write(d);
};
const toHelper = (msg) => refApp.sendBridge('Default', msg);
const hostState = () => toSse({ type: 'hostState', ...app.host });
const setHost = (patch) => { if (patch.state && !('compact' in patch)) patch = { ...patch, compact: patch.state === 'collapsed' }; Object.assign(app.host, patch); hostState(); refApp.setAppState(app.host); };
refApp.on('fromExt', ({ msg }) => {
  app.fromExt.push({ msg });
  if (msg.type === 'bridgeResult') toSse(msg);
  else if (msg.type === 'bridgeEvent') { app.bridgeEvents.push(msg); toSse(msg); }
});

const appSrv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    app.sse.add(res);
    req.on('close', () => app.sse.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/send') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let m; try { m = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (m.type === 'bridge') {
        app.bridgeCalls.push(m);
        // TEST-ONLY: Clear in a (stubbed) incognito window gets the incognito answer without touching the real tabs.
        if (m.call === 'sidebar.cmd' && m.args?.[0]?.cmd === 'clearToday' && app.incWins.has(m.args[0].windowId)) {
          toSse({ type: 'bridgeResult', id: m.id, ok: true, result: { ok: true, archived: 0, closed: 2, incognito: true } });
          res.writeHead(204).end(); return;
        }
        res.writeHead(toHelper(m) ? 204 : 503).end(); return;
      }
      if (m.type === 'host') {
        app.hostLog.push({ action: m.action, value: m.value, t: Date.now() });
        if (m.action === 'ready') hostState();
        if (m.action === 'setPinned') setHost({ state: m.value ? 'pinned' : 'peek' });
        if (m.action === 'setLaunchAtLogin') setHost({ launchAtLogin: !!m.value });
        if (m.action === 'setLockstep') setHost({ lockstep: !!m.value });
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
const lastHost = (a) => [...app.hostLog].reverse().find((x) => x.action === a);
const hostCount = (a) => app.hostLog.filter((x) => x.action === a).length;

let ctx;
async function finish(code) {
  try { await ctx?.close(); } catch { /* ignore */ }
  for (const r of app.sse) r.end();
  appSrv.close(); await refApp.close(); siteSrv.close();
  console.log(`\nScreenshots in ${SHOTS}`);
  process.exit(code);
}
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

async function main() {
  ctx = await chromium.launchPersistentContext(udd, {
    channel: 'chromium', headless: true, viewport: { width: 1200, height: 800 },
    env: { ...process.env, SIDEBAR_APP_DIR: appDir },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const swEval = (fn, arg) => sw.evaluate(fn, arg);
  const first = ctx.pages()[0] || await ctx.newPage();
  await first.goto(U('alpha'));
  for (const n of ['bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']) { const p = await ctx.newPage(); await p.goto(U(n)); }
  await sleep(300);
  const mainWin = await swEval(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1/*' }))[0]?.windowId ?? (await chrome.windows.getAll())[0].id);
  await until(() => refApp.isConnected('Default'), 20000, 200);
  await until(async () => (await swEval(async () => (await chrome.storage.session.get('helper')).helper))?.profiles?.length, 8000, 200);

  const pageUrl = `${APP}/sidepanel.html?mode=overlay&windowId=${mainWin}&bridgeHttp=${encodeURIComponent(APP)}`;
  const before = new Set(ctx.pages());
  await swEval(async (u) => chrome.windows.create({ url: u, type: 'popup', width: 320, height: 860 }), pageUrl);
  const panel = await until(() => ctx.pages().find((p) => !before.has(p) && p.url().startsWith(APP)), 8000, 100);
  await panel.setViewportSize({ width: 320, height: 760 });
  const cmd = (m) => panel.evaluate((x) => new Promise((res) => chrome.runtime.sendMessage(x, res)), m);
  await until(async () => (await panel.locator('[data-testid="today-row"]').count()) >= 5);
  setHost({ state: 'pinned', accessibility: true, screenCapture: true, appVersion: '3.0.0', launchAtLogin: false });
  await sleep(300);

  // ---- build state: pinned folder with children, two groups
  const tabs = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => ({ id: t.id, url: t.url })), mainWin);
  const tid = (n) => tabs.find((t) => t.url.includes('/' + n + '.html')).id;
  await cmd({ cmd: 'ensureRoots' });
  const pinnedRoot = await swEval(async () => (await chrome.storage.local.get('roots')).roots.pinned);
  await cmd({ cmd: 'pinTab', tabId: tid('alpha'), target: 'pinned' });
  const folder = await swEval(async (p) => (await chrome.bookmarks.create({ parentId: p, title: 'Reading list' })).id, pinnedRoot);
  await cmd({ cmd: 'pinTab', tabId: tid('bravo'), target: 'pinned', parentId: folder, index: 0 });
  await cmd({ cmd: 'pinTab', tabId: tid('charlie'), target: 'pinned', parentId: folder, index: 1 });
  const g1 = await swEval(async ([ids, w]) => { const g = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: w } }); await chrome.tabGroups.update(g, { title: 'Research', color: 'blue' }); return g; }, [[tid('delta'), tid('echo')], mainWin]);
  const g2 = await swEval(async ([ids, w]) => { const g = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: w } }); await chrome.tabGroups.update(g, { title: 'Later', color: 'orange', collapsed: true }); return g; }, [[tid('golf')], mainWin]);
  await swEval(async (id) => chrome.tabs.update(id, { active: true }), tid('echo'));
  await sleep(1200);

  const shotPanel = async (name, clipSel) => {
    for (const scheme of ['light', 'dark']) {
      await panel.emulateMedia({ colorScheme: scheme }); await sleep(450);
      const path_ = path.join(SHOTS, `${name}-${scheme}.png`);
      if (clipSel) {
        const box = await panel.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 6), width: innerWidth, height: Math.min(innerHeight - Math.max(0, r.top - 6), r.height + 12) }; }, clipSel);
        await panel.screenshot({ path: path_, clip: box || undefined });
      } else await panel.screenshot({ path: path_ });
    }
    await panel.emulateMedia({ colorScheme: 'light' });
  };
  if (!only || only.test('panel')) {
    await shotPanel('panel-expanded');
    await shotPanel('footer', '#footer');
    await shotPanel('pinned-folder-expanded', '#sec-pinned');
    await shotPanel('group-expanded', '.sec-today');
    setHost({ state: 'collapsed' }); await sleep(500);
    await panel.setViewportSize({ width: 320, height: 760 });
    await shotPanel('panel-compact');
    await shotPanel('pinned-folder-compact', '#sec-pinned');
    await shotPanel('footer-compact', '#footer');
    setHost({ state: 'pinned' }); await sleep(500);
  }
  if (!only || only.test('boost')) {
    await swEval(async (id) => chrome.tabs.update(id, { active: true }), tid('delta'));
    await cmd({ cmd: 'saveBoost', hostname: '127.0.0.1', patch: { css: 'h1{color:red}', zaps: [{ id: 'z1', selector: '.ad', label: 'Ad' }, { id: 'z2', selector: '#cookie', label: 'Cookie banner' }, { id: 'z3', selector: '.promo', label: 'Promo' }] } });
    await sleep(500);
    await panel.locator('[data-testid="boost-button"]').click(); await sleep(900);
    await shotPanel('zap-code');
    await panel.locator('[data-testid="code-button"]').click(); await sleep(700);
    await shotPanel('zap-code-open');
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(400);
  }
  if (!only || only.test('settings')) {
    await panel.locator('[data-testid="settings-button"]').click();
    const sp = await until(() => ctx.pages().find((p) => p.url().includes('settings.html')), 8000, 100);
    await sp.setViewportSize({ width: 860, height: 600 });
    await sleep(500);
    const SEC = ['general', 'appearance', 'tabs', 'windows', 'little', 'screenshots', 'boosts', 'profiles', 'app'];
    for (const scheme of ['light', 'dark']) {
      await sp.emulateMedia({ colorScheme: scheme });
      for (const id of SEC) {
        await sp.locator(`[data-testid="settings-nav-${id}"]`).click(); await sleep(250);
        await sp.screenshot({ path: path.join(SHOTS, `settings-${id}-${scheme}.png`) });
      }
      await sp.locator('[data-testid="settings-nav-screenshots"]').click();
      await sp.locator('[data-testid="capture-s3-endpoint"]').fill('https://abc123.r2.cloudflarestorage.com'); await sleep(200);
      await sp.locator('[data-testid="capture-upload-settings"]').scrollIntoViewIfNeeded();
      await sp.evaluate(() => { document.getElementById('pane-body').scrollTop = 420; }); await sleep(200);
      await sp.screenshot({ path: path.join(SHOTS, `settings-upload-${scheme}.png`) });
    }
    await sp.setViewportSize({ width: 520, height: 700 }); await sleep(300);
    await sp.emulateMedia({ colorScheme: 'light' });
    await sp.locator('[data-testid="settings-nav-screenshots"]').click(); await sleep(200);
    await sp.screenshot({ path: path.join(SHOTS, `settings-narrow.png`) });
  }
  await finish(0);
}
main().catch((e) => { console.error(e); finish(2); });
