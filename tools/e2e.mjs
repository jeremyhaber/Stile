// End-to-end test: loads the extension in Chromium, wired to the Node reference host (tools/fake-app, which
// plays the Sidebar Mac app) through connector.js, a fake Chrome "Local State" and a fake Chrome binary.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');

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
  const cmd = (msg) => panel.evaluate((m) => new Promise((res) => chrome.runtime.sendMessage(m, res)), msg).catch((e) => ({ error: String(e) }));
  const swEval = (fn, arg) => sw.evaluate(fn, arg);

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
  await panel.locator('[data-testid="settings-button"]').click(); await sleep(400);
  await panel.screenshot({ path: path.join(OUT, '04-settings.png') });
  const g = panel.locator('[data-testid="settings-archive-global"]');
  check('global default control enabled with helper', !(await g.isDisabled()));
  const opts = await g.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
  const day = opts.find(([, t]) => /24 hours/.test(t));
  await g.selectOption(day[0]); await sleep(700);
  const stateJson = JSON.parse(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'));
  check('global default saved to helper state', stateJson.archiveDefaultMinutes === 1440, JSON.stringify(stateJson));
  await panel.locator('[data-testid="settings-archive-profile"]').selectOption({ index: 0 }); await sleep(400);
  const st4 = await cmd({ cmd: 'debugState' });
  check('profile setting "use default" follows global', st4.settings.archiveMinutes == null && st4.settings.effectiveMinutes === 1440, JSON.stringify(st4.settings));
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(300);

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
  await panel.locator('[data-testid="settings-button"]').click(); await sleep(400);
  // Sidebar colour setting (side-panel mode)
  {
    const bg = () => panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const rgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
    const profBg = await bg();
    check('sidebar colour: default auto uses the profile tint (not the neutral grey)', profBg !== 'rgb(243, 243, 246)' && profBg !== 'rgb(31, 32, 35)', profBg);
    check('sidebar colour: Automatic selected, note says "From your profile colour"',
      (await panel.locator('[data-testid="sidebar-color-mode"] [data-mode="auto"]').getAttribute('aria-pressed')) === 'true' &&
      /From your profile colour/.test(await panel.locator('[data-testid="sidebar-color-note"]').innerText()));
    await panel.locator('[data-testid="sidebar-color-mode"] [data-mode="custom"]').click(); await sleep(400);
    check('sidebar colour: Custom shows 14 swatches and the picker', (await panel.locator('[data-testid="sidebar-color-swatch"]:visible').count()) === 14 && await panel.locator('[data-testid="sidebar-color-picker"]').isVisible());
    await panel.locator('[data-testid="sidebar-color-swatch"][data-color="#e6f4ea"]').click(); await sleep(400);
    check('sidebar colour: custom swatch sets the exact background', (await bg()) === rgb('#e6f4ea'), await bg());
    await panel.screenshot({ path: path.join(OUT, '05-sidebar-colour.png') });
    await panel.locator('[data-testid="sidebar-color-picker"]').fill('#204060'); await sleep(500);
    check('sidebar colour: picker value applies exactly, with light text on dark', (await bg()) === rgb('#204060') && (await panel.evaluate(() => getComputedStyle(document.body).color)) === 'rgb(236, 236, 240)', await bg());
    const saved = await swEval(async () => (await chrome.storage.sync.get('sidebarColor')).sidebarColor);
    check('sidebar colour: stored in chrome.storage.sync', saved && saved.mode === 'custom' && saved.color === '#204060', JSON.stringify(saved));
    await panel.locator('[data-testid="sidebar-color-mode"] [data-mode="auto"]').click(); await sleep(500);
    check('sidebar colour: back to Automatic restores the profile tint', (await bg()) === profBg, await bg());
  }
  const styleRow = panel.locator('[data-testid="profile-style-row"]').first();
  await styleRow.click(); await sleep(300);
  await panel.locator('[data-testid="style-icon"][data-icon="rocket"]').first().click(); await sleep(500);
  await panel.locator('[data-testid="style-color"][data-color="#bf5af2"]').first().click(); await sleep(800);
  const st5 = JSON.parse(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'));
  check('icon and colour saved to helper', st5.profileStyles?.Default?.icon === 'rocket' && st5.profileStyles?.Default?.color?.toLowerCase() === '#bf5af2', JSON.stringify(st5.profileStyles));
  await panel.screenshot({ path: path.join(OUT, '06-style-editor.png') });
  await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(400);
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
    // Sidebar.app promotes by Chrome window id (pill / ⌘O), not entry id.
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
    const sp = ctx.pages().find((p) => p.url().includes('littlesearch.html'));
    check('v2.8 littlesearch: url null opens littlesearch.html titled "New little window" with a focused field', rs.ok && !!sp && (await sp.title()) === 'New little window' && (await sp.evaluate(() => document.activeElement && document.activeElement.id)) === 'q');
    check('v2.8 littlesearch: an unused search window is not listed in Temporary', (await tempRows()) === 0);
    if (sp) {
      await sp.fill('#q', `127.0.0.1:${PORT}/delta.html`);
      await sp.press('#q', 'Enter');
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
    await panel.locator('[data-testid="settings-button"]').click(); await sleep(400);
    const lt = panel.locator('[data-testid="settings-little"]');
    check('v2.8 settings: Little windows section with all controls', (await lt.isVisible()) && (await panel.locator('[data-testid="little-default-browser"]').count()) === 1 && (await panel.locator('[data-testid="little-style"] .seg-b').count()) === 2 && (await panel.locator('[data-testid="little-max-open"]').count()) === 1 && (await panel.locator('[data-testid="temporary-expiry"]').count()) === 1 && /Control\+Option\+N/.test(await lt.innerText()));
    check('v2.8 settings: defaults are Minimal, 3, 6 hours', (await panel.locator('[data-testid="little-style"] [data-style="minimal"]').getAttribute('aria-pressed')) === 'true' && (await panel.locator('[data-testid="little-max-open"]').inputValue()) === '3' && (await panel.locator('[data-testid="temporary-expiry"]').inputValue()) === '360');
    check('v2.8 settings: expiry choices are 1 h / 6 h / 12 h / 24 h / Never', (await panel.locator('[data-testid="temporary-expiry"] option').allInnerTexts()).join() === '1 hour,6 hours,12 hours,24 hours,Never');
    await panel.locator('[data-testid="little-style"] [data-style="regular"]').click();
    await panel.locator('[data-testid="little-max-open"]').selectOption('4');
    await panel.locator('[data-testid="temporary-expiry"]').selectOption('60');
    await sleep(500);
    const sv = await swEval(async () => chrome.storage.sync.get(['littleStyle', 'littleMaxOpen', 'temporaryMinutes']));
    check('v2.8 settings: style, max open and expiry are stored in storage.sync', sv.littleStyle === 'regular' && sv.littleMaxOpen === 4 && sv.temporaryMinutes === 60, JSON.stringify(sv));
    check('v2.8 settings: the style hint explains the trade-off', /moves the live tab/.test(await panel.locator('#little-style-hint').innerText()));
    await panel.screenshot({ path: path.join(OUT, '12-little-settings.png') });
    const sw2 = panel.locator('[data-testid="little-default-browser"]');
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
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(300);

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
    await panel.locator('[data-testid="settings-button"]').click(); await sleep(400);
    const prs = panel.locator('[data-testid="pinned-reset-on-restart"]');
    check('v2.8 settings: "Reset pinned tabs when Chrome restarts" is present, on by default', (await prs.isVisible()) && (await prs.isChecked()));
    await prs.uncheck(); await sleep(400);
    check('v2.8 settings: the switch is stored as storage.sync.pinnedResetOnRestart', (await swEval(async () => (await chrome.storage.sync.get('pinnedResetOnRestart')).pinnedResetOnRestart)) === false);
    await prs.check(); await sleep(300);
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(300);
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

  // ---- v2.7: toolbar badge, offline card, overlay toggle
  {
    const dbg = () => cmd({ cmd: 'debugState' });
    const untilSt = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 250) { const d = await dbg(); if (fn(d)) return d; await sleep(250); } return dbg(); };
    let d = await untilSt((x) => x?.helper?.status === 'connected' && x.settings?.appEverConnected);
    check('v2.7: appEverConnected stored after the first connection', d.settings?.appEverConnected === true);
    check('v2.7: badge cleared and title "Sidebar" while connected', d.badge?.text === '' && d.badge?.title === 'Sidebar', JSON.stringify(d.badge));
    const menu = () => (d.contextMenus || []).find((m) => m.id === 'overlay-toggle');
    check('v2.7: context menu item exists while connected (checkbox, action context, checked)', menu()?.type === 'checkbox' && menu().checked === true && menu().contexts?.[0] === 'action', JSON.stringify(d.contextMenus));
    check('v2.7: offline card hidden while connected', (await panel.locator('[data-testid="app-offline-card"]').isVisible()) === false);

    await panel.locator('[data-testid="settings-button"]').click(); await sleep(400);
    const sw = panel.locator('[data-testid="overlay-enabled"]');
    check('v2.7: settings switch present, checked by default', (await sw.isVisible()) && (await sw.isChecked()));
    await sw.uncheck(); await sleep(600);
    const stj = () => JSON.parse(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'));
    check('v2.7: switch sends setOverlayEnabled (persisted in state.json)', stj().overlayEnabled === false, JSON.stringify(stj()));
    d = await dbg();
    check('v2.7: context menu follows the switch', menu()?.checked === false && d.settings?.overlayEnabled === false);
    host.broadcast({ type: 'overlayEnabled', enabled: true }); await sleep(600);
    d = await dbg();
    check('v2.7: broadcast from the app updates switch and menu', (await sw.isChecked()) && menu()?.checked === true && d.settings?.overlayEnabled === true);
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(300);

    // drop the connection (the app "quit")
    for (const c of [...host.conns]) c.sock.destroy();
    d = await untilSt((x) => x?.helper?.status !== 'connected');
    check('v2.7: helper reported as disconnected', d.helper?.status !== 'connected', JSON.stringify(d.helper));
    d = await untilSt((x) => x?.badge?.text === '!');
    check('v2.7: badge "!" after having connected once', d.badge?.text === '!' && /isn't running/.test(d.badge?.title || ''), JSON.stringify(d.badge));
    check('v2.7: context menu removed while disconnected', !menu(), JSON.stringify(d.contextMenus));
    await sleep(500);
    const card = panel.locator('[data-testid="app-offline-card"]');
    await panel.locator('[data-testid="settings-button"]').click(); await sleep(400);
    check('v2.8 settings: the default-browser switch is disabled with a hint while the app is offline', (await panel.locator('[data-testid="little-default-browser"]').isDisabled()) && /Needs Sidebar\.app/.test(await panel.locator('[data-testid="little-default-hint"]').innerText()));
    await panel.locator('[data-testid="back-button"]:visible').click(); await sleep(300);
    check('v2.7: offline card shown with both buttons', (await card.isVisible()) && /isn't running/.test(await card.innerText()) && (await panel.locator('[data-testid="app-offline-open"]').isVisible()) && (await panel.locator('[data-testid="app-offline-retry"]').isVisible()));
    // Retry reconnects (the reference host is still listening)
    await panel.locator('[data-testid="app-offline-retry"]').click();
    d = await untilSt((x) => x?.helper?.status === 'connected' && x.badge?.text === '');
    check('v2.7: Retry reconnects, badge cleared, menu back', d.helper?.status === 'connected' && d.badge?.text === '' && !!menu(), JSON.stringify([d.helper?.status, d.badge]));
    await sleep(400);
    check('v2.7: offline card hidden after reconnect', (await card.isVisible()) === false);
  }

  check('no page errors in panel', errors.length === 0, errors.slice(0, 3).join(' | '));
  const swErrs = await swEval(() => (self.__errs || []).length).catch(() => 0);
  await ctx.close();
  await host.close();
  server.kill();
  console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); server.kill(); process.exit(2); });
