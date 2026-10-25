// Boost end-to-end harness. Copies the extension, mounts the boost view in a test page.
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path'; import os from 'os';
import http from 'http';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'boost-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bxe2e-'));
const EXT = path.join(tmp, 'ext');
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
{
  const bp = path.join(EXT, 'background.js');
  let bgsrc = fs.readFileSync(bp, 'utf8');
  if (!/^import .*boosts-sw\.js/m.test(bgsrc)) {
    // The panel/SW agent may still have the hook stubs in place: wire the real module in.
    bgsrc = bgsrc.replace(/^(async )?function (registerBoostListeners|handleBoostCommand)\([^\n]*\n/gm, '');
    bgsrc = "import { registerBoostListeners, handleBoostCommand } from './boosts-sw.js';\n" + bgsrc;
    if (!/registerBoostListeners\(\);/.test(bgsrc)) bgsrc += '\nregisterBoostListeners();\n';
    if (!/handleBoostCommand\(msg/.test(bgsrc)) bgsrc += "\nchrome.runtime.onMessage.addListener((m,s,r)=>{ handleBoostCommand(m,s).then(x=>{ if(x!==undefined) r(x); }); return true; });\n";
    fs.writeFileSync(bp, bgsrc);
  }
}
fs.writeFileSync(path.join(EXT, 'boost-test.html'), `<!doctype html><meta charset=utf-8><link rel=stylesheet href=sidepanel.css><link rel=stylesheet href=boost.css>
<body style="width:340px;margin:0;padding:8px"><div id=bar></div><div id=root></div><div id=settings></div><script type=module src=boost-test.js></script>`);
fs.writeFileSync(path.join(EXT, 'boost-test.js'), `
import {createBoostButton, renderBoostView, renderBoostSettings} from './boost-view.js';
const windowId = +new URLSearchParams(location.search).get('windowId');
const cmd = (name, args) => new Promise(r => chrome.runtime.sendMessage({cmd:name, ...args}, r));
const ctx = {windowId, cmd, goBack(){ document.title='back'; }, openBoost(){ document.title='open'; }, toast(t){ document.title='toast:'+t; }};
document.getElementById('bar').append(createBoostButton(ctx));
renderBoostView(document.getElementById('root'), ctx);
renderBoostSettings(document.getElementById('settings'), ctx);
`);
const PAGE = (t) => `<!doctype html><title>${t}</title><body><div id=box style="padding:20px">Hello</div><div id=ad class="ad-banner" style="height:50px;background:#fc0">AD</div><p id=p>text</p></body>`;
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE('Page ' + q.headers.host)); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const A = `http://127.0.0.1:${PORT}/`, B = `http://localhost:${PORT}/`;

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctxb = await chromium.launchPersistentContext(path.join(tmp, 'udd'), { channel: 'chromium', headless: true, args: ['--host-resolver-rules=MAP localhost 127.0.0.1', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
console.log("launched");
let sw = ctxb.serviceWorkers()[0] || await ctxb.waitForEvent('serviceworker');
console.log("sw up");
const extId = new URL(sw.url()).host;
const swEval = (f, a) => sw.evaluate(f, a);
const helper = await ctxb.newPage(); await helper.goto(`chrome-extension://${extId}/boost-test.html?windowId=0`);
const bg = async (cmd, args = {}) => { return Promise.race([bgRaw(cmd, args).then((x) => { if (!x || x.ok === false) console.log('bg', cmd, JSON.stringify(x)); return x; }), sleep(8000).then(() => ({ ok: false, error: 'timeout' }))]); };
const bgRaw = async (cmd, args = {}) => helper.evaluate(([c, a]) => new Promise((r) => chrome.runtime.sendMessage({ cmd: c, ...a }, r)), [cmd, args]);
const disp = async (page, sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).display, sel);

const page = await ctxb.newPage(); await page.setViewportSize({ width: 800, height: 500 });
console.log("goto A");
await page.goto(A); console.log("A ok"); console.log('np'); const pageB = await ctxb.newPage(); console.log('np ok'); await pageB.goto(B, {timeout:15000}); console.log('B ok');
const tabIdOf = (url) => swEval((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === u)?.id), url);
const winId = await swEval(() => chrome.windows.getLastFocused().then((w) => w.id));

// CSS boost live + reload + host isolation
let r = await bg('saveBoost', { hostname: '127.0.0.1', patch: { css: '#box{background:rgb(1,2,3)!important}' } });
ok(r.ok, 'saveBoost');
await sleep(400);
const bgOf = (p) => p.evaluate(() => getComputedStyle(document.getElementById('box')).backgroundColor);
ok(await bgOf(page) === 'rgb(1, 2, 3)', 'CSS applied live');
ok(await bgOf(pageB) !== 'rgb(1, 2, 3)', 'CSS does not leak to localhost');
await page.reload(); ok(await bgOf(page) === 'rgb(1, 2, 3)', 'CSS applies after reload');
ok(await page.evaluate(() => !!document.getElementById('__sidebar_boost__')), 'style element present');

// disable
await bg('saveBoost', { hostname: '127.0.0.1', patch: { enabled: false } }); await sleep(300);
ok(await bgOf(page) !== 'rgb(1, 2, 3)' && await page.evaluate(() => !document.getElementById('__sidebar_boost__')), 'disable removes styles');
await bg('saveBoost', { hostname: '127.0.0.1', patch: { enabled: true } }); await sleep(300);
ok(await bgOf(page) === 'rgb(1, 2, 3)', 're-enable restores');

// zap via picker
await page.bringToFront();
const tabId = await tabIdOf(A);
r = await bg('startZap', { tabId }); ok(r.ok, 'startZap');
await sleep(300);
const adBox = await page.locator('#ad').boundingBox();
await page.mouse.move(adBox.x + 20, adBox.y + 20); await sleep(200);
await page.screenshot({ path: path.join(SHOTS, 'zap-hover.png') });
await page.keyboard.press('ArrowUp'); await sleep(100);
await page.keyboard.press('ArrowDown'); await sleep(100);
await page.mouse.click(adBox.x + 20, adBox.y + 20); await sleep(500);
ok(await disp(page, '#ad') === 'none', 'zapped element hidden immediately');
let g = await bg('getBoost', { hostname: '127.0.0.1' });
ok(g.boost.zaps.length === 1 && g.boost.zaps[0].selector === '#ad', 'zap stored with selector ' + g.boost.zaps[0]?.selector);
await page.keyboard.press('Escape'); await sleep(700);
ok(await page.evaluate(() => !window.__sidebarZap && !document.querySelector('[data-sidebar-zap]')), 'picker exited on Escape');
ok(await disp(page, '#ad') === 'none', 'zap persists via content script after picker exit');
await page.reload(); ok(await disp(page, '#ad') === 'none', 'zap persists across reload');
ok(await disp(pageB, '#ad') !== 'none', 'zap does not leak to localhost');
// undo + stopZap
await bg('startZap', { tabId }); await sleep(300);
await page.mouse.move(adBox.x + 20, 130); await page.mouse.click(60, 35); await sleep(400);
g = await bg('getBoost', { hostname: '127.0.0.1' }); ok(g.boost.zaps.length === 2, 'second zap added (' + g.boost.zaps.map((z) => z.selector) + ')');
await page.evaluate(() => { const s = document.querySelector('[data-sidebar-zap]'); }); 
await bg('stopZap', { tabId }); await sleep(700);
ok(await page.evaluate(() => !window.__sidebarZap), 'stopZap message exits picker');

// panel view
const panel = await ctxb.newPage(); await panel.setViewportSize({ width: 360, height: 700 });
await panel.goto(`chrome-extension://${extId}/boost-test.html?windowId=${winId}`);
await page.bringToFront();
// active tab for window is 'page'? ensure
await swEval((id) => chrome.tabs.update(id, { active: true }), tabId); await sleep(500);
await panel.waitForSelector('[data-testid=boost-view]');
ok((await panel.locator('[data-testid=zap-row]').count()) === 2, 'view lists 2 zaps');
ok(await panel.locator('[data-testid=boost-button]').getAttribute('data-active') === 'true', 'boost button active on boosted host');
await panel.screenshot({ path: path.join(SHOTS, 'boost-view.png') });
await panel.locator('[data-testid=zap-remove]').first().click(); await sleep(500);
ok((await panel.locator('[data-testid=zap-row]').count()) === 1, 'remove one zap in view');
await panel.locator('[data-testid=code-button]').click();
await panel.locator('[data-testid=code-tab-css]').click();
await panel.locator('[data-testid=code-editor]').fill('p{color:rgb(9,8,7)!important}');
await panel.locator('[data-testid=code-save]').click(); await sleep(500);
ok(await page.evaluate(() => getComputedStyle(document.getElementById('p')).color) === 'rgb(9, 8, 7)', 'CSS saved from view applies live');
await panel.locator('[data-testid=code-tab-js]').click(); await sleep(300);
const us = (await bg('userScriptsStatus')).available;
console.log('userScripts available:', us);
const help = await panel.locator('[data-testid=userscripts-help]').count();
ok(us ? help === 0 : help === 1, 'JS tab shows instructions iff unavailable');
await panel.screenshot({ path: path.join(SHOTS, 'boost-view-code-js.png') });
if (us) {
  await panel.locator('[data-testid=code-editor]').fill('document.title="js-ran"');
  await panel.locator('[data-testid=code-save]').click(); await sleep(600);
  await page.reload(); await sleep(800);
  ok(await page.title() === 'js-ran', 'user script ran after reload');
}
// settings list
ok(await panel.locator('[data-testid=boost-site-row]').count() === 1, 'settings lists 1 boosted site');
await panel.locator('[data-testid=boost-site-toggle]').click(); await sleep(400);
ok(await bgOf(page) !== 'rgb(1, 2, 3)', 'settings toggle disables boost');
ok(await panel.locator('[data-testid=boost-button]').getAttribute('data-active') === 'false', 'button inactive when disabled');
await panel.screenshot({ path: path.join(SHOTS, 'boost-view-disabled.png') });
// unavailable page
await swEval((id) => chrome.tabs.update(id, { url: 'chrome://version' }), tabId).catch(() => {}); await sleep(800);
await panel.screenshot({ path: path.join(SHOTS, 'boost-view-restricted.png') });
ok(await panel.locator('[data-testid=boost-unavailable]').count() === 1, 'restricted page message');
// delete
await swEval((id, u) => chrome.tabs.update(id, { url: u }), [tabId, A].length ? undefined : 0).catch(() => {});
await page.goto(A); await sleep(500);
await panel.locator('[data-testid=boost-delete]').click(); await panel.locator('[data-testid=boost-delete]').click(); await sleep(500);
ok(Object.keys((await bg('listBoosts')).boosts).length === 0, 'delete boost');
ok(await disp(page, '#ad') !== 'none', 'delete unhides zaps');

// title override
await page.goto(A); await sleep(300);
const t0 = await page.title();
const tid = await tabIdOf(A);
await swEval(([id, u]) => chrome.storage.local.set({ tabNames: { [id]: { name: 'My Custom', url: u } } }), [tid, A]); await sleep(500);
ok(await page.title() === 'My Custom', 'title override applied live');
await page.evaluate(() => { document.title = 'page changed'; }); await sleep(300);
ok(await page.title() === 'My Custom', 'title kept against page changes');
await page.reload(); await sleep(400); ok(await page.title() === 'My Custom', 'title override after reload');
await swEval(() => chrome.storage.local.set({ tabNames: {} })); await sleep(500);
const t1 = await page.title(); ok(t1 !== 'My Custom', 'title restored after clearing: ' + t1);
ok(!(await pageB.title()).includes('Custom'), 'other tab unaffected');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await ctxb.close(); srv.close();
process.exit(fails ? 1 : 0);
