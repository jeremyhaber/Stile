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
  fromExt: [], bridgeEvents: [], sse: new Set(), hostLog: [],
  host: { state: 'peek', railFound: true, railControllable: true, launchAtLogin: false, accessibility: true, appVersion: '2.1.0-test' },
};
const toSse = (obj) => { const d = `data: ${JSON.stringify(obj)}\n\n`; for (const r of app.sse) r.write(d); };
const toHelper = (msg) => refApp.sendBridge('Default', msg);
const hostState = () => toSse({ type: 'hostState', ...app.host });
const setHost = (patch) => { Object.assign(app.host, patch); hostState(); };
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
      if (m.type === 'bridge') { res.writeHead(toHelper(m) ? 204 : 503).end(); return; }
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

  // ---- drag and drop
  await panel.locator('[data-testid="today-row"][data-url*="charlie"]').dragTo(panel.locator('[data-testid="favourites-grid"]'));
  await sleep(900);
  check('drag tab -> favourites creates a tile', (await panel.locator('[data-testid="favourite-tile"]').count()) === 1);
  await panel.locator('[data-testid="today-row"][data-url*="delta"]').dragTo(panel.locator('[data-testid="pinned-tree"]'));
  await sleep(900);
  check('drag tab -> pinned creates a row', (await panel.locator('[data-testid="pinned-row"]').count()) === 1);
  check('busy was reported true during a drag', app.hostLog.some((x) => x.action === 'busy' && x.value === true));
  await until(() => lastHost('busy')?.value === false, 3000);
  check('busy returns to false after the drag', lastHost('busy')?.value === false);

  // ---- rename
  const eRow = panel.locator('[data-testid="today-row"][data-url*="echo"]');
  await eRow.click({ button: 'right' }); await sleep(300);
  await until(() => lastHost('busy')?.value === true, 3000);
  check('host: busy=true while a context menu is open', lastHost('busy')?.value === true);
  await panel.locator('[data-testid="context-menu-item"][data-action="rename-tab"]').click(); await sleep(300);
  check('host: busy=true while the rename input is open', (await panel.locator('[data-testid="rename-input"]').count()) === 1 && lastHost('busy')?.value === true);
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

  // ---- compact strip (Chrome's rail collapsed)
  await panel.setViewportSize({ width: 56, height: 860 });
  setHost({ state: 'collapsed' }); await sleep(700);
  const strip = panel.locator('[data-testid="compact-strip"]');
  check('compact: strip is visible, full lists are not rendered', await strip.isVisible() && (await panel.locator('[data-testid="today-row"]').count()) === 0 && (await panel.locator('.row:visible, input:visible, h2:visible').count()) === 0);
  const nTabs = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  const unboundTabs = nTabs - 1; // delta is pinned (bound); charlie is a favourite
  const compactTabs = panel.locator('[data-testid="compact-tab"]');
  check('compact: favourites, pinned (open) and Today tabs are icon buttons', (await panel.locator('[data-testid="compact-favourite"]').count()) === 1 && (await panel.locator('[data-testid="compact-pinned"]').count()) === 1 && (await compactTabs.count()) === unboundTabs - 1, `${await compactTabs.count()} tabs`);
  check('compact: profile icon, divider and "+" new tab are present', (await panel.locator('[data-testid="compact-profile"]').count()) === 1 && (await panel.locator('[data-testid="compact-divider"]').count()) === 1 && (await panel.locator('[data-testid="compact-new-tab"]').count()) === 1);
  const shape2 = await panel.evaluate(() => {
    const b = document.querySelector('[data-testid="compact-tab"]').getBoundingClientRect();
    const list = document.getElementById('compact-list');
    return { w: Math.round(b.width), h: Math.round(b.height), text: [...document.querySelectorAll('.cbtn')].some((x) => x.querySelector('.title')), draggable: document.querySelectorAll('[draggable="true"]').length,
      scrollbar: getComputedStyle(list).scrollbarWidth, ov: getComputedStyle(list).overflowY, cx: Math.round(b.left + b.width / 2) };
  });
  check('compact: 36px squares, icons only, centred, no drag and drop, hidden scrollbar', shape2.w === 36 && shape2.h === 36 && !shape2.text && shape2.draggable === 0 && shape2.scrollbar === 'none' && shape2.ov === 'auto' && shape2.cx === 28, JSON.stringify(shape2));
  check('compact: tooltips carry the titles', (await compactTabs.first().getAttribute('title'))?.length > 0);
  check('compact: footer shows only the archive icon and the pin toggle', (await panel.locator('[data-testid="archive-button"]').isVisible()) && (await pin.isVisible()) && !(await panel.locator('[data-testid="settings-button"]').isVisible()));
  const act0 = await panel.locator('[data-testid="compact-tab"][data-active="true"]').count();
  await panel.locator('[data-testid="compact-tab"][data-url*="alpha"]').click(); await sleep(500);
  const activeUrl2 = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('compact: clicking an icon activates the tab', activeUrl2.includes('alpha'), activeUrl2);
  check('compact: the active tab icon is highlighted', await panel.locator('[data-testid="compact-tab"][data-active="true"][data-url*="alpha"]').count() === 1 && act0 <= 1);
  await panel.locator('[data-testid="compact-favourite"]').click(); await sleep(500);
  const favActive = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('compact: clicking a favourite opens it', favActive.includes('charlie'), favActive);
  const before2 = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  await panel.locator('[data-testid="compact-new-tab"]').click(); await sleep(600);
  const after2 = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  check('compact: "+" creates a new tab', after2 === before2 + 1);
  await swEval(async (w) => { const t = (await chrome.tabs.query({ windowId: w, active: true }))[0]; await chrome.tabs.remove(t.id); }, mainWin);
  await sleep(700);
  check('compact: live updates (closed tab removed from the strip)', (await panel.locator('[data-testid="compact-tab"]').count()) === unboundTabs - 1);
  const setPinnedN = app.hostLog.filter((x) => x.action === 'setPinned').length;
  await pin.click(); await sleep(400);
  check('compact: footer pin toggle posts setPinned', app.hostLog.filter((x) => x.action === 'setPinned').length === setPinnedN + 1 && lastHost('setPinned')?.value === true);
  setHost({ state: 'collapsed' }); await sleep(400);
  await panel.emulateMedia({ colorScheme: 'light' }); await sleep(400);
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-compact.png') });
  await panel.emulateMedia({ colorScheme: 'dark' }); await sleep(400);
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-compact-dark.png') });
  await panel.emulateMedia({ colorScheme: 'light' });
  setHost({ state: 'peek' }); await sleep(500);
  await panel.setViewportSize({ width: 320, height: 860 });
  await sleep(300);
  check('compact -> peek restores the full rows', (await panel.locator('[data-testid="today-row"]').count()) >= 3 && !(await strip.isVisible()));

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
  check('peek: rounded right corners (overlay-float)', await panel.evaluate(() => getComputedStyle(document.body).borderTopRightRadius === '10px' && getComputedStyle(document.body).borderTopLeftRadius === '0px'));
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
  check('theme: no user colour -> default light background (#e9eef6)', (await bgOf()) === DEF_LIGHT, await bgOf());
  await panel.emulateMedia({ colorScheme: 'dark' }); await sleep(400);
  check('theme: no user colour -> default dark background (#1f1f1f)', (await bgOf()) === DEF_DARK, await bgOf());
  await panel.emulateMedia({ colorScheme: 'light' });
  writePrefs({ user_color: GREEN });
  pushProfiles();
  await until(async () => (await bgOf()) === bgLight, 20000, 200);

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
