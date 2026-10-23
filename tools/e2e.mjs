// End-to-end test: loads the extension in Chromium with the real helper wired up
// through a fake Chrome "Local State" and a fake Chrome binary.
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
const helperDir = path.join(tmp, 'helper');
fs.mkdirSync(path.join(udd, 'NativeMessagingHosts'), { recursive: true });
fs.mkdirSync(helperDir, { recursive: true });

// Helper + native host manifest
const helperPath = path.join(tmp, 'sidebar-helper.pl');
fs.copyFileSync(path.join(ROOT, 'helper/sidebar-helper.pl'), helperPath);
fs.chmodSync(helperPath, 0o755);
const tpl = fs.readFileSync(path.join(ROOT, 'helper/com.sidebar.helper.json.template'), 'utf8');
fs.writeFileSync(path.join(udd, 'NativeMessagingHosts/com.sidebar.helper.json'), tpl.replace('__HELPER_PATH__', helperPath));

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

async function main() {
  await sleep(500);
  const ctx = await chromium.launchPersistentContext(udd, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1200, height: 800 },
    env: { ...process.env, SIDEBAR_HELPER_DIR: helperDir, SIDEBAR_LOCAL_STATE: localState, SIDEBAR_CHROME_BIN: fakeChrome },
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

  // Drag charlie into favourites
  await panel.locator('[data-testid="today-row"][data-url*="charlie"]').dragTo(panel.locator('[data-testid="favourites-grid"]'));
  await sleep(700);
  check('drag tab → favourites creates a tile', (await panel.locator('[data-testid="favourite-tile"]').count()) === 1);
  check('pinned tab leaves Today', (await todayRows()) === 4, String(await todayRows()));

  // Drag delta into pinned
  await panel.locator('[data-testid="today-row"][data-url*="delta"]').dragTo(panel.locator('[data-testid="pinned-tree"]'));
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
  await panel.locator('[data-testid="today-row"][data-url*="echo"]').dragTo(panel.locator('[data-testid="pinned-folder"]').first());
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
  check('pending handoff written for target profile', fs.readdirSync(path.join(helperDir, 'pending')).some((f) => f.startsWith('Profile')));

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
  const net = await import('net');
  await swEval(async (w) => chrome.windows.update(w, { focused: true }), mainWin);
  await new Promise((res, rej) => { const s = net.createConnection(path.join(helperDir, 'sock/Default.sock'), () => { s.end(JSON.stringify({ type: 'activate', bounds: { left: 40, top: 30, width: 900, height: 640, state: 'normal' } }) + '\n'); res(); }); s.on('error', rej); });
  await sleep(1200);
  const wb = await swEval(async () => { const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); return { left: w.left, top: w.top, width: w.width, height: w.height }; });
  check('activate from another profile applies window bounds', wb.width === 900 && wb.height === 640, JSON.stringify(wb));

  check('no page errors in panel', errors.length === 0, errors.slice(0, 3).join(' | '));
  const swErrs = await swEval(() => (self.__errs || []).length).catch(() => 0);
  await ctx.close();
  server.kill();
  console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); server.kill(); process.exit(2); });
