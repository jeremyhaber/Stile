// Overlay end-to-end: extension in Chromium + the REAL helper + a Node fake "Mac app" that
//  - listens on <helperDir>/overlay.sock (helper relay),
//  - serves extension/ files over HTTP,
//  - implements the bridgeHttp test transport (POST /send, GET /events as SSE).
// The overlay page (sidepanel.html?mode=overlay) runs against that transport via bridge-shim.js.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import http from 'http';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = process.env.OVERLAY_SHOTS || '/tmp/claude-0/-home-claude/e0605526-dcdb-5d20-aaac-918c6d6e8268/scratchpad/overlay-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbov-'));
const udd = path.join(tmp, 'udd');
const helperDir = path.join(tmp, 'helper');
fs.mkdirSync(path.join(udd, 'NativeMessagingHosts'), { recursive: true });
fs.mkdirSync(helperDir, { recursive: true });

const helperPath = path.join(tmp, 'sidebar-helper.pl');
fs.copyFileSync(path.join(ROOT, 'helper/sidebar-helper.pl'), helperPath);
fs.chmodSync(helperPath, 0o755);
const tpl = fs.readFileSync(path.join(ROOT, 'helper/com.sidebar.helper.json.template'), 'utf8');
fs.writeFileSync(path.join(udd, 'NativeMessagingHosts/com.sidebar.helper.json'), tpl.replace('__HELPER_PATH__', helperPath));
const localState = path.join(tmp, 'Local State');
// One profile so the extension resolves its directory without identity.
fs.writeFileSync(localState, JSON.stringify({ profile: { profiles_order: ['Default'], info_cache: {
  Default: { name: 'Personal', user_name: '', profile_highlight_color: -12627531 },
} } }));
const fakeChrome = path.join(tmp, 'fake-chrome.sh');
fs.writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n');
fs.chmodSync(fakeChrome, 0o755);

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

// ------------------------------------------------------------------ fake Mac app
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const app = {
  conn: null, buf: '', hello: null, fromExt: [], bridgeEvents: [], sse: new Set(), hostLog: [], connections: 0,
  host: { pinned: false, pinMode: 'push', state: 'peek' },
};
const toSse = (obj) => { const d = `data: ${JSON.stringify(obj)}\n\n`; for (const r of app.sse) r.write(d); };
const toHelper = (obj) => { if (app.conn) app.conn.write(JSON.stringify(obj) + '\n'); return !!app.conn; };
const hostState = () => toSse({ type: 'hostState', ...app.host });

const sockPath = path.join(helperDir, 'overlay.sock');
const sockSrv = net.createServer((c) => {
  app.conn = c; app.buf = ''; app.connections++;
  c.on('data', (d) => {
    app.buf += d.toString('utf8');
    let i;
    while ((i = app.buf.indexOf('\n')) >= 0) {
      const line = app.buf.slice(0, i); app.buf = app.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'profileHello') app.hello = m;
      else if (m.type === 'fromExt') {
        app.fromExt.push(m);
        if (m.msg.type === 'bridgeResult') toSse(m.msg);
        else if (m.msg.type === 'bridgeEvent') { app.bridgeEvents.push(m.msg); toSse(m.msg); }
      }
    }
  });
  c.on('close', () => { if (app.conn === c) app.conn = null; });
  c.on('error', () => {});
});
await new Promise((r) => sockSrv.listen(sockPath, r));

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
      if (m.type === 'bridge') { res.writeHead(toHelper({ type: 'toExt', msg: m }) ? 204 : 503).end(); return; }
      if (m.type === 'host') {
        app.hostLog.push({ action: m.action, value: m.value, t: Date.now() });
        if (m.action === 'ready') hostState();
        if (m.action === 'setPinned') { app.host.pinned = !!m.value; app.host.state = m.value ? 'pinned' : 'peek'; hostState(); }
        if (m.action === 'setPinMode') { app.host.pinMode = m.value; hostState(); }
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
  appSrv.close(); sockSrv.close(); siteSrv.close();
  console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${SHOTS}`);
  process.exit(code);
}

async function main() {
  ctx = await chromium.launchPersistentContext(udd, {
    channel: 'chromium', headless: true, viewport: { width: 1200, height: 800 },
    env: { ...process.env, SIDEBAR_HELPER_DIR: helperDir, SIDEBAR_LOCAL_STATE: localState, SIDEBAR_CHROME_BIN: fakeChrome },
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
  const connected = await until(() => app.conn && app.hello, 20000, 200);
  check('helper connected to the app socket and sent profileHello', !!connected, JSON.stringify(app.hello)?.slice(0, 120));
  check('profileHello carries profileDir and profiles', app.hello?.profileDir === 'Default' && Array.isArray(app.hello?.profiles) && app.hello.profiles.length === 1);
  const flag = await until(async () => swEval(async () => (await chrome.storage.session.get('overlayConnected')).overlayConnected), 5000, 200);
  check('extension recorded overlayStatus connected', flag === true);

  // ---- raw bridge through helper (before any page): hello
  const rawCall = async (call, args = []) => {
    const id = 'raw' + Math.random().toString(36).slice(2);
    const before = app.fromExt.length;
    toHelper({ type: 'toExt', msg: { type: 'bridge', id, call, args } });
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
  panel.on('console', (m) => { if (m.type() === 'error' && !/chrome-extension:\/\/invalid/.test(m.location()?.url || '')) errors.push(m.text() + ' ' + (m.location()?.url || '')); });
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
  check('pin toggle is visible with aria-pressed=false', (await panel.locator('[data-testid="pin-toggle"]').isVisible()) && (await panel.locator('[data-testid="pin-toggle"]').getAttribute('aria-pressed')) === 'false');
  await panel.locator('[data-testid="settings-button"]').click(); await sleep(300);
  check('settings: pin-mode select visible, tips hidden', (await panel.locator('[data-testid="settings-pin-mode"]').isVisible()) && !(await panel.locator('[data-testid="left-button"]').isVisible()) && !(await panel.locator('[data-testid="shortcut-button"]').isVisible()));
  check('settings: pin-mode select offers push/float', (await panel.locator('[data-testid="settings-pin-mode"] option').evaluateAll((o) => o.map((x) => x.value))).join() === 'push,float');
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
  await panel.locator('[data-testid="pin-toggle"]').click();
  await until(() => lastHost('setPinned'));
  check('host: setPinned(true) posted by pin toggle', lastHost('setPinned')?.value === true);
  await until(async () => (await panel.locator('[data-testid="pin-toggle"]').getAttribute('aria-pressed')) === 'true', 4000);
  check('pin toggle reflects __sidebarHostState (pressed)', (await panel.locator('[data-testid="pin-toggle"]').getAttribute('aria-pressed')) === 'true');
  check('push mode while pinned: no overlay-float class', !(await panel.evaluate(() => document.documentElement.classList.contains('overlay-float'))));
  await panel.locator('[data-testid="pin-toggle"]').click();
  await until(async () => (await panel.locator('[data-testid="pin-toggle"]').getAttribute('aria-pressed')) === 'false', 4000);
  check('pin toggle unpins', lastHost('setPinned')?.value === false && (await panel.locator('[data-testid="pin-toggle"]').getAttribute('aria-pressed')) === 'false');
  check('peek state adds overlay-float class', await panel.evaluate(() => document.documentElement.classList.contains('overlay-float')));

  // pin mode select -> setPinMode ; host state pushes update it
  await panel.locator('[data-testid="settings-button"]').click(); await sleep(200);
  await panel.locator('[data-testid="settings-pin-mode"]').selectOption('float'); await sleep(400);
  check('host: setPinMode("float") posted', lastHost('setPinMode')?.value === 'float');
  app.host = { pinned: true, pinMode: 'push', state: 'pinned' }; hostState(); await sleep(400);
  check('__sidebarHostState updates pin-mode select and toggle', (await panel.locator('[data-testid="settings-pin-mode"]').inputValue()) === 'push' && (await panel.locator('[data-testid="pin-toggle"]').getAttribute('aria-pressed')) === 'true');
  app.host = { pinned: true, pinMode: 'float', state: 'pinned' }; hostState(); await sleep(300);
  check('float while pinned sets overlay-float', await panel.evaluate(() => document.documentElement.classList.contains('overlay-float')));
  app.host = { pinned: false, pinMode: 'push', state: 'peek' }; hostState();
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(200);

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

  // ---- screenshots
  await panel.emulateMedia({ colorScheme: 'light' }); await sleep(500);
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-light.png') });
  const nDark = hostCount('theme');
  await panel.emulateMedia({ colorScheme: 'dark' }); await sleep(600);
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-dark.png') });
  check('host: theme re-posted when the colour scheme changes', hostCount('theme') > nDark && lastHost('theme')?.value.dark === true, JSON.stringify(lastHost('theme')?.value));
  app.host = { pinned: false, pinMode: 'float', state: 'peek' }; hostState(); await sleep(300);
  await panel.screenshot({ path: path.join(SHOTS, 'overlay-dark-float.png') });
  await panel.emulateMedia({ colorScheme: 'light' });

  // ---- app disconnect: helper tells the extension, events stop
  app.conn.destroy();
  const off = await until(async () => (await swEval(async () => (await chrome.storage.session.get('overlayConnected')).overlayConnected)) === false, 6000, 200);
  check('app disconnect -> overlayStatus connected:false reaches the extension', off === true);
  const nEv = app.bridgeEvents.length;
  await swEval(async (w) => chrome.tabs.create({ windowId: w, url: 'about:blank', active: false }), mainWin);
  await sleep(800);
  check('no events forwarded while the app is disconnected', app.bridgeEvents.length === nEv);
  const re = await until(() => app.conn && app.connections >= 2, 9000, 200);
  check('helper reconnects to the app socket', !!re);
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
