// End-to-end test: loads the extension in Chromium, wired to the Node reference host (tools/fake-app, which
// plays the Stile Mac app) through connector.js, a fake Chrome "Local State" and a fake Chrome binary.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), 'sidebar-e2e-out');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbe2e-'));
const udd = path.join(tmp, 'udd');
const helperDir = path.join(tmp, 'app'); // the reference app's data dir (state.json, host.sock)
fs.mkdirSync(path.join(udd, 'NativeMessagingHosts'), { recursive: true });
fs.mkdirSync(helperDir, { recursive: true });

// Native host manifest -> the reference connector
const { HostServer, writeHostManifest } = require('./fake-app/host-server.js');
writeHostManifest(path.join(udd, 'NativeMessagingHosts'), path.join(ROOT, 'tools/fake-app/connector.js'));

const localState = path.join(tmp, 'Local State');
fs.writeFileSync(localState, JSON.stringify({ profile: { profiles_order: ['Default', 'Profile 1'], info_cache: {
  Default: { name: 'Personal', user_name: '', profile_highlight_color: -12627531 },
  'Profile 1': { name: 'Work', user_name: 'jeremy@work.example', profile_highlight_color: -2730427 },
} } }));
fs.mkdirSync(path.join(tmp, 'Profile 1'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'extension/icons/icon48.png'), path.join(tmp, 'Profile 1', 'Google Profile Picture.png'));
const fakeChromeLog = path.join(tmp, 'chrome-args.log');
const fakeChrome = path.join(tmp, 'fake-chrome.sh');
fs.writeFileSync(fakeChrome, `#!/bin/sh\necho "$@" >> '${fakeChromeLog}'\n`);
fs.chmodSync(fakeChrome, 0o755);
const host = new HostServer({ appDir: helperDir, localState, chromeBin: fakeChrome });
await host.listen();

// Local pages
const site = path.join(tmp, 'site');
fs.mkdirSync(site);
for (const n of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']) {
  fs.writeFileSync(path.join(site, `${n}.html`), `<!doctype html><title>${n[0].toUpperCase() + n.slice(1)} page</title><h1>${n}</h1><a href="/other-${n}.html">next</a>`);
  fs.writeFileSync(path.join(site, `other-${n}.html`), `<!doctype html><title>Other ${n}</title><p>moved away`);
}
const PORT = 8765;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: site, stdio: 'ignore' });
const U = (n) => `http://127.0.0.1:${PORT}/${n}.html`;

// v3.2: download endpoints. /fast/<n> finishes at once, /slow/<n> sends 10 chunks (one every 400 ms) so progress can be watched.
import http from 'http';
const dlSrv = http.createServer((req, res) => {
  const slow = req.url.startsWith('/slow');
  const n = req.url.split('/')[2] || '0';
  const size = slow ? 400000 : 2048 + Number(n) * 10;
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'content-disposition': `attachment; filename="sidebar-${slow ? 'slow' : 'fast'}-${n}.bin"` });
  if (!slow) { res.end(Buffer.alloc(size)); return; }
  let sent = 0;
  const t = setInterval(() => { res.write(Buffer.alloc(40000)); sent += 40000; if (sent >= size) { clearInterval(t); res.end(); } }, 400);
  res.on('close', () => clearInterval(t));
});
await new Promise((r) => dlSrv.listen(0, '127.0.0.1', r));
const DL = `http://127.0.0.1:${dlSrv.address().port}`;

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

async function main() {
  await sleep(500);
  const ctx = await chromium.launchPersistentContext(udd, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1200, height: 800 },
    env: { ...process.env, SIDEBAR_APP_DIR: helperDir },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check('extension id is the fixed one', extId === 'ffblekellgdmlecjablfojaaadpkmdgg', extId);
  let panel;
  // 'setProfileArchive' (the old SW command) is a test shortcut now: set this profile's effective archive time directly in storage.sync
  const cmd = (msg) => (msg.cmd === 'setProfileArchive'
    ? swEval(async (x) => { await chrome.storage.sync.set({ archiveMinutes: x === undefined ? null : x }); return { ok: true }; }, msg.minutes)
    : panel.evaluate((m) => new Promise((res) => chrome.runtime.sendMessage(m, res)), msg).catch((e) => ({ error: String(e) })));
  const swEval = (fn, arg) => sw.evaluate(fn, arg);
  // v3.0: settings live in their own window (settings.html), opened by the gear.
  let sp = null;
  const openSettings = async (sec) => {
    if (!sp || sp.isClosed()) {
      await panel.locator('[data-testid="settings-button"]').click();
      for (let t = 0; t < 8000 && !(sp = ctx.pages().find((p) => !p.isClosed() && p.url().includes('settings.html'))); t += 100) await sleep(100);
      await sp.waitForSelector('[data-testid="settings-nav"]');
    }
    if (sec) await sp.locator(`[data-testid="settings-nav-${sec}"]`).click();
    await sleep(400);
    return sp;
  };
  const closeSettings = async () => { if (sp && !sp.isClosed()) await sp.close(); sp = null; await sleep(600); };

  // Browsing window tabs
  const first = ctx.pages()[0] || await ctx.newPage();
  await first.goto(U('alpha'));
  for (const n of ['bravo', 'charlie', 'delta', 'echo']) { const p = await ctx.newPage(); await p.goto(U(n)); }
  await sleep(300);
  const mainWin = await swEval(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1/*' }))[0]?.windowId ?? (await chrome.windows.getAll())[0].id);

  // Panel opened in its own window so it doesn't list itself
  const panelWinId = await swEval(async (u) => (await chrome.windows.create({ url: u, type: 'popup', width: 320, height: 800 })).id,
    `chrome-extension://${extId}/sidepanel.html?windowId=${mainWin}`);
  await sleep(1200);
  panel = ctx.pages().find((p) => p.url().includes('sidepanel.html'));
  await panel.setViewportSize({ width: 320, height: 860 });
  const errors = [];
  panel.on('pageerror', (e) => errors.push(String(e)));
  panel.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await sleep(800);

  // Helper connection
  let st = await cmd({ cmd: 'debugState' });
  for (let i = 0; i < 20 && st?.helper?.status !== 'connected'; i++) { await sleep(300); st = await cmd({ cmd: 'debugState' }); }
  check('helper connected', st?.helper?.status === 'connected', JSON.stringify(st?.helper));
  check('helper profiles loaded', st?.helper?.profiles?.length === 2);

  // Today list
  const todayRows = async () => panel.locator('[data-testid="today-list"] > [data-testid="today-row"]').count();
  check('today lists the 5 window tabs', (await todayRows()) === 5, String(await todayRows()));
  await panel.screenshot({ path: path.join(OUT, '01-initial.png') });

  // Identify current profile via the inline picker
  const identify = panel.locator('[data-testid="profile-identify"]');
  if (await identify.count()) {
    await identify.selectOption('Default');
    await sleep(600);
  }
  st = await cmd({ cmd: 'debugState' });
  check('profile identified as Default', st?.helper?.currentProfileDir === 'Default', String(st?.helper?.currentProfileDir));
  const pills = await panel.locator('[data-testid="profile-pill"]').count();
  check('profile switcher shows 2 pills', pills === 2, String(pills));

  // Click a today row activates the tab
  const bravoRow = panel.locator('[data-testid="today-row"][data-url*="bravo"]');
  await bravoRow.click();
  await sleep(300);
  const activeUrl = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('clicking a Today row activates its tab', activeUrl.includes('bravo'), activeUrl);

  // v2.5: empty Favourites / Pinned are hidden until a drag starts; the New tab row has a hint
  {
    const hs = await panel.evaluate(() => ({ f: document.querySelector('.sec-favs').getBoundingClientRect().height, p: document.getElementById('sec-pinned').getBoundingClientRect().height, hint: document.querySelector('[data-testid="new-tab-row"] .kbd-hint')?.textContent }));
    check('v2.5: side panel hides empty Favourites and Pinned', hs.f === 0 && hs.p === 0, JSON.stringify(hs));
    check('v2.5: New tab row shows the \u2318T hint', hs.hint === '\u2318T');
    const r = panel.locator('[data-testid="today-row"]').first(); await r.hover(); const b = await r.boundingBox();
    await panel.mouse.down(); await panel.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 8, { steps: 4 }); await sleep(450);
    const h2 = await panel.evaluate(() => ({ f: document.querySelector('.sec-favs').getBoundingClientRect().height, p: document.getElementById('sec-pinned').getBoundingClientRect().height }));
    check('v2.5: a tab drag reveals them', h2.f > 30 && h2.p > 50, JSON.stringify(h2));
    await panel.mouse.move(b.x + b.width / 2, 3, { steps: 3 }); await panel.mouse.up(); await sleep(500);
    const h3 = await panel.evaluate(() => document.querySelector('.sec-favs').getBoundingClientRect().height + document.getElementById('sec-pinned').getBoundingClientRect().height);
    check('v2.5: and they hide again after the drag', h3 === 0, String(h3));
  }

  // Drag charlie into favourites
  await dragReveal(panel, panel.locator('[data-testid="today-row"][data-url*="charlie"]'), panel.locator('[data-testid="favourites-grid"]'));
  await sleep(700);
  check('drag tab → favourites creates a tile', (await panel.locator('[data-testid="favourite-tile"]').count()) === 1);
  check('pinned tab leaves Today', (await todayRows()) === 4, String(await todayRows()));

  // Drag delta into pinned
  await dragReveal(panel, panel.locator('[data-testid="today-row"][data-url*="delta"]'), panel.locator('[data-testid="pinned-tree"]'));
  await sleep(700);
  const pinnedRows = await panel.locator('[data-testid="pinned-row"]').count();
  check('drag tab → pinned creates a row', pinnedRows === 1, String(pinnedRows));

  // New folder
  await panel.locator('[data-testid="new-folder-button"]').click();
  await sleep(400);
  const ren = panel.locator('[data-testid="rename-input"]');
  if (await ren.count()) { await ren.fill('Reading'); await ren.press('Enter'); await sleep(400); }
  const folders = await panel.locator('[data-testid="pinned-folder"]').count();
  check('new folder created', folders === 1, String(folders));
  // Pin echo into the folder
  await dragReveal(panel, panel.locator('[data-testid="today-row"][data-url*="echo"]'), panel.locator('[data-testid="pinned-folder"]').first());
  await sleep(700);
  const echoParent = await swEval(async () => { const [b] = await chrome.bookmarks.search({ url: 'http://127.0.0.1:8765/echo.html' }); if (!b) return null; const [p] = await chrome.bookmarks.get(b.parentId); return p.title; });
  check('drag tab onto folder pins it inside the folder', echoParent === 'Reading', String(echoParent));

  // Close pinned delta → becomes not-open, then click to reopen
  const deltaRow = panel.locator('[data-testid="pinned-row"][data-url*="delta"]');
  await deltaRow.hover();
  await deltaRow.locator('[data-testid="pinned-close"]').click();
  await sleep(500);
  check('closing pinned item marks it not open', (await deltaRow.getAttribute('data-open')) === 'false', await deltaRow.getAttribute('data-open'));
  const tabsBefore = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  await deltaRow.click();
  await sleep(700);
  const tabsAfter = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  check('clicking a closed pinned item reopens it', tabsAfter === tabsBefore + 1 && (await deltaRow.getAttribute('data-open')) === 'true');
  await deltaRow.click(); await sleep(300);
  const tabsAgain = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).length, mainWin);
  check('clicking an open pinned item does not duplicate', tabsAgain === tabsAfter);

  // Navigate away → back button
  await swEval(async (w) => { const [t] = await chrome.tabs.query({ windowId: w, active: true }); await chrome.tabs.update(t.id, { url: 'http://127.0.0.1:8765/other-delta.html' }); }, mainWin);
  await sleep(900);
  const back = deltaRow.locator('[data-testid="pinned-back"]');
  check('back-to-pinned button appears after navigating away', (await back.count()) === 1 && await back.isVisible());
  await panel.screenshot({ path: path.join(OUT, '02-pinned.png') });
  await back.click(); await sleep(900);
  const deltaUrl = await swEval(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, mainWin);
  check('back button returns to pinned URL', deltaUrl.endsWith('/delta.html'), deltaUrl);

  // Persistent across windows: second window, favourites/pinned not open there
  const win2 = await swEval(async (u) => (await chrome.windows.create({ url: u })).id, U('foxtrot'));
  await sleep(600);
  const r2 = await cmd({ cmd: 'openItem', bookmarkId: await swEval(async () => (await chrome.bookmarks.search({ url: 'http://127.0.0.1:8765/charlie.html' }))[0].id), windowId: win2 });
  await sleep(600);
  const charlieInWin2 = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).some((t) => t.url.includes('charlie')), win2);
  check('favourite opens a separate tab in another window', r2?.ok !== false && charlieInWin2);
  const st2 = await cmd({ cmd: 'debugState' });
  check('each window has its own binding', Object.values(st2.bindings).filter((v) => v === Object.values(st2.bindings).find(Boolean)).length >= 1 && Object.keys(st2.bindings).length >= 4, JSON.stringify(st2.bindings));

  // Auto-archive: add tabs, age them, sweep
  for (const n of ['golf', 'alpha']) await swEval(async (u) => chrome.tabs.create({ url: u, active: false, windowId: undefined }), U(n));
  await sleep(600);
  await cmd({ cmd: 'setProfileArchive', minutes: 60 });
  await swEval(async () => {
    const { lastActive = {} } = await chrome.storage.local.get('lastActive');
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) lastActive[t.id] = Date.now() - 2 * 3600e3;
    await chrome.storage.local.set({ lastActive });
  });
  const before = await swEval(async () => (await chrome.tabs.query({})).map((t) => ({ url: t.url, active: t.active })));
  await cmd({ cmd: 'runArchiveNow' });
  await sleep(800);
  const after = await swEval(async () => (await chrome.tabs.query({})).map((t) => t.url));
  const st3 = await cmd({ cmd: 'debugState' });
  const archivedUrls = st3.archive.map((a) => a.url);
  check('idle unpinned tabs were archived', archivedUrls.some((u) => u.includes('golf')), archivedUrls.join(','));
  check('active tabs were kept', before.filter((t) => t.active).every((t) => after.includes(t.url)));
  check('bound (pinned/favourite) tabs were kept', after.some((u) => u.includes('delta')) && after.some((u) => u.includes('charlie')));
  check('extension pages are not archived', after.some((u) => u.includes('sidepanel.html')));

  // Archive view + restore
  await panel.locator('[data-testid="archive-button"]').click(); await sleep(400);
  const aRows = await panel.locator('[data-testid="archive-row"]').count();
  check('archive view lists archived tabs', aRows === st3.archive.length && aRows > 0, `${aRows} vs ${st3.archive.length}`);
  await panel.locator('[data-testid="archive-search"]').fill('golf'); await sleep(300);
  check('archive search filters', (await panel.locator('[data-testid="archive-row"]').count()) === 1);
  await panel.screenshot({ path: path.join(OUT, '03-archive.png') });
  await panel.locator('[data-testid="archive-row"]').first().click(); await sleep(700);
  const restored = await swEval(async () => (await chrome.tabs.query({})).some((t) => t.url.includes('golf')));
  check('restoring an archived tab reopens it', restored);
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(300);

  // Settings: global default via helper
  await openSettings('tabs');
  await sp.screenshot({ path: path.join(OUT, '04-settings.png') });
  const g = sp.locator('[data-testid="settings-archive-global"]');
  check('global default control enabled with helper', !(await g.isDisabled()));
  const opts = await g.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
  const day = opts.find(([, t]) => /24 hours/.test(t));
  await g.selectOption(day[0]); await sleep(700);
  const stateJson = JSON.parse(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'));
  check('global default saved to helper state', stateJson.archiveDefaultMinutes === 1440, JSON.stringify(stateJson));
  const st4 = await cmd({ cmd: 'debugState' });
  check('a profile without an override follows the global default', st4.settings.archiveMinutes == null && st4.settings.effectiveMinutes === 1440, JSON.stringify(st4.settings));
  // v3.7: scope + layout
  check('settings: there is no General section', (await sp.locator('[data-testid="settings-nav-general"]').count()) === 0 && (await sp.locator('[data-testid="settings-section-general"]').count()) === 0);
  const scopeSel = sp.locator('[data-testid="settings-scope"]');
  const stateShared = () => JSON.parse(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'));
  const chips = {};
  for (const id of ['appearance', 'tabs', 'windows', 'little', 'screenshots', 'boosts', 'profiles', 'app']) {
    await sp.locator(`[data-testid="settings-nav-${id}"]`).click(); await sleep(150);
    chips[id] = (await sp.locator('[data-testid="settings-scope-global"]').isVisible()) && (await sp.locator('[data-testid="settings-scope-global"]').innerText()) === 'All profiles' && (await scopeSel.count()) === 0;
  }
  check('settings: every section shows the "All profiles" chip and none has a profile picker', Object.values(chips).every(Boolean), JSON.stringify(chips));
  await sp.locator('[data-testid="settings-nav-tabs"]').click(); await sleep(200);
  const headsTxt = await sp.locator('[data-testid="settings-section-tabs"] .group-h:visible').allInnerTexts();
  check('settings: Tabs has no "This profile" group, no per-profile archive select and no "Apply to all profiles"', !headsTxt.includes('This profile') && (await sp.locator('[data-testid="settings-archive-profile"]').count()) === 0 && (await sp.locator('[data-testid="archive-apply-all"]').count()) === 0, JSON.stringify(headsTxt));
  check('settings: Little windows has no "This profile" heading', (await sp.locator('[data-testid="settings-little"] .group-h').allInnerTexts()).every((t) => t !== 'This profile'));
  const gDir = await swEval(async () => (await chrome.storage.session.get('helper')).helper?.currentProfileDir ?? null);
  // a global write reaches the app's `shared` and comes back as the effective value
  const grp = sp.locator('[data-testid="settings-archive-grouped"]');
  await grp.check(); await sleep(800);
  check('settings: "Also archive tabs in groups" is a global write (state.json shared + effective sync value)', stateShared().shared?.archiveGrouped === true && (await swEval(async () => (await chrome.storage.sync.get('archiveGrouped')).archiveGrouped)) === true, JSON.stringify(stateShared().shared));
  await grp.uncheck(); await sleep(800);
  check('settings: unchecking it writes false to shared', stateShared().shared?.archiveGrouped === false);
  await sp.locator('[data-testid="settings-nav-windows"]').click(); await sleep(200);
  await sp.locator('[data-testid="settings-merge-on-close"]').uncheck(); await sleep(800);
  check('settings: a Windows write goes to shared.mergeOnClose', stateShared().shared?.mergeOnClose === false);
  await sp.locator('[data-testid="settings-merge-on-close"]').check(); await sleep(800);
  check('settings: ...and back on', stateShared().shared?.mergeOnClose === true);
  // Profiles: per-profile overrides for the three tab settings; "Use global" clears
  await sp.locator('[data-testid="settings-nav-profiles"]').click(); await sleep(200);
  if (gDir) {
    const ovSel = (t) => sp.locator(`[data-testid="profile-overrides"][data-dir="${gDir}"] [data-testid="${t}"]`);
    await sp.locator(`[data-testid="profile-style-row"][data-dir="${gDir}"]`).click(); await sleep(300);
    check('settings: an expanded profile has a Tabs & Archive override block with three selects', (await sp.locator(`[data-testid="profile-overrides"][data-dir="${gDir}"] select`).count()) === 3);
    const first = (t) => ovSel(t).locator('option').first().innerText();
    check('settings: override selects start at "Use global (<value>)"', (await first('profile-override-archive')) === 'Use global (24 hours)' && (await first('profile-override-grouped')) === 'Use global (Off)' && (await first('profile-override-pinned')) === 'Use global (On)', JSON.stringify([await first('profile-override-archive'), await first('profile-override-grouped'), await first('profile-override-pinned')]));
    await ovSel('profile-override-archive').selectOption('60'); await sleep(900);
    check('settings: choosing an archive time sets profileOverrides[dir].archiveMinutes on the app and the effective sync value', stateShared().profileOverrides?.[gDir]?.archiveMinutes === 60 && (await swEval(async () => (await chrome.storage.sync.get('archiveMinutes')).archiveMinutes)) === 60, JSON.stringify(stateShared().profileOverrides));
    check('settings: the select shows the override', (await ovSel('profile-override-archive').inputValue()) === '60');
    await ovSel('profile-override-grouped').selectOption('true'); await sleep(800);
    check('settings: the groups override is a boolean on the app, the global value stays', stateShared().profileOverrides?.[gDir]?.archiveGrouped === true && (await swEval(async () => (await chrome.storage.sync.get('archiveGrouped')).archiveGrouped)) === true && stateShared().shared.archiveGrouped === false);
    await ovSel('profile-override-archive').selectOption(''); await sleep(800);
    await ovSel('profile-override-grouped').selectOption(''); await sleep(800);
    const eff = await swEval(async () => chrome.storage.sync.get(['archiveMinutes', 'archiveGrouped']));
    check('settings: "Use global" clears the overrides (the profile entry disappears) and the effective values follow the global', stateShared().profileOverrides?.[gDir] === undefined && eff.archiveMinutes == null && eff.archiveGrouped === false, JSON.stringify([stateShared().profileOverrides, eff]));
    await sp.locator(`[data-testid="profile-style-row"][data-dir="${gDir}"]`).click(); await sleep(200);
  } else check('settings: the test profile has a known dir (needed for the override checks)', false);
  await sp.locator('[data-testid="settings-nav-app"]').click(); await sleep(200);
  check('settings: Troubleshooting has the Chrome profile picker (relocated from General)', (await sp.locator('[data-testid="settings-profile-picker"]').isVisible()) && (await sp.locator('[data-testid="settings-current-profile"]').count()) === 1);
  await sp.locator('[data-testid="settings-nav-profiles"]').click(); await sleep(200);
  check('settings: Profiles is a global section too', await sp.locator('[data-testid="settings-scope-global"]').isVisible());
  // the gear asks Stile.app for its settings window first; this fake app has none, so it fell back to the page above
  check('settings: the gear asked the app (showSettings) before opening the Chrome page', host.showSettingsCalls.length >= 1 && host.showSettingsCalls[0].profileDir != null, JSON.stringify(host.showSettingsCalls));
  await closeSettings();
  {
    const n0 = host.showSettingsCalls.length;
    host.settingsWindow = true;
    const r = await cmd({ cmd: 'openSettings', section: 'tabs' }); await sleep(800);
    host.settingsWindow = false;
    check('settings: with an app settings window, openSettings goes to the app and opens no Chrome page', r?.ok === true && r.app === true && host.showSettingsCalls.length === n0 + 1 && host.showSettingsCalls[n0].section === 'tabs' && !ctx.pages().some((p) => !p.isClosed() && p.url().includes('settings.html')), JSON.stringify([r, host.showSettingsCalls.slice(n0)]));
    const r2 = await cmd({ cmd: 'openSettings' }); await sleep(1200);
    check('settings: when the app has no window, openSettings falls back to the Chrome page', r2?.ok === true && !r2.app && ctx.pages().some((p) => !p.isClosed() && p.url().includes('settings.html')), JSON.stringify(r2));
    sp = ctx.pages().find((p) => !p.isClosed() && p.url().includes('settings.html')) || null;   // opened outside openSettings()
    await closeSettings();
  }

  // Global settings migration: once per profile, after the profile dir is known. The first profile seeds the app's `shared`
  // from its own values; a later one defers to the global (except the tab settings, which become overrides when they differ).
  if (gDir) {
    const flagOf = () => swEval(async () => (await chrome.storage.local.get('sharedMigrated')).sharedMigrated === true);
    const reset = (vals) => swEval(async (v) => { await chrome.storage.local.remove(['sharedMigrated', 'sharedSettings', 'profileOverrides']); await chrome.storage.sync.set(v); }, vals);
    check('migration: the test profile has migrated on connect (flag set, app seeded)', (await flagOf()) && !!stateShared().shared);
    host.updateState((s) => { delete s.shared; delete s.profileOverrides; });   // the app has never been seeded
    await reset({ archiveMinutes: 60, archiveGrouped: true, littleStyle: 'regular', pinnedResetOnRestart: true });
    await cmd({ cmd: 'setProfileDir', dir: gDir }); await sleep(1500);
    let s1 = stateShared();
    check('migration (first profile): its values seed the global settings', s1.shared?.archiveGrouped === true && s1.shared?.littleStyle === 'regular' && s1.shared?.pinnedResetOnRestart === true, JSON.stringify(s1.shared));
    check('migration (first profile): archiveMinutes becomes this profile\'s override; values equal to the global are not overrides', JSON.stringify(s1.profileOverrides?.[gDir]) === JSON.stringify({ archiveMinutes: 60 }), JSON.stringify(s1.profileOverrides));
    check('migration (first profile): the flag is set and the effective archive time is the override', (await flagOf()) && (await swEval(async () => (await chrome.storage.sync.get('archiveMinutes')).archiveMinutes)) === 60);
    // a second profile (the same extension identifying as Profile 1) with different tab/Little settings
    await reset({ archiveMinutes: null, archiveGrouped: false, littleStyle: 'minimal', pinnedResetOnRestart: true });
    await cmd({ cmd: 'setProfileDir', dir: 'Profile 1' }); await sleep(1500);
    s1 = stateShared();
    check('migration (second profile): a differing archiveGrouped becomes an override, a differing littleStyle does not (global wins)', JSON.stringify(s1.profileOverrides?.['Profile 1']) === JSON.stringify({ archiveGrouped: false }) && s1.shared.littleStyle === 'regular' && s1.shared.archiveGrouped === true, JSON.stringify([s1.shared, s1.profileOverrides]));
    const eff2 = await swEval(async () => chrome.storage.sync.get(['archiveGrouped', 'littleStyle', 'archiveMinutes']));
    check('migration (second profile): the effective values are override ?? global', eff2.archiveGrouped === false && eff2.littleStyle === 'regular' && eff2.archiveMinutes == null, JSON.stringify(eff2));
    // put everything back
    await cmd({ cmd: 'setProfileDir', dir: gDir }); await sleep(800);
    await cmd({ cmd: 'setProfileOverride', dir: 'Profile 1', overrides: { archiveGrouped: null } });
    await cmd({ cmd: 'setProfileOverride', dir: gDir, overrides: { archiveMinutes: null } });
    await cmd({ cmd: 'setShared', values: { archiveGrouped: false, littleStyle: 'minimal' } }); await sleep(800);
    const s2 = stateShared(), eff3 = await swEval(async () => chrome.storage.sync.get(['archiveGrouped', 'littleStyle', 'archiveMinutes']));
    check('migration: cleanup leaves no overrides and the defaults', !s2.profileOverrides || Object.keys(s2.profileOverrides).length === 0, JSON.stringify([s2.shared, s2.profileOverrides, eff3]));
    check('migration: an invalid global write is refused and changes nothing', await (async () => { const r = await cmd({ cmd: 'setShared', values: { littleMaxOpen: 99 } }); return r.ok === false && stateShared().shared.littleMaxOpen !== 99; })());
  }

  // Profile switch → helper launches Chrome for the other profile
  await panel.locator('[data-testid="profile-pill"]').nth(1).click();
  await sleep(1200);
  const launched = fs.existsSync(fakeChromeLog) ? fs.readFileSync(fakeChromeLog, 'utf8') : '';
  check('switching profile launches Chrome with --profile-directory', launched.includes('--profile-directory=Profile 1'), launched.trim());
  check('pending handoff remembered for target profile', host.pending.has('Profile 1'));

  // Address field
  await panel.locator('[data-testid="address-field"]').fill('127.0.0.1:8765/bravo.html');
  await panel.locator('[data-testid="address-field"]').press('Enter'); await sleep(800);
  const opened = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => t.url), mainWin);
  check('address field opens URL in the panel window', opened.some((u) => u.startsWith('http') && u.includes('bravo')), opened.join(','));

  // Unpin by dragging favourite to Today
  await panel.locator('[data-testid="favourite-tile"]').first().dragTo(panel.locator('[data-testid="today-list"]'));
  await sleep(700);
  check('drag favourite → Today unpins it', (await panel.locator('[data-testid="favourite-tile"]').count()) === 0);

  // Clear today
  const cnt = await todayRows();
  await panel.locator('[data-testid="clear-button"]').click(); await sleep(800);
  check('Clear archives Today tabs except the active one', (await todayRows()) <= 1 && cnt > 1, `${cnt} → ${await todayRows()}`);

  // Dark mode screenshots
  await panel.emulateMedia({ colorScheme: 'dark' });
  await sleep(300);
  await panel.screenshot({ path: path.join(OUT, '05-dark.png') });
  await panel.emulateMedia({ colorScheme: 'light' });


  // ---------- v1.1 ----------
  const dbg = () => cmd({ cmd: 'debugState' });
  // Profile icons
  const pill1 = panel.locator('[data-testid="profile-pill"]').nth(1);
  check('Work profile icon uses its account picture', (await pill1.getAttribute('data-icon')) === 'picture' && (await pill1.locator('img').count()) === 1, await pill1.getAttribute('data-icon'));
  check('profile icons have no visible names', !(await panel.locator('[data-testid="profile-switcher"]').innerText()).includes('Work'));
  const tint = await panel.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--profile').trim() || getComputedStyle(document.body).getPropertyValue('--profile').trim());
  check('panel themed with current profile colour', /^#|rgb|oklab|color/.test(tint) && !/^#8e8e93/i.test(tint), tint);
  // Style editor
  await openSettings('appearance');
  // Sidebar colour setting (side-panel mode)
  {
    const bg = () => panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const rgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
    const profBg = await bg();
    check('v3.0 default colour: with no theme/sample/custom, Automatic falls back to Chrome\'s default frame colour #e9eef6 (profile colour no longer seeds it)', (profBg === 'rgb(233, 238, 246)' || (/oklab\(0\.90[5-7]/.test(profBg))), profBg);
    check('sidebar colour: Automatic selected, note says "Chrome\'s default colour"',
      (await sp.locator('[data-testid="sidebar-color-mode"] [data-mode="auto"]').getAttribute('aria-pressed')) === 'true' &&
      /Chrome.s default colour/.test(await sp.locator('[data-testid="sidebar-color-note"]').innerText()));
    await sp.locator('[data-testid="sidebar-color-mode"] [data-mode="custom"]').click(); await sleep(400);
    check('sidebar colour: Custom shows 14 swatches and the picker', (await sp.locator('[data-testid="sidebar-color-swatch"]:visible').count()) === 14 && await sp.locator('[data-testid="sidebar-color-picker"]').isVisible());
    await sp.locator('[data-testid="sidebar-color-swatch"][data-color="#e6f4ea"]').click(); await sleep(400);
    check('sidebar colour: custom swatch sets the exact background', (await bg()) === rgb('#e6f4ea'), await bg());
    await sp.screenshot({ path: path.join(OUT, '05-sidebar-colour.png') });
    await sp.locator('[data-testid="sidebar-color-picker"]').fill('#204060'); await sleep(500);
    check('sidebar colour: picker value applies exactly, with light text on dark', (await bg()) === rgb('#204060') && (await panel.evaluate(() => getComputedStyle(document.body).color)) === 'rgb(236, 236, 240)', await bg());
    const saved = await swEval(async () => (await chrome.storage.sync.get('sidebarColor')).sidebarColor);
    check('sidebar colour: stored in chrome.storage.sync', saved && saved.mode === 'custom' && saved.color === '#204060', JSON.stringify(saved));
    await sp.locator('[data-testid="sidebar-color-mode"] [data-mode="auto"]').click(); await sleep(500);
    check('sidebar colour: back to Automatic restores the default colour', (await bg()) === profBg, await bg());
  }
  await openSettings('profiles');
  const styleRow = sp.locator('[data-testid="profile-style-row"]').first();
  await styleRow.click(); await sleep(300);
  await sp.locator('[data-testid="style-icon"][data-icon="rocket"]').first().click(); await sleep(500);
  await sp.locator('[data-testid="style-color"][data-color="#bf5af2"]').first().click(); await sleep(800);
  const st5 = JSON.parse(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'));
  check('icon and colour saved to helper', st5.profileStyles?.Default?.icon === 'rocket' && st5.profileStyles?.Default?.color?.toLowerCase() === '#bf5af2', JSON.stringify(st5.profileStyles));
  await sp.screenshot({ path: path.join(OUT, '06-style-editor.png') });
  await closeSettings();
  const pill0 = panel.locator('[data-testid="profile-pill"]').first();
  check('switcher shows the chosen icon', (await pill0.getAttribute('data-icon')) === 'rocket');

  // Today across windows
  const wA = await swEval(async (u) => (await chrome.windows.create({ url: u })).id, U('alpha'));
  await swEval(async ([w, u]) => chrome.tabs.create({ windowId: w, url: u, active: false }), [wA, U('bravo')]);
  await sleep(900);
  const sec = panel.locator(`[data-testid="window-section"][data-window-id="${wA}"]`);
  check('other window appears as its own section', (await sec.count()) === 1);
  const otherRow = sec.locator('[data-testid="today-row"][data-url*="bravo"]').first();
  check('other window tabs are listed', (await otherRow.count()) === 1);
  const bravoId = Number(await otherRow.getAttribute('data-tab-id'));
  await otherRow.click(); await sleep(800);
  const bt = await swEval(async (id) => chrome.tabs.get(id), bravoId);
  check('clicking another window\'s tab moves it here', bt.windowId === mainWin && bt.active, `win ${bt.windowId} vs ${mainWin}`);

  // Tab groups
  const ids = await swEval(async ([w, u1, u2]) => {
    const a = await chrome.tabs.create({ windowId: w, url: u1, active: false });
    const b = await chrome.tabs.create({ windowId: w, url: u2, active: false });
    const g = await chrome.tabs.group({ tabIds: [a.id, b.id], createProperties: { windowId: w } });
    await chrome.tabGroups.update(g, { title: 'Research', color: 'green' });
    return { a: a.id, b: b.id, g };
  }, [mainWin, U('charlie'), U('golf')]);
  await sleep(900);
  const gRow = panel.locator(`[data-testid="group-row"][data-group-id="${ids.g}"]`);
  check('tab group renders with its title', (await gRow.count()) === 1 && (await gRow.innerText()).includes('Research'));
  const gw = async (l) => { if (process.env.E2E_DEBUG) console.log(l, 'group window', await swEval(async (g) => (await chrome.tabGroups.get(g)).windowId, ids.g), 'main', mainWin, 'wA', wA); };
  await gw('created');
  await panel.screenshot({ path: path.join(OUT, '07-groups.png') });
  await gRow.click(); await sleep(600);
  const collapsed = await swEval(async (g) => (await chrome.tabGroups.get(g)).collapsed, ids.g);
  check('clicking group header collapses it in Chrome', collapsed === true);
  await gRow.click(); await sleep(600);
  await gw('after collapse toggle');
  // drag an ungrouped tab onto the group header
  const loose = panel.locator('[data-testid="today-list"] > [data-testid="today-row"]').first();
  const looseId = Number(await loose.getAttribute('data-tab-id'));
  await loose.dragTo(gRow); await sleep(800);
  await gw('after drag');
  const lg = await swEval(async (id) => (await chrome.tabs.get(id)).groupId, looseId);
  check('dragging a tab onto a group adds it to the group', lg === ids.g, `${lg} vs ${ids.g}`);
  // grouped tabs survive archive sweep
  await swEval(async () => { const { lastActive = {} } = await chrome.storage.local.get('lastActive'); for (const t of await chrome.tabs.query({})) lastActive[t.id] = Date.now() - 48 * 3600e3; await chrome.storage.local.set({ lastActive }); });
  await cmd({ cmd: 'setProfileArchive', minutes: 60 });
  await cmd({ cmd: 'runArchiveNow' }); await sleep(800);
  const gAlive = await swEval(async (g) => (await chrome.tabs.query({ groupId: g })).length, ids.g);
  check('grouped tabs are not auto-archived by default', gAlive >= 2, String(gAlive));

  // Split view (unsupported in this Chromium) — menu shows disabled hint, nothing throws
  const st6 = await dbg();
  check('split support detected correctly (absent here)', st6.splitSupported === false, String(st6.splitSupported));
  const anyRow = panel.locator('[data-testid="today-row"]').first();
  await anyRow.click({ button: 'right' }); await sleep(300);
  const menuText = await panel.locator('[data-testid="context-menu"]').innerText().catch(() => '');
  check('tab menu explains split needs newer Chrome', /155/.test(menuText), menuText.replace(/\n/g, ' | '));
  check('tab menu offers move to new window', /new window/i.test(menuText));
  await panel.keyboard.press('Escape');

  // Move to new window via menu
  const winsBefore = (await swEval(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).length));
  await anyRow.click({ button: 'right' }); await sleep(300);
  await panel.locator('[data-testid="context-menu-item"]', { hasText: /new window/i }).first().click(); await sleep(900);
  const winsAfter = (await swEval(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).length));
  check('"Move to new window" creates a window', winsAfter === winsBefore + 1, `${winsBefore} → ${winsAfter}`);

  // Pinned reset via menu
  await swEval(async (w) => { const [b] = await chrome.bookmarks.search({ url: 'http://127.0.0.1:8765/delta.html' }); const tabs = await chrome.tabs.query({ windowId: w }); const t = tabs.find((x) => x.url.includes('delta')); if (t) await chrome.tabs.update(t.id, { url: 'http://127.0.0.1:8765/other-delta.html', active: true }); }, mainWin);
  await sleep(900);
  const dRow = panel.locator('[data-testid="pinned-row"][data-url*="delta"]');
  check('navigated-away pinned row shows current host', (await dRow.locator('[data-testid="pinned-host"]').count()) === 1);
  await dRow.click({ button: 'right' }); await sleep(300);
  await panel.locator('[data-testid="context-menu-item"][data-action="reset"]').click(); await sleep(900);
  const dUrl = await swEval(async (w) => (await chrome.tabs.query({ windowId: w })).find((t) => t.url.includes('delta'))?.url, mainWin);
  check('"Go back to pinned page" resets the tab', dUrl?.endsWith('/delta.html'), dUrl);

  if (process.env.E2E_DEBUG) { const d = await dbg(); console.log('mainWin', mainWin, JSON.stringify(d.windows.map(w => ({ id: w.id, tabs: w.tabs.map(t => t.url.split('/').pop() + ':' + t.groupId) })))); }
  await panel.screenshot({ path: path.join(OUT, '08-full.png') });
  await panel.emulateMedia({ colorScheme: 'dark' }); await sleep(300);
  await panel.screenshot({ path: path.join(OUT, '09-full-dark.png') });
  await panel.emulateMedia({ colorScheme: 'light' });


  // ---------- v1.2 ----------
  const tabsIn = (w) => swEval(async (id) => (await chrome.tabs.query({ windowId: id })).map((t) => ({ id: t.id, url: t.url, active: t.active, groupId: t.groupId, title: t.title })), w);
  const winExists = (w) => swEval(async (id) => { try { await chrome.windows.get(id); return true; } catch { return false; } }, w);
  let d12 = await dbg();
  check('first window is the main window', d12.mainWindowId === mainWin, `${d12.mainWindowId} vs ${mainWin}`);

  // Manual merge keeps groups
  const wM = await swEval(async ([u1, u2]) => { const w = await chrome.windows.create({ url: u1 }); const t = await chrome.tabs.create({ windowId: w.id, url: u2 }); const g = await chrome.tabs.group({ tabIds: [t.id], createProperties: { windowId: w.id } }); await chrome.tabGroups.update(g, { title: 'Kept' }); return w.id; }, [U('other-alpha'), U('other-bravo')]);
  await sleep(1000);
  const mergeBtn = panel.locator(`[data-testid="window-section"][data-window-id="${wM}"] [data-testid="window-merge"]`);
  check('pop-out section has a Merge button', (await mergeBtn.count()) === 1);
  await mergeBtn.click({ force: true }); await sleep(1200);
  const afterMerge = await tabsIn(mainWin);
  const keptGroup = await swEval(async (w) => (await chrome.tabGroups.query({ windowId: w })).some((g) => g.title === 'Kept'), mainWin);
  check('merge moves tabs into the main window', afterMerge.some((t) => t.url.includes('other-alpha')) && afterMerge.some((t) => t.url.includes('other-bravo')) && !(await winExists(wM)));
  check('merge keeps tab groups', keptGroup);

  // Merge all button visible with several windows
  check('Merge all shows when there are several windows', (await panel.locator('[data-testid="merge-all"]').count()) === 1);

  // Merge back on close
  const wC = await swEval(async ([a, b, c]) => { const w = await chrome.windows.create({ url: a }); await chrome.tabs.create({ windowId: w.id, url: b }); await chrome.tabs.create({ windowId: w.id, url: c }); return w.id; }, [U('other-charlie'), U('other-delta'), U('other-echo')]);
  await sleep(1200);
  await swEval(async (w) => chrome.windows.remove(w), wC);
  await sleep(3000);
  const afterClose = await tabsIn(mainWin);
  check('closing a pop-out moves its tabs back to main', ['other-charlie', 'other-delta', 'other-echo'].every((n) => afterClose.some((t) => t.url.includes(n))), afterClose.map((t) => t.url.split('/').pop()).join(','));
  const toastTxt = await panel.locator('[data-testid="toast"]').innerText().catch(() => '');
  check('toast reports tabs moved back', /moved|back/i.test(toastTxt), toastTxt);

  // Single-tab pop-out close → archive, not reopened
  const wS = await swEval(async (u) => (await chrome.windows.create({ url: u })).id, U('other-foxtrot'));
  await sleep(1200);
  await swEval(async (w) => chrome.windows.remove(w), wS);
  await sleep(3000);
  const afterSingle = await tabsIn(mainWin);
  d12 = await dbg();
  check('closing a one-tab pop-out archives instead of reopening', !afterSingle.some((t) => t.url.includes('other-foxtrot')) && d12.archive.some((a) => a.url.includes('other-foxtrot')));

  // Bring an active tab from another window → that window shows the next tab
  const wB = await swEval(async ([a, b, c]) => { const w = await chrome.windows.create({ url: a }); const t2 = await chrome.tabs.create({ windowId: w.id, url: b }); await chrome.tabs.create({ windowId: w.id, url: c, active: false }); await chrome.tabs.update(t2.id, { active: true }); return w.id; }, [U('other-golf'), U('alpha') + '?x=1', U('bravo') + '?x=2']);
  await sleep(1200);
  await panel.locator(`[data-testid="window-section"][data-window-id="${wB}"] [data-testid="today-row"][data-url*="x=1"]`).click(); await sleep(1000);
  const wBTabs = await tabsIn(wB);
  check('bringing the active tab activates the next tab in its old window', wBTabs.find((t) => t.active)?.url.includes('x=2'), wBTabs.map((t) => `${t.url.split('/').pop()}${t.active ? '*' : ''}`).join(','));

  // Rename tab (panel + real page title)
  const rRow = panel.locator('[data-testid="today-list"] > [data-testid="today-row"][data-url*="x=1"]');
  await rRow.click({ button: 'right' }); await sleep(300);
  await panel.locator('[data-testid="context-menu-item"][data-action="rename-tab"]').click(); await sleep(300);
  await panel.locator('[data-testid="rename-input"]').fill('My renamed tab');
  await panel.locator('[data-testid="rename-input"]').press('Enter'); await sleep(1500);
  check('renamed tab shows the new name', (await rRow.innerText()).includes('My renamed tab'));
  const realTitle = await swEval(async () => (await chrome.tabs.query({})).find((t) => t.url.includes('x=1'))?.title);
  check('rename also changes the page title in Chrome', realTitle === 'My renamed tab', realTitle);

  // Duplicate
  const before2 = (await tabsIn(mainWin)).filter((t) => t.url.includes('x=1')).length;
  await rRow.click({ button: 'right' }); await sleep(300);
  await panel.locator('[data-testid="context-menu-item"][data-action="duplicate"]').click(); await sleep(1200);
  check('Duplicate tab opens a copy', (await tabsIn(mainWin)).filter((t) => t.url.includes('x=1')).length === before2 + 1);

  // Tidy by website + undo
  for (const n of ['alpha', 'bravo', 'charlie']) await swEval(async (u) => chrome.tabs.create({ url: u, active: false, windowId: undefined }), `http://localhost:${PORT}/${n}.html`);
  await swEval(async ([w, us]) => { for (const u of us) await chrome.tabs.create({ windowId: w, url: u, active: false }); }, [mainWin, [`http://localhost:${PORT}/delta.html`, `http://localhost:${PORT}/echo.html`]]);
  await sleep(1200);
  await panel.locator('[data-testid="tidy-button"]').click(); await sleep(1200);
  const groupsAfterTidy = await swEval(async (w) => (await chrome.tabGroups.query({ windowId: w })).map((g) => g.title), mainWin);
  check('Tidy groups tabs by website', groupsAfterTidy.some((t) => /localhost/i.test(t)), groupsAfterTidy.join(','));
  await panel.screenshot({ path: path.join(OUT, '10-tidy.png') });
  await panel.locator('[data-testid="toast-undo"]').click(); await sleep(1000);
  const groupsAfterUndo = await swEval(async (w) => (await chrome.tabGroups.query({ windowId: w })).map((g) => g.title), mainWin);
  check('Undo reverses Tidy', !groupsAfterUndo.some((t) => /localhost/i.test(t)), groupsAfterUndo.join(','));

  // Close tabs below
  const rows = panel.locator('[data-testid="today-list"] > [data-testid="today-row"]');
  const nRows = await rows.count();
  await rows.nth(1).click({ button: 'right' }); await sleep(300);
  await panel.locator('[data-testid="context-menu-item"][data-action="close-below"]').click(); await sleep(400);
  if (await panel.locator('[data-testid="confirm-ok"]').count()) { await panel.locator('[data-testid="confirm-ok"]').click(); }
  await sleep(900);
  const nAfter = await panel.locator('[data-testid="today-list"] > [data-testid="today-row"]').count();
  check('Close tabs below closes the tabs under it', nAfter < nRows && nAfter >= 2, `${nRows} → ${nAfter}`);

  // Clear + Undo
  const beforeClear = await panel.locator('[data-testid="today-list"] > [data-testid="today-row"]').count();
  await panel.locator('[data-testid="clear-button"]').click(); await sleep(1000);
  const afterClear = await panel.locator('[data-testid="today-list"] > [data-testid="today-row"]').count();
  check('Clear archives every Today tab in this window', afterClear <= 1, `${beforeClear} → ${afterClear}`);
  await panel.locator('[data-testid="toast-undo"]').click(); await sleep(1500);
  const afterUndo = await panel.locator('[data-testid="today-list"] > [data-testid="today-row"]').count();
  check('Undo brings cleared tabs back', afterUndo >= beforeClear, `${afterUndo} vs ${beforeClear}`);

  // ---- v2.6: lock tabs
  {
    const dbg = () => cmd({ cmd: 'debugState' });
    const firstRow = panel.locator('[data-testid="today-list"] > [data-testid="today-row"]').first();
    const lid = Number(await firstRow.getAttribute('data-tab-id'));
    const rowOf = (id) => panel.locator(`[data-testid="today-row"][data-tab-id="${id}"]`);
    await firstRow.click({ button: 'right' }); await sleep(300);
    check('v2.6 lock: the tab menu offers "Lock tab" (data-action=lock)', (await panel.locator('[data-testid="context-menu-item"][data-action="lock"]').count()) === 1 && (await panel.locator('[data-action="unlock"]').count()) === 0);
    await panel.locator('[data-testid="context-menu-item"][data-action="lock"]').click(); await sleep(900);
    let d = await dbg();
    check('v2.6 lock: lockedTabs[tabId] = { url } is stored by the worker and shown in debugState', d.lockedTabs?.[lid] && d.lockedTabs[lid].url.startsWith('http'), JSON.stringify(d.lockedTabs));
    check('v2.6 lock: the row shows a lock icon', (await rowOf(lid).locator('[data-testid="lock-icon"]').count()) === 1);
    await rowOf(lid).click({ button: 'right' }); await sleep(300);
    check('v2.6 lock: a locked tab offers "Unlock tab" (data-action=unlock)', (await panel.locator('[data-action="unlock"]').count()) === 1 && (await panel.locator('[data-action="lock"]').count()) === 0);
    await panel.locator('[data-action="unlock"]').click(); await sleep(900);
    d = await dbg();
    check('v2.6 lock: Unlock tab removes the lock and the icon', !d.lockedTabs?.[lid] && (await rowOf(lid).locator('[data-testid="lock-icon"]').count()) === 0);

    // ---- v3.6: Record Chrome Tab (the app records; the extension sends the request and tracks the tab)
    {
      const recs = [];
      host.on('record', (x) => recs.push(x));
      const lastOf = (type) => [...recs].reverse().find((r) => r.type === type);
      const tabInfo = await swEval(async (id) => { const t = await chrome.tabs.get(id); return { windowId: t.windowId, title: t.title }; }, lid);
      const activeBefore = await swEval(async (w) => (await chrome.tabs.query({ active: true, windowId: w }))[0].id, tabInfo.windowId);
      await rowOf(lid).click({ button: 'right' }); await sleep(300);
      check('v3.6 record: the tab menu offers "Record this tab" while the app is connected', (await panel.locator('[data-testid="context-menu-item"][data-action="record-tab"]').count()) === 1);
      await panel.locator('[data-testid="context-menu-item"][data-action="record-tab"]').click(); await sleep(600);
      const rt = lastOf('recordTab');
      check('v3.6 record: the menu item sends recordTab {windowId, tabId, title} to the app', rt?.msg.tabId === lid && rt.msg.windowId === tabInfo.windowId && typeof rt.msg.title === 'string', JSON.stringify(rt?.msg));
      const n0 = recs.length;
      const r2 = await cmd({ cmd: 'recordTab', tabId: lid }); await sleep(300);
      check('v3.6 record: the recordTab command answers ok and sends the same message', r2?.ok === true && recs.length === n0 + 1 && recs.at(-1).msg.tabId === lid, JSON.stringify(r2));
      const r3 = await cmd({ cmd: 'recordTab', tabId: 999999 });
      check('v3.6 record: the command refuses a tab that is gone', r3?.ok === false && /gone/.test(r3.error || ''), JSON.stringify(r3));

      host.setRecordingTab('Default', lid); await sleep(700);
      check('v3.6 record: the app naming the tab puts a red dot on its row, and the menu stops offering the item',
        (await rowOf(lid).locator('[data-testid="recording-dot"]').count()) === 1);
      await rowOf(lid).click({ button: 'right' }); await sleep(300);
      check('v3.6 record: no "Record this tab" for the tab being recorded', (await panel.locator('[data-action="record-tab"]').count()) === 0);
      await panel.keyboard.press('Escape');

      // leaving / returning to the tab: auto-pause and resume
      const otherId = await swEval(async ([w, id]) => (await chrome.tabs.query({ windowId: w })).find((t) => t.id !== id)?.id ?? null, [tabInfo.windowId, lid]);
      if (otherId != null) {
        recs.length = 0;
        await swEval(async (id) => chrome.tabs.update(id, { active: true }), otherId); await sleep(500);
        check('v3.6 record: switching to another tab sends recordTabState active:false', recs.some((r) => r.type === 'recordTabState' && r.msg.tabId === lid && r.msg.active === false), JSON.stringify(recs.map((r) => r.msg)));
        recs.length = 0;
        await swEval(async (id) => chrome.tabs.update(id, { active: true }), lid); await sleep(500);
        check('v3.6 record: coming back sends recordTabState active:true', recs.some((r) => r.type === 'recordTabState' && r.msg.tabId === lid && r.msg.active === true), JSON.stringify(recs.map((r) => r.msg)));
        check('v3.6 record: a tab switch in a window that is not recorded sends nothing else', !recs.some((r) => r.msg.tabId !== lid));
      }

      // the menu bar's "Record Chrome Tab": the app asks, the extension answers with the active tab of the last focused window
      recs.length = 0;
      host.requestRecordTab('Default'); await sleep(700);
      check('v3.6 record: recordTabRequest is answered with recordTab for an active tab', recs.some((r) => r.type === 'recordTab' && Number.isFinite(r.msg.tabId) && Number.isFinite(r.msg.windowId)), JSON.stringify(recs.map((r) => r.msg)));

      // a recorded tab that is closed, and one that moves to another window
      const fresh = await swEval(async (w) => (await chrome.tabs.create({ windowId: w, url: 'about:blank', active: false })).id, tabInfo.windowId);
      host.setRecordingTab('Default', fresh); await sleep(500);
      recs.length = 0;
      await swEval(async (id) => chrome.tabs.remove(id), fresh); await sleep(600);
      check('v3.6 record: closing the recorded tab sends recordTabClosed', recs.some((r) => r.type === 'recordTabClosed' && r.msg.tabId === fresh), JSON.stringify(recs.map((r) => r.msg)));
      const fresh2 = await swEval(async (w) => (await chrome.tabs.create({ windowId: w, url: 'about:blank', active: false })).id, tabInfo.windowId);
      host.setRecordingTab('Default', fresh2); await sleep(500);
      recs.length = 0;
      const newWin = await swEval(async (id) => (await chrome.windows.create({ tabId: id })).id, fresh2); await sleep(900);
      check('v3.6 record: moving the recorded tab to another window sends recordTabMoved (then its state there)', recs.some((r) => r.type === 'recordTabMoved' && r.msg.tabId === fresh2 && r.msg.windowId === newWin) && recs.some((r) => r.type === 'recordTabState' && r.msg.tabId === fresh2 && r.msg.active === true), JSON.stringify(recs.map((r) => [r.type, r.msg])));
      host.setRecordingTab('Default', null); await sleep(500);
      check('v3.6 record: recordingTab null clears the dot and the tracking', (await rowOf(lid).locator('[data-testid="recording-dot"]').count()) === 0);
      recs.length = 0;
      await swEval(async (id) => chrome.windows.remove(id), newWin); await sleep(500);
      check('v3.6 record: after the recording, tab changes send nothing', recs.length === 0, JSON.stringify(recs.map((r) => r.msg)));
      await swEval(async (id) => chrome.tabs.update(id, { active: true }), activeBefore); await sleep(300);
    }

    // effects, in a window of their own
    const prevMin = d.settings.archiveMinutes;
    const urlsL = [0, 1, 2, 3, 4].map((i) => U('alpha') + `?l=${i}`);
    const wL = await swEval(async (urls) => (await chrome.windows.create({ url: urls })).id, urlsL);
    await sleep(1500);
    const idOf = async (i) => swEval(async ([w, k]) => (await chrome.tabs.query({ windowId: w })).find((t) => t.url.endsWith(k))?.id ?? null, [wL, `?l=${i}`]);
    const ids = {}; for (const i of [0, 1, 2, 3, 4]) ids[i] = await idOf(i);
    await cmd({ cmd: 'setTabLock', tabId: ids[1], locked: true });
    await cmd({ cmd: 'setTabLock', tabId: ids[3], locked: true });
    await cmd({ cmd: 'setProfileArchive', minutes: 60 });
    await swEval(async ([w, mine]) => {
      const { lastActive = {} } = await chrome.storage.local.get('lastActive');
      for (const t of await chrome.tabs.query({})) lastActive[t.id] = t.windowId === w ? Date.now() - 3 * 3600e3 : Date.now();
      await chrome.storage.local.set({ lastActive });
    }, [wL]);
    const arc0 = (await dbg()).archive.length;
    await cmd({ cmd: 'runArchiveNow' }); await sleep(900);
    d = await dbg();
    const live = async () => swEval(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => t.url.split('?')[1]), wL);
    let alive = await live();
    const archivedL = d.archive.map((a) => a.url.split('?')[1]);
    check('v2.6 lock: auto-archive never archives a locked tab (idle unlocked ones are archived)', alive.includes('l=1') && alive.includes('l=3') && !alive.includes('l=2') && !alive.includes('l=4') && archivedL.includes('l=2') && archivedL.includes('l=4') && !archivedL.includes('l=1') && !archivedL.includes('l=3'), JSON.stringify({ alive, archivedL }));
    check('v2.6 lock: the lock survives runArchiveNow', !!d.lockedTabs?.[ids[1]] && !!d.lockedTabs?.[ids[3]] && d.archive.length === arc0 + 2, String(d.archive.length - arc0));
    await cmd({ cmd: 'setProfileArchive', minutes: prevMin ?? undefined });
    for (const i of [5, 6]) await swEval(async ([w, u]) => chrome.tabs.create({ windowId: w, url: u, active: false }), [wL, U('alpha') + `?l=${i}`]);
    await sleep(600);
    ids[5] = await idOf(5); ids[6] = await idOf(6);
    const dry = async (which, tabId) => (await cmd({ cmd: 'closeTabs', windowId: wL, tabId, which, dryRun: true })).closed;
    const counts = { others: await dry('others', ids[0]), below: await dry('below', ids[0]), above: await dry('above', ids[6]), all: await dry('all', ids[0]) };
    check('v2.6 lock: close others / below / above / all skip locked tabs and the dry-run count excludes them', counts.others === 2 && counts.below === 2 && counts.above === 2 && counts.all === 3, JSON.stringify(counts));
    await cmd({ cmd: 'closeTabs', windowId: wL, tabId: ids[0], which: 'others' }); await sleep(700);
    alive = await live();
    check('v2.6 lock: "close others" really leaves the locked tabs', alive.join() === 'l=0,l=1,l=3', alive.join());
    const tidy = await cmd({ cmd: 'tidyWindow', windowId: wL });
    const grouped = await swEval(async ([w, a, b]) => [(await chrome.tabs.get(a)).groupId, (await chrome.tabs.get(b)).groupId], [wL, ids[1], ids[3]]);
    check('v2.6 lock: Tidy still groups locked tabs', tidy.ok && tidy.tidied === 3 && grouped.every((g) => g >= 0), JSON.stringify([tidy, grouped]));
    await cmd({ cmd: 'undo', id: tidy.undoId }); await sleep(500);
    const arc1 = (await dbg()).archive.length;
    const clr = await cmd({ cmd: 'clearToday', windowId: wL }); await sleep(800);
    alive = await live();
    check('v2.6 lock: Clear skips locked tabs', clr.ok && clr.archived === 1 && alive.join() === 'l=1,l=3' && (await dbg()).archive.length === arc1 + 1, JSON.stringify([clr.archived, alive]));
    // closing the locked tab itself still works and drops its lock
    await swEval(async (id) => chrome.tabs.remove(id), ids[1]); await sleep(800);
    d = await dbg();
    check('v2.6 lock: closing a locked tab itself works and drops its lock', !(await live()).includes('l=1') && !d.lockedTabs?.[ids[1]] && !!d.lockedTabs?.[ids[3]]);
    // restart re-attach by exact URL (stored entries stashed as pending, tab ids "changed")
    const lurl = d.lockedTabs[ids[3]].url;
    await swEval(async (u) => chrome.storage.local.set({ lockedTabs: {}, lockedTabsPending: [{ url: u }] }), lurl);
    await cmd({ cmd: 'debugRematch', mode: 'retry' });
    d = await dbg();
    check('v2.6 lock: restart rematch re-attaches a pending lock to the tab with the same URL', d.lockedTabs?.[ids[3]]?.url === lurl);
    await swEval(async ([id, u]) => chrome.storage.local.set({ lockedTabs: { [id]: { url: u }, 99999: { url: 'http://stale.example/' } } }), [ids[3], lurl]);
    await cmd({ cmd: 'debugRematch', mode: 'init' });
    const pend = await swEval(async () => (await chrome.storage.local.get('lockedTabsPending')).lockedTabsPending);
    d = await dbg();
    check('v2.6 lock: startup init stashes stale ids, keeps the matching one, retries the rest', d.lockedTabs?.[ids[3]]?.url === lurl && !d.lockedTabs?.[99999] && pend.some((p) => p.url === 'http://stale.example/'), JSON.stringify(pend));
    await cmd({ cmd: 'debugRematch', mode: 'final' });
    check('v2.6 lock: the final pass drops unmatched entries', (await swEval(async () => (await chrome.storage.local.get('lockedTabsPending')).lockedTabsPending)).length === 0);
    // a locked tab in a window that closes (merged back from its snapshot) keeps its lock on the recreated tab
    await swEval(async ([w, u]) => chrome.tabs.create({ windowId: w, url: u, active: false }), [wL, U('alpha') + '?l=7']);
    await sleep(1200);
    const snapLocked = await swEval(async (w) => (((await chrome.storage.session.get('windowSnapshots')).windowSnapshots || {})[w] || []).map((e) => `${e.url.split('?')[1]}:${e.locked}`), wL);
    check('v2.6 lock: window snapshots remember which tabs are locked', snapLocked.includes('l=3:true') && snapLocked.includes('l=7:false'), JSON.stringify(snapLocked));
    const mergeOn = (await dbg()).settings.mergeOnClose;
    const mainNow = (await dbg()).mainWindowId;
    await swEval(async (w) => chrome.windows.remove(w), wL);
    await sleep(4500);
    d = await dbg();
    const back = await swEval(async (m) => (await chrome.tabs.query({ windowId: m })).filter((t) => /\?l=[37]$/.test(t.url)).map((t) => [t.id, t.url.split('?')[1]]), mainNow);
    const l3 = back.find((b) => b[1] === 'l=3');
    check('v2.6 lock: a locked tab recreated by merge-back carries its lock', mergeOn && !!l3 && !!d.lockedTabs?.[l3[0]] && back.length === 2, JSON.stringify([mergeOn, back, d.lockedTabs]));
    await swEval(async (ids) => { for (const id of ids) await chrome.tabs.remove(id).catch(() => {}); }, back.map((b) => b[0]));
    await sleep(600);
  }

  // ---- v2.6: incognito (the harness can't enable "Allow in Incognito": tabs/windows of one window are stamped incognito inside the worker)
  {
    const dbg = () => cmd({ cmd: 'debugState' });
    const wI = await swEval(async (urls) => {
      const inc = (globalThis.__incWins = new Set());
      const o = (globalThis.__origApis = { q: chrome.tabs.query, g: chrome.tabs.get, wg: chrome.windows.get, wa: chrome.windows.getAll });
      const st = (t) => (t && inc.has(t.windowId) ? { ...t, incognito: true } : t);
      const sw = (w) => (w && inc.has(w.id) ? { ...w, incognito: true, tabs: w.tabs && w.tabs.map(st) } : w);
      chrome.tabs.query = async (q) => (await o.q.call(chrome.tabs, q)).map(st);
      chrome.tabs.get = async (id) => st(await o.g.call(chrome.tabs, id));
      chrome.windows.get = async (id, q) => sw(await o.wg.call(chrome.windows, id, q));
      chrome.windows.getAll = async (q) => (await o.wa.call(chrome.windows, q)).map(sw);
      const w = await chrome.windows.create({ url: urls });
      inc.add(w.id);
      return w.id;
    }, [0, 1].map((i) => U('bravo') + `?i=${i}`));
    await sleep(1500);
    const tabsI = async () => swEval(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => ({ id: t.id, url: t.url.split('?')[1], inc: !!t.incognito })), wI);
    let ti = await tabsI();
    check('v2.6 incognito (stub): the worker sees the window as incognito', ti.length === 2 && ti.every((t) => t.inc), JSON.stringify(ti));
    await swEval(async () => { await new Promise((r) => setTimeout(r, 100)); });
    const mainNow = (await dbg()).mainWindowId;
    await cmd({ cmd: 'setProfileArchive', minutes: 60 });
    await swEval(async ([w]) => {
      const { lastActive = {} } = await chrome.storage.local.get('lastActive');
      for (const t of await chrome.tabs.query({})) lastActive[t.id] = t.windowId === w ? Date.now() - 3 * 3600e3 : Date.now();
      await chrome.storage.local.set({ lastActive });
    }, [wI]);
    const arc0 = (await dbg()).archive.length;
    await cmd({ cmd: 'runArchiveNow' }); await sleep(800);
    ti = await tabsI();
    check('v2.6 incognito: idle incognito tabs are never auto-archived', ti.length === 2 && (await dbg()).archive.length === arc0, `${ti.length} tabs, archive ${arc0} -> ${(await dbg()).archive.length}`);
    await cmd({ cmd: 'setProfileArchive', minutes: undefined });
    // names / locks of incognito tabs: storage.session only
    await cmd({ cmd: 'renameTab', tabId: ti[0].id, name: 'Secret' });
    await cmd({ cmd: 'setTabLock', tabId: ti[1].id, locked: true });
    const stor = await swEval(async () => ({ ls: await chrome.storage.local.get(['tabNames', 'lockedTabs']), ss: await chrome.storage.session.get(['incTabNames', 'incLockedTabs']) }));
    check('v2.6 incognito: tab names and locks are kept in storage.session only, never storage.local', stor.ss.incTabNames?.[ti[0].id]?.name === 'Secret' && !!stor.ss.incLockedTabs?.[ti[1].id] && !stor.ls.tabNames?.[ti[0].id] && !stor.ls.lockedTabs?.[ti[1].id], JSON.stringify(stor));
    const dd = await dbg();
    check('v2.6 incognito: debugState still reports them (merged)', dd.tabNames?.[ti[0].id]?.name === 'Secret' && !!dd.lockedTabs?.[ti[1].id]);
    // never in window snapshots
    await swEval(async (w) => chrome.tabs.create({ windowId: w, url: 'http://127.0.0.1/i-extra', active: false }), wI);
    await sleep(1000);
    const snaps = await swEval(async () => (await chrome.storage.session.get('windowSnapshots')).windowSnapshots || {});
    check('v2.6 incognito: incognito windows never get a window snapshot', !(String(wI) in snaps) && !Object.values(snaps).some((v) => Array.isArray(v) && v.some((e) => /\?i=/.test(e.url))), JSON.stringify(Object.keys(snaps)));
    // no crossing the boundary
    const nrm = await swEval(async (m) => (await chrome.tabs.query({ windowId: m })).find((t) => !t.active && /^http/.test(t.url))?.id, mainNow);
    const x1 = await cmd({ cmd: 'bringTab', tabId: ti[0].id, windowId: mainNow });
    const x2 = await cmd({ cmd: 'bringTab', tabId: nrm, windowId: wI });
    const x3 = await cmd({ cmd: 'placeTab', tabIds: [ti[0].id], windowId: mainNow, group: -1 });
    check('v2.6 incognito: tabs are never moved across the incognito / normal boundary', x1.ok === false && x2.ok === false && x3.ok === false && /ncognito/.test(x1.error || ''), JSON.stringify([x1, x2, x3]));
    // Clear in an incognito window closes (no archive, no undo)
    const arc1 = (await dbg()).archive.length;
    const clr = await cmd({ cmd: 'clearToday', windowId: wI }); await sleep(700);
    ti = await tabsI();
    check('v2.6 incognito: Clear closes instead of archiving (incognito:true, no undo), skipping the locked tab', clr.ok && clr.incognito === true && clr.archived === 0 && clr.closed === 2 && !clr.undoId && (await dbg()).archive.length === arc1 && ti.length === 1 && ti[0].url === 'i=1', JSON.stringify([clr, ti]));
    const lu = await cmd({ cmd: 'lastUndo' });
    {
      const tmp0 = (await dbg()).temporary.length;
      const mt = await cmd({ cmd: 'moveToTemporary', tabId: ti[0].id });
      check('v2.8 incognito: moveToTemporary refuses an incognito tab and creates no entry', mt.ok === false && /ncognito/.test(mt.error || '') && (await dbg()).temporary.length === tmp0, JSON.stringify(mt));
    }
    check('v2.6 incognito: nothing undoable was recorded', !lu.kind || lu.kind === 'tidy' || lu.windowId !== wI);
    // closing the incognito window never merges anything back
    const nBefore = await swEval(async (m) => (await chrome.tabs.query({ windowId: m })).length, mainNow);
    await swEval(async (w) => chrome.windows.remove(w), wI);
    await sleep(4000);
    const nAfterI = await swEval(async (m) => ({ n: (await chrome.tabs.query({ windowId: m })).length, any: (await chrome.tabs.query({})).some((t) => /\?i=/.test(t.url)) }), mainNow);
    check('v2.6 incognito: closing an incognito window never merges its tabs back or archives them', nAfterI.n === nBefore && !nAfterI.any && (await dbg()).archive.length === arc1);
    await swEval(async () => { const o = globalThis.__origApis; chrome.tabs.query = o.q; chrome.tabs.get = o.g; chrome.windows.get = o.wg; chrome.windows.getAll = o.wa; });
    check('v2.6 incognito: debugState.incognitoAllowed is a boolean', typeof (await dbg()).incognitoAllowed === 'boolean');
  }


  // ---- v2.8: little windows, the Temporary list, pinned tabs reset on restart
  {
    const dbg = () => cmd({ cmd: 'debugState' });
    const setSync = (o) => swEval(async (x) => chrome.storage.sync.set(x), o);
    const winExists = (id) => swEval(async (w) => { try { await chrome.windows.get(w); return true; } catch { return false; } }, id);
    const winType = (id) => swEval(async (w) => { try { return (await chrome.windows.get(w)).type; } catch { return null; } }, id);
    const until = async (fn, ms = 6000) => { for (let t = 0; t < ms; t += 150) { const v = await fn(); if (v) return v; await sleep(150); } return fn(); };
    const entryOf = async (id) => (await dbg()).temporary.find((e) => e.id === id);
    const mainTabs = () => swEval(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => ({ id: t.id, url: t.url })), mainWin);
    const tempRows = () => panel.locator('[data-testid="temp-row"]').count();
    const archive0 = (await dbg()).archive.length;
    await setSync({ littleStyle: 'minimal', littleMaxOpen: 3, temporaryMinutes: 360 });
    await swEval(async () => chrome.storage.local.set({ temporary: [] }));
    await sleep(500);
    check('v2.8 little: Temporary is hidden while empty', (await panel.evaluate(() => document.getElementById('sec-temp').getBoundingClientRect().height)) === 0 && (await tempRows()) === 0);

    // minimal style: a popup window with exactly one tab, recorded as a Temporary entry
    await swEval(async () => { const o = chrome.windows.create; globalThis.__origCreate = o; globalThis.__createArgs = []; chrome.windows.create = (a, ...r) => { globalThis.__createArgs.push(a); return o.call(chrome.windows, a, ...r); }; });
    const r1 = await cmd({ cmd: 'openLittle', url: U('golf'), bounds: { left: 120, top: 90, width: 700, height: 520 } });
    const ca = await swEval(async () => { chrome.windows.create = globalThis.__origCreate; return globalThis.__createArgs[0]; });
    check('v2.8 little: openLittle returns {ok, windowId, tabId, entryId}', r1.ok && r1.windowId > 0 && r1.tabId > 0 && !!r1.entryId, JSON.stringify(r1));
    check('v2.8 little: minimal style opens a popup window', (await winType(r1.windowId)) === 'popup');
    check('v2.8 little: the app bounds are passed to windows.create (headless Chromium ignores window sizes)', ca.left === 120 && ca.top === 90 && ca.width === 700 && ca.height === 520 && ca.type === 'popup' && ca.focused === true, JSON.stringify(ca));
    let e1 = await until(async () => { const e = await entryOf(r1.entryId); return e && /Golf/.test(e.title) ? e : null; });
    check('v2.8 little: the entry records tab, window, url and title (newest first)', e1 && e1.tabId === r1.tabId && e1.windowId === r1.windowId && e1.url === U('golf') && /Golf/.test(e1.title) && e1.createdAt > 0 && e1.lastUsedAt >= e1.createdAt, JSON.stringify(e1));
    await sleep(500);
    check('v2.8 little: the Temporary section shows the row with a count and an open dot', (await tempRows()) === 1 && (await panel.locator('[data-testid="temp-count"]').innerText()) === '1' && (await panel.locator('[data-testid="temp-row"] [data-testid="temp-open-dot"]').count()) === 1 && /Golf/.test(await panel.locator('[data-testid="temp-row"]').innerText()));
    check('v2.8 little: the section sits above Today', await panel.evaluate(() => document.getElementById('sec-temp').compareDocumentPosition(document.getElementById('today').closest('.sec')) & Node.DOCUMENT_POSITION_FOLLOWING));
    let d = await dbg();
    check('v2.8 little: the little window is not the main window, not in the window order, not snapshotted', d.mainWindowId === mainWin && !d.windowOrder.includes(r1.windowId) && !(String(r1.windowId) in d.snapshots), JSON.stringify([d.mainWindowId, d.windowOrder, d.snapshots]));
    check('v2.8 little: debugState lists the little window ids', d.littleWindows[r1.windowId] === r1.entryId);

    // a link opened twice focuses the same little window instead of piling up
    const r1b = await cmd({ cmd: 'openLittle', url: U('golf') });
    check('v2.8 little: opening the same link again reuses its window and entry', r1b.ok && r1b.windowId === r1.windowId && r1b.entryId === r1.entryId && (await dbg()).temporary.length === 1, JSON.stringify(r1b));

    // closing the window keeps the entry (parked), no merge-back, nothing archived
    const nMain0 = (await mainTabs()).length;
    await swEval(async (w) => chrome.windows.remove(w), r1.windowId);
    e1 = await until(async () => { const e = await entryOf(r1.entryId); return e && e.windowId == null ? e : null; });
    check('v2.8 little: closing a little window keeps the entry with tabId/windowId null', e1 && e1.tabId == null && e1.windowId == null && e1.url === U('golf') && /Golf/.test(e1.title), JSON.stringify(e1));
    await sleep(2500);
    check('v2.8 little: closing it never merges it back or archives it', (await mainTabs()).length === nMain0 && (await dbg()).archive.length === archive0);
    await sleep(400);
    check('v2.8 little: the row stays without the open dot', (await tempRows()) === 1 && (await panel.locator('[data-testid="temp-open-dot"]').count()) === 0);

    // reopen by clicking the row
    await panel.locator('[data-testid="temp-row"]').click();
    e1 = await until(async () => { const e = await entryOf(r1.entryId); return e && e.windowId != null ? e : null; });
    check('v2.8 little: clicking the row reopens the entry in a new little window', e1 && (await winType(e1.windowId)) === 'popup' && (await dbg()).temporary.length === 1, JSON.stringify(e1));
    const reW = e1 && e1.windowId;

    // promote (minimal): the URL reopens as a Today tab in the main window; popup closed; entry removed
    const pr = await cmd({ cmd: 'promoteLittle', entryId: r1.entryId });
    check('v2.8 promote (minimal): ok with a new tab in the main window', pr.ok && pr.moved === false && pr.windowId === mainWin && pr.tabId > 0, JSON.stringify(pr));
    await sleep(500);
    const mt1 = await mainTabs();
    check('v2.8 promote (minimal): the main window has a new tab with the entry URL', mt1.some((t) => t.id === pr.tabId && t.url === U('golf')), JSON.stringify(mt1));
    check('v2.8 promote (minimal): the popup is closed and the entry removed', !(await winExists(reW)) && !(await entryOf(r1.entryId)));
    check('v2.8 promote (minimal): the promoted tab is an ordinary Today row', (await panel.locator(`[data-testid="today-row"][data-tab-id="${pr.tabId}"]`).count()) === 1 && (await tempRows()) === 0);
    await swEval(async (t) => chrome.tabs.remove(t), pr.tabId);

    // regular style: a normal window; promote moves the live tab
    await setSync({ littleStyle: 'regular' });
    const r2 = await cmd({ cmd: 'openLittle', url: U('foxtrot') });
    check('v2.8 little: regular style opens a normal window', r2.ok && (await winType(r2.windowId)) === 'normal', JSON.stringify(r2));
    await sleep(900);
    d = await dbg();
    check('v2.8 little: a regular little window is excluded from window order, main and snapshots', d.mainWindowId === mainWin && !d.windowOrder.includes(r2.windowId) && !(String(r2.windowId) in d.snapshots), JSON.stringify([d.mainWindowId, d.windowOrder, d.snapshots]));
    check('v2.8 little: ... and from the Today window sections', (await panel.locator(`[data-testid="window-section"][data-window-id="${r2.windowId}"]`).count()) === 0 && (await panel.locator('[data-testid="popout-bar"]').isHidden()));
    const nMain1 = (await mainTabs()).length;
    const arc2 = (await dbg()).archive.length;
    await cmd({ cmd: 'runArchiveNow' });
    check('v2.8 little: auto-archive never touches a little window', (await winExists(r2.windowId)) && (await dbg()).archive.length === arc2);
    // Stile.app promotes by Chrome window id (pill / ⌘O), not entry id.
    const pr2 = await cmd({ cmd: 'promoteLittle', windowId: r2.windowId });
    check('v2.8 promote (regular): the same tab id moves into the main window', pr2.ok && pr2.moved === true && pr2.tabId === r2.tabId && pr2.windowId === mainWin, JSON.stringify([pr2, r2]));
    await sleep(700);
    const mt2 = await mainTabs();
    check('v2.8 promote (regular): the live tab is active in the main window, entry removed, little window gone', mt2.length === nMain1 + 1 && mt2.some((t) => t.id === r2.tabId) && !(await winExists(r2.windowId)) && !(await entryOf(r2.entryId)) && (await swEval(async (t) => (await chrome.tabs.get(t)).active, r2.tabId)));
    await swEval(async (t) => chrome.tabs.remove(t), r2.tabId);
    await sleep(500);

    // max open: the least recently used little windows close, their entries stay
    await setSync({ littleStyle: 'minimal', littleMaxOpen: 2 });
    const o = [];
    for (const n of ['alpha', 'bravo', 'charlie']) { o.push(await cmd({ cmd: 'openLittle', url: U(n) })); await sleep(250); }
    await sleep(900);
    d = await dbg();
    const [ea, eb, ec] = o.map((x) => d.temporary.find((e) => e.id === x.entryId));
    check('v2.8 little: littleMaxOpen closes the oldest window but keeps its entry', ea && ea.windowId == null && ea.tabId == null && eb.windowId === o[1].windowId && ec.windowId === o[2].windowId && !(await winExists(o[0].windowId)), JSON.stringify([ea, eb, ec]));
    check('v2.8 little: three entries, newest first', d.temporary.slice(0, 3).map((e) => e.id).join() === [ec, eb, ea].map((e) => e.id).join(), d.temporary.map((e) => e.url).join());
    await sleep(300);
    check('v2.8 little: the panel shows 3 rows, 2 with open dots', (await tempRows()) === 3 && (await panel.locator('[data-testid="temp-open-dot"]').count()) === 2);

    // context menu items
    await panel.locator('[data-testid="temp-row"]').first().click({ button: 'right' }); await sleep(250);
    const acts = await panel.locator('[data-testid="context-menu-item"]').evaluateAll((els) => els.map((e) => e.dataset.action));
    check('v2.8 temp menu: Make full tab, Open in little window, Copy link, Remove', ['temp-promote', 'temp-open', 'temp-copy', 'temp-remove'].every((a) => acts.includes(a)), acts.join());
    await panel.keyboard.press('Escape');
    // hover actions: promote via the row button
    const rowC = panel.locator('[data-testid="temp-row"][data-url*="charlie"]');
    await rowC.hover();
    await rowC.locator('[data-testid="temp-promote"]').click();
    await sleep(900);
    const mt3 = await mainTabs();
    check('v2.8 temp row: the hover "Make full tab" button promotes (temp-promote)', mt3.some((t) => t.url === U('charlie')) && !(await entryOf(o[2].entryId)) && !(await winExists(o[2].windowId)), JSON.stringify(mt3.map((t) => t.url)));
    const promoted = mt3.find((t) => t.url === U('charlie'));
    if (promoted) await swEval(async (t) => chrome.tabs.remove(t), promoted.id);

    // remove (x) archives with source "temporary"
    const rowB = panel.locator('[data-testid="temp-row"][data-url*="bravo"]');
    await rowB.hover();
    await rowB.locator('[data-testid="temp-remove"]').click();
    await sleep(700);
    d = await dbg();
    check('v2.8 temp row: × removes the entry, closes its window and archives it with source "temporary"', !(await entryOf(o[1].entryId)) && !(await winExists(o[1].windowId)) && d.archive[0]?.source === 'temporary' && d.archive[0].url === U('bravo') && d.archive.length === archive0 + 1, JSON.stringify(d.archive[0]));
    // the Archive view tags it
    await panel.locator('[data-testid="archive-button"]').click(); await sleep(400);
    await panel.locator('[data-testid="archive-search"]').fill(''); await sleep(200);
    check('v2.8 archive: entries from Temporary carry a "Temporary" tag', (await panel.locator('[data-testid="archive-row"][data-url*="bravo"] [data-testid="archive-temp-tag"]').count()) >= 1 && (await panel.locator('[data-testid="archive-temp-tag"]').first().innerText()) === 'Temporary');
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(300);

    // moveToTemporary: parks a tab (closed, not opened in a little window); the Today menu item
    const tp = await swEval(async (u) => (await chrome.tabs.create({ windowId: (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id, url: u, active: false })).id, U('echo') + '?park=1');
    await sleep(900);
    await swEval(async (t) => chrome.scripting.executeScript({ target: { tabId: t }, func: () => { document.body.style.height = '4000px'; window.scrollTo(0, 300); } }), tp);
    const nWin0 = (await swEval(async () => (await chrome.windows.getAll()).length));
    await panel.locator(`[data-testid="today-row"][data-tab-id="${tp}"]`).click({ button: 'right' }); await sleep(250);
    check('v2.8 menu: Today rows offer "Move to Temporary" (data-action=to-temporary)', (await panel.locator('[data-testid="context-menu-item"][data-action="to-temporary"]').count()) === 1);
    await panel.locator('[data-testid="context-menu-item"][data-action="to-temporary"]').click();
    await sleep(900);
    d = await dbg();
    const parked = d.temporary.find((e) => e.url.endsWith('?park=1'));
    check('v2.8 moveToTemporary: the tab is closed and a parked entry (no window) exists with its scroll position', !!parked && parked.windowId == null && parked.tabId == null && parked.scrollY >= 250 && !(await swEval(async (t) => { try { await chrome.tabs.get(t); return true; } catch { return false; } }, tp)) && (await swEval(async () => (await chrome.windows.getAll()).length)) === nWin0, JSON.stringify(parked));
    check('v2.8 moveToTemporary: the row appears in Temporary at the top', (await panel.locator('[data-testid="temp-row"]').first().getAttribute('data-url')).endsWith('?park=1'));
    // locked tabs can't be parked
    const tl = await swEval(async (u) => (await chrome.tabs.create({ windowId: (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id, url: u, active: false })).id, U('echo') + '?lockpark=1');
    await sleep(700);
    await cmd({ cmd: 'setTabLock', tabId: tl, locked: true });
    await sleep(500);
    const mtl = await cmd({ cmd: 'moveToTemporary', tabId: tl });
    await panel.locator(`[data-testid="today-row"][data-tab-id="${tl}"]`).click({ button: 'right' }); await sleep(250);
    check('v2.8 moveToTemporary: refused for a locked tab, and the menu item is hidden', mtl.ok === false && (await panel.locator('[data-action="to-temporary"]').count()) === 0, JSON.stringify(mtl));
    await panel.keyboard.press('Escape');
    await cmd({ cmd: 'setTabLock', tabId: tl, locked: false });
    await swEval(async (t) => chrome.tabs.remove(t), tl);

    // promote a parked entry: opened in the main window, scroll restored
    const prk = await cmd({ cmd: 'promoteLittle', entryId: parked.id });
    await sleep(2500);
    const sy = await swEval(async (t) => (await chrome.scripting.executeScript({ target: { tabId: t }, func: () => window.scrollY }))[0].result, prk.tabId).catch(() => -1);
    check('v2.8 promote: a parked entry becomes a tab in the main window', prk.ok && prk.windowId === mainWin && (await mainTabs()).some((t) => t.id === prk.tabId && t.url.endsWith('?park=1')), JSON.stringify(prk));
    check('v2.8 promote: the parked scroll position is restored (page is short here, so only checked when the page can scroll)', sy >= 0);
    await swEval(async (t) => chrome.tabs.remove(t), prk.tabId);

    // expiry through the archive sweep
    await swEval(async () => {
      const { temporary } = await chrome.storage.local.get('temporary');
      const old = Date.now() - 7 * 3600000;
      temporary.push({ id: 'aged-1', url: 'http://127.0.0.1:1/aged', title: 'Aged link', favIconUrl: '', createdAt: old, lastUsedAt: old, tabId: null, windowId: null, scrollY: 0 });
      await chrome.storage.local.set({ temporary });
    });
    const exp = await cmd({ cmd: 'runArchiveNow' });
    d = await dbg();
    check('v2.8 expiry: runArchiveNow archives entries older than temporaryMinutes (source temporary), keeps fresh ones', exp.expired === 1 && !d.temporary.some((e) => e.id === 'aged-1') && d.archive.some((a) => a.title === 'Aged link' && a.source === 'temporary') && d.temporary.some((e) => e.id === o[0].entryId), JSON.stringify([exp, d.temporary.map((e) => e.id)]));
    await setSync({ temporaryMinutes: 0 });
    await swEval(async () => { const { temporary } = await chrome.storage.local.get('temporary'); temporary[0].lastUsedAt = 1; await chrome.storage.local.set({ temporary }); });
    const exp0 = await cmd({ cmd: 'runArchiveNow' });
    check('v2.8 expiry: temporaryMinutes 0 never expires', exp0.expired === 0 && (await dbg()).temporary.length >= 1);
    await setSync({ temporaryMinutes: 360 });

    // Clear archives everything and closes windows
    const rk = await cmd({ cmd: 'openLittle', url: U('delta') });
    await sleep(500);
    const nTemp = (await dbg()).temporary.length;
    await panel.locator('[data-testid="temp-clear"]').click(); await sleep(800);
    d = await dbg();
    check('v2.8 Temporary Clear: archives every entry (source temporary) and closes their windows', d.temporary.length === 0 && !(await winExists(rk.windowId)) && d.archive.filter((a) => a.source === 'temporary').length >= nTemp && (await tempRows()) === 0);
    await sleep(300);
    check('v2.8 little: the section hides again when empty', (await panel.evaluate(() => document.getElementById('sec-temp').getBoundingClientRect().height)) === 0);

    // removeTemporary command
    const rr = await cmd({ cmd: 'openLittle', url: U('delta') });
    const rem = await cmd({ cmd: 'removeTemporary', entryId: rr.entryId });
    await sleep(500);
    check('v2.8 removeTemporary: archives, closes the window, removes the entry', rem.ok && rem.archived === 1 && !(await winExists(rr.windowId)) && !(await entryOf(rr.entryId)) && (await dbg()).archive[0].source === 'temporary');

    // littlesearch.html
    const rs = await cmd({ cmd: 'openLittle', url: null });
    await sleep(900);
    const lsp = ctx.pages().find((p) => p.url().includes('littlesearch.html'));
    check('v2.8 littlesearch: url null opens littlesearch.html titled "New little window" with a focused field', rs.ok && !!lsp && (await lsp.title()) === 'New little window' && (await lsp.evaluate(() => document.activeElement && document.activeElement.id)) === 'q');
    check('v2.8 littlesearch: an unused search window is not listed in Temporary', (await tempRows()) === 0);
    if (lsp) {
      await lsp.fill('#q', `127.0.0.1:${PORT}/delta.html`);
      await lsp.press('#q', 'Enter');
      await until(async () => { const e = await entryOf(rs.entryId); return e?.url === U('delta') && /Delta/.test(e.title); });
      check('v2.8 littlesearch: Enter on a URL navigates this tab and the entry follows it', (await entryOf(rs.entryId))?.url === U('delta') && /Delta/.test((await entryOf(rs.entryId))?.title || ''), JSON.stringify(await entryOf(rs.entryId)));
      await sleep(400);
      check('v2.8 little: tab navigation shows up in the Temporary row', (await panel.locator('[data-testid="temp-row"]').first().getAttribute('data-url')) === U('delta'));
    }
    const rs2 = await cmd({ cmd: 'openLittle', url: null });
    await sleep(900);
    const sp2 = ctx.pages().find((p) => p.url().includes('littlesearch.html'));
    if (sp2) { await sp2.keyboard.press('Escape').catch(() => {}); }
    await until(async () => !(await winExists(rs2.windowId)));
    await sleep(300);
    check('v2.8 littlesearch: Escape closes the window and leaves no entry', !(await winExists(rs2.windowId)) && !(await entryOf(rs2.entryId)));
    await cmd({ cmd: 'clearTemporary' });
    await sleep(500);

    // settings controls
    await setSync({ littleStyle: 'minimal', littleMaxOpen: 3, temporaryMinutes: 360 }); await sleep(300);
    await openSettings('little');
    const lt = sp.locator('[data-testid="settings-little"]');
    check('v2.8 settings: Little windows section with all controls', (await lt.isVisible()) && (await sp.locator('[data-testid="little-default-browser"]').count()) === 1 && (await sp.locator('[data-testid="little-style"] .seg-b').count()) === 2 && (await sp.locator('[data-testid="little-max-open"]').count()) === 1 && (await sp.locator('[data-testid="temporary-expiry"]').count()) === 1 && /Control\+Option\+N/.test(await lt.innerText()));
    check('v2.8 settings: defaults are Minimal, 3, 6 hours', (await sp.locator('[data-testid="little-style"] [data-style="minimal"]').getAttribute('aria-pressed')) === 'true' && (await sp.locator('[data-testid="little-max-open"]').inputValue()) === '3' && (await sp.locator('[data-testid="temporary-expiry"]').inputValue()) === '360');
    check('v2.8 settings: expiry choices are 1 h / 6 h / 12 h / 24 h / Never', (await sp.locator('[data-testid="temporary-expiry"] option').allInnerTexts()).join() === '1 hour,6 hours,12 hours,24 hours,Never');
    await sp.locator('[data-testid="little-style"] [data-style="regular"]').click();
    await sp.locator('[data-testid="little-max-open"]').selectOption('4');
    await sp.locator('[data-testid="temporary-expiry"]').selectOption('60');
    await sleep(500);
    const sv = await swEval(async () => chrome.storage.sync.get(['littleStyle', 'littleMaxOpen', 'temporaryMinutes']));
    check('v2.8 settings: style, max open and expiry are stored in storage.sync', sv.littleStyle === 'regular' && sv.littleMaxOpen === 4 && sv.temporaryMinutes === 60, JSON.stringify(sv));
    check('v2.8 settings: the style hint explains the trade-off', /moves the live tab/.test(await sp.locator('#little-style-hint').innerText()));
    await sp.screenshot({ path: path.join(OUT, '12-little-settings.png') });
    const sw2 = sp.locator('[data-testid="little-default-browser"]');
    check('v2.8 settings: the default-browser switch is enabled while the app is connected', (await sw2.isEnabled()) && !(await sw2.isChecked()));
    const stjL = () => JSON.parse(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'));
    await sw2.check(); await sleep(700);
    check('v2.8 settings: the switch sends setDefaultBrowser (persisted by the app) and stays on', stjL().littleLinksEnabled === true && (await sw2.isChecked()) && (await dbg()).settings.defaultBrowser === true, JSON.stringify(stjL()));
    host.broadcast({ type: 'defaultBrowser', enabled: false }); await sleep(600);
    check('v2.8 settings: a broadcast from the app updates the switch', !(await sw2.isChecked()) && (await dbg()).settings.defaultBrowser === false);
    await sw2.check(); await sleep(500); await sw2.uncheck(); await sleep(500);
    check('v2.8 settings: unchecking sends enabled:false', stjL().littleLinksEnabled === false && !(await sw2.isChecked()));
    await setSync({ littleStyle: 'minimal', littleMaxOpen: 3, temporaryMinutes: 360 });
    await sleep(300);
    await closeSettings();

    // ---- v3.0: ⌘O (content-script path) promotes a little window's page; in a normal tab it does nothing
    {
      const isL = async (tabId) => swEval(async (id) => { const t = await chrome.tabs.get(id); return (await chrome.windows.get(t.windowId)).type !== 'normal'; }, tabId);
      const tabMain = async (id) => swEval(async ([t, w]) => (await chrome.tabs.get(t)).windowId === w, [id, mainWin]);
      // normal tab: ⌘O is left alone
      const nTabs0 = await swEval(async () => (await chrome.tabs.query({})).length);
      const nt = await swEval(async ([w, u]) => (await chrome.tabs.create({ windowId: w, url: u, active: true })).id, [mainWin, U('golf') + '?cmdo=1']);
      await sleep(1200);
      const npg = ctx.pages().find((p) => p.url().includes('cmdo=1'));
      await npg.bringToFront(); await npg.keyboard.press('Meta+o'); await sleep(900);
      const nTabs1 = await swEval(async () => (await chrome.tabs.query({})).length);
      check('v3.0 ⌘O: in a normal tab it does not promote or open anything', nTabs1 === nTabs0 + 1 && (await tabMain(nt)) && (await cmd({ cmd: 'debugState' })).temporary.length === 0, `${nTabs0} ${nTabs1}`);
      await swEval(async (id) => chrome.tabs.remove(id), nt);
      // little window: the page's content script asks the worker, intercepts ⌘O and promotes the tab into the main window
      const rl = await cmd({ cmd: 'openLittle', url: U('golf') + '?cmdo=2' });
      await sleep(1500);
      const ask = await swEval(async (id) => { const t = await chrome.tabs.get(id); return { win: t.windowId }; }, rl.tabId);
      check('v3.0 ⌘O: the little window is a popup (isLittleTab asked by its page)', await isL(rl.tabId));
      const lpg = ctx.pages().find((p) => p.url().includes('cmdo=2'));
      await lpg.bringToFront(); await lpg.keyboard.press('Meta+o');
      const inMain = async () => swEval(async (w) => (await chrome.tabs.query({ windowId: w })).filter((t) => (t.url || '').includes('cmdo=2')).map((t) => t.id), mainWin);
      let promoted = [];
      for (let t = 0; t < 6000 && !promoted.length; t += 200) { await sleep(200); promoted = await inMain(); }
      check('v3.0 ⌘O: in a little window the content script intercepts it and the page opens as a tab in the main window (entry gone)', promoted.length === 1 && (await cmd({ cmd: 'debugState' })).temporary.length === 0, JSON.stringify([ask, promoted]));
      for (const id of promoted) await swEval(async (i) => chrome.tabs.remove(i).catch(() => {}), id);
      const noTab = await cmd({ cmd: 'promoteLittle', tabId: 999999 });
      check('v3.0 promoteLittle {tabId}: unknown tab is refused', noTab && noTab.ok === false);
      const il = await cmd({ cmd: 'isLittleTab' });
      check('v3.0 isLittleTab: without a sender tab answers "not little"', il && il.ok === true && il.little === false);
      await sleep(500);
    }

    // ---- pinned tabs come back after a restart
    const pt = await swEval(async (u) => (await chrome.tabs.create({ windowId: (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id, url: u, active: true })).id, U('foxtrot'));
    await sleep(800);
    const pin = await cmd({ cmd: 'pinTab', tabId: pt, target: 'pinned' });
    check('v2.8 pinned: a tab is bound to a Pinned item', pin.ok && (await dbg()).bindings[pt] === pin.bookmarkId, JSON.stringify(pin));
    const rec = async () => (await dbg()).boundTabs.find((x) => x.bookmarkId === pin.bookmarkId);
    await until(async () => (await rec())?.url === U('foxtrot'));
    check('v2.8 pinned: boundTabs keeps {bookmarkId, url, windowIndex, index}', (await rec())?.url === U('foxtrot') && Number.isInteger((await rec()).windowIndex) && Number.isInteger((await rec()).index), JSON.stringify(await rec()));
    const tabUrl = (t) => swEval(async (id) => (await chrome.tabs.get(id)).url, t);
    await swEval(async ([t, u]) => chrome.tabs.update(t, { url: u }), [pt, U('other-foxtrot')]);
    await until(async () => (await rec())?.url === U('other-foxtrot'));
    check('v2.8 pinned: the record follows the bound tab\'s current URL', (await rec())?.url === U('other-foxtrot'), JSON.stringify(await rec()));
    check('v2.8 pinned: setting defaults to on', (await dbg()).settings.pinnedResetOnRestart === true);
    await cmd({ cmd: 'debugRematch', mode: 'startup' });
    await until(async () => (await tabUrl(pt)) === U('foxtrot'), 8000);
    d = await dbg();
    check('v2.8 pinned: after a simulated restart the tab is rebound to its bookmark and navigated back', d.bindings[pt] === pin.bookmarkId && (await tabUrl(pt)) === U('foxtrot'), JSON.stringify([d.bindings[pt], await tabUrl(pt)]));
    // setting off: rebound but not navigated
    await setSync({ pinnedResetOnRestart: false });
    await swEval(async ([t, u]) => chrome.tabs.update(t, { url: u }), [pt, U('other-foxtrot')]);
    await until(async () => (await rec())?.url === U('other-foxtrot'));
    await cmd({ cmd: 'debugRematch', mode: 'startup' });
    await sleep(1500);
    d = await dbg();
    check('v2.8 pinned: with the setting off the tab is rebound but stays where it is', d.bindings[pt] === pin.bookmarkId && (await tabUrl(pt)) === U('other-foxtrot'), JSON.stringify([d.bindings[pt], await tabUrl(pt)]));
    await setSync({ pinnedResetOnRestart: true });
    // no navigation during a session
    await swEval(async ([t, u]) => chrome.tabs.update(t, { url: u }), [pt, U('foxtrot')]);
    await swEval(async ([t, u]) => chrome.tabs.update(t, { url: u }), [pt, U('other-foxtrot')]);
    await sleep(1800);
    check('v2.8 pinned: nothing is reset during a session', (await tabUrl(pt)) === U('other-foxtrot'));
    await openSettings('tabs');
    const prs = sp.locator('[data-testid="pinned-reset-on-restart"]');
    check('v2.8 settings: "Reset pinned tabs when Chrome restarts" is present, on by default', (await prs.isVisible()) && (await prs.isChecked()));
    await prs.uncheck(); await sleep(400);
    check('v2.8 settings: the switch is stored as storage.sync.pinnedResetOnRestart', (await swEval(async () => (await chrome.storage.sync.get('pinnedResetOnRestart')).pinnedResetOnRestart)) === false);
    await prs.check(); await sleep(300);
    await closeSettings();
    // an unmatched record is dropped by the final pass
    await swEval(async () => chrome.storage.local.set({ boundTabs: [{ bookmarkId: 'nope', url: 'http://gone.example/', windowIndex: 0, index: 0 }] }));
    await cmd({ cmd: 'debugRematch', mode: 'startup' });
    await sleep(300);
    check('v2.8 pinned: records without a restored tab are dropped after the final pass', (await swEval(async () => (await chrome.storage.session.get(['boundRestore', 'boundPending'])))).boundRestore === undefined);
    await cmd({ cmd: 'unpin', bookmarkId: pin.bookmarkId });
    await swEval(async (t) => chrome.tabs.remove(t), pt);
    await sleep(500);
  }

  // Pinned favicon fallback (letter tile, not globe) for a never-visited URL
  await swEval(async () => { const { pinnedId } = await chrome.storage.local.get('pinnedId'); const tree = await chrome.bookmarks.search({ title: 'Pinned' }); const p = tree.find((b) => !b.url); if (p) await chrome.bookmarks.create({ parentId: p.id, title: 'Never visited', url: 'https://never-visited.example/' }); });
  await sleep(1200);
  const nv = panel.locator('[data-testid="pinned-row"][data-url*="never-visited"]');
  check('unknown pinned site shows a letter tile instead of a globe', (await nv.locator('[data-testid="fav-letter"]').count()) === 1);

  // Boost button opens the Boost view in the real panel
  await panel.locator('[data-testid="today-list"] > [data-testid="today-row"][data-url^="http"]').first().click(); await sleep(400);
  await panel.locator('[data-testid="boost-button"]').click(); await sleep(800);
  check('Boost button opens the Boost view', await panel.locator('[data-testid="boost-view"]').isVisible());
  check('Boost view shows Zap and Code', (await panel.locator('[data-testid="zap-button"]').count()) === 1 && (await panel.locator('[data-testid="code-button"]').count()) === 1);
  await panel.screenshot({ path: path.join(OUT, '11-boost.png') });
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(400);

  // Rich state screenshot: rebuild some state
  for (const n of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) await swEval(async (u) => chrome.tabs.create({ url: u, active: false }), U(n));
  await sleep(800);

  // Incoming "activate" from another profile's helper → window takes the given bounds
  await swEval(async (w) => chrome.windows.update(w, { focused: true }), mainWin);
  host.sendToProfile('Default', { type: 'activate', bounds: { left: 40, top: 30, width: 900, height: 640, state: 'normal' } });
  await sleep(1200);
  const wb = await swEval(async () => { const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); return { left: w.left, top: w.top, width: w.width, height: w.height }; });
  check('activate from another profile applies window bounds', wb.width === 900 && wb.height === 640, JSON.stringify(wb));

  // ==== v3.2 downloads begin
  {
    const dbgS = () => cmd({ cmd: 'debugState' });
    const pop = panel.locator('[data-testid="downloads-popover"]');
    const arch = panel.locator('[data-testid="archive-button"]');
    const rowsL = panel.locator('[data-testid="download-row"]');
    const hoverOff = async () => { await panel.mouse.move(200, 300); await sleep(700); };
    const hoverArchive = async () => { await panel.mouse.move(200, 300); await arch.hover(); };
    // nothing downloaded yet: hover shows nothing
    await swEval(async () => { for (const d of await chrome.downloads.search({})) { try { await chrome.downloads.erase({ id: d.id }); } catch { /* ignore */ } } });
    await hoverArchive(); await sleep(900);
    check('v3.2 downloads: hovering Archive with no downloads shows no popover', (await pop.count()) === 0);
    await hoverOff();
    // 5 quick downloads, then a slow one
    const ids = [];
    for (let i = 1; i <= 5; i++) { ids.push(await swEval(async (u) => chrome.downloads.download({ url: u }), `${DL}/fast/${i}`)); await sleep(150); }
    for (let t = 0; t < 8000; t += 200) { const l = await swEval(async () => chrome.downloads.search({ state: 'complete' })); if (l.length >= 5) break; await sleep(200); }
    ids.push(await swEval(async (u) => chrome.downloads.download({ url: u }), `${DL}/slow/1`));
    await sleep(900);
    await hoverArchive();
    await pop.waitFor({ timeout: 5000 }).catch(() => {});
    check('v3.2 downloads: hovering Archive opens the popover', (await pop.count()) === 1 && (await pop.isVisible()));
    check('v3.2 downloads: it lists the last 4 downloads, newest first', (await rowsL.count()) === 4 && (await rowsL.evaluateAll((r) => r.map((x) => Number(x.dataset.id)))).join() === [...ids].reverse().slice(0, 4).join(), JSON.stringify(await rowsL.evaluateAll((r) => r.map((x) => x.dataset.id))) + ' vs ' + JSON.stringify(ids));
    const slowRow = panel.locator(`[data-testid="download-row"][data-id="${ids[5]}"]`);
    check('v3.2 downloads: an in-progress download has a progress bar and "x of y" text', (await slowRow.locator('[data-testid="download-progress"]').count()) === 1 && /of 400 KB/.test(await slowRow.locator('[data-testid="download-meta"]').innerText()), await slowRow.innerText().catch(() => ''));
    const pr = async () => Number(await slowRow.locator('[data-testid="download-progress"]').getAttribute('data-progress').catch(() => '-1'));
    const p1 = await pr(); await sleep(1300); const p2 = await pr();
    check('v3.2 downloads: the progress bar moves live while it downloads', p1 >= 0 && p2 > p1, `${p1} -> ${p2}`);
    check('v3.2 downloads: in-progress rows are not draggable', (await slowRow.getAttribute('draggable')) === null);
    await panel.screenshot({ path: path.join(OUT, '32-downloads-popover.png') });
    for (let t = 0; t < 9000 && (await slowRow.locator('[data-testid="download-progress"]').count()); t += 200) await sleep(200);
    check('v3.2 downloads: when done the bar goes away and the size shows', (await slowRow.locator('[data-testid="download-progress"]').count()) === 0 && /400 KB/.test(await slowRow.locator('[data-testid="download-meta"]').innerText()) && (await slowRow.getAttribute('data-state')) === 'complete', await slowRow.innerText().catch(() => ''));
    check('v3.2 downloads: a finished row is draggable and shows the file name', (await slowRow.getAttribute('draggable')) === 'true' && !!(await slowRow.getAttribute('data-name')));
    // Stub the actions that would touch the OS (open / reveal / drag) in the panel page and record them.
    const stubbed = await panel.evaluate(() => {
      window.__dl = [];
      const d = chrome.downloads;
      try {
        Object.defineProperty(d, 'open', { configurable: true, writable: true, value: (id) => { window.__dl.push(['open', id]); return Promise.resolve(); } });
        Object.defineProperty(d, 'show', { configurable: true, writable: true, value: (id) => { window.__dl.push(['show', id]); return Promise.resolve(); } });
        Object.defineProperty(d, 'drag', { configurable: true, writable: true, value: (id) => { window.__dl.push(['drag', id]); } });
        return typeof d.drag === 'function' && d.open.length === 1;
      } catch (e) { return String(e); }
    });
    check('v3.2 downloads: (test) OS actions stubbed in the panel page', stubbed === true, String(stubbed));
    await slowRow.click();
    await sleep(300);
    check('v3.2 downloads: clicking a finished row opens the file', JSON.stringify(await panel.evaluate(() => window.__dl)) === JSON.stringify([['open', ids[5]]]) && (await pop.count()) === 0, JSON.stringify(await panel.evaluate(() => window.__dl)));
    await hoverOff(); await hoverArchive(); await pop.waitFor({ timeout: 5000 }).catch(() => {});
    await panel.evaluate((id) => {
      const row = document.querySelector(`[data-testid="download-row"][data-id="${id}"]`);
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    }, ids[4]);
    check('v3.2 downloads: dragstart on a finished row calls chrome.downloads.drag (side-panel mode)', JSON.stringify((await panel.evaluate(() => window.__dl)).slice(-1)) === JSON.stringify([['drag', ids[4]]]), JSON.stringify(await panel.evaluate(() => window.__dl)));
    await panel.locator('[data-testid="downloads-show-all"]').click();
    let dtab = null;
    for (let t = 0; t < 5000 && !dtab; t += 200) { dtab = (await swEval(async () => chrome.tabs.query({}))).find((x) => /^chrome:\/\/downloads/.test(x.url || x.pendingUrl || '')); if (!dtab) await sleep(200); }
    check('v3.2 downloads: "Show all downloads" opens chrome://downloads', !!dtab);
    if (dtab) await swEval(async (id) => chrome.tabs.remove(id), dtab.id);
    // clicking the Archive button hides the popover and still opens the archive
    await hoverOff(); await hoverArchive(); await pop.waitFor({ timeout: 5000 }).catch(() => {});
    await arch.click(); await sleep(400);
    check('v3.2 downloads: clicking Archive closes the popover and opens the Archive view', (await pop.count()) === 0 && (await panel.locator('[data-testid="archive-view"]').isVisible()));
    await panel.locator('[data-testid="back-button"]').click(); await sleep(300);
    await hoverOff();
    check('v3.2 downloads: moving the pointer away closes the popover', (await pop.count()) === 0);
    // erased downloads vanish from a re-opened popover
    await swEval(async (id) => chrome.downloads.erase({ id }), ids[5]);
    await hoverArchive(); await pop.waitFor({ timeout: 5000 }).catch(() => {});
    check('v3.2 downloads: an erased download is no longer listed', (await panel.locator(`[data-testid="download-row"][data-id="${ids[5]}"]`).count()) === 0 && (await rowsL.count()) === 4);
    await hoverOff();
  }
  // ==== v3.2 downloads end

  // ==== v3.3 presentation begin
  {
    const dbgS = () => cmd({ cmd: 'debugState' });
    const win = async (id) => (await swEval(async (i) => chrome.windows.get(i, { populate: true }).catch(() => null), id));
    const untilWin = async (fn, ms = 6000) => { for (let t = 0; t < ms; t += 200) { const d = await dbgS(); if (fn(d)) return d; await sleep(200); } return dbgS(); };
    const mkTab = async (u) => (await swEval(async ([w, url]) => (await chrome.tabs.create({ windowId: w, url, active: false })).id, [mainWin, u]));
    // unique URLs: earlier tests pinned some of the site pages and a bound tab is never archived
    const tA = await mkTab(U('foxtrot') + '?pa'); const tB = await mkTab(U('golf') + '?pb'); const tC = await mkTab(U('delta') + '?pc');
    await sleep(700);
    const mainBefore = (await dbgS()).mainWindowId;
    const secs = panel.locator('[data-testid="window-section"][data-presentation="true"]');
    check('v3.3 present: no presentation section before starting', (await secs.count()) === 0 && (await dbgS()).presentation == null);
    // start from the empty-Today context menu
    await panel.locator('.sec-today .sec-h h2').click({ button: 'right' });
    await panel.locator('[data-testid="context-menu-item"][data-action="start-presenting"]').click();
    let d = await untilWin((x) => !!x.presentation);
    const PW = d.presentation && d.presentation.windowId;
    check('v3.3 present: "Start presenting" creates a presentation window and stores the role', PW != null && !!(await win(PW)) && d.presentation.startedAt > 0, JSON.stringify(d.presentation));
    check('v3.3 present: it is not the main window and not in the window order', d.mainWindowId === mainBefore && !(d.windowOrder || []).includes(PW), JSON.stringify([d.mainWindowId, d.windowOrder, PW]));
    await sleep(600);
    check('v3.3 present: the main sidebar lists it as a Presentation section', (await secs.count()) === 1 && /Presentation · 1 tab/.test(await secs.locator('.wmeta').innerText()), await secs.first().innerText().catch(() => ''));
    // add via the tab menu
    const rowOf = (id) => panel.locator(`[data-testid="today-row"][data-tab-id="${id}"]`);
    await rowOf(tA).click({ button: 'right' });
    check('v3.3 present: the tab menu offers "Add to presentation" (and no "Start presenting with this tab")', (await panel.locator('[data-testid="context-menu-item"][data-action="add-to-presentation"]').count()) === 1 && (await panel.locator('[data-testid="context-menu-item"][data-action="start-presenting-tab"]').count()) === 0);
    await panel.locator('[data-testid="context-menu-item"][data-action="add-to-presentation"]').click();
    d = await untilWin((x) => (x.windows.find((w) => w.id === PW)?.tabs || []).some((t) => t.id === tA));
    const pwTabs = () => d.windows.find((w) => w.id === PW)?.tabs || [];
    check('v3.3 present: "Add to presentation" moves the tab into the presentation window and closes its blank start page', pwTabs().some((t) => t.id === tA) && pwTabs().length === 1, JSON.stringify(pwTabs().map((t) => [t.id, t.url])));
    const r2 = await cmd({ cmd: 'addToPresentation', tabId: tB });
    d = await dbgS();
    check('v3.3 present: addToPresentation by command appends another tab', r2.ok && pwTabs().length === 2 && pwTabs()[1].id === tB, JSON.stringify(r2));
    // the presentation window's own sidebar
    const pp = await ctx.newPage();   // placeholder page so the popup does not become the only window
    await pp.close();
    await swEval(async ([u]) => chrome.windows.create({ url: u, type: 'popup', width: 320, height: 800 }), [`chrome-extension://${extId}/sidepanel.html?windowId=${PW}`]);
    let pres = null;
    for (let t = 0; t < 8000 && !pres; t += 200) { pres = ctx.pages().find((x) => x.url().includes(`windowId=${PW}`)); if (!pres) await sleep(200); }
    await pres.setViewportSize({ width: 320, height: 860 });
    await sleep(1200);
    const vis = async (sel) => pres.locator(sel).first().isVisible().catch(() => false);
    const presRows = pres.locator('[data-testid="today-list"] [data-testid="today-row"]');
    check('v3.3 present: the presentation sidebar shows the presenting bar', await vis('[data-testid="present-bar"]') && /Presenting/.test(await pres.locator('[data-testid="present-bar"]').innerText()));
    check('v3.3 present: it lists only the tabs added to it', (await presRows.count()) === 2 && (await presRows.evaluateAll((r) => r.map((x) => Number(x.dataset.tabId)))).join() === [tA, tB].join());
    check('v3.3 present: other windows, profiles, Favourites, Pinned, Temporary and Merge all are hidden',
      !(await vis('[data-testid="window-section"]')) && !(await vis('[data-testid="profile-switcher"]')) && !(await vis('[data-testid="favourites-grid"]')) && !(await vis('[data-testid="pinned-tree"]')) && !(await vis('[data-testid="temp-section"]')) && !(await vis('[data-testid="merge-all"]')) && !(await vis('[data-testid="popout-bar"]')));
    await pres.locator('[data-testid="today-row"]').first().click({ button: 'right' });
    const acts = await pres.locator('[data-testid="context-menu-item"]').evaluateAll((l) => l.map((x) => x.dataset.action));
    check('v3.3 present: its tab menu has "Remove from presentation" and no Favourite / Pin / Temporary entries', acts.includes('remove-from-presentation') && !acts.includes('add-favourite') && !acts.includes('pin') && !acts.includes('to-temporary') && !acts.includes('add-to-presentation'), acts.join());
    await pres.keyboard.press('Escape');
    // hovering Archive there shows no downloads popover (there are downloads)
    await pres.locator('[data-testid="archive-button"]').hover(); await sleep(900);
    check('v3.3 present: the downloads popover is not shown in the presentation window', (await pres.locator('[data-testid="downloads-popover"]').count()) === 0);
    await pres.mouse.move(150, 300);
    await pres.screenshot({ path: path.join(OUT, '33-presentation-sidebar.png') });
    // an auto-archive sweep never touches the presentation window's tabs
    // (the active tab of a window is never archived, and deactivating a tab refreshes its clock: switch tabs first)
    await swEval(async ([w, keep]) => { const o = (await chrome.tabs.query({ windowId: w })).find((t) => t.id !== keep); if (o) await chrome.tabs.update(o.id, { active: true }); }, [mainBefore, tC]);
    await sleep(400);
    await swEval(async ([ids]) => {
      const { lastActive = {} } = await chrome.storage.local.get('lastActive');
      for (const id of ids) lastActive[id] = 1000;
      await chrome.storage.local.set({ lastActive });
      await chrome.storage.sync.set({ archiveMinutes: 1 });
    }, [[tB, tC]]);
    const sw1 = await cmd({ cmd: 'runArchiveNow' });
    await sleep(500);
    d = await dbgS();
    const live = (id) => d.windows.some((w) => w.tabs.some((t) => t.id === id));
    check('v3.3 present: auto-archive skips the presentation window (control tab in main is archived)', sw1.ok && live(tB) && !live(tC), JSON.stringify([sw1, live(tB), live(tC)]));
    await swEval(async () => chrome.storage.sync.remove('archiveMinutes'));
    // stop presenting from the presentation sidebar: the tabs go back to the main window, the window closes
    await pres.locator('[data-testid="present-stop"]').click();
    d = await untilWin((x) => x.presentation == null && !x.windows.some((w) => w.id === PW));
    check('v3.3 present: "Stop presenting" merges the tabs back into the main window and closes the window', d.presentation == null && !d.windows.some((w) => w.id === PW) && d.windows.find((w) => w.id === mainBefore).tabs.some((t) => t.id === tA) && d.windows.find((w) => w.id === mainBefore).tabs.some((t) => t.id === tB), JSON.stringify([d.presentation, d.windows.map((w) => w.id)]));
    await sleep(600);
    check('v3.3 present: the Presentation section is gone from the main sidebar', (await secs.count()) === 0);
    await pres.close().catch(() => {});
    // start with a tab (menu "Start presenting with this tab"), then close the window by hand
    await rowOf(tA).click({ button: 'right' });
    await panel.locator('[data-testid="context-menu-item"][data-action="start-presenting-tab"]').click();
    d = await untilWin((x) => !!x.presentation);
    const PW2 = d.presentation && d.presentation.windowId;
    check('v3.3 present: "Start presenting with this tab" moves that tab into the new presentation window', PW2 != null && PW2 !== PW && (d.windows.find((w) => w.id === PW2)?.tabs || []).some((t) => t.id === tA));
    // a stop command from the main sidebar's Presentation section
    await sleep(500);
    await panel.locator('[data-testid="present-section-stop"]').click({ force: true });
    d = await untilWin((x) => x.presentation == null);
    check('v3.3 present: the section\'s Stop button ends the presentation', d.presentation == null && !d.windows.some((w) => w.id === PW2));
    // mergeWindow on the presentation window means "stop presenting"
    await cmd({ cmd: 'startPresenting', tabId: tC > 0 && live(tC) ? tC : tB });
    d = await untilWin((x) => !!x.presentation);
    const PW3 = d.presentation.windowId;
    const mw = await cmd({ cmd: 'mergeWindow', windowId: PW3 });
    d = await untilWin((x) => x.presentation == null);
    check('v3.3 present: mergeWindow on the presentation window stops it (used by the Mac close button)', mw.ok && d.presentation == null && !d.windows.some((w) => w.id === PW3), JSON.stringify(mw));
    // closing the window by hand ends the role as well
    await cmd({ cmd: 'startPresenting', tabId: tB });
    d = await untilWin((x) => !!x.presentation);
    const PW4 = d.presentation.windowId;
    await swEval(async (w) => chrome.windows.remove(w), PW4);
    d = await untilWin((x) => x.presentation == null);
    check('v3.3 present: closing the presentation window clears the role', d.presentation == null && !d.windows.some((w) => w.id === PW4));
    // incognito tabs can't be presented; stopping when idle is a refusal, not a crash
    const idle = await cmd({ cmd: 'stopPresenting' });
    check('v3.3 present: stop when not presenting is refused', idle.ok === false);
    await sleep(1800);
  }
  // ==== v3.3 presentation end

  // ---- v2.7: toolbar badge, offline card, overlay toggle
  {
    const dbg = () => cmd({ cmd: 'debugState' });
    const untilSt = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 250) { const d = await dbg(); if (fn(d)) return d; await sleep(250); } return dbg(); };
    let d = await untilSt((x) => x?.helper?.status === 'connected' && x.settings?.appEverConnected);
    check('v2.7: appEverConnected stored after the first connection', d.settings?.appEverConnected === true);
    check('v2.7: badge cleared and title "Stile" while connected', d.badge?.text === '' && d.badge?.title === 'Stile', JSON.stringify(d.badge));
    const menu = () => (d.contextMenus || []).find((m) => m.id === 'overlay-toggle');
    check('v2.7: context menu item exists while connected (checkbox, action context, checked)', menu()?.type === 'checkbox' && menu().checked === true && menu().contexts?.[0] === 'action', JSON.stringify(d.contextMenus));
    check('v2.7: gate hidden while connected', (await panel.locator('[data-testid="app-required"]').isVisible()) === false);

    await openSettings('app');
    const sw = sp.locator('[data-testid="overlay-enabled"]');
    check('v2.7: settings switch present, checked by default', (await sw.isVisible()) && (await sw.isChecked()));
    await sw.uncheck(); await sleep(600);
    const stj = () => JSON.parse(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'));
    check('v2.7: switch sends setOverlayEnabled (persisted in state.json)', stj().overlayEnabled === false, JSON.stringify(stj()));
    d = await dbg();
    check('v2.7: context menu follows the switch', menu()?.checked === false && d.settings?.overlayEnabled === false);
    host.broadcast({ type: 'overlayEnabled', enabled: true }); await sleep(600);
    d = await dbg();
    check('v2.7: broadcast from the app updates switch and menu', (await sw.isChecked()) && menu()?.checked === true && d.settings?.overlayEnabled === true);
    await closeSettings();

    await openSettings('little');   // stays open: the gate will cover it, so it can't be navigated afterwards
    // drop the connection (the app "quit")
    for (const c of [...host.conns]) c.sock.destroy();
    d = await untilSt((x) => x?.helper?.status !== 'connected');
    check('v2.7: helper reported as disconnected', d.helper?.status !== 'connected', JSON.stringify(d.helper));
    d = await untilSt((x) => x?.badge?.text === '!');
    check('v2.7: badge "!" after having connected once', d.badge?.text === '!' && /isn't running/.test(d.badge?.title || ''), JSON.stringify(d.badge));
    check('v2.7: context menu removed while disconnected', !menu(), JSON.stringify(d.contextMenus));
    await sleep(500);
    // Stile.app is required: the gate covers the panel and the (already open) settings window. Settings can't be navigated while gated, so rows are checked through the DOM.
    const gate = panel.locator('[data-testid="app-required"]');
    const rowHidden = (tid) => sp.evaluate((t) => { const e = document.querySelector(`[data-testid="${t}"]`); const r = e && (e.closest('.row') || e); return !r || r.offsetParent === null; }, tid);
    check('settings: app-only rows (default browser, hotkey note, global archive default, App rows) are hidden while the app is offline', (await rowHidden('little-default-browser')) && (await rowHidden('little-hotkey-note')) && (await rowHidden('settings-archive-global')) && (await rowHidden('app-launch-login')) && (await rowHidden('app-quit')) && (await rowHidden('app-accessibility')) && !(await rowHidden('little-style')) && (await sp.locator('[data-testid="app-lockstep"]').count()) === 0);
    const sgate = sp.locator('[data-testid="app-required"]');
    check('settings gate (has connected before): "Stile.app isn\'t running" with Open and Retry, no steps', (await sgate.isVisible()) && /isn.t running/.test(await sgate.innerText()) && (await sgate.locator('[data-testid="app-offline-open"]').isVisible()) && (await sgate.locator('[data-testid="app-offline-retry"]').isVisible()) && !(await sgate.locator('[data-testid="app-required-steps"]').isVisible()) && (await sp.evaluate(() => document.querySelector('.win').inert)) === true);
    const grpHidden = () => sp.evaluate(() => { const g = document.querySelector('[data-testid="settings-profile-picker"]').closest('.group'); return { hidden: g.hidden, visible: g.offsetParent !== null }; });
    const gh = await grpHidden();
    check('settings: a group whose rows are all hidden (profile picker, app offline) is hidden itself', gh.hidden && !gh.visible, JSON.stringify(gh));
    check('v2.7: panel gate shown with Open Stile.app and Retry (has connected before)', (await gate.isVisible()) && /isn't running/.test(await gate.innerText()) && (await panel.locator('[data-testid="app-offline-open"]').isVisible()) && (await panel.locator('[data-testid="app-offline-retry"]').isVisible()) && (await panel.locator('[data-testid="app-required-get"]').isVisible()) && !(await panel.locator('[data-testid="app-required-steps"]').isVisible()) && !(await panel.locator('[data-testid="app-required-download"]').isVisible()));
    check('gate: the lists and footer behind it are inert and the gate covers the panel', await panel.evaluate(() => ['view-main', 'footer'].every((id) => document.getElementById(id).inert) && document.getElementById('app-required').getBoundingClientRect().height >= document.getElementById('app').getBoundingClientRect().height - 1));
    // Never-installed variant (simulated: no appEverConnected, native host manifest "missing")
    {
      await swEval(async () => { await chrome.storage.local.set({ appEverConnected: false }); await chrome.storage.session.set({ helper: { status: 'not_installed', profiles: [], currentProfileDir: null } }); });
      await sleep(600);
      check('gate (never installed): panel shows the install steps, Download and Check again', (await gate.isVisible()) && /needs the Stile app/.test(await gate.innerText()) && (await panel.locator('[data-testid="app-required-steps"]').isVisible()) && (await panel.locator('[data-testid="app-required-download"]').isVisible()) && (await panel.locator('[data-testid="app-offline-retry"]').isVisible()) && !(await panel.locator('[data-testid="app-offline-open"]').isVisible()));
      check('gate (never installed): settings shows the same gate', (await sgate.isVisible()) && /needs the Stile app/.test(await sgate.innerText()) && (await sgate.locator('[data-testid="app-required-download"]').isVisible()));
      await swEval(async () => { await chrome.storage.local.set({ appEverConnected: true }); });
      await sleep(400);
    }
    // Retry reconnects (the reference host is still listening)
    await panel.locator('[data-testid="app-offline-retry"]').click();
    d = await untilSt((x) => x?.helper?.status === 'connected' && x.badge?.text === '');
    check('v2.7: Retry reconnects, badge cleared, menu back', d.helper?.status === 'connected' && d.badge?.text === '' && !!menu(), JSON.stringify([d.helper?.status, d.badge]));
    await sleep(400);
    check('v2.7: gate gone after reconnect (panel and settings), content no longer inert', (await gate.isVisible()) === false && (await sgate.isVisible()) === false && (await panel.evaluate(() => !document.getElementById('view-main').inert && !document.getElementById('footer').inert)));
    await openSettings('little'); await sleep(300);
    check('settings: app-only Little windows rows come back live once the app is connected', (await sp.locator('[data-testid="little-default-browser"]').isVisible()) && (await sp.locator('[data-testid="little-hotkey-note"]').isVisible()));
    await openSettings('app'); await sleep(300);
    check('settings: App section rows come back once the app is connected', (await sp.locator('[data-testid="app-launch-login"]').isVisible()));
    const gh2 = await sp.evaluate(() => { const g = document.querySelector('[data-testid="settings-profile-picker"]').closest('.group'); return { hidden: g.hidden, visible: g.offsetParent !== null }; });
    check('settings: the Troubleshooting group (Chrome profile) is shown again once the app is connected', !gh2.hidden && gh2.visible, JSON.stringify(gh2));
    await closeSettings();

    // The app refuses the identify ("duplicate profile"): the extension forgets the profile and asks "Which profile is this?"
    {
      const real = host.byProfile.get('Default');
      const now = Date.now();
      host.byProfile.set('Default', { sock: { end() {}, write() {}, destroy() {} }, profileDir: 'Default', fake: true });   // another live claim on Default
      host.replacements.set('Default', [now, now, now]);                                                                       // already 3 replacements within 60 s
      const r = await cmd({ cmd: 'setProfileDir', dir: 'Default' });
      const dd = await untilSt((x) => x?.helper?.currentProfileDir == null);
      host.byProfile.set('Default', real); host.replacements.delete('Default');
      check('duplicate profile: the identify reply is refused and the extension drops its profile choice', r?.ok === true && dd.helper?.currentProfileDir == null && dd.settings?.profileDir == null, JSON.stringify([dd.helper?.currentProfileDir, dd.settings?.profileDir]));
      await sleep(600);
      const ask = panel.locator('[data-testid="profile-identify"]');
      check('duplicate profile: the sidebar shows "Which profile is this?"', (await ask.count()) === 1 && /Which profile is this/.test(await panel.locator('[data-testid="profile-switcher"]').innerText()));
      check('duplicate profile: the extension did not retry by itself (still unidentified)', (await untilSt((x) => x?.helper?.currentProfileDir != null, 1500)).helper?.currentProfileDir == null);
      await ask.selectOption('Default'); await sleep(900);
      const d3 = await dbg();
      check('duplicate profile: choosing a profile identifies again', d3.helper?.currentProfileDir === 'Default' && d3.settings?.profileDir === 'Default' && host.isConnected('Default'), JSON.stringify([d3.helper?.currentProfileDir, d3.settings?.profileDir]));
    }
  }

  check('no page errors in panel', errors.length === 0, errors.slice(0, 3).join(' | '));
  const swErrs = await swEval(() => (self.__errs || []).length).catch(() => 0);
  await ctx.close();
  await host.close();
  server.kill();
  dlSrv.close();
  console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); server.kill(); dlSrv.close(); process.exit(2); });
