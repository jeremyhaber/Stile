// Screenshot editor in a Stile.app window (v3.4), in WebKit like the app's WKWebView. The page is served over HTTP
// with the picture at /__capture/<id>.png (the app's scheme handler does the same) and `webkit.messageHandlers
// .stileCapture` stubbed: every request the page makes of the app is recorded and answered like CaptureEditor.swift.
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path'; import os from 'os'; import http from 'http'; import zlib from 'zlib';
const require = createRequire(import.meta.url);
const { webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'overlay-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// ------------------------------------------------------------------ a PNG: dark blue with a white box and black text-like stripes
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const W = 1200, H = 800;
const PNG = png(W, H, (x, y) => (x > 200 && x < 1000 && y > 200 && y < 600 ? ((y % 24 < 10 && x % 14 < 9) ? [0, 0, 0] : [255, 255, 255]) : [18, 52, 86]));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/__capture/app1.png') { r.setHeader('content-type', 'image/png'); return r.end(PNG); }
  const f = path.join(EXT, decodeURIComponent(u.pathname));
  if (!f.startsWith(EXT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.statusCode = 404; return r.end('not found'); }
  r.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream'); r.end(fs.readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${srv.address().port}`;

const META = { id: 'app1', time: Date.now(), url: '', title: 'Finder', mode: 'area', width: W, height: H, dpr: 2, note: '', link: '' };
const S3 = { endpoint: 'https://s3.example.test', region: 'us-east-1', bucket: 'shots', accessKeyId: 'AKIDEXAMPLE0000TEST', secretAccessKey: 'secret', prefix: 'shots/', style: 'path', naming: 'random', linkType: 'public', publicBase: 'https://cdn.example.test/' };

const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
await ctx.addInitScript(([meta, s3]) => {
  window.__calls = [];
  const answer = (m) => {
    switch (m.op) {
      case 'load': return m.id === 'app1' ? { meta, config: { annotate: true, askWhere: false, s3 } } : null;
      case 'save': return { path: '/Users/x/Downloads/Screenshots/' + m.name, folder: 'Downloads' };
      case 'fetch': return { status: 200, statusText: 'no error', body: '' };
      default: return true;
    }
  };
  window.webkit = { messageHandlers: { stileCapture: { postMessage: (m) => { window.__calls.push(m); return Promise.resolve(answer(m)); } } } };
}, [META, S3]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const calls = (op) => page.evaluate((op) => window.__calls.filter((c) => c.op === op), op);

await page.goto(`${SITE}/capture/capture.html?host=app&id=app1`);
await page.waitForSelector('[data-testid=annotate-stage]', { timeout: 10000 }).catch(() => {});
check('app window: the editor loads in WebKit without `chrome`', await page.locator('[data-testid=capture-editor]').count() === 1 && !errors.length, errors.join(' | '));
check('app window: asked the app for the capture (load) and read the picture from /__capture/', (await calls('load')).length === 1 && await page.evaluate(() => document.querySelector('[data-testid=annotate-stage] image')?.getAttribute('href')?.startsWith('blob:')));
check('app window: status shows the size, "Area" and the app name', /1200 × 800 px/.test(await page.textContent('[data-testid=capture-status]')) && (await page.textContent('[data-testid=capture-mode]')) === 'Area' && (await page.textContent('[data-testid=capture-app]')) === 'Finder');
check('app window: Upload shown (the profile’s S3 settings came with the capture)', await page.locator('[data-testid=capture-upload]').count() === 1);

// annotate: a badge and a blur box
await page.locator('[data-testid=annotate-tool-badge]').click(); await page.locator('[data-testid=annotate-add]').click();
await page.locator('[data-testid=annotate-tool-blur]').click(); await page.locator('[data-testid=annotate-add]').click();
await sleep(400);
check('app window: blur preview is a Gaussian blur in WebKit', await page.locator('[data-testid=annotate-stage] feGaussianBlur').count() === 1);
const r = Number(await page.locator('[data-testid=annotate-stage] svg circle').first().getAttribute('r'));
check('app window: a number badge is a sensible size (radius ≤ 2% of the width)', r > 0 && r <= W * 0.02, String(r));
await page.screenshot({ path: path.join(SHOTS, 'capture-app-editor.png') });

// zoomed in, the selection outline and handles stay a few screen px (WebKit ignored CSS zoom with non-scaling-stroke)
for (let i = 0; i < 12; i++) await page.locator('[data-testid=capture-zoom-in], [aria-label="Zoom in"]').first().click();
await sleep(300);
const sel = await page.evaluate(() => {
  const stage = document.querySelector('[data-testid=annotate-stage]');
  const svg = stage.querySelector('svg');
  const k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;   // screen px per image px, zoom included
  const c = stage.querySelector('[data-testid=annotate-selection] circle');
  return { zoom: Number(stage.dataset.zoom || 1), stroke: Number(c.getAttribute('stroke-width')) * k, r: Number(c.getAttribute('r')) * k, ve: !!stage.querySelector('[data-testid=annotate-selection] [vector-effect]') };
});
check('zoomed in: selection strokes ≈ 2 screen px and handles ≈ 6 px radius in WebKit', sel.zoom > 2 && Math.abs(sel.stroke - 2) < 0.5 && Math.abs(sel.r - 6) < 1 && !sel.ve, JSON.stringify(sel));
await page.screenshot({ path: path.join(SHOTS, 'capture-app-editor-zoomed.png') });

// copy, save, upload go to the app
await page.locator('[data-testid=capture-copy]').click(); await sleep(800);
const cp = await calls('copyImage');
check('Copy: the flattened PNG goes to the app (copyImage)', cp.length === 1 && Buffer.from(cp[0].data, 'base64').subarray(1, 4).toString() === 'PNG');
await page.locator('[data-testid=capture-save]').click(); await sleep(800);
const sv = await calls('save');
check('Save: the app saves "Screenshot YYYY-MM-DD at HH.MM.SS.png" (no Chrome download)', sv.length === 1 && /^Screenshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/.test(sv[0].name) && sv[0].askWhere === false && Buffer.from(sv[0].data, 'base64').subarray(1, 4).toString() === 'PNG', JSON.stringify(sv.map((s) => s.name)));
check('Save: toast "Saved to Downloads"', /Saved to Downloads/.test(await page.locator('[data-testid=capture-toast]').allTextContents().then((t) => t.join(' '))));
await page.locator('[data-testid=capture-upload]').click(); await sleep(1500);
const ft = await calls('fetch');
check('Upload: the signed PUT goes through the app (fetch), not the page', ft.length === 1 && ft[0].method === 'PUT' && ft[0].url.startsWith('https://s3.example.test/shots/shots/') && /AWS4-HMAC-SHA256/.test(ft[0].headers.authorization || ft[0].headers.Authorization || '') && !!ft[0].body, JSON.stringify(ft.map((f) => [f.method, f.url])));
const sl = await calls('setLink'), ct = await calls('copyText');
check('Upload: the link is stored (setLink) and copied (copyText)', sl.length === 1 && sl[0].id === 'app1' && sl[0].link.startsWith('https://cdn.example.test/shots/') && ct.length === 1 && ct[0].text === sl[0].link, JSON.stringify([sl, ct]));
check('Upload: the link shows in the status line', (await page.textContent('[data-testid=capture-link] code')).startsWith('https://cdn.example.test/'));

// closing: the window's red button asks the page, a dirty editor confirms first
await page.evaluate(() => window.__stileRequestClose());
check('Close button with annotations: "Discard changes?" first, nothing closed', await page.locator('[data-testid=capture-dialog]').count() === 1 && (await calls('close')).length === 0);
await page.locator('[data-testid=capture-dialog] button', { hasText: /Discard/ }).click(); await sleep(200);
check('Discard: the page asks the app to close the window', (await calls('close')).length === 1);

// a capture the app no longer has
const p2 = await ctx.newPage();
await p2.goto(`${SITE}/capture/capture.html?host=app&id=gone`);
await p2.waitForSelector('[data-testid=capture-missing]', { timeout: 5000 }).catch(() => {});
check('app window: a missing capture says so', await p2.locator('[data-testid=capture-missing]').count() === 1);

// ------------------------------------------------------------------ v3.5c: Stile.app's own settings window (capture-only mode)
// settings.html?host=app in WebKit, `webkit.messageHandlers.stileSettings` stubbed like AppSettingsWindow.swift answers it.
{
  const ctx2 = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await ctx2.addInitScript(() => {
    window.__sc = [];
    const st = {
      useChrome: false, microphones: [{ id: 'mic-1', name: 'Built-in Microphone' }], microphone: false, screenCapture: true, launchAtLogin: false, showMenuBarIcon: true, appVersion: '3.5.0-test',
      capture: { screenshotFolder: '/Users/x/Downloads/Screenshots', recordingFolder: '/Users/x/Movies/Stile', recordingFolderFollowsScreenshots: false, defaultScreenshotFolder: '/Users/x/Downloads/Screenshots', defaultRecordingFolder: '/Users/x/Movies/Stile',
        filenamePattern: 'Screenshot {yyyy}-{mm}-{dd} at {hh}.{min}.{ss}', windowShadow: true, annotate: true, askWhere: false,
        s3: { endpoint: '', region: '', regionAuto: true, bucket: '', accessKeyId: '', prefix: 'screenshots/{yyyy}/{mm}/', style: 'auto', naming: 'random', linkType: 'presigned', publicBase: '', expiry: 604800, v: 2, secretSet: false },
        recording: { micDeviceId: '', systemAudio: false, countdown: true, fps: 30, codec: 'h264', maxResolution: '1080p', showCursor: true } },
    };
    let secret = '';
    const push = () => setTimeout(() => window.__stileSettingsPush && window.__stileSettingsPush(JSON.parse(JSON.stringify(st))), 10);
    const apply = (patch) => {
      const c = st.capture;
      for (const k of ['filenamePattern', 'windowShadow', 'annotate', 'askWhere']) if (k in patch) c[k] = patch[k];
      if (patch.s3) { const { secretAccessKey, ...rest } = patch.s3; Object.assign(c.s3, rest); if (secretAccessKey !== undefined) { secret = secretAccessKey; c.s3.secretSet = !!secret; } }
      if (patch.recording) Object.assign(c.recording, patch.recording);
    };
    window.webkit = { messageHandlers: { stileSettings: { postMessage: (m) => {
      window.__sc.push(m);
      switch (m.op) {
        case 'state': return Promise.resolve(JSON.parse(JSON.stringify(st)));
        case 'set': apply(m.patch); push(); return Promise.resolve(st.capture);
        case 'full': return Promise.resolve({ ...st.capture, s3: { ...st.capture.s3, secretAccessKey: secret } });
        case 'fetch': return Promise.resolve({ status: 200, statusText: 'OK', body: '' });
        case 'appSetting': if (m.name === 'setUseChrome') { st.useChrome = !!m.value; push(); } return Promise.resolve(true);
        default: return Promise.resolve(true);
      }
    } } } };
  });
  const sp = await ctx2.newPage();
  const errs = [];
  sp.on('pageerror', (e) => errs.push(String(e)));
  const sc = (op) => sp.evaluate((op) => window.__sc.filter((c) => c.op === op), op);
  await sp.goto(`${SITE}/settings.html?host=app`);
  await sp.waitForSelector('[data-testid=capture-settings]', { timeout: 10000 }).catch(() => {});
  check('settings window: loads in WebKit without `chrome` and without errors', await sp.locator('[data-testid=capture-settings]').count() === 1 && !errs.length, errs.join(' | '));
  const navs = await sp.locator('.nav-item').allTextContents();
  check('settings window: only Capture, Recording and App', JSON.stringify(navs.map((t) => t.trim())) === JSON.stringify(['Capture', 'Recording', 'App']), JSON.stringify(navs));
  check('settings window: the Capture pane has the app rows and no extension-only ones',
    await sp.locator('[data-testid=capture-folder]').isVisible() && await sp.locator('[data-testid=capture-pattern]').isVisible() && await sp.locator('[data-testid=capture-shadow]').isVisible() && !(await sp.locator('[data-testid=capture-after]').isVisible()) && !/chrome:\/\/extensions/.test(await sp.locator('[data-testid=capture-settings]').innerText()));
  check('settings window: shows the app\'s folder and pattern', (await sp.locator('[data-testid=capture-folder]').innerText()) === '/Users/x/Downloads/Screenshots' && (await sp.locator('[data-testid=capture-pattern]').inputValue()).startsWith('Screenshot {yyyy}'));
  await sp.locator('[data-testid=capture-pattern]').fill('Shot {hh}');
  await sleep(200);
  check('settings window: the file name pattern is sent to the app (set)', (await sc('set')).some((c) => c.patch.filenamePattern === 'Shot {hh}'));
  await sp.locator('[data-testid=capture-shadow]').uncheck(); await sleep(150);
  check('settings window: the shadow switch is sent to the app', (await sc('set')).some((c) => c.patch.windowShadow === false));
  await sp.locator('[data-testid=capture-folder-choose]').click(); await sleep(100);
  check('settings window: "Choose…" asks the app (chooseFolder screenshots)', (await sc('chooseFolder')).some((c) => c.kind === 'screenshots'));
  // S3 + the connection test goes through the app's fetch, with the secret taken from the app only for the test
  const fillS = async (t, v) => sp.locator(`[data-testid=${t}]`).fill(v);
  await fillS('capture-s3-endpoint', 'https://s3.example.test'); await fillS('capture-s3-region', 'us-east-1'); await fillS('capture-s3-bucket', 'shots');
  await fillS('capture-s3-key', 'AKIDEXAMPLE0000TEST'); await fillS('capture-s3-secret', 'sekrit-value');
  await sleep(500);
  check('settings window: the secret is not sent while it is typed', !(await sc('set')).some((c) => c.patch.s3 && 'secretAccessKey' in c.patch.s3));
  await sp.evaluate(() => document.activeElement && document.activeElement.blur());   // leaving the field sends it
  await sleep(600);
  const sets = await sc('set');
  check('settings window: S3 fields and the secret are sent to the app (the secret once)', sets.some((c) => c.patch.s3 && c.patch.s3.bucket === 'shots' && c.patch.s3.accessKeyId === 'AKIDEXAMPLE0000TEST') && sets.filter((c) => c.patch.s3 && 'secretAccessKey' in c.patch.s3).length >= 1);
  await sp.locator('[data-testid=capture-pattern]').click(); await sleep(300);
  const body = await sp.evaluate(() => document.body.innerText + [...document.querySelectorAll('input')].map((i) => i.value).join('|'));
  check('settings window: after saving, the secret is not in the page; the field hints at the Keychain', !body.includes('sekrit-value') && /Keychain/.test(await sp.locator('[data-testid=capture-s3-secret]').getAttribute('placeholder')));
  await sp.locator('[data-testid=capture-s3-test]').click();
  await sp.waitForFunction(() => /Connected|Could not|\d{3}/.test(document.querySelector('[data-testid=capture-s3-result]').textContent), null, { timeout: 8000 }).catch(() => {});
  const res = await sp.locator('[data-testid=capture-s3-result]').textContent();
  const fetches = await sc('fetch');
  check('settings window: Test connection reads the full settings from the app and PUTs then DELETEs through the app (no page fetch)', (await sc('full')).length === 1 && fetches.length === 2 && fetches[0].method === 'PUT' && fetches[1].method === 'DELETE' && /AWS4-HMAC-SHA256/.test(fetches[0].headers.authorization || fetches[0].headers.Authorization || '') && /Connected/.test(res), res + ' ' + JSON.stringify(fetches.map((f) => [f.method, f.url])));
  // recording
  await sp.locator('[data-testid=settings-nav-recording]').click(); await sleep(150);
  check('settings window: the Recording pane shows the defaults and the microphone list',
    await sp.locator('[data-testid=recording-settings]').isVisible() && await sp.locator('[data-testid=recording-fps]').inputValue() === '30' && /Built-in Microphone/.test(await sp.locator('[data-testid=recording-mic]').innerText()) && (await sp.locator('[data-testid=recording-folder]').innerText()) === '/Users/x/Movies/Stile');
  await sp.locator('[data-testid=recording-fps]').selectOption('60');
  await sp.locator('[data-testid=recording-mic]').selectOption('mic-1');
  await sleep(200);
  const rs = await sc('set');
  check('settings window: recording choices are sent to the app', rs.some((c) => c.patch.recording && c.patch.recording.fps === 60) && rs.some((c) => c.patch.recording && c.patch.recording.micDeviceId === 'mic-1'));
  await sp.locator('[data-testid=recording-folder-choose]').click(); await sleep(100);
  check('settings window: the recordings folder asks the app (chooseFolder recordings)', (await sc('chooseFolder')).some((c) => c.kind === 'recordings'));
  await sp.locator('[data-testid=recording-folder-reset]').click(); await sleep(100);
  check('settings window: "Use screenshot folder" clears the recordings folder', (await sc('set')).some((c) => c.patch.recordingFolder === ''));
  // app
  await sp.locator('[data-testid=settings-nav-app]').click(); await sleep(150);
  check('settings window: App pane — Use Stile with Chrome is off, Screen Recording on, version shown', !(await sp.locator('[data-testid=app-use-chrome]').isChecked()) && (await sp.locator('[data-testid=app-screen-capture]').innerText()) === 'On' && /3\.5\.0-test/.test(await sp.locator('[data-testid=app-version]').innerText()));
  await sp.locator('[data-testid=app-use-chrome]').check(); await sleep(250);
  check('settings window: switching Chrome mode on is sent to the app and the note appears', (await sc('appSetting')).some((c) => c.name === 'setUseChrome' && c.value === true) && await sp.locator('[data-testid=app-chrome-note]').isVisible());
  await sp.locator('[data-testid=app-microphone-on]').click(); await sleep(100);
  check('settings window: the microphone button asks the app', (await sc('appSetting')).some((c) => c.name === 'requestMicrophone'));
  await sp.screenshot({ path: path.join(SHOTS, 'settings-app-window.png') });
  check('settings window: with Chrome mode on, the App note points to Chrome (no longer opens its settings)', /Open Chrome with the Stile extension/.test(await sp.locator('[data-testid=app-chrome-note]').innerText()));
  await ctx2.close();
}

// ------------------------------------------------------------------ v3.7: settings.html?host=app&profile=<dir>: the full settings page, bridged to that profile's extension
// `sidebarBridge` answers like bridge-sw.js (a tiny in-memory extension), `stileSettings` like AppSettingsWindow.swift (state + selectProfile).
{
  const ctx3 = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await ctx3.addInitScript(() => {
    window.__sc = [];
    const profiles = [{ dir: 'Default', name: 'Personal', email: 'me@example.com', picture: null, color: '#0000ff' }, { dir: 'Profile 1', name: 'Work', email: '', picture: null, color: '#db9f81' }, { dir: 'Profile 2', name: 'Kids', email: '', picture: null, color: '#00ff00' }];
    const store = { session: { helper: { status: 'connected', profiles, currentProfileDir: 'Default' }, appState: { appVersion: '3.7.0-test' } }, local: { globalDefaultMinutes: 1440, overlayEnabled: true }, sync: {} };
    const pick = (o, keys) => { if (keys == null) return { ...o }; const r = {}; for (const k of [].concat(typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : keys)) if (k in o) r[k] = o[k]; return r; };
    const answer = (call, args) => {
      if (call === 'sidebar.hello') return { extensionId: 'ffblekellgdmlecjablfojaaadpkmdgg', version: '3.7.0' };
      if (call === 'runtime.getManifest') return { name: 'Stile', version: '3.7.0', manifest_version: 3 };
      if (call === 'sidebar.capabilities') return { split: false, tabGroups: false, userScripts: false };
      let m = /^storage\.(local|sync|session)\.(get|set|remove)$/.exec(call);
      if (m) { const o = store[m[1]]; if (m[2] === 'get') return pick(o, args[0]); if (m[2] === 'set') Object.assign(o, args[0]); else for (const k of [].concat(args[0])) delete o[k]; return null; }
      if (call === 'tabs.query') return [];
      if (call === 'sidebar.cmd') { window.__sc.push({ op: 'cmd', msg: args[0] }); return { ok: true }; }
      return null;
    };
    window.webkit = { messageHandlers: {
      sidebarBridge: { postMessage: (s) => { const m = JSON.parse(s); if (m.type !== 'bridge') return; setTimeout(() => window.__sidebarBridgeReceive({ type: 'bridgeResult', id: m.id, ok: true, result: answer(m.call, m.args || []) }), 5); } },
      stileSettings: { postMessage: (m) => {
        window.__sc.push(m);
        if (m.op === 'state') return Promise.resolve({ useChrome: true, connectedProfiles: ['Default', 'Profile 2'], scopeProfile: 'Default' });
        if (m.op === 'selectProfile') return m.dir === 'Profile 1' ? Promise.reject(new Error('That profile isn’t open in Chrome')) : Promise.resolve(true);
        return Promise.resolve(true);
      } },
    } };
  });
  const bp = await ctx3.newPage();
  const berrs = [];
  bp.on('pageerror', (e) => berrs.push(String(e)));
  await bp.goto(`${SITE}/settings.html?host=app&profile=Default`);
  await bp.waitForSelector('[data-testid=settings-nav]', { timeout: 10000 }).catch(() => {});
  await bp.waitForSelector('[data-testid=settings-scope]', { timeout: 5000 }).catch(() => {});
  check('bridged settings: renders the full settings page in WebKit without errors', await bp.locator('[data-testid=settings-section-tabs]').count() === 1 && !berrs.length, berrs.join(' | '));
  check('bridged settings: opens on Tabs & Archive (no General)', (await bp.locator('[data-testid=settings-title]').innerText()) === 'Tabs & Archive' && (await bp.locator('[data-testid=settings-nav-general]').count()) === 0);
  const bsel = bp.locator('[data-testid=settings-scope]');
  const optInfo = await bsel.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.disabled, o.textContent]));
  check('bridged settings: the profile picker is enabled and lists every profile, not-open ones disabled with a suffix', !(await bsel.isDisabled()) && (await bsel.inputValue()) === 'Default' && optInfo.length === 3 && optInfo.find((o) => o[0] === 'Profile 1')[1] === true && /not open in Chrome/.test(optInfo.find((o) => o[0] === 'Profile 1')[2]) && !optInfo.find((o) => o[0] === 'Profile 2')[1], JSON.stringify(optInfo));
  check('bridged settings: the extension\'s rows work through the bridge (global archive default shows 24 hours)', (await bp.locator('[data-testid=settings-archive-global]').inputValue()) === '1440' && (await bp.locator('[data-testid=settings-archive-profile] option').first().innerText()) === 'Use default (24 hours)');
  await bsel.selectOption('Profile 2'); await sleep(200);
  check('bridged settings: choosing a profile asks the app (selectProfile with the current section)', (await bp.evaluate(() => window.__sc)).some((c) => c.op === 'selectProfile' && c.dir === 'Profile 2' && c.section === 'tabs'));
  await bp.evaluate(() => { window.__sc.length = 0; });
  await bp.locator('[data-testid=archive-apply-all]').click(); await sleep(200);
  check('bridged settings: "Apply to all profiles" reaches the extension (clearArchiveOverrides command)', (await bp.evaluate(() => window.__sc)).some((c) => c.op === 'cmd' && c.msg.cmd === 'clearArchiveOverrides'));
  await bp.evaluate(() => window.__stileSettingsPush({ connectedProfiles: ['Default'], scopeProfile: 'Default' })); await sleep(100);
  check('bridged settings: an app push updates which profiles are open', (await bsel.locator('option').evaluateAll((os) => os.find((o) => o.value === 'Profile 2').disabled)) === true);
  await bp.locator('[data-testid=settings-nav-app]').click(); await sleep(150);
  check('bridged settings: App is a global section ("All profiles" chip)', await bp.locator('[data-testid=settings-scope-global]').isVisible());
  await bp.screenshot({ path: path.join(SHOTS, 'settings-bridged.png') });
  await ctx3.close();
}

await browser.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
