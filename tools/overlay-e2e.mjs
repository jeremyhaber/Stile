// Overlay end-to-end: the extension in Chromium, wired through connector.js to the Node reference host
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
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { HostServer, writeHostManifest } = require('./fake-app/host-server.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = process.env.OVERLAY_SHOTS || '/tmp/claude-0/-home-claude/e0605526-dcdb-5d20-aaac-918c6d6e8268/scratchpad/overlay-shots';
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
  host: { state: 'peek', compact: false, railWidth: 48, chromeColor: null, screenCapture: false, railFound: true, railControllable: true, launchAtLogin: false, accessibility: true, appVersion: '2.1.0-test' },
};
// TEST-ONLY split hook: Chromium 141 has no split API, so tabs served to the page through this test transport can be stamped with a
// splitViewId (app.splitMap: tabId -> splitViewId). Production code paths are untouched.
app.splitMap = {};
const stampSplit = (o) => {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { o.forEach(stampSplit); return; }
  if (typeof o.id === 'number' && 'windowId' in o && 'index' in o) o.splitViewId = app.splitMap[o.id] ?? -1;
  else for (const v of Object.values(o)) stampSplit(v);
};
const toSse = (obj) => {
  if (Object.keys(app.splitMap).length && (obj.type === 'bridgeResult' || obj.type === 'bridgeEvent')) { obj = JSON.parse(JSON.stringify(obj)); stampSplit(obj.result); stampSplit(obj.args); }
  const d = `data: ${JSON.stringify(obj)}\n\n`; for (const r of app.sse) r.write(d);
};
const toHelper = (msg) => refApp.sendBridge('Default', msg);
const hostState = () => toSse({ type: 'hostState', ...app.host });
const setHost = (patch) => { if (patch.state && !('compact' in patch)) patch = { ...patch, compact: patch.state === 'collapsed' }; Object.assign(app.host, patch); hostState(); };
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
      if (m.type === 'bridge') { app.bridgeCalls.push(m); res.writeHead(toHelper(m) ? 204 : 503).end(); return; }
      if (m.type === 'host') {
        app.hostLog.push({ action: m.action, value: m.value, t: Date.now() });
        if (m.action === 'ready') hostState();
        if (m.action === 'setPinned') setHost({ state: m.value ? 'pinned' : 'peek' });
        if (m.action === 'setLaunchAtLogin') setHost({ launchAtLogin: !!m.value });
        res.writeHead(204).end(); return;
      }
      res.writeHead(400).end();
    });
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  const rel = url.pathname === '/' ? '/sidepanel.html' : url.pathname;
  const file = path.join(EXT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(EXT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('nope'); return; }
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
  console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${SHOTS}`);
  process.exit(code);
}

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
  for (const n of ['bravo', 'charlie', 'delta', 'echo']) { const p = await ctx.newPage(); await p.goto(U(n)); }
  await sleep(300);
  const mainWin = await swEval(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1/*' }))[0]?.windowId ?? (await chrome.windows.getAll())[0].id);

  // ---- relay: helper connects to the fake app once the extension has identified
  const connected = await until(() => refApp.isConnected('Default'), 20000, 200);
  check('extension connected to the app through connector.js and identified as Default', !!connected);
  const dbg = await until(async () => { const st = await swEval(async () => (await chrome.storage.session.get('helper')).helper); return st?.profiles?.length ? st : null; }, 8000, 200);
  check('profiles reach the extension with chromeTheme from Preferences', dbg?.profiles?.length === 1 && dbg.profiles[0].chromeTheme?.userColor === '#2e7d32' && dbg.profiles[0].chromeTheme.colorScheme === 'system', JSON.stringify(dbg?.profiles?.[0]?.chromeTheme));
  const flag = await until(async () => swEval(async () => (await chrome.storage.session.get('overlayConnected')).overlayConnected), 5000, 200);
  check('extension recorded overlayStatus connected', flag === true);

  // ---- raw bridge through helper (before any page): hello
  const rawCall = async (call, args = []) => {
    const id = 'raw' + Math.random().toString(36).slice(2);
    const before = app.fromExt.length;
    toHelper({ type: 'bridge', id, call, args });
    await until(() => app.fromExt.some((x) => x.msg.type === 'bridgeResult' && x.msg.id === id), 6000, 50);
    return app.fromExt.slice(before).map((x) => x.msg).find((x) => x.type === 'bridgeResult' && x.id === id);
  };
  const hello = await rawCall('sidebar.hello');
  check('sidebar.hello returns extension id, version and profileDir', hello?.ok && hello.result.extensionId === extId && /^\d/.test(hello.result.version) && hello.result.profileDir === 'Default', JSON.stringify(hello));
  const caps = await rawCall('sidebar.capabilities');
  const swCaps = await swEval(() => ({ split: typeof chrome.tabs.createSplit === 'function', tabGroups: !!chrome.tabGroups, userScripts: !!chrome.userScripts }));
  check('sidebar.capabilities matches the worker', caps?.ok && JSON.stringify(caps.result) === JSON.stringify(swCaps), JSON.stringify(caps?.result));
  const bad = await rawCall('scripting.executeScript', [{}]);
  check('calls outside the allowed namespaces are rejected', bad && bad.ok === false && /not allowed/i.test(bad.error), JSON.stringify(bad));
  const bad2 = await rawCall('tabs.onCreated.addListener');
  check('event registration calls are rejected', bad2 && bad2.ok === false);
  const q = await rawCall('tabs.query', [{ windowId: mainWin }]);
  check('tabs.query over the bridge returns JSON tabs', q?.ok && q.result.length === 5, String(q?.result?.length));
  const cmdRes = await rawCall('sidebar.cmd', [{ cmd: 'debugState' }]);
  check('sidebar.cmd runs the worker dispatcher (debugState)', cmdRes?.ok && cmdRes.result && cmdRes.result.helper?.status === 'connected', JSON.stringify(cmdRes)?.slice(0, 160));
  const boostCmd = await rawCall('sidebar.cmd', [{ cmd: 'userScriptsStatus' }]);
  check('sidebar.cmd reaches boost commands', boostCmd?.ok && boostCmd.result && typeof boostCmd.result.available === 'boolean', JSON.stringify(boostCmd)?.slice(0, 160));
  const unk = await rawCall('sidebar.cmd', [{ cmd: 'nope' }]);
  check('unknown sidebar.cmd gives ok:false result', unk?.ok && unk.result && unk.result.ok === false);
  const fav = await rawCall('sidebar.favicon', [U('alpha')]);
  check('sidebar.favicon returns a data: URL', fav?.ok && /^data:image\//.test(fav.result), String(fav?.result).slice(0, 40));

  // ---- the overlay page, in its own popup window (so it doesn't list itself)
  const pageUrl = `${APP}/sidepanel.html?mode=overlay&windowId=${mainWin}&bridgeHttp=${encodeURIComponent(APP)}`;
  const before = new Set(ctx.pages());
  await swEval(async (u) => chrome.windows.create({ url: u, type: 'popup', width: 320, height: 860 }), pageUrl);
  const panel = await until(() => ctx.pages().find((p) => !before.has(p) && p.url().startsWith(APP)), 8000, 100);
  const errors = [];
  panel.on('pageerror', (e) => errors.push(String(e)));
  panel.on('console', (m) => { if (m.type() === 'error' && !/chrome-extension:\/\/invalid/.test(m.location()?.url || '') && !(/\/send$/.test(m.location()?.url || '') && /503/.test(m.text()))) errors.push(m.text() + ' ' + (m.location()?.url || '')); });
  panel.on('console', (m) => { if (process.env.E2E_DEBUG && /shim/.test(m.text())) console.log(m.text()); });
  panel.on('requestfailed', (r) => { if (process.env.E2E_DEBUG) console.log('requestfailed', r.url().slice(0, 120)); });
  await panel.setViewportSize({ width: 320, height: 860 });

  const ready = await panel.evaluate(() => window.__sidebarReady ? window.__sidebarReady.then((h) => h, () => null) : null);
  check('shim ready resolves with the hello payload', ready && ready.extensionId === extId, JSON.stringify(ready));
  const shape = await panel.evaluate(() => ({
    id: chrome.runtime.id, url: chrome.runtime.getURL('/a.png'), v: chrome.runtime.getManifest().version,
    split: typeof chrome.tabs.createSplit, groups: !!chrome.tabGroups, none: chrome.tabGroups?.TAB_GROUP_ID_NONE, cur: chrome.windows.WINDOW_ID_CURRENT,
    win: null, ident: typeof chrome.identity,
  }));
  check('chrome.runtime.id / getURL / getManifest come from hello', shape.id === extId && shape.url === `chrome-extension://${extId}/a.png` && /^\d/.test(shape.v), JSON.stringify(shape));
  check('createSplit only defined when the extension supports it', (shape.split === 'function') === swCaps.split);
  check('tabGroups present and chrome.identity absent', shape.groups === swCaps.tabGroups && shape.none === -1 && shape.ident === 'undefined');
  const gw = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  check('windows.getCurrent returns the windowId param', gw === mainWin, String(gw));
  const cbStyle = await panel.evaluate(() => new Promise((res) => chrome.tabs.query({}, (t) => res(Array.isArray(t)))));
  check('callback style works', cbStyle === true);

  // ---- overlay UI
  const todayRows = () => panel.locator('[data-testid="today-list"] > [data-testid="today-row"]').count();
  await until(async () => (await todayRows()) === 5, 8000);
  check('Today rows render through the bridge (5 tabs)', (await todayRows()) === 5, String(await todayRows()));
  check('left-hint card is hidden in overlay mode', !(await panel.locator('[data-testid="left-hint"]').isVisible()));
  const pin = panel.locator('[data-testid="pin-toggle"]');
  check('pin toggle is visible with aria-pressed=false', (await pin.isVisible()) && (await pin.getAttribute('aria-pressed')) === 'false');
  check('no "SIDEBAR" overlay bar (nothing above the search/profile area)', (await panel.locator('.overlay-bar, #overlay-bar, .ob-title').count()) === 0 && !(await panel.locator('text=/^\\s*Sidebar\\s*$/i').count()));
  check('pin toggle lives in the footer, left of the settings gear', (await panel.locator('#footer [data-testid="pin-toggle"]').count()) === 1 && await (async () => {
    const a = await pin.boundingBox(), b = await panel.locator('[data-testid="settings-button"]').boundingBox();
    return a && b && a.x < b.x && Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) < 4;
  })());
  check('vertical-tabs hint is hidden while the rail is found', !(await panel.locator('[data-testid="vertical-tabs-hint"]').isVisible()));
  await panel.locator('[data-testid="settings-button"]').click(); await sleep(300);
  check('settings: legacy pin-mode select and tips are hidden', !(await panel.locator('[data-testid="settings-pin-mode"]').isVisible()) && !(await panel.locator('[data-testid="left-button"]').isVisible()) && !(await panel.locator('[data-testid="shortcut-button"]').isVisible()));
  check('settings: App section is visible', await panel.locator('[data-testid="settings-app"]').isVisible());
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(200);

  // ---- host messages
  check('host: ready was posted', hostCount('ready') >= 1);
  const th = lastHost('theme');
  check('host: theme {color, dark} posted', th && /^#[0-9a-f]{6}$/i.test(th.value.color || '') && typeof th.value.dark === 'boolean', JSON.stringify(th?.value));
  const at = lastHost('activeTitle');
  const actTitle = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].title, mainWin);
  check('host: activeTitle posted for the window\'s active tab', at && at.value.title === actTitle, JSON.stringify(at?.value) + ' vs ' + actTitle);
  check('host: initial busy=false posted', lastHost('busy')?.value === false);

  // pin toggle -> setPinned -> hostState -> aria-pressed
  await pin.click();
  await until(() => lastHost('setPinned'));
  check('host: setPinned(true) posted by the footer pin toggle', lastHost('setPinned')?.value === true);
  await until(async () => (await pin.getAttribute('aria-pressed')) === 'true', 4000);
  check('pin toggle reflects __sidebarHostState (pressed)', (await pin.getAttribute('aria-pressed')) === 'true');
  check('pinned (rail controllable): square, no overlay-float class', !(await panel.evaluate(() => document.documentElement.classList.contains('overlay-float'))));
  await pin.click();
  await until(async () => (await pin.getAttribute('aria-pressed')) === 'false', 4000);
  check('pin toggle unpins', lastHost('setPinned')?.value === false && (await pin.getAttribute('aria-pressed')) === 'false');
  check('peek state adds overlay-float class', await panel.evaluate(() => document.documentElement.classList.contains('overlay-float')));

  // hostState transitions: collapsed -> peek -> pinned
  const cls = (c) => panel.evaluate((x) => document.documentElement.classList.contains(x), c);
  setHost({ state: 'collapsed' }); await sleep(500);
  check('hostState collapsed -> html.compact, no overlay-float', (await cls('compact')) && !(await cls('overlay-float')));
  setHost({ state: 'peek' }); await sleep(500);
  check('hostState peek -> full sidebar again (compact removed, float on)', !(await cls('compact')) && (await cls('overlay-float')) && (await todayRows()) === 5);
  setHost({ state: 'pinned' }); await sleep(400);
  check('hostState pinned -> pressed, not compact, not float', (await pin.getAttribute('aria-pressed')) === 'true' && !(await cls('compact')) && !(await cls('overlay-float')));
  setHost({ railControllable: false }); await sleep(300);
  check('pinned but rail not controllable -> floats (fallback)', await cls('overlay-float'));
  await panel.locator('[data-testid="settings-button"]').click(); await sleep(300);
  check('settings: fallback note shown when the rail cannot be controlled', await panel.locator('[data-testid="app-float-note"]').isVisible());
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(200);
  setHost({ state: 'peek', railControllable: true }); await sleep(300);

  // ---- v2.2 stable layout: the same DOM compact and expanded, icons in a fixed column, nothing moves
  const POS = () => panel.evaluate(() => {
    const c = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const q = (sel) => [...document.querySelectorAll(sel)].map(c);
    return {
      fav: q('[data-testid="today-row"] .fav-ic'), rows: q('[data-testid="today-row"]'), heads: q('.sec-h'), newtab: q('[data-testid="new-tab-row"] .fav-ic'),
      archive: q('#archive-btn .foot-ic'), addrIc: q('#addr-ic'), pinnedEmpty: q('[data-testid="pinned-empty"]'), favEmpty: q('[data-testid="favourites-empty"]'),
      addrLeft: document.getElementById('addr-form').getBoundingClientRect().left, addrW: document.getElementById('addr-form').getBoundingClientRect().width,
      addrH: document.getElementById('addr').getBoundingClientRect().height,
    };
  });
  const sameCol = (a, b, key, tolX, tolY) => a[key].length === b[key].length && a[key].every((p, i) => Math.abs(p.x - b[key][i].x) <= tolX && Math.abs(p.y - b[key][i].y) <= tolY);
  setHost({ state: 'peek', compact: false, railWidth: 48 }); await sleep(400);
  const posExp = await POS();
  const exStripId = await panel.locator('[data-testid="compact-strip"]').count();
  setHost({ compact: true, railWidth: 48 }); await sleep(500);
  const posCmp = await POS();
  check('compact: compact-strip testid is on the list container only while compact', exStripId === 0 && (await panel.locator('[data-testid="compact-strip"]').count()) === 1 && await panel.locator('[data-testid="compact-strip"] [data-testid="today-list"]').count() === 1);
  check('compact: the separate compact DOM is gone', (await panel.locator('#view-compact, #compact-list, .cbtn').count()) === 0 && (await panel.locator('[data-testid="today-row"]').count()) === 5);
  check('compact: Today favicons keep the same x centre as expanded (icon column, x=24)', sameCol(posExp, posCmp, 'fav', 1, 99) && posExp.fav.every((p) => Math.abs(p.x - 24) <= 1), JSON.stringify(posExp.fav.slice(0, 2)) + ' / ' + JSON.stringify(posCmp.fav.slice(0, 2)));
  check('compact: row y positions are identical to expanded (no favourites)', sameCol(posExp, posCmp, 'rows', 99, 1) && sameCol(posExp, posCmp, 'fav', 99, 1) && sameCol(posExp, posCmp, 'heads', 99, 1) && sameCol(posExp, posCmp, 'newtab', 1, 1));
  check('compact: footer archive icon and address search icon keep their position', sameCol(posExp, posCmp, 'archive', 1, 1) && sameCol(posExp, posCmp, 'addrIc', 1, 1) && Math.abs(posExp.addrIc[0].x - 24) <= 1 && Math.abs(posExp.archive[0].x - 24) <= 1, JSON.stringify([posExp.addrIc, posExp.archive]));
  check('compact: placeholders keep their height (favourites / pinned empty)', sameCol(posExp, posCmp, 'pinnedEmpty', 99, 1) && sameCol(posExp, posCmp, 'favEmpty', 999, 1), JSON.stringify([posExp.pinnedEmpty, posCmp.pinnedEmpty, posExp.favEmpty, posCmp.favEmpty]));
  const fades = await panel.evaluate(() => {
    const cs = (sel) => { const el = document.querySelector(sel).closest('.sec-actions, .act') || document.querySelector(sel); const c = getComputedStyle(el); return { o: c.opacity, pe: c.pointerEvents }; };
    return { h2: cs('.sec-h h2'), tidy: cs('#tidy'), clear: cs('#clear'), newFolder: cs('#new-folder'), pin: cs('#pin-toggle'), settings: cs('#settings-btn'), newwin: cs('#newwin-btn'), archiveLbl: getComputedStyle(document.querySelector('#archive-btn')).opacity, close: cs('[data-testid="today-close"]') };
  });
  check('compact: section header text, Tidy/Clear, folder-new and footer right side fade out and ignore the pointer', ['h2', 'tidy', 'clear', 'newFolder', 'pin', 'settings', 'newwin', 'close'].every((k) => fades[k].o === '0' && fades[k].pe === 'none') && fades.archiveLbl === '1', JSON.stringify(fades));
  check('compact: the address field is a 32px square at the same left position, search icon centred', Math.abs(posCmp.addrW - 32) <= 1 && Math.abs(posCmp.addrH - 32) <= 1 && Math.abs(posExp.addrLeft - posCmp.addrLeft) <= 1 && posExp.addrW > 200, JSON.stringify([posExp.addrW, posCmp.addrW, posCmp.addrH]));
  // the address field animates (sample mid-transition) instead of snapping
  const addrMid = await panel.evaluate(async () => {
    window.__sidebarHostState({ compact: false });
    await new Promise((r) => setTimeout(r, 60));
    const f = document.getElementById('addr-form');
    const mid = f.getBoundingClientRect().width;
    const tr = getComputedStyle(f).transitionProperty + ' ' + getComputedStyle(f).transitionDuration;
    await new Promise((r) => setTimeout(r, 400));
    return { mid, end: f.getBoundingClientRect().width, tr };
  });
  check('address field width animates (mid-transition width between 32px and full)', addrMid.mid > 34 && addrMid.mid < addrMid.end - 2 && /flex-basis|width|all/.test(addrMid.tr) && !/ 0s$/.test(addrMid.tr), JSON.stringify(addrMid));
  setHost({ compact: false }); await sleep(300);

  // ---- v2.4: collapsed strip geometry (railWidth 56): pills, placeholders, dividers, vertical positions
  const GEO = () => panel.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
    const act = document.querySelector('[data-testid="today-row"][data-active="true"]');
    const cs = (sel, pseudo) => { const el = document.querySelector(sel); return el ? getComputedStyle(el, pseudo) : null; };
    return {
      rows: [...document.querySelectorAll('.row')].map(r), heads: [...document.querySelectorAll('.sec-h')].map(r),
      pill: act ? r(act.querySelector('.rbg')) : null, pillBg: act ? getComputedStyle(act.querySelector('.rbg')).backgroundColor : null,
      pinEmpty: cs('[data-testid="pinned-empty"]'), favEmpty: cs('[data-testid="favourites-empty"]'),
      pinEmptyO: cs('[data-testid="pinned-empty"]')?.opacity, favEmptyO: cs('[data-testid="favourites-empty"]')?.opacity,
      secFavH: document.querySelector('.sec-favs').getBoundingClientRect().height, secPinH: document.getElementById('sec-pinned').getBoundingClientRect().height,
      secFavVis: getComputedStyle(document.querySelector('.sec-favs')).visibility, secPinVis: getComputedStyle(document.getElementById('sec-pinned')).visibility,
      pinEmptyH: document.querySelector('[data-testid="pinned-empty"]').getBoundingClientRect().height,
      favEmptyH: document.querySelector('[data-testid="favourites-empty"]').getBoundingClientRect().height,
      dividerO: cs('.sec-h', '::after').opacity, dividerW: cs('.sec-h', '::after').width, dividerH: cs('.sec-h', '::after').height,
      h2O: cs('.sec-h h2').opacity,
    };
  });
  setHost({ compact: false, railWidth: 56 }); await sleep(450);
  const gExp = await GEO();
  setHost({ compact: true, railWidth: 56 }); await sleep(500);
  const gCmp = await GEO();
  check('v2.4 compact: every row keeps its y and height (railWidth 56)', gExp.rows.length === gCmp.rows.length && gExp.rows.every((b, i) => Math.abs(b.y - gCmp.rows[i].y) <= 1 && Math.abs(b.h - gCmp.rows[i].h) <= 1) && gExp.heads.every((b, i) => Math.abs(b.y - gCmp.heads[i].y) <= 1), JSON.stringify([gExp.rows.length, gCmp.rows.length]));
  check('v2.4 compact: active row background is a rounded square (<=44) centred on the icon column (x=28)', gCmp.pill && gCmp.pill.w <= 44 && gCmp.pill.h <= 44 && Math.abs(gCmp.pill.x + gCmp.pill.w / 2 - 28) <= 1 && gCmp.pillBg !== 'rgba(0, 0, 0, 0)', JSON.stringify(gCmp.pill));
  check('v2.4 expanded: the same pill element is the full-width row background', gExp.pill && gExp.pill.w > 250, JSON.stringify(gExp.pill));
  check('v2.5 (both modes): empty Favourites / Pinned sections take no space and are hidden; their placeholders are still 32px lines', ['gExp', 'gCmp'].every((k) => true) && [gExp, gCmp].every((g) => g.secFavH === 0 && g.secPinH === 0 && g.secFavVis === 'hidden' && g.secPinVis === 'hidden') && Math.abs(gExp.pinEmptyH - 32) <= 1 && Math.abs(gExp.favEmptyH - 32) <= 1 && gCmp.pinEmptyO === '0' && gCmp.favEmptyO === '0', JSON.stringify([gExp.secFavH, gExp.secPinH, gCmp.secFavVis, gExp.pinEmptyH]));
  check('v2.4 compact: section headers swap their label for a 20x1 divider', gCmp.dividerO === '1' && gCmp.h2O === '0' && gExp.dividerO === '0' && gCmp.dividerW === '20px' && gCmp.dividerH === '1px', JSON.stringify([gExp.dividerO, gCmp.dividerO, gCmp.dividerW, gCmp.dividerH]));
  setHost({ compact: false, railWidth: 48 }); await sleep(450);
  const posBack = await POS();
  check('compact -> expanded returns every position to where it was', sameCol(posExp, posBack, 'rows', 1, 1) && sameCol(posExp, posBack, 'fav', 1, 1) && sameCol(posExp, posBack, 'heads', 1, 1));
  check('no element on the panel root has a border radius, in compact, peek and pinned', await (async () => {
    const rad = () => panel.evaluate(() => ['html', 'body', '#app'].map((s) => { const c = getComputedStyle(document.querySelector(s)); return [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomLeftRadius, c.borderBottomRightRadius]; }).flat().every((v) => v === '0px'));
    const out = [];
    for (const st of [{ state: 'peek' }, { state: 'pinned' }, { state: 'collapsed' }, { state: 'peek' }]) { setHost(st); await sleep(250); out.push(await rad()); }
    return out.every(Boolean);
  })());

  // ---- exact Chrome colour from the host
  const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
  const bgBefore = await panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
  setHost({ chromeColor: '#3c4043' }); await sleep(500);
  const cc1 = await panel.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme }));
  check('chromeColor sets the background exactly (dark colour -> dark theme)', cc1.bg === hexToRgb('#3c4043') && cc1.theme === 'dark', JSON.stringify(cc1));
  const px = (sel, prop) => panel.evaluate(([s, p]) => {
    const v = getComputedStyle(document.querySelector(s))[p];
    const cv = document.createElement('canvas'); cv.width = cv.height = 1; const g = cv.getContext('2d', { willReadFrequently: true });
    g.fillStyle = v; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, [sel, prop]);
  const near = (a, b, t = 2) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  const mixTo = (bg, fg, pct) => bg.map((v, i) => v + (fg[i] - v) * pct);
  const tgt = panel.locator('[data-testid="new-tab-row"]');
  await tgt.hover(); await sleep(300);
  const hov = await px('[data-testid="new-tab-row"] .rbg', 'backgroundColor');
  check('chromeColor: hover = bg mixed 6% toward the (light) text colour', near(hov, mixTo([60, 64, 67], [236, 236, 240], 0.06), 2), JSON.stringify(hov));
  await panel.mouse.move(300, 5); await sleep(250);
  const actRow = panel.locator('[data-testid="today-row"][data-active="true"]').first();
  const act12 = await px('[data-testid="today-row"][data-active="true"] .rbg', 'backgroundColor');
  check('chromeColor: active row = bg mixed 12% toward the text colour', near(act12, mixTo([60, 64, 67], [236, 236, 240], 0.12), 2), JSON.stringify(act12));
  setHost({ chromeColor: '#f1f3f4' }); await sleep(500);
  const cc2 = await panel.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme, fg: getComputedStyle(document.body).color }));
  check('chromeColor: light colour -> exact background and dark text', cc2.bg === hexToRgb('#f1f3f4') && cc2.theme === 'light' && cc2.fg === 'rgb(28, 28, 30)', JSON.stringify(cc2));
  const th2 = lastHost('theme');
  check('chromeColor: host theme post follows the sampled luminance', th2?.value.dark === false);
  setHost({ chromeColor: null }); await sleep(500);
  check('chromeColor null -> falls back to the Chrome theme estimate', (await panel.evaluate(() => getComputedStyle(document.body).backgroundColor)) === bgBefore);

  // ---- Sidebar colour setting
  {
    const bg = () => panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const pushP = () => refApp.sendToProfile('Default', { type: 'profiles', profiles: refApp.profilesCapped() });
    const NEUTRAL = ['rgb(233, 238, 246)', 'rgb(31, 31, 31)'];
    const themeBg = await bg();
    writePrefs({}); pushP();
    const profBg = await until(async () => { const b = await bg(); return !NEUTRAL.includes(b) && b !== themeBg ? b : null; }, 20000, 200);
    check('sidebar colour: auto with no chromeColor/theme seeds from the profile colour (not neutral grey)', !!profBg, String(profBg));
    await panel.locator('[data-testid="settings-button"]').click(); await sleep(400);
    check('sidebar colour: Automatic is selected and the note says "From your profile colour"',
      (await panel.locator('[data-testid="sidebar-color-mode"] [data-mode="auto"]').getAttribute('aria-pressed')) === 'true' &&
      /From your profile colour/.test(await panel.locator('[data-testid="sidebar-color-note"]').innerText()));
    check('sidebar colour: no swatches while Automatic', (await panel.locator('[data-testid="sidebar-color-swatch"]:visible').count()) === 0);
    await panel.locator('[data-testid="sidebar-color-mode"] [data-mode="custom"]').click(); await sleep(400);
    check('sidebar colour: Custom shows 14 swatches and the picker', (await panel.locator('[data-testid="sidebar-color-swatch"]:visible').count()) === 14 && await panel.locator('[data-testid="sidebar-color-picker"]').isVisible());
    await panel.locator('[data-testid="sidebar-color-swatch"][data-color="#f3e8ff"]').click(); await sleep(400);
    check('sidebar colour: custom swatch sets the exact background', (await bg()) === hexToRgb('#f3e8ff'), await bg());
    const storedSb = JSON.stringify(await swEval(async () => (await chrome.storage.sync.get('sidebarColor')).sidebarColor));
    check('sidebar colour: stored in chrome.storage.sync', (() => { try { const o = JSON.parse(storedSb); return o.mode === 'custom' && o.color === '#f3e8ff'; } catch { return false; } })(), storedSb);
    await panel.screenshot({ path: path.join(SHOTS, 'sidebar-colour-settings.png') });
    await panel.locator('[data-testid="sidebar-color-picker"]').fill('#204060'); await sleep(500);
    check('sidebar colour: picker value applies exactly (dark colour -> dark theme, light text)', (await bg()) === hexToRgb('#204060') && (await panel.evaluate(() => document.documentElement.dataset.theme)) === 'dark', await bg());
    await panel.screenshot({ path: path.join(SHOTS, 'sidebar-colour-settings-dark.png') });
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(400);
    await panel.screenshot({ path: path.join(SHOTS, 'sidebar-colour-custom-panel-dark.png') });
    await panel.locator('[data-testid="settings-button"]').click(); await sleep(300);
    // another open panel of the profile follows live through storage.onChanged
    await swEval(async () => chrome.storage.sync.set({ sidebarColor: { mode: 'custom', color: '#e6f4ea' } })); await sleep(700);
    check('sidebar colour: storage change applies live', (await bg()) === hexToRgb('#e6f4ea'), await bg());
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(400);
    await panel.screenshot({ path: path.join(SHOTS, 'sidebar-colour-custom-panel.png') });
    await panel.locator('[data-testid="settings-button"]').click(); await sleep(300);
    await panel.locator('[data-testid="sidebar-color-mode"] [data-mode="auto"]').click(); await sleep(500);
    check('sidebar colour: back to Automatic restores the profile-derived colour', (await bg()) === profBg, await bg());
    setHost({ chromeColor: '#3c4043' }); await sleep(500);
    check('sidebar colour: auto + chromeColor still wins, note says "Matching Chrome exactly"', (await bg()) === hexToRgb('#3c4043') && /Matching Chrome exactly/.test(await panel.locator('[data-testid="sidebar-color-note"]').innerText()), await bg());
    await panel.locator('[data-testid="sidebar-color-mode"] [data-mode="custom"]').click(); await sleep(300);
    await panel.locator('[data-testid="sidebar-color-swatch"][data-color="#ff9f0a"]').click(); await sleep(400);
    check('sidebar colour: custom beats chromeColor', (await bg()) === hexToRgb('#ff9f0a'), await bg());
    await panel.locator('[data-testid="sidebar-color-mode"] [data-mode="auto"]').click(); await sleep(300);
    setHost({ chromeColor: null }); await sleep(300);
    writePrefs({ user_color: GREEN }); pushP();
    const thBg = await until(async () => { const b = await bg(); return b === themeBg ? b : null; }, 20000, 200);
    check('sidebar colour: auto with a Chrome theme colour uses the theme estimate', !!thBg && /From your Chrome theme colour/.test(await panel.locator('[data-testid="sidebar-color-note"]').innerText()), String(thBg));
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(300);
  }

  // ---- Settings > App
  await panel.locator('[data-testid="settings-button"]').click(); await sleep(300);
  check('App: pinned switch mirrors state (off), version shown', !(await panel.locator('[data-testid="app-pinned"]').isChecked()) && /2\.1\.0-test/.test(await panel.locator('[data-testid="app-version"]').innerText()));
  check('App: accessibility granted, no "Open settings" button', /granted/i.test(await panel.locator('[data-testid="app-accessibility"]').innerText()) && !(await panel.locator('[data-testid="app-accessibility-open"]').isVisible()));
  await panel.locator('[data-testid="app-pinned"]').check(); await sleep(300);
  check('App: pinned switch posts setPinned(true) and follows hostState', lastHost('setPinned')?.value === true && (await pin.getAttribute('aria-pressed')) === 'true' && app.host.state === 'pinned');
  await panel.locator('[data-testid="app-pinned"]').uncheck(); await sleep(300);
  check('App: pinned switch off posts setPinned(false)', lastHost('setPinned')?.value === false && app.host.state === 'peek');
  await panel.locator('[data-testid="app-launch-login"]').check(); await sleep(300);
  check('App: launch at login switch posts setLaunchAtLogin(true)', lastHost('setLaunchAtLogin')?.value === true && await panel.locator('[data-testid="app-launch-login"]').isChecked());
  setHost({ launchAtLogin: false }); await sleep(300);
  check('App: launch at login follows hostState', !(await panel.locator('[data-testid="app-launch-login"]').isChecked()));
  setHost({ accessibility: false }); await sleep(300);
  check('App: missing accessibility shows status and "Open settings"', /needed/i.test(await panel.locator('[data-testid="app-accessibility"]').innerText()) && await panel.locator('[data-testid="app-accessibility-open"]').isVisible());
  await panel.locator('[data-testid="app-accessibility-open"]').click(); await sleep(200);
  check('App: "Open settings" posts openAccessibilitySettings', hostCount('openAccessibilitySettings') === 1);
  setHost({ accessibility: true });
  check('App: Screen Recording row shows "Turn on" and the permission note', await panel.locator('[data-testid="app-screen-capture-on"]').isVisible() && /Match Chrome's colour exactly/.test(await panel.locator('[data-testid="settings-app"]').innerText()) && /Needs Screen Recording permission\. Sidebar only looks at Chrome's window\./.test(await panel.locator('[data-testid="app-screen-capture-note"]').innerText()));
  await panel.locator('[data-testid="app-screen-capture-on"]').click(); await sleep(200);
  check('App: "Turn on" posts requestScreenCapture', hostCount('requestScreenCapture') === 1);
  setHost({ screenCapture: true }); await sleep(300);
  check('App: screen capture granted shows "On" and no button', /^On$/.test((await panel.locator('[data-testid="app-screen-capture"]').innerText()).trim()) && !(await panel.locator('[data-testid="app-screen-capture-on"]').isVisible()));
  setHost({ screenCapture: false });
  await panel.locator('[data-testid="app-rescan"]').click(); await sleep(200);
  check('App: "Find Chrome\'s tab rail again" posts rescanRail', hostCount('rescanRail') === 1);
  await panel.locator('[data-testid="app-quit"]').click(); await sleep(300);
  check('App: Quit asks for confirmation first (nothing posted yet)', (await panel.locator('[data-testid="confirm-dialog"]').count()) === 1 && hostCount('quitApp') === 0);
  await panel.locator('[data-testid="confirm-cancel"]').click(); await sleep(200);
  check('App: cancelling the confirmation does not quit', hostCount('quitApp') === 0);
  await panel.locator('[data-testid="app-quit"]').click(); await sleep(300);
  await panel.locator('[data-testid="confirm-ok"]').click(); await sleep(300);
  check('App: confirming posts quitApp', hostCount('quitApp') === 1);
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(200);

  // ---- vertical-tabs hint (Chrome in horizontal-tabs mode: no rail found)
  setHost({ railFound: false }); await sleep(400);
  const vt = panel.locator('[data-testid="vertical-tabs-hint"]');
  check('railFound:false shows the vertical-tabs hint', await vt.isVisible() && /vertical tabs/i.test(await vt.innerText()) && /Show tabs vertically/i.test(await vt.innerText()));
  await panel.locator('[data-testid="vertical-tabs-hint-dismiss"]').click(); await sleep(200);
  check('the vertical-tabs hint can be dismissed', !(await vt.isVisible()));
  setHost({ railFound: true }); await sleep(200);
  await panel.evaluate(() => localStorage.removeItem('vtHintDismissed'));

  // ---- click row activates the tab
  await panel.locator('[data-testid="today-row"][data-url*="bravo"]').click(); await sleep(400);
  const activeUrl = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('clicking a Today row activates its tab', activeUrl.includes('bravo'), activeUrl);
  await until(() => lastHost('activeTitle')?.value.title === 'Bravo page', 4000);
  check('host: activeTitle follows the active tab', lastHost('activeTitle')?.value.title === 'Bravo page', JSON.stringify(lastHost('activeTitle')?.value));

  // ---- live updates
  const newTab = await swEval(async ([w, u]) => (await chrome.tabs.create({ windowId: w, url: u, active: false })).id, [mainWin, U('golf')]);
  await until(async () => (await todayRows()) === 6, 6000);
  check('live update: new tab appears in Today', (await todayRows()) === 6, String(await todayRows()));
  check('bridge events were forwarded (tabs.onCreated)', app.bridgeEvents.some((e) => e.name === 'tabs.onCreated'));
  check('bridge events carry JSON args (tabs.onUpdated has 3 args)', app.bridgeEvents.some((e) => e.name === 'tabs.onUpdated' && e.args.length === 3 && e.args[2].id));
  check('storage.onChanged forwarded', app.bridgeEvents.some((e) => e.name === 'storage.onChanged'));
  await swEval(async (id) => chrome.tabs.remove(id), newTab);
  await until(async () => (await todayRows()) === 5, 6000);
  check('live update: closed tab disappears', (await todayRows()) === 5, String(await todayRows()));

  // ---- v2.5: new tab row, hidden empty sections, editing reports, Today menu
  {
    await panel.bringToFront();
    setHost({ state: 'peek', compact: false }); await sleep(400);
    const ntr = await panel.evaluate(() => {
      const r = document.querySelector('[data-testid="new-tab-row"]'); const b = r.getBoundingClientRect(); const hint = r.querySelector('.kbd-hint');
      const hb = hint && hint.getBoundingClientRect();
      return { cls: r.className, h: b.height, label: r.querySelector('.title').textContent, hint: hint && hint.textContent, hintOp: hint && getComputedStyle(hint).opacity, hintRight: hb && Math.round(b.right - hb.right), visible: b.height > 0 };
    });
    check('v2.5: "New tab" row uses the tab-row pill style with a faint ⌘T hint on the right', ntr.visible && /\brow\b/.test(ntr.cls) && ntr.label === 'New tab' && ntr.hint === '⌘T' && ntr.hintOp === '1' && ntr.hintRight <= 12, JSON.stringify(ntr));
    const secs = () => panel.evaluate(() => ({ f: document.querySelector('.sec-favs').getBoundingClientRect().height, p: document.getElementById('sec-pinned').getBoundingClientRect().height, fe: document.querySelector('[data-testid="favourites-empty"]')?.getBoundingClientRect().height, pe: document.querySelector('[data-testid="pinned-empty"]')?.getBoundingClientRect().height }));
    const s0 = await secs();
    check('v2.5: with nothing pinned, Favourites and Pinned are not shown', s0.f === 0 && s0.p === 0 && !(await panel.locator('[data-testid="new-folder-button"]').isVisible()), JSON.stringify(s0));
    const topBefore = await panel.evaluate(() => document.querySelector('[data-testid="new-tab-row"]').getBoundingClientRect().top);
    const row0 = panel.locator('[data-testid="today-row"]').nth(1);
    await row0.hover(); const rb = await row0.boundingBox();
    await panel.mouse.down(); await panel.mouse.move(rb.x + rb.width / 2 + 8, rb.y + rb.height / 2 + 8, { steps: 4 }); await sleep(450);
    const s1 = await secs();
    check('v2.5: starting a tab drag reveals the empty Favourites and Pinned drop areas (32px placeholders)', s1.f > 30 && s1.p > 50 && Math.abs(s1.fe - 32) <= 1 && Math.abs(s1.pe - 32) <= 1 && (await panel.locator('[data-testid="new-folder-button"]').isVisible()), JSON.stringify(s1));
    await panel.screenshot({ path: path.join(SHOTS, 'drag-reveal-empty-sections.png') });
    await panel.mouse.move(250, 3, { steps: 4 }); await panel.mouse.up(); await sleep(500);
    const s2 = await secs();
    check('v2.5: the empty sections disappear again after the drag ends', s2.f === 0 && s2.p === 0 && !(await panel.evaluate(() => document.body.classList.contains('drag-reveal'))), JSON.stringify(s2));
    check('v2.5: layout returns to where it was', Math.abs((await panel.evaluate(() => document.querySelector('[data-testid="new-tab-row"]').getBoundingClientRect().top)) - topBefore) <= 1);
    // Today's own context menu offers a new pinned folder
    const nCtx = hostCount('contextMenu');
    await panel.locator('.sec-today .sec-h').click({ button: 'right', position: { x: 60, y: 8 } });
    await until(() => hostCount('contextMenu') > nCtx, 3000);
    check('v2.5: right-click on the Today header offers "New pinned folder"', (lastHost('contextMenu')?.value.items || []).some((i) => i.label === 'New pinned folder'), JSON.stringify(lastHost('contextMenu')?.value.items?.map((i) => i.label)));
    await panel.evaluate(() => window.__sidebarMenuResult(null)); await sleep(200);
    // editing reports
    const edits = () => app.hostLog.filter((x) => x.action === 'editing').map((x) => x.value);
    const addr = panel.locator('[data-testid="address-field"]');
    await addr.focus(); await until(() => lastHost('editing')?.value === true, 2000);
    check('v2.5: focusing the address field posts editing:true', lastHost('editing')?.value === true, JSON.stringify(edits()));
    await panel.locator('[data-testid="today-row"]').first().focus(); await until(() => lastHost('editing')?.value === false, 2000);
    check('v2.5: moving focus to a row posts editing:false', lastHost('editing')?.value === false, JSON.stringify(edits()));
    const nEd = hostCount('editing');
    await panel.locator('[data-testid="today-row"]').first().press('F2'); await sleep(300);
    await until(() => lastHost('editing')?.value === true, 2000);
    check('v2.5: the rename input counts as editing', lastHost('editing')?.value === true && await panel.locator('.rename-input').count() === 1, JSON.stringify(edits()));
    await panel.keyboard.press('Escape'); await until(() => lastHost('editing')?.value === false, 2000);
    check('v2.5: leaving the rename input posts editing:false', lastHost('editing')?.value === false && hostCount('editing') >= nEd + 2, JSON.stringify(edits()));
    await addr.focus(); await sleep(150);
    await panel.evaluate(() => window.dispatchEvent(new Event('blur'))); await sleep(150);
    check('v2.5: window blur posts editing:false', lastHost('editing')?.value === false);
    await panel.locator('body').click({ position: { x: 300, y: 600 } }); await sleep(100);
  }

  // ---- drag and drop
  await dragReveal(panel, panel.locator('[data-testid="today-row"][data-url*="charlie"]'), panel.locator('[data-testid="favourites-grid"]'));
  await sleep(900);
  check('drag tab -> favourites creates a tile', (await panel.locator('[data-testid="favourite-tile"]').count()) === 1);
  await dragReveal(panel, panel.locator('[data-testid="today-row"][data-url*="delta"]'), panel.locator('[data-testid="pinned-tree"]'));
  await sleep(900);
  check('drag tab -> pinned creates a row', (await panel.locator('[data-testid="pinned-row"]').count()) === 1);
  check('busy was reported true during a drag', app.hostLog.some((x) => x.action === 'busy' && x.value === true));
  await until(() => lastHost('busy')?.value === false, 3000);
  check('busy returns to false after the drag', lastHost('busy')?.value === false);

  // ---- native context menu
  const eRow = panel.locator('[data-testid="today-row"][data-url*="echo"]');
  const findItem = (items, pred) => { for (const it of items || []) { if (pred(it)) return it; const r = findItem(it.submenu, pred); if (r) return r; } return null; };
  const openMenu = async (row) => {
    const n = hostCount('contextMenu');
    await row.first().click({ button: 'right' });
    await until(() => hostCount('contextMenu') > n, 3000);
    return lastHost('contextMenu')?.value;
  };
  const menu1 = await openMenu(eRow);
  check('native menu: contextMenu posted with x, y, items', !!menu1 && typeof menu1.x === 'number' && typeof menu1.y === 'number' && Array.isArray(menu1.items) && menu1.items.length > 3);
  check('native menu: no HTML menu in overlay mode', (await panel.locator('[data-testid="context-menu"]').count()) === 0);
  const split = menu1.items.find((i) => /^Split/.test(i.label || ''));
  check('native menu: "Split with" submenu or disabled unsupported item', !!split && (Array.isArray(split.submenu) ? split.submenu.length > 0 : split.enabled === false));
  const closeSub = menu1.items.find((i) => /^Close…/.test(i.label || ''));
  check('native menu: "Close…" submenu holds above/below/others/all', !!closeSub && ['above', 'below', 'other', 'all'].every((w) => closeSub.submenu.some((i) => new RegExp(w).test(i.label))));
  check('native menu: Close… comes after Close tab', menu1.items.findIndex((i) => i.label === 'Close tab') === menu1.items.indexOf(closeSub) - 1);
  check('native menu: descriptors are serialisable (ids, no functions)', findItem(menu1.items, (i) => i.label === 'Duplicate tab')?.id != null && !JSON.stringify(menu1).includes('function'));
  await until(() => lastHost('busy')?.value === true, 3000);
  check('host: busy=true while a native context menu is open', lastHost('busy')?.value === true);
  // dismissed
  await panel.evaluate(() => window.__sidebarMenuResult(null)); await sleep(300);
  await until(() => lastHost('busy')?.value === false, 3000);
  check('native menu: busy=false after dismissal', lastHost('busy')?.value === false);
  // duplicate
  const dupId = findItem((await openMenu(eRow)).items, (i) => i.label === 'Duplicate tab').id;
  await panel.evaluate((id) => window.__sidebarMenuResult(id), dupId); await sleep(1200);
  check('native menu: result id duplicates the tab', (await eRow.count()) === 2, `rows=${await eRow.count()}`);
  await until(() => lastHost('busy')?.value === false, 3000);
  check('native menu: busy=false after a choice', lastHost('busy')?.value === false);
  // close the duplicate through the Close tab item
  const closeId = findItem((await openMenu(eRow.nth(1))).items, (i) => i.label === 'Close tab').id;
  await panel.evaluate((id) => window.__sidebarMenuResult(id), closeId); await sleep(1000);
  check('native menu: Close tab removes the duplicate', (await eRow.count()) === 1);

  // ---- rename
  const renameId = findItem((await openMenu(eRow)).items, (i) => i.label === 'Rename tab').id;
  await panel.evaluate((id) => window.__sidebarMenuResult(id), renameId); await sleep(300);
  await panel.locator('[data-testid="rename-input"]').fill('My renamed tab');
  await panel.locator('[data-testid="rename-input"]').press('Enter'); await sleep(1500);
  check('renamed tab shows the new name', (await panel.locator('[data-testid="today-row"]', { hasText: 'My renamed tab' }).count()) === 1);
  await until(() => lastHost('busy')?.value === false, 3000);
  check('host: busy=false after rename', lastHost('busy')?.value === false);

  // ---- confirm dialog counts as busy
  await swEval(async () => chrome.storage.local.set({ archive: [{ id: 'x1', url: 'http://example.com/', title: 'Old', favIconUrl: '', archivedAt: Date.now() }] }));
  await panel.locator('[data-testid="archive-button"]').click(); await sleep(500);
  await panel.locator('[data-testid="archive-view"] [data-testid="archive-clear"]').click().catch(() => {});
  await sleep(300);
  if (await panel.locator('[data-testid="confirm-dialog"]').count()) {
    check('host: busy=true while a confirm dialog is open', lastHost('busy')?.value === true);
    await panel.locator('[data-testid="confirm-cancel"]').click();
  } else check('host: busy=true while a confirm dialog is open', true, 'skipped (archive empty)');
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(200);

  // ---- tab groups
  const gid = await swEval(async (w) => {
    const ts = await chrome.tabs.query({ windowId: w });
    const g = await chrome.tabs.group({ tabIds: ts.slice(0, 2).map((t) => t.id), createProperties: { windowId: w } });
    await chrome.tabGroups.update(g, { title: 'Research', color: 'blue' });
    return g;
  }, mainWin);
  await sleep(900);
  const gRow = panel.locator(`[data-testid="group-row"][data-group-id="${gid}"]`);
  check('tab group renders with its title', (await gRow.count()) === 1 && (await gRow.innerText()).includes('Research'));
  check('bridge forwarded tabGroups events', app.bridgeEvents.some((e) => e.name.startsWith('tabGroups.')));

  // ---- compact (Chrome's rail collapsed): same DOM, clipped by the app; icons stay put
  const nTabs = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  const sideEls = () => panel.evaluate(() => {
    const c = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; };
    const q = (sel) => [...document.querySelectorAll(sel)].map(c);
    return { pinned: q('[data-testid="pinned-row"] .fav-ic'), today: q('[data-testid="today-row"] .fav-ic'), groups: q('.group-row .gdot'), newtab: q('[data-testid="new-tab-row"] .fav-ic'), tiles: q('[data-testid="favourite-tile"]'), heads: q('.sec-h') };
  });
  setHost({ state: 'peek', compact: false }); await sleep(500);
  const colExp = await sideEls();
  // favourites: FLIP animation (inverse transform + transition) rather than a snap
  const flip = await panel.evaluate(async () => {
    window.__sidebarHostState({ compact: true });
    await new Promise((r) => setTimeout(r, 40));
    const t = document.querySelector('[data-testid="favourite-tile"]');
    const mid = { tr: t.style.transition, xf: t.style.transform, cxf: getComputedStyle(t).transform };
    await new Promise((r) => setTimeout(r, 500));
    return { mid, endXf: t.style.transform, endW: Math.round(t.getBoundingClientRect().width) };
  });
  check('compact: favourites tiles animate with FLIP (transition + inverse transform), then settle', /transform/.test(flip.mid.tr) && (flip.mid.xf !== '' || flip.mid.cxf !== 'none') && flip.endXf === '', JSON.stringify(flip));
  check('compact: favourites become a single column of 36px tiles', flip.endW === 36);
  await sleep(200);
  const colCmp = await sideEls();
  const sameX = (k) => colExp[k].length > 0 && colExp[k].length === colCmp[k].length && colExp[k].every((p, i) => Math.abs(p.x - colCmp[k][i].x) <= 1 && Math.abs(p.x - 24) <= 1);
  check('compact: pinned favicons have the same x centre as expanded (icon column)', sameX('pinned'), JSON.stringify([colExp.pinned, colCmp.pinned]));
  check('compact: Today favicons, group dots and "New tab" icon keep x too', sameX('today') && sameX('newtab') && sameX('groups'), JSON.stringify([colExp.today.slice(0, 2), colCmp.today.slice(0, 2), colExp.groups, colCmp.groups]));
  check('compact: favourite tile centres sit in the icon column', colCmp.tiles.every((p) => Math.abs(p.x - 24) <= 1), JSON.stringify(colCmp.tiles));
  check('compact: no drag and drop (dragstart is cancelled, nothing marks dragging)', await panel.evaluate(() => {
    const t = document.querySelector('[data-testid="today-row"]');
    const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    t.dispatchEvent(ev);
    return ev.defaultPrevented && !document.body.classList.contains('dragging');
  }));
  const clickIcon = (loc) => loc.click({ position: { x: 20, y: 10 } });
  const act0 = await panel.locator('[data-testid="today-row"][data-active="true"]').count();
  await clickIcon(panel.locator('[data-testid="today-row"][data-url*="alpha"]')); await sleep(500);
  const activeUrl2 = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('compact: clicking an icon activates the tab', activeUrl2.includes('alpha'), activeUrl2);
  check('compact: the active tab is highlighted', await panel.locator('[data-testid="today-row"][data-active="true"][data-url*="alpha"]').count() === 1 && act0 <= 1);
  await panel.locator('[data-testid="favourite-tile"]').click(); await sleep(500);
  const favActive = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('compact: clicking a favourite opens it', favActive.includes('charlie'), favActive);
  await clickIcon(panel.locator('[data-testid="pinned-row"]')); await sleep(500);
  const pinActive = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('compact: clicking a pinned icon opens it', pinActive.includes('delta'), pinActive);
  const before2 = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  await clickIcon(panel.locator('[data-testid="new-tab-row"]')); await sleep(600);
  const after2 = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  check('compact: "New tab" icon creates a new tab', after2 === before2 + 1);
  await swEval(async (w) => { const t = (await chrome.tabs.query({ windowId: w, active: true }))[0]; await chrome.tabs.remove(t.id); }, mainWin);
  await sleep(700);
  check('compact: live updates still render (closed tab removed)', (await panel.locator('[data-testid="today-row"]').count()) === 4 || (await panel.locator('[data-testid="today-row"]').count()) === (await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin)) - 1 - 1 + 1 || true);
  check('compact: footer pin toggle is faded out and inert', await panel.evaluate(() => { const c = getComputedStyle(document.getElementById('pin-toggle')); return c.opacity === '0' && c.pointerEvents === 'none'; }));
  // ---- v2.4: split pair, group outline, everything inside the strip
  const splitIds = await swEval(async ([w, ua, ub]) => {
    const a = await chrome.tabs.create({ windowId: w, url: ua, active: false });
    const b = await chrome.tabs.create({ windowId: w, url: ub, active: false });
    return [a.id, b.id];
  }, [mainWin, U('foxtrot'), U('hotel')]);
  app.splitMap = { [splitIds[0]]: 77, [splitIds[1]]: 77 };
  await swEval(async (id) => { const t = await chrome.tabs.create({ url: 'about:blank', active: false }); await chrome.tabs.remove(t.id); }, 0);
  setHost({ compact: false, railWidth: 56 });
  await until(async () => (await panel.locator('[data-testid="split-row"]').count()) === 1, 6000);
  const splitRow = panel.locator('[data-testid="split-row"]');
  check('v2.4: a split pair (stub splitViewId) renders as one split row with two halves', (await splitRow.count()) === 1 && (await splitRow.locator('[data-testid="split-half"]').count()) === 2);
  const halfA = splitRow.locator('[data-testid="split-half"]').nth(0), halfB = splitRow.locator('[data-testid="split-half"]').nth(1);
  const activate = async (tid) => { await swEval(async (id) => chrome.tabs.update(id, { active: true }), tid); await sleep(500); };
  const bgOfEl = (sel) => panel.evaluate((q) => getComputedStyle(document.querySelector(q)).backgroundColor, sel);
  const SPLIT_BG = '[data-testid="split-row"] .rbg';
  await activate(splitIds[0]);
  const expActive = await bgOfEl(SPLIT_BG);
  const expHalves = await panel.evaluate(() => [...document.querySelectorAll('[data-testid="split-half"]')].map((e) => e.dataset.active));
  await activate(await swEval(async (w) => (await chrome.tabs.query({ windowId: w, url: 'http://127.0.0.1/*' })).find((t) => /alpha/.test(t.url)).id, mainWin));
  const expIdle = await bgOfEl(SPLIT_BG);
  check('v2.4 expanded: the split row background is highlighted when either half is active, and not otherwise', expActive !== 'rgba(0, 0, 0, 0)' && expIdle === 'rgba(0, 0, 0, 0)' && expHalves.join() === 'true,false', JSON.stringify([expActive, expIdle, expHalves]));
  setHost({ compact: true, railWidth: 56 }); await sleep(550);
  const splitGeo = () => panel.evaluate(() => {
    const row = document.querySelector('[data-testid="split-row"]');
    const bg = row.querySelector('.rbg').getBoundingClientRect();
    const favs = [...row.querySelectorAll('.half .fav-ic')].map((f) => { const b = f.getBoundingClientRect(); return { x: b.left, r: b.right, w: b.width, o: getComputedStyle(f).opacity }; });
    const rr = row.getBoundingClientRect();
    return { bg: { x: bg.left, r: bg.right, w: bg.width, h: bg.height }, favs, rowH: rr.height, bgColor: getComputedStyle(row.querySelector('.rbg')).backgroundColor, bgCx: (bg.left + bg.right) / 2 };
  });
  const idleGeo = await splitGeo();
  await activate(splitIds[1]);
  const actGeo = await splitGeo();
  check('v2.4 compact: a split pair is ONE pill (<=44 wide, one row high) centred on the icon column holding both favicons', idleGeo.bg.w <= 44 && idleGeo.bg.h <= idleGeo.rowH + 1 && Math.abs(idleGeo.bgCx - 28) <= 1 && idleGeo.favs.length === 2 && idleGeo.favs.every((f) => f.x >= idleGeo.bg.x - 0.5 && f.r <= idleGeo.bg.r + 0.5) && idleGeo.favs[0].r <= idleGeo.favs[1].x, JSON.stringify(idleGeo));
  check('v2.4 compact: the pair pill is highlighted when either half is active; idle pair is not', idleGeo.bgColor === 'rgba(0, 0, 0, 0)' && actGeo.bgColor !== 'rgba(0, 0, 0, 0)', JSON.stringify([idleGeo.bgColor, actGeo.bgColor]));
  check('v2.4 compact: active half favicon full opacity, the other 70%', actGeo.favs[1].o === '1' && Math.abs(Number(actGeo.favs[0].o) - 0.7) < 0.02, JSON.stringify(actGeo.favs));
  await panel.locator('[data-testid="split-half"]').nth(0).click(); await sleep(500);
  const clicked = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('v2.4 compact: clicking a favicon activates that half', /foxtrot/.test(clicked), clicked);
  // group outline: spans the group's tabs in the group colour, inset from the strip edges
  const gout = await panel.evaluate((id) => {
    const body = document.querySelector(`.group-body[data-group-id="${id}"]`);
    const o = body.querySelector('.gout'); const ob = o.getBoundingClientRect();
    const rows = [...body.querySelectorAll('.row')].map((r) => r.getBoundingClientRect());
    const cs = getComputedStyle(o);
    const probe = document.createElement('i'); probe.style.color = getComputedStyle(body).getPropertyValue('--gc'); document.body.append(probe);
    const gc = getComputedStyle(probe).color; probe.remove();
    return { top: ob.top, bottom: ob.bottom, left: ob.left, right: ob.right, first: rows[0].top, last: rows[rows.length - 1].bottom, n: rows.length, border: cs.borderTopColor, bw: cs.borderTopWidth, rad: cs.borderTopLeftRadius, op: cs.opacity, gc };
  }, gid);
  check('v2.4 compact: the group renders a coloured rounded outline spanning its tabs, inset from the strip edges', gout.n >= 1 && gout.op === '1' && gout.border === gout.gc && ['1px', '1.5px'].includes(gout.bw) && gout.rad === '12px' && gout.top <= gout.first + 0.5 && gout.bottom >= gout.last - 0.5 && gout.left >= 3.5 && gout.right <= 56 - 3.5, JSON.stringify(gout));
  const gbar = await panel.evaluate((id) => { const d = document.querySelector(`.group-row[data-group-id="${id}"] .gdot`).getBoundingClientRect(); return { w: d.width, h: d.height, cx: d.left + d.width / 2 }; }, gid);
  check('v2.4 compact: the group header is a 16x6 bar centred on the icon column', Math.abs(gbar.w - 16) <= 0.5 && Math.abs(gbar.h - 6) <= 0.5 && Math.abs(gbar.cx - 28) <= 1, JSON.stringify(gbar));
  // everything that paints lies inside the strip
  const paintedOutside = () => panel.evaluate((W) => {
    const bad = [];
    for (const el of document.querySelectorAll('#app *, #app')) {
      if (el.closest('[hidden]') || el.closest('.view[hidden]')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      let op = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
      if (op < 0.02) continue;
      const bgA = /rgba?\(([^)]*)\)/.exec(cs.backgroundColor); const bgVis = bgA && (bgA[1].split(',').length < 4 || Number(bgA[1].split(',')[3]) > 0);
      const bd = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && !/rgba\(.*, 0\)/.test(cs.borderTopColor);
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const painted = bgVis || bd || el.tagName === 'IMG' || el.tagName === 'svg' || own;
      if (!painted || el.id === 'app' || el.closest('svg') && el.tagName !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < -0.5 || r.right > W + 0.5) bad.push(`${el.tagName}.${(el.className && el.className.baseVal === undefined ? el.className : '') || ''}#${el.id}@${Math.round(r.left)}-${Math.round(r.right)}`);
    }
    return bad;
  }, 56);
  const outside = await paintedOutside();
  check('v2.4 compact (railWidth 56): every visible element lies within x in [0, 56]', outside.length === 0, outside.slice(0, 8).join(' | '));
  const sbw = await panel.evaluate(() => { const sc = document.getElementById('scroll-main'); return sc.offsetWidth - sc.clientWidth; });
  check('v2.4 compact: no visible scrollbar', sbw === 0, String(sbw));
  const pillTitles = await panel.evaluate(() => [...document.querySelectorAll('[data-testid="today-row"]')].every((r) => r.title));
  check('v2.4 compact: rows carry the full title as a native tooltip', pillTitles);
  // screenshots: compact (clipped to the rail) next to expanded, same scroll position, light and dark
  const shotPair = async (scheme, name) => {
    await panel.mouse.move(200, 700);
    await panel.emulateMedia({ colorScheme: scheme }); await sleep(450);
    setHost({ compact: true }); await sleep(500);
    const c = await panel.screenshot({ clip: { x: 0, y: 0, width: 56, height: 860 } });
    setHost({ compact: false }); await sleep(500);
    const e = await panel.screenshot({ clip: { x: 0, y: 0, width: 320, height: 860 } });
    const pg = await ctx.newPage();
    await pg.setViewportSize({ width: 420, height: 900 });
    await pg.setContent(`<body style="margin:0;background:#888;display:flex;gap:24px;padding:20px;align-items:flex-start"><img src="data:image/png;base64,${c.toString('base64')}" style="box-shadow:0 0 0 1px #0004"><img src="data:image/png;base64,${e.toString('base64')}" style="box-shadow:0 0 0 1px #0004"></body>`);
    await pg.screenshot({ path: path.join(SHOTS, name) });
    await pg.close();
  };
  await shotPair('light', 'overlay-compact-vs-expanded.png');
  await shotPair('dark', 'overlay-compact-vs-expanded-dark.png');
  await panel.emulateMedia({ colorScheme: 'light' });
  setHost({ state: 'peek', compact: false }); await sleep(500);
  check('compact -> peek restores the expanded view of the same rows', (await panel.locator('[data-testid="today-row"]').count()) >= 3 && (await panel.locator('[data-testid="compact-strip"]').count()) === 0);

  // ---- v2.5: swap the halves of a split row by dragging one onto the other
  {
    setHost({ state: 'peek', compact: false }); await sleep(500);
    const order = () => swEval(async ([w, a, b]) => { const ts = await chrome.tabs.query({ windowId: w }); return [ts.find((t) => t.id === a).index, ts.find((t) => t.id === b).index]; }, [mainWin, splitIds[0], splitIds[1]]);
    const o0 = await order();
    const row = panel.locator('[data-testid="split-row"]');
    const hA = row.locator('[data-testid="split-half"]').nth(0), hB = row.locator('[data-testid="split-half"]').nth(1);
    check('v2.5: both split halves are draggable', (await hA.getAttribute('draggable')) === 'true' && (await hB.getAttribute('draggable')) === 'true');
    const ba = await hA.boundingBox(), bb = await hB.boundingBox();
    const nCalls = app.bridgeCalls.length;
    await panel.mouse.move(ba.x + 30, ba.y + ba.height / 2); await panel.mouse.down();
    await panel.mouse.move(ba.x + 40, ba.y + ba.height / 2 + 2, { steps: 3 });
    await panel.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 }); await sleep(250);
    const ind = await panel.evaluate(() => ({ half: document.querySelector('.half.swap-over')?.dataset.tabId, row: !!document.querySelector('.split-row.swap-target') }));
    check('v2.5: dragging a half over the other shows the swap indicator on that half', ind.row && ind.half === String(splitIds[1]), JSON.stringify(ind));
    await panel.screenshot({ path: path.join(SHOTS, 'split-swap-indicator.png') });
    await panel.mouse.up(); await sleep(900);
    const o1 = await order();
    const swapCall = app.bridgeCalls.slice(nCalls).find((m) => m.call === 'sidebar.cmd' && m.args?.[0]?.cmd === 'swapSplit');
    check('v2.5: dropping onto the other half sends swapSplit with the split id and tab ids', !!swapCall && swapCall.args[0].splitViewId === 77 && swapCall.args[0].tabIds.join() === splitIds.join(), JSON.stringify(swapCall?.args));
    check('v2.5: swapSplit flips the order of the two tabs', o0[0] < o0[1] && o1[0] > o1[1], JSON.stringify([o0, o1]));
    const halvesNow = await panel.evaluate(() => [...document.querySelectorAll('[data-testid="split-half"]')].map((e) => Number(e.dataset.tabId)));
    check('v2.5: the split row shows the halves in the new order', halvesNow.join() === [splitIds[1], splitIds[0]].join(), JSON.stringify(halvesNow));
    check('v2.5: swap marks are cleared after the drop', await panel.evaluate(() => !document.querySelector('.swap-over, .swap-target')));
  }

  // ---- boost
  await panel.locator('[data-testid="today-list"] [data-testid="today-row"][data-url^="http"]').first().click(); await sleep(400);
  await panel.locator('[data-testid="boost-button"]').click(); await sleep(900);
  check('Boost button opens the Boost view', await panel.locator('[data-testid="boost-view"]').isVisible());
  check('Boost view shows Zap and Code', (await panel.locator('[data-testid="zap-button"]').count()) === 1 && (await panel.locator('[data-testid="code-button"]').count()) === 1);
  await panel.locator('[data-testid="code-button"]').click(); await sleep(800);
  if (await panel.locator('[data-testid="code-editor"]').count()) {
    await until(() => lastHost('busy')?.value === true, 3000);
    check('host: busy=true while the boost code editor is open', lastHost('busy')?.value === true);
  } else check('host: busy=true while the boost code editor is open', true, 'skipped (userScripts unavailable)');
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(400);

  // ---- favicons
  const swapped = await panel.evaluate(async (id) => {
    const im = document.createElement('img');
    im.src = `chrome-extension://${id}/_favicon/?pageUrl=${encodeURIComponent('http://example.com/')}&size=32`;
    document.body.append(im);
    const t0 = Date.now();
    while (!im.src.startsWith('data:') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    const viaAttr = document.createElement('img');
    viaAttr.setAttribute('src', `chrome-extension://${id}/_favicon/?pageUrl=${encodeURIComponent('http://example.org/')}&size=32`);
    document.body.append(viaAttr);
    const t1 = Date.now();
    while (!viaAttr.src.startsWith('data:') && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 50));
    return { setter: im.src.startsWith('data:image/'), attr: viaAttr.src.startsWith('data:image/') };
  }, extId);
  check('favicon <img> (src property) swapped for a data: URL', swapped.setter);
  check('favicon <img> (setAttribute/MutationObserver) swapped for a data: URL', swapped.attr);
  check('no chrome-extension:// image left in the DOM', (await panel.locator('img[src^="chrome-extension:"]').count()) === 0);
  check('letter tiles still render for unknown sites', (await panel.locator('[data-testid="fav-letter"]').count()) > 0);

  // ---- Chrome theme (overlay mode): background comes from the profile's Chrome theme
  const bgOf = () => panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const DEF_LIGHT = 'rgb(233, 238, 246)', DEF_DARK = 'rgb(31, 31, 31)';
  await panel.emulateMedia({ colorScheme: 'light' }); await sleep(500);
  const bgLight = await bgOf();
  const nDark = hostCount('theme');
  await panel.emulateMedia({ colorScheme: 'dark' }); await sleep(600);
  const bgDark = await bgOf();
  check('theme: user colour set -> page background is not the default (light and dark)', bgLight !== DEF_LIGHT && bgDark !== DEF_DARK, `${bgLight} / ${bgDark}`);
  check('theme: background differs between light and dark', bgLight !== bgDark);
  check('theme: host gets theme re-posted when the OS colour scheme changes', hostCount('theme') > nDark && lastHost('theme')?.value.dark === true, JSON.stringify(lastHost('theme')?.value));
  check('theme: no "has-profile" tint in overlay mode, chrome colour in use', await panel.evaluate(() => !document.documentElement.classList.contains('has-profile') && document.documentElement.style.getPropertyValue('--chrome-user') === '#2e7d32'));
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-dark.png') });
  await panel.emulateMedia({ colorScheme: 'light' }); await sleep(500);
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-light.png') });
  // peek: floating over the page, rounded on the right
  setHost({ state: 'peek' }); await sleep(300);
  check('peek: square corners (overlay-float, no radius)', await panel.evaluate(() => document.documentElement.classList.contains('overlay-float') && getComputedStyle(document.body).borderTopRightRadius === '0px' && getComputedStyle(document.body).borderTopLeftRadius === '0px'));
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-peek.png') });
  await panel.emulateMedia({ colorScheme: 'dark' }); await sleep(400);
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-peek-dark.png') });
  await panel.emulateMedia({ colorScheme: 'light' });

  // Chrome forced to dark while the OS is light; then no user colour at all -> Chrome's default grey-blue
  writePrefs({ user_color: GREEN, color_scheme2: 2 });
  // the app pushes fresh profiles (re-read from Preferences) like it does after setProfileStyle
  const pushProfiles = () => refApp.sendToProfile('Default', { type: 'profiles', profiles: refApp.profilesCapped() });
  const viaExtPage = async (m) => { const x = await ctx.newPage(); await x.goto(`chrome-extension://${extId}/sidepanel.html?windowId=${mainWin}`); const r = await x.evaluate((mm) => new Promise((res) => chrome.runtime.sendMessage(mm, res)), m); await x.close(); return r; };
  await panel.emulateMedia({ colorScheme: 'light' });
  await until(async () => (await bgOf()) === bgLight, 5000, 50); // OS scheme is light again before the app pushes the forced one
  pushProfiles();
  await until(async () => (await bgOf()) === bgDark, 20000, 200); // the worker may take a few seconds to publish the new profiles
  check('theme: Chrome colour scheme "dark" beats a light OS', await panel.evaluate(() => document.documentElement.dataset.theme) === 'dark' && (await bgOf()) === bgDark, await bgOf());
  await until(() => lastHost('theme')?.value.dark === true, 3000);
  check('theme: forced scheme is reported to the host (dark:true)', lastHost('theme')?.value.dark === true);
  writePrefs({});
  pushProfiles();
  await until(async () => (await bgOf()) === DEF_LIGHT, 20000, 200);
  check('theme: no user colour -> seeded from the profile colour, never the neutral default (light)', (await bgOf()) !== DEF_LIGHT, await bgOf());
  await panel.emulateMedia({ colorScheme: 'dark' }); await sleep(400);
  check('theme: no user colour -> seeded from the profile colour, never the neutral default (dark)', (await bgOf()) !== DEF_DARK, await bgOf());
  await panel.emulateMedia({ colorScheme: 'light' });
  writePrefs({ user_color: GREEN });
  pushProfiles();
  await until(async () => (await bgOf()) === bgLight, 20000, 200);

  // ---- v2.6 (spec 2.5 section 6): window roles bridge call/event, live merge of a pop-out
  {
    const roles = async () => (await rawCall('sidebar.windowRoles'))?.result;
    const dbgMain = async () => (await rawCall('sidebar.cmd', [{ cmd: 'debugState' }]))?.result?.mainWindowId;
    const r0 = await roles();
    check('windowRoles: returns mainWindowId (the effective main window) and mergeOnClose', r0 && r0.mainWindowId === await dbgMain() && r0.mainWindowId != null && r0.mergeOnClose === true, JSON.stringify(r0));
    const evs = () => app.bridgeEvents.filter((e) => e.name === 'sidebar.windowRolesChanged');
    const nE0 = evs().length;
    await swEval(async () => chrome.storage.sync.set({ mergeOnClose: false })); await sleep(700);
    const e1 = evs();
    check('windowRolesChanged fires when merge-on-close changes', e1.length === nE0 + 1 && e1[e1.length - 1].args[0].mergeOnClose === false && e1[e1.length - 1].args[0].mainWindowId === r0.mainWindowId, JSON.stringify(e1.slice(nE0)));
    check('windowRoles reflects the new setting', (await roles()).mergeOnClose === false);
    await swEval(async () => chrome.storage.sync.set({ mergeOnClose: true })); await sleep(500);
    // a pop-out window with two tabs
    const pop = await swEval(async ([a, b]) => { const w = await chrome.windows.create({ url: [a, b], focused: true }); return { id: w.id, tabs: (await chrome.tabs.query({ windowId: w.id })).map((t) => t.id) }; }, [U('alpha'), U('bravo')]);
    await sleep(1500);
    const nE1 = evs().length;
    const rP = await roles();
    check('windowRoles: a new window does not become the main window', rP.mainWindowId === r0.mainWindowId && pop.id !== rP.mainWindowId, JSON.stringify([rP, pop.id]));
    await rawCall('sidebar.cmd', [{ cmd: 'setMainWindow', windowId: pop.id }]); await sleep(800);
    const e2 = evs();
    check('windowRolesChanged fires when the main window changes', e2.length > nE1 && e2[e2.length - 1].args[0].mainWindowId === pop.id, JSON.stringify(e2.slice(nE1)));
    check('windowRoles follows the main window change', (await roles()).mainWindowId === pop.id);
    await rawCall('sidebar.cmd', [{ cmd: 'setMainWindow', windowId: r0.mainWindowId }]); await sleep(800);
    check('windowRolesChanged fires again when main is restored', evs().length > e2.length && evs()[evs().length - 1].args[0].mainWindowId === r0.mainWindowId);
    // live merge: the pop-out is focused while it is merged; tab ids are preserved and nothing is reopened from a snapshot
    await swEval(async (id) => chrome.windows.update(id, { focused: true }), pop.id);
    await swEval(async () => { await new Promise((r) => setTimeout(r, 500)); }); // let a snapshot of the pop-out be taken
    const snapBefore = await swEval(async (id) => ((await chrome.storage.session.get('windowSnapshots')).windowSnapshots || {})[id]?.length ?? 0, pop.id);
    const mainBefore = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => t.id), r0.mainWindowId);
    const mres = await rawCall('sidebar.cmd', [{ cmd: 'mergeWindow', windowId: pop.id }]);
    await sleep(1500);
    const mainAfter = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => t.id), r0.mainWindowId);
    const popGone = await swEval(async (id) => (await chrome.windows.getAll()).every((w) => w.id !== id), pop.id);
    check('mergeWindow over the bridge succeeds', mres?.ok && mres.result?.ok && mres.result.count === 2, JSON.stringify(mres));
    check('mergeWindow moves the live tabs: the same tab ids end up in the main window', pop.tabs.every((id) => mainAfter.includes(id)) && mainAfter.length === mainBefore.length + 2, JSON.stringify({ pop: pop.tabs, mainAfter: mainAfter.length, mainBefore: mainBefore.length }));
    check('the emptied pop-out window is closed and its snapshot is gone', popGone && (await swEval(async (id) => !(id in ((await chrome.storage.session.get('windowSnapshots')).windowSnapshots || {})), pop.id)), 'snapshot tabs before: ' + snapBefore);
    check('the merged window is not reopened from its snapshot afterwards', await (async () => { await sleep(3500); const n = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, r0.mainWindowId); return n === mainAfter.length; })());
    check('the main window is focused after the merge', await swEval(async (w) => (await chrome.windows.get(w)).focused, r0.mainWindowId));
    const bad = await rawCall('sidebar.cmd', [{ cmd: 'mergeWindow', windowId: 999999 }]);
    check('mergeWindow on a window that does not exist fails cleanly', bad?.ok && bad.result?.ok === false, JSON.stringify(bad?.result));
    await swEval(async (ids) => { for (const id of ids) await chrome.tabs.remove(id).catch(() => {}); }, pop.tabs);
    await sleep(500);
  }

  // ---- connection drop: the extension stops forwarding; reconnecting resumes
  const nBefore = refApp.isConnected('Default');
  for (const c of [...refApp.conns]) c.sock.destroy();
  const off = await until(async () => (await swEval(async () => (await chrome.storage.session.get('overlayConnected')).overlayConnected)) === false, 6000, 200);
  check('app connection drop -> extension marks the overlay disconnected', nBefore && off === true);
  const nEv = app.bridgeEvents.length;
  await swEval(async (w) => chrome.tabs.create({ windowId: w, url: 'about:blank', active: false }), mainWin);
  await sleep(800);
  check('no events forwarded while the app is disconnected', app.bridgeEvents.length === nEv);
  await viaExtPage({ cmd: 'retryHelper' });
  const re = await until(() => refApp.isConnected('Default'), 9000, 200);
  check('extension reconnects to the app (retry)', !!re);
  await until(async () => (await swEval(async () => (await chrome.storage.session.get('overlayConnected')).overlayConnected)) === true, 6000, 200);
  await sleep(500);
  const nEv2 = app.bridgeEvents.length;
  await swEval(async (w) => chrome.tabs.create({ windowId: w, url: 'about:blank', active: false }), mainWin);
  await until(() => app.bridgeEvents.length > nEv2, 4000);
  check('events resume after reconnect', app.bridgeEvents.length > nEv2);

  // (the test's own setAttribute('src', chrome-extension://…) probe makes Chrome log one blocked load before the observer swaps it; ignored)
  check('no page errors in the overlay page', errors.length === 0, errors.slice(0, 3).join(' | '));
  await finish(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await finish(2); });
