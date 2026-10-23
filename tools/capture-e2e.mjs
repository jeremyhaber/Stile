// Screenshots e2e (v2.9 part B): capture modes, after-capture modes, editor, recent captures, S3 upload, settings.
// Loads the extension in Chromium, serves local pages and a fake S3 server whose SigV4 verification uses the `aws4`
// library (installed in tools/capture-build, test-only) as an independent implementation.
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path'; import os from 'os'; import http from 'http'; import crypto from 'crypto';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const aws4 = createRequire(path.join(path.dirname(new URL(import.meta.url).pathname), 'capture-build', 'package.json'))('aws4');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = process.env.SHOTS || '/tmp/claude-0/-home-claude/e0605526-dcdb-5d20-aaac-918c6d6e8268/scratchpad/overlay-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// ------------------------------------------------------------------ pages
const BANDS = ['#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b'];
const LONG = `<!doctype html><title>Long page</title><body style="margin:0;font:20px sans-serif">
<div style="position:fixed;top:0;left:0;right:0;height:50px;background:#ff0000;color:#fff;z-index:10">FIXED HEADER</div>
${BANDS.map((c, i) => `<div style="height:500px;background:${c};padding-top:60px;box-sizing:border-box">band ${i}</div>`).join('')}</body>`;
const PLAIN = `<!doctype html><title>Plain page</title><body style="margin:0;font:20px sans-serif;background:#fff"><div id=a style="position:absolute;left:100px;top:100px;width:400px;height:300px;background:#e8e8ff">box</div><h1 style="margin:20px">Plain page</h1></body>`;
const TALL = `<!doctype html><title>Tall page</title><body style="margin:0"><div style="height:20500px;background:linear-gradient(#fff,#06c)">tall</div></body>`;
const pages = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.url.startsWith('/long') ? LONG : q.url.startsWith('/tall') ? TALL : PLAIN); });
await new Promise((r) => pages.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${pages.address().port}`;

// ------------------------------------------------------------------ fake S3 (verifies SigV4 with aws4)
const CREDS = { accessKeyId: 'AKIDEXAMPLE0000TEST', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const store = new Map();         // "bucket/key" -> Buffer
const s3log = [];                // { method, path, ok, why }
const s3 = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const fail = (code, status, msg, why) => { s3log.push({ method: req.method, path: u.pathname, ok: false, why }); res.statusCode = status; res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${msg}</Message></Error>`); };
    let ok = false, why = '';
    if (req.method === 'GET' && !req.headers.authorization && !u.searchParams.has('X-Amz-Signature')) {   // a public bucket serves anonymous reads
      const b = store.get(decodeURIComponent(u.pathname.slice(1)));
      s3log.push({ method: 'GET', path: u.pathname, ok: true, anon: true });
      if (!b) { res.statusCode = 404; return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
      res.setHeader('content-type', 'image/png'); return res.end(b);
    }
    if (u.searchParams.has('X-Amz-Signature')) {            // presigned GET
      const q = Object.fromEntries(u.searchParams);
      const region = q['X-Amz-Credential'].split('/')[2];
      const o = { host: req.headers.host, method: req.method, path: u.pathname + `?X-Amz-Date=${q['X-Amz-Date']}&X-Amz-Expires=${q['X-Amz-Expires']}`, service: 's3', region, signQuery: true };
      aws4.sign(o, CREDS);
      const want = /X-Amz-Signature=([0-9a-f]+)/.exec(o.path)?.[1];
      ok = want === q['X-Amz-Signature']; why = ok ? '' : 'presign mismatch';
      const exp = Date.parse(q['X-Amz-Date'].replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, '$1-$2-$3T$4:$5:$6Z')) + Number(q['X-Amz-Expires']) * 1000;
      if (ok && Date.now() > exp) { ok = false; why = 'expired'; }
    } else {
      const a = req.headers.authorization || '';
      const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(a);
      if (!m) { why = 'no authorization'; }
      else {
        const [, ak, , region, signed, sig] = m;
        const names = signed.split(';');
        const headers = {};
        for (const n of names) headers[n] = req.headers[n];
        const needed = ['host', 'x-amz-date', 'x-amz-content-sha256'];
        const missing = needed.filter((n) => !names.includes(n));
        const o = { host: req.headers.host, method: req.method, path: req.url, headers, service: 's3', region };
        aws4.sign(o, CREDS);
        const mine = /Signature=([0-9a-f]+)/.exec(o.headers.Authorization)[1];
        const payload = req.headers['x-amz-content-sha256'];
        const hashOk = payload === crypto.createHash('sha256').update(body).digest('hex');
        ok = ak === CREDS.accessKeyId && mine === sig && !missing.length && hashOk;
        why = ok ? '' : ak !== CREDS.accessKeyId ? 'InvalidAccessKeyId' : missing.length ? 'unsigned ' + missing : !hashOk ? 'payload hash' : 'SignatureDoesNotMatch';
      }
    }
    if (!ok) return fail(why === 'InvalidAccessKeyId' ? 'InvalidAccessKeyId' : 'SignatureDoesNotMatch', 403, 'The request signature we calculated does not match the signature you provided.', why);
    const key = decodeURIComponent(u.pathname.slice(1));
    s3log.push({ method: req.method, path: u.pathname, ok: true, ct: req.headers['content-type'], cc: req.headers['cache-control'] });
    if (req.method === 'PUT') { store.set(key, body); res.setHeader('etag', '"x"'); res.end(); }
    else if (req.method === 'DELETE') { store.delete(key); res.statusCode = 204; res.end(); }
    else if (req.method === 'GET') { const b = store.get(key); if (!b) { res.statusCode = 404; return res.end('<Error><Code>NoSuchKey</Code></Error>'); } res.setHeader('content-type', 'image/png'); res.end(b); }
    else { res.statusCode = 405; res.end(); }
  });
});
await new Promise((r) => s3.listen(0, '127.0.0.1', r));
const S3URL = `http://127.0.0.1:${s3.address().port}`;
const S3CFG = { preset: 'custom', endpoint: S3URL, region: 'us-east-1', bucket: 'shots', accessKeyId: CREDS.accessKeyId, secretAccessKey: CREDS.secretAccessKey, prefix: 'screenshots/{yyyy}/{mm}/', style: 'path', naming: 'random', linkType: 'public', publicBase: `${S3URL}/shots/`, expiry: 3600 };

// ------------------------------------------------------------------ browser
const ctx = await chromium.launchPersistentContext(path.join(tmp, 'udd'), {
  channel: 'chromium', headless: true, viewport: null,
  args: ['--window-size=1100,860', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${extId}` }).catch(() => {});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE }).catch(() => {});

const helper = await ctx.newPage();
await helper.goto(`chrome-extension://${extId}/capture/capture.html?id=none`);
const send = (m) => helper.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);
const mainWin = await sw.evaluate(async () => (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id);
const setSync = (o) => helper.evaluate((x) => chrome.storage.sync.set(x), o);
const setS3 = (o) => helper.evaluate((x) => chrome.storage.local.set({ captureS3: x }), o);
const list = async () => (await send({ cmd: 'captureList' })).captures;
const editorPages = () => ctx.pages().filter((p) => /capture\.html\?id=/.test(p.url()) && !p.url().includes('id=none'));
const waitEditor = async (id, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const p = editorPages().find((x) => !id || x.url().includes('id=' + id)); if (p) return p; await sleep(100); } return null; };
const closeEditors = async () => { for (const p of editorPages()) await p.close().catch(() => {}); };
// PNG pixels of a stored capture, read through the extension's own store
const pixels = (id, pts, col) => helper.evaluate(async ([id, pts, col]) => {
  const { getBlob } = await import('/capture/common.js');
  const bmp = await createImageBitmap(await getBlob(id));
  const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
  const px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
  const out = { w: bmp.width, h: bmp.height, pts: pts.map(([x, y]) => px(x, y)) };
  if (col != null) { const d = g.getImageData(col, 0, 1, bmp.height).data; let red = 0; for (let y = 0; y < bmp.height; y++) if (d[y * 4] > 240 && d[y * 4 + 1] < 20 && d[y * 4 + 2] < 20) red++; out.red = red; }
  return out;
}, [id, pts, col]);
const near = (a, hex, tol = 6) => { const n = parseInt(hex.slice(1), 16); return Math.abs(a[0] - (n >> 16)) <= tol && Math.abs(a[1] - ((n >> 8) & 255)) <= tol && Math.abs(a[2] - (n & 255)) <= tol; };
const newest = async () => (await list())[0];
const freshAfter = async (n0) => { for (let i = 0; i < 60; i++) { const l = await list(); if (l.length > n0 || (l[0] && l.length === 30)) return l[0]; await sleep(150); } return null; };

const page = await ctx.newPage();
await page.goto(`${SITE}/plain`); await page.bringToFront(); await sleep(800);
const [VW, VH] = await page.evaluate(() => [innerWidth, innerHeight]);
// the clipboard is read from the http page (permission can't be granted to extension origins in Playwright)
const readClip = async () => {
  await page.bringToFront();
  return page.evaluate(async () => { try { const it = await navigator.clipboard.read(); const t = it[0].types; const b = await it[0].getType('image/png').catch(() => null); const bmp = b && await createImageBitmap(b); return { t, size: b && b.size, w: bmp && bmp.width, h: bmp && bmp.height }; } catch (e) { return { err: String(e) }; } });
};

// ------------------------------------------------------------------ settings defaults + commands registered
{
  const cmds = await helper.evaluate(() => chrome.commands.getAll());
  const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
  check('manifest commands: capture-visible/full/region', !!byName['capture-visible'] && !!byName['capture-full'] && !!byName['capture-region']);
  check('only capture-region has a suggested key', byName['capture-region'].shortcut === 'Alt+Shift+3' && !byName['capture-visible'].shortcut && !byName['capture-full'].shortcut, JSON.stringify(cmds.map((c) => [c.name, c.shortcut])));
  await sleep(300);
  const st = await send({ cmd: 'debugState' });
  check('page right-click menu "Screenshot ▸ Visible area / Full page / Region" registered', ['sbcap', 'sbcap-visible', 'sbcap-full', 'sbcap-region'].every((i) => (st.captureMenus || []).includes(i)), JSON.stringify(st.captureMenus));
  const perms = await helper.evaluate(() => chrome.runtime.getManifest().permissions);
  check('downloads permission requested', perms.includes('downloads'));
}

// ------------------------------------------------------------------ visible area -> editor
let capVisible;
{
  await closeEditors();
  const n0 = (await list()).length;
  const r = await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
  check('capture visible: ok', r && r.ok === true, JSON.stringify(r));
  capVisible = await freshAfter(n0);
  check('capture visible: stored (viewport-size png, mode, url, title)', capVisible && capVisible.width === VW && capVisible.height === VH && capVisible.mode === 'visible' && capVisible.url.startsWith(SITE) && capVisible.title === 'Plain page', JSON.stringify(capVisible && { ...capVisible, thumb: '…' }));
  const ed = await waitEditor(capVisible.id);
  check('capture visible: editor window opens (default after-capture mode)', !!ed);
  const win = await sw.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.type));
  check('editor is a popup window', win.includes('popup'), win.join());
  if (ed) {
    await ed.waitForSelector('[data-testid=annotate-stage]');
    check('editor: status line shows size, mode and page title link', (await ed.textContent('[data-testid=capture-status]')).includes(`${VW} × ${VH} px`) && (await ed.textContent('[data-testid=capture-mode]')) === 'Visible area' && (await ed.textContent('[data-testid=capture-page-link]')) === 'Plain page');
    const tools = await ed.locator('[data-testid^=annotate-tool-]').count();
    check('editor: 12 annotation tools from AnnotateToolbar', tools === 12, String(tools));
    check('editor: export actions + drag handle + zoom', await ed.locator('[data-testid=capture-copy]').count() === 1 && await ed.locator('[data-testid=capture-save]').count() === 1 && await ed.locator('[data-testid=capture-drag]').count() === 1 && await ed.locator('[data-testid=capture-fit]').count() === 1);
    check('editor: no Upload button until configured', await ed.locator('[data-testid=capture-upload]').count() === 0);
    check('editor: properties bar hidden with the Select tool', await ed.locator('[data-testid=capture-props]').count() === 0);
    await ed.locator('[data-testid=annotate-tool-rect]').click();
    check('editor: properties bar appears when a tool is chosen', await ed.locator('[data-testid=capture-props]').count() === 1);
  }
}

// ------------------------------------------------------------------ editor: annotate (keyboard Add), copy, save
{
  const ed = await waitEditor(capVisible.id);
  await ed.bringToFront();
  const shapesBefore = await ed.locator('[data-testid=annotate-stage] svg > *:not(defs):not(image)').count();
  await ed.locator('[data-testid=annotate-tool-rect]').click();
  await ed.locator('[data-testid=annotate-add]').click();       // the keyboard-accessible "Add rectangle" path
  await sleep(200);
  const shapesAfter = await ed.locator('[data-testid=annotate-stage] svg > *:not(defs):not(image)').count();
  check('annotate: Add rectangle places a shape (undoable)', shapesAfter > shapesBefore && await ed.locator('[data-testid=annotate-undo]:not([aria-disabled=true])').count() === 1, `${shapesBefore} -> ${shapesAfter}`);
  await ed.locator('[data-testid=annotate-color-red]').click();
  await ed.screenshot({ path: path.join(SHOTS, 'capture-editor-rect-light.png') });
  // Copy puts the flattened PNG on the clipboard
  await ed.locator('[data-testid=capture-copy]').click();
  await ed.waitForSelector('[data-testid=capture-toast]');
  const clip = await readClip();
  await ed.bringToFront();
  check('copy: clipboard holds image/png of the full size', clip.t && clip.t.includes('image/png') && clip.w === VW && clip.h === VH, JSON.stringify(clip));
  const orig = await helper.evaluate(async (id) => { const { getBlob } = await import('/capture/common.js'); return (await getBlob(id)).size; }, capVisible.id);
  check('copy: the annotation is flattened into the copy', clip.size && clip.size !== orig, `${clip.size} vs ${orig}`);
  // Save -> chrome.downloads, Screenshots/Screenshot YYYY-MM-DD at HH.MM.SS.png
  // headless Chromium renames downloads, so the requested name is recorded at the chrome.downloads call
  await ed.evaluate(() => { const o = chrome.downloads.download; window.__dl = []; chrome.downloads.download = function (a) { window.__dl.push({ filename: a.filename, saveAs: a.saveAs, conflictAction: a.conflictAction, url: a.url.slice(0, 5) }); return o.apply(this, arguments); }; });
  const dlP = ed.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await ed.locator('[data-testid=capture-save]').click();
  const dl = await dlP;
  const req = await ed.evaluate(() => window.__dl);
  check('save: chrome.downloads asked for Screenshots/Screenshot YYYY-MM-DD at HH.MM.SS.png (saveAs off)', !!dl && req.length === 1 && /^Screenshots\/Screenshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/.test(req[0].filename) && req[0].saveAs === false && req[0].url === 'blob:', JSON.stringify(req));
  // keyboard shortcuts: Ctrl+Shift+C copies, Escape with changes asks first
  await ed.keyboard.press('Control+Shift+C'); await sleep(300);
  check('shortcut: Ctrl+Shift+C copies', await ed.locator('[data-testid=capture-toast]').count() >= 1);
  await ed.locator('[data-testid=annotate-stage]').focus();
  await ed.keyboard.press('Escape'); await sleep(100); await ed.keyboard.press('Escape'); await sleep(200);
  check('Escape with unsaved annotations asks "Discard changes?"', await ed.locator('[data-testid=capture-dialog]').count() === 1);
  await ed.locator('[data-testid=annotate-keep]').click();
  check('Keep editing closes the dialog and keeps the editor', await ed.locator('[data-testid=capture-dialog]').count() === 0 && !ed.isClosed());
  // drag-out handle publishes the PNG as DownloadURL
  const du = await ed.evaluate(() => new Promise((res) => { const h = document.querySelector('[data-testid=capture-drag]'); h.addEventListener('dragstart', (e) => setTimeout(() => res(e.dataTransfer.getData('DownloadURL')), 0), { once: true }); h.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })); }));
  check('drag-out: DownloadURL = image/png:<Screenshot name>:blob:', /^image\/png:Screenshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png:blob:/.test(du), du.slice(0, 90));
  await ed.close();
}

// ------------------------------------------------------------------ full page (fixed header appears once)
{
  await page.goto(`${SITE}/long`); await page.waitForLoadState('load'); await page.bringToFront();
  await page.evaluate(() => scrollTo(0, 300));
  const n0 = (await list()).length;
  const t0 = Date.now();
  await send({ cmd: 'captureStart', mode: 'full', windowId: mainWin });
  const secs = (Date.now() - t0) / 1000;
  const cap = await freshAfter(n0);
  check('full page: stored with the document height (3000 px) and width', cap && cap.mode === 'full' && cap.height === 3000 && cap.width === VW, JSON.stringify(cap && [cap.width, cap.height]));
  check('full page: ≥ 550 ms between captures (5 frames take ≥ 2.2 s)', secs >= 2.2, secs.toFixed(1) + 's');
  { const d = await helper.evaluate(async (id) => { const { getBlob } = await import('/capture/common.js'); const b = await getBlob(id); const a = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }, cap.id); fs.writeFileSync(path.join(SHOTS, 'capture-fullpage.png'), Buffer.from(d, 'base64')); }
  const ys = [25, VH + 25, 1250, 1900, 2990, VH, 2 * VH, 3 * VH, 3000 - VH + 10];
  const px = await pixels(cap.id, ys.map((y) => [500, y]), 500);
  check('full page: header visible at the top', near(px.pts[0], '#ff0000'));
  check('full page: header NOT repeated (only the first 50 px column is red)', px.red >= 45 && px.red <= 55, 'red rows: ' + px.red);
  check('full page: bands stitched in order without gaps (seams at every viewport boundary)', ys.slice(1).every((y, i) => near(px.pts[i + 1], BANDS[Math.floor(y / 500)])), JSON.stringify(ys.slice(1).map((y, i) => [y, px.pts[i + 1]])));
  check('full page: scroll position restored and page styles removed', await page.evaluate(() => scrollY) === 300 && await page.locator('[data-sb-cap-hide]').count() === 0 && await page.locator('style[data-sb-cap-style]').count() === 0 && await page.locator('[data-sb-cap-ui]').count() === 1);
  const edFull = await waitEditor(cap.id);
  check('full page: opens the editor with the tall picture', !!edFull);
  if (edFull) { await edFull.waitForSelector('[data-testid=annotate-stage]'); await sleep(300); await edFull.screenshot({ path: path.join(SHOTS, 'capture-editor-fullpage.png') }); }
  await closeEditors();
  // cancel
  const n1 = (await list()).length;
  const run = send({ cmd: 'captureStart', mode: 'full', windowId: mainWin });
  await page.waitForSelector('[data-testid=capture-pill]', { state: 'attached', timeout: 5000 }).catch(() => {});
  const pillText = await page.locator('[data-testid=capture-pill]').textContent().catch(() => '');
  await sleep(500);
  await send({ cmd: 'captureCancel' });
  const rr = await run;
  check('full page: progress pill says "Capturing… Esc to cancel"', /Capturing….*Esc to cancel/.test(pillText), pillText);
  check('full page: cancel stops, restores scroll, stores nothing', rr && rr.ok === false && (await list()).length === n1 && await page.evaluate(() => scrollY) === 300 && await page.locator('[data-sb-cap-hide]').count() === 0 && await page.locator('[data-testid=capture-pill]').count() === 0, JSON.stringify(rr));
}

// ------------------------------------------------------------------ very tall page: capped at 20 000 CSS px, noted in the editor
{
  await page.goto(`${SITE}/tall`); await page.bringToFront();
  const n0 = (await list()).length;
  await send({ cmd: 'captureStart', mode: 'full', windowId: mainWin });
  const cap = await freshAfter(n0);
  check('tall page: capture capped at 20 000 px with a note', cap && cap.height === 20000 && /first 20000 px/.test(cap.note), JSON.stringify(cap && [cap.height, cap.note]));
  const ed = await waitEditor(cap.id);
  await ed.waitForSelector('[data-testid=capture-status]');
  check('tall page: the editor notes that it was capped', /first 20000 px/.test(await ed.locator('[data-testid=capture-status]').textContent()));
  await ed.close();
}

// ------------------------------------------------------------------ region (drive the overlay with the mouse)
{
  await page.goto(`${SITE}/plain`); await page.bringToFront();
  const n0 = (await list()).length;
  const started = send({ cmd: 'captureStart', mode: 'region', windowId: mainWin });
  await page.waitForSelector('[data-testid=capture-region-overlay]', { timeout: 8000 });
  await started;
  const frozenOk = await page.evaluate(([vw, vh]) => { const o = document.querySelector('[data-sb-cap-ui]').shadowRoot.querySelector('.frozen'); return o.complete && o.naturalWidth === vw && o.naturalHeight === vh; }, [VW, VH]);
  check('region: frozen visible-area image fills the viewport under a dim layer', frozenOk);
  await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(300, 200, { steps: 4 }); await page.mouse.move(500, 400, { steps: 4 });
  const label = await page.locator('[data-testid=capture-region-label]').textContent();
  check('region: live W×H label while dragging', label === '400 × 300', label);
  await page.mouse.up();
  await page.screenshot({ path: path.join(SHOTS, 'capture-region-overlay.png') });
  // adjust with a handle: drag the south-east handle by +20, +10
  const h = await page.locator('[data-h=se]').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down(); await page.mouse.move(h.x + h.width / 2 + 20, h.y + h.height / 2 + 10, { steps: 3 }); await page.mouse.up();
  check('region: handles adjust the selection', await page.locator('[data-testid=capture-region-label]').textContent() === '420 × 310');
  // move with Space held while drawing is covered by drag-inside move: drag inside by (+30,+20)
  await page.mouse.move(250, 250); await page.mouse.down(); await page.mouse.move(280, 270, { steps: 3 }); await page.mouse.up();
  check('region: dragging inside moves the selection (size unchanged)', await page.locator('[data-testid=capture-region-label]').textContent() === '420 × 310');
  // Space while drawing moves the whole selection
  await page.mouse.move(600, 100); await page.mouse.down(); await page.mouse.move(700, 180, { steps: 3 });
  await page.keyboard.down('Space'); await page.mouse.move(760, 230, { steps: 3 }); await page.keyboard.up('Space'); await page.mouse.up();
  const sp = await page.evaluate(() => { const b = document.querySelector('[data-sb-cap-ui]').shadowRoot.querySelector('.sel'); return [b.style.left, b.style.top, b.style.width, b.style.height]; });
  check('region: Space-drag moves the selection without resizing it', sp.join() === '660px,150px,100px,80px', sp.join());
  // restore the 420 x 310 selection used below
  await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(520, 410, { steps: 4 }); await page.mouse.up();
  check('region: a new drag replaces the selection', await page.locator('[data-testid=capture-region-label]').textContent() === '420 × 310');
  await page.keyboard.press('Enter');
  const cap = await freshAfter(n0);
  check('region: Enter crops the frozen image to the selection', cap && cap.mode === 'region' && cap.width === 420 && cap.height === 310, JSON.stringify(cap && [cap.width, cap.height]));
  const px = await pixels(cap.id, [[300, 200]]);
  check('region: cropped pixels come from the selected area (box colour #e8e8ff at crop (300,200))', near(px.pts[0], '#e8e8ff', 4), JSON.stringify(px.pts));
  check('region: overlay removed after confirming', await page.locator('[data-testid=capture-region-overlay]').count() === 0);
  await closeEditors();
  // Escape cancels; double-click confirms
  const n1 = (await list()).length;
  await send({ cmd: 'captureStart', mode: 'region', windowId: mainWin });
  await page.waitForSelector('[data-testid=capture-region-overlay]');
  await page.mouse.move(50, 50); await page.mouse.down(); await page.mouse.move(150, 150, { steps: 3 }); await page.mouse.up();
  check('region: overlay shows a Cancel button (keyboard focus may still be in the side panel)', await page.locator('[data-testid=capture-region-cancel]').count() === 1);
  await page.keyboard.press('Escape'); await sleep(500);
  check('region: Escape cancels (nothing stored, overlay gone)', (await list()).length === n1 && await page.locator('[data-testid=capture-region-overlay]').count() === 0);
  await send({ cmd: 'captureStart', mode: 'region', windowId: mainWin });
  await page.waitForSelector('[data-testid=capture-region-overlay]');
  await page.mouse.move(50, 50); await page.mouse.down(); await page.mouse.move(250, 150, { steps: 3 }); await page.mouse.up();
  await page.mouse.dblclick(150, 100);
  const c2 = await freshAfter(n1);
  check('region: double-click confirms', c2 && c2.width === 200 && c2.height === 100, JSON.stringify(c2 && [c2.width, c2.height]));
  await closeEditors();
  const n2 = (await list()).length;
  await send({ cmd: 'captureStart', mode: 'region', windowId: mainWin });
  await page.waitForSelector('[data-testid=capture-region-overlay]');
  await page.locator('[data-testid=capture-region-cancel]').click(); await sleep(400);
  check('region: Cancel button cancels', (await list()).length === n2 && await page.locator('[data-testid=capture-region-overlay]').count() === 0);
}

// ------------------------------------------------------------------ pages where capture is not allowed
{
  const w2 = await sw.evaluate(async () => (await chrome.windows.create({ url: 'chrome://version', focused: true })).id);
  await sleep(600);
  const r = await send({ cmd: 'captureStart', mode: 'visible', windowId: w2 });
  check("unsupported page: \"Screenshots aren't available on this page\"", r && r.ok === false && /Screenshots aren.t available on this page/.test(r.error), JSON.stringify(r));
  const t = await sw.evaluate(async () => (await chrome.storage.session.get('capToast')).capToast);
  check('unsupported page: toast event published for the side panel', t && /aren.t available/.test(t.text));
  await sw.evaluate((id) => chrome.windows.remove(id), w2);
  await page.bringToFront();
}

// ------------------------------------------------------------------ side panel: camera button, menu, recent captures
const panelWinId = await sw.evaluate(async (u) => (await chrome.windows.create({ url: u, focused: false })).id, `${SITE}/plain`);
await sleep(500);
const panel = await ctx.newPage();
await panel.setViewportSize({ width: 380, height: 760 });
await panel.goto(`chrome-extension://${extId}/sidepanel.html?windowId=${panelWinId}`);
await panel.waitForSelector('[data-testid=address-field]');
{
  check('side panel: camera button sits in the footer next to Boost', await panel.locator('#footer [data-testid=capture-button]').count() === 1 && await panel.locator('#footer [data-testid=boost-button]').count() === 1 && await panel.locator('.addr-row [data-testid=capture-button]').count() === 0);
  await panel.locator('[data-testid=capture-button]').click();
  const items = await panel.locator('[data-testid=context-menu-item]').allTextContents();
  check('camera menu: Visible area / Full page / Region / Recent captures', items.length === 4 && /Visible/.test(items[0]) && /Full/.test(items[1]) && /Region/.test(items[2]) && /Recent/.test(items[3]), JSON.stringify(items));
  await sleep(300); await panel.screenshot({ path: path.join(SHOTS, 'capture-menu.png') });
  const n0 = (await list()).length;
  await setSync({ captureAfter: 'editor' });
  await panel.locator('[data-action=capture-visible]').click();
  const cap = await freshAfter(n0);
  check('camera menu → Visible area captures the window the panel belongs to', cap && cap.url.startsWith(SITE) && cap.title === 'Plain page');
  await closeEditors();
  // Recent captures view
  await panel.locator('[data-testid=capture-button]').click();
  await panel.locator('[data-action=capture-recent]').click();
  await panel.waitForSelector('[data-testid=capture-recent-view]');
  const rows = await panel.locator('[data-testid=capture-recent-item]').count();
  check('recent captures: lists stored captures with thumbnails', rows === (await list()).length && rows >= 4 && await panel.locator('[data-testid=capture-recent-item] img').first().evaluate((i) => i.complete && i.naturalWidth > 0), String(rows));
  await panel.screenshot({ path: path.join(SHOTS, 'capture-recent.png') });
  await panel.locator('[data-testid=capture-recent-item] .cap-open').first().click();
  check('recent captures: clicking reopens the editor', !!(await waitEditor(null, 5000)));
  await closeEditors();
  const del0 = (await list()).length;
  await panel.locator('[data-testid=capture-recent-item]').first().hover();
  await panel.locator('[data-testid=capture-recent-delete]').first().click();
  await sleep(400);
  check('recent captures: delete removes one', (await list()).length === del0 - 1);
  await panel.locator('[data-testid=captures-view] [data-testid=back-button]').click();
  check('recent captures: back returns to the main view', await panel.locator('[data-testid=view-main]').isVisible());
  // the unsupported-page toast shows in the panel
  const w3 = await sw.evaluate(async () => (await chrome.windows.create({ url: 'chrome://version', focused: false })).id);
  await sleep(500);
  const panel2 = await ctx.newPage();
  await panel2.goto(`chrome-extension://${extId}/sidepanel.html?windowId=${w3}`); await panel2.waitForSelector('[data-testid=capture-button]');
  await panel2.locator('[data-testid=capture-button]').click(); await panel2.locator('[data-action=capture-visible]').click();
  await panel2.waitForSelector('[data-testid=toast]');
  check('side panel shows the "not available" toast', /aren.t available/.test(await panel2.locator('[data-testid=toast]').first().textContent()));
  await panel2.close(); await sw.evaluate((id) => chrome.windows.remove(id), w3);
}

// ------------------------------------------------------------------ settings (persistence, validation, test connection)
{
  const openShots = async () => {
    const pg = await ctx.newPage(); await pg.setViewportSize({ width: 860, height: 700 });
    await pg.goto(`chrome-extension://${extId}/settings.html#screenshots`);
    await pg.waitForSelector('[data-testid=capture-settings]');
    return pg;
  };
  // migration: a v2.9 config with a provider preset loses `provider`/`preset`, keeps its values, and is persisted again
  await helper.evaluate(() => chrome.storage.local.set({ captureS3: { provider: 'r2', preset: 'r2', endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'old', accessKeyId: 'AK', secretAccessKey: 'SK', style: 'path', prefix: 'p/', naming: 'random', linkType: 'public', publicBase: 'https://x/', expiry: 3600 } }));
  const mig = await helper.evaluate(async () => { const m = await import(chrome.runtime.getURL('capture/common.js')); const c = await m.getS3Config(); return { c, stored: (await chrome.storage.local.get('captureS3')).captureS3 }; });
  check('S3 migration: provider/preset dropped, bucket + keys kept, stored again without them', !('provider' in mig.c) && !('preset' in mig.c) && mig.c.bucket === 'old' && mig.c.accessKeyId === 'AK' && !('provider' in mig.stored) && !('preset' in mig.stored), JSON.stringify(mig.stored));
  const regs = await helper.evaluate(async () => { const m = await import(chrome.runtime.getURL('capture/s3.js')); return ['https://x.r2.cloudflarestorage.com', 'https://s3.eu-west-2.amazonaws.com', 'https://nyc3.digitaloceanspaces.com', 'https://s3.us-west-004.backblazeb2.com', 'https://s3.eu-central-1.wasabisys.com', 'http://127.0.0.1:9000'].map((e) => m.regionFromEndpoint(e)); });
  check('S3 region auto-detect: R2 auto, AWS, DigitalOcean, Backblaze, Wasabi; unknown host gives none', JSON.stringify(regs) === JSON.stringify(['auto', 'eu-west-2', 'nyc3', 'us-west-004', 'eu-central-1', null]), JSON.stringify(regs));
  await helper.evaluate(() => chrome.storage.local.remove('captureS3'));
  let sp = await openShots();
  check('settings: defaults — editor / annotation on / ask-where off', await sp.locator('[data-testid=capture-after]').inputValue() === 'editor' && await sp.locator('[data-testid=capture-annotate]').isChecked() && !(await sp.locator('[data-testid=capture-ask-where]').isChecked()));
  await sp.locator('[data-testid=capture-after]').selectOption('thumbnail');
  await sp.locator('[data-testid=capture-annotate]').uncheck();
  await sp.locator('[data-testid=capture-ask-where]').check();
  const sync = await helper.evaluate(() => chrome.storage.sync.get(['captureAfter', 'captureAnnotate', 'captureAskWhere']));
  check('settings: stored in storage.sync (captureAfter, captureAnnotate, captureAskWhere)', sync.captureAfter === 'thumbnail' && sync.captureAnnotate === false && sync.captureAskWhere === true, JSON.stringify(sync));
  check('settings: no provider presets', await sp.locator('[data-testid=capture-s3-preset]').count() === 0);
  await sp.locator('[data-testid=capture-s3-endpoint]').fill('https://abc.r2.cloudflarestorage.com');
  check('settings: R2 endpoint auto-fills region "auto"', await sp.locator('[data-testid=capture-s3-region]').inputValue() === 'auto');
  await sp.locator('[data-testid=capture-s3-endpoint]').fill('https://s3.eu-west-2.amazonaws.com');
  check('settings: AWS endpoint auto-fills its region', await sp.locator('[data-testid=capture-s3-region]').inputValue() === 'eu-west-2');
  await sp.locator('[data-testid=capture-s3-endpoint]').fill('https://nyc3.digitaloceanspaces.com');
  check('settings: DigitalOcean endpoint auto-fills nyc3', await sp.locator('[data-testid=capture-s3-region]').inputValue() === 'nyc3');
  await sp.locator('[data-testid=capture-s3-advanced]').click();
  check('settings: Addressing sits under Advanced (automatic by default)', await sp.locator('[data-testid=capture-s3-style]').inputValue() === 'auto');
  const fill = async (t, v) => { await sp.locator(`[data-testid=${t}]`).fill(v); };
  await fill('capture-s3-endpoint', S3URL); await fill('capture-s3-region', 'us-east-1'); await fill('capture-s3-bucket', 'shots');
  await fill('capture-s3-key', CREDS.accessKeyId); await fill('capture-s3-secret', 'wrong-secret'); await fill('capture-s3-prefix', 'screenshots/{yyyy}/{mm}/');
  await sp.locator('[data-testid=capture-s3-linktype]').selectOption('public'); await fill('capture-s3-base', `${S3URL}/shots/`);
  await sp.screenshot({ path: path.join(SHOTS, 'capture-settings-top.png') });
  await sp.locator('[data-testid=capture-s3-test]').click();
  await sp.waitForFunction(() => /Signature|match|Connected|Could not/i.test(document.querySelector('[data-testid=capture-s3-result]').textContent), null, { timeout: 8000 });
  const bad = await sp.locator('[data-testid=capture-s3-result]').textContent();
  check('test connection: wrong secret shows the exact server error', /403/.test(bad) && /SignatureDoesNotMatch/.test(bad) && /does not match the signature/.test(bad), bad);
  await fill('capture-s3-secret', CREDS.secretAccessKey);
  store.clear(); s3log.length = 0;
  await sp.locator('[data-testid=capture-s3-test]').click();
  await sp.waitForFunction(() => /Connected/.test(document.querySelector('[data-testid=capture-s3-result]').textContent), null, { timeout: 8000 });
  check('test connection: PUT sidebar-test.txt then DELETE it (both signed correctly)', s3log.length === 2 && s3log[0].method === 'PUT' && /sidebar-test\.txt$/.test(s3log[0].path) && s3log[1].method === 'DELETE' && s3log.every((l) => l.ok) && store.size === 0, JSON.stringify(s3log));
  await sleep(400);
  await sp.close(); sp = await openShots();
  check('settings: persist across reloads (incl. S3 fields)', await sp.locator('[data-testid=capture-after]').inputValue() === 'thumbnail' && !(await sp.locator('[data-testid=capture-annotate]').isChecked()) && await sp.locator('[data-testid=capture-s3-bucket]').inputValue() === 'shots' && await sp.locator('[data-testid=capture-s3-key]').inputValue() === CREDS.accessKeyId);
  const inLocal = await helper.evaluate(() => Promise.all([chrome.storage.local.get('captureS3'), chrome.storage.sync.get('captureS3')]));
  check('credentials live in storage.local only (never sync)', !!inLocal[0].captureS3 && inLocal[0].captureS3.secretAccessKey === CREDS.secretAccessKey && !inLocal[1].captureS3);
  check('settings page says the keys stay in the browser and go only to the endpoint', /never synced/.test(await sp.locator('[data-testid=capture-upload-settings]').textContent()));
  await sp.locator('[data-testid=capture-upload-settings]').scrollIntoViewIfNeeded();
  await sp.screenshot({ path: path.join(SHOTS, 'capture-settings-upload.png') });
  await sp.locator('[data-testid=capture-s3-clear]').click(); await sleep(300);
  const cleared = await helper.evaluate(() => chrome.storage.local.get('captureS3'));
  check('Clear credentials wipes key + secret only', cleared.captureS3.accessKeyId === '' && cleared.captureS3.secretAccessKey === '' && cleared.captureS3.bucket === 'shots');
  await setS3(S3CFG); await setSync({ captureAfter: 'editor', captureAnnotate: true, captureAskWhere: false });
  await sp.close();
}

// ------------------------------------------------------------------ upload from the editor (public base URL, then presigned)
{
  await page.goto(`${SITE}/plain`); await page.bringToFront();
  const n0 = (await list()).length;
  await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
  const cap = await freshAfter(n0);
  const ed = await waitEditor(cap.id);
  await ed.waitForSelector('[data-testid=annotate-stage]');
  check('editor: Upload button appears once storage is configured', await ed.locator('[data-testid=capture-upload]').count() === 1);
  await ed.locator('[data-testid=annotate-tool-ellipse]').click(); await ed.locator('[data-testid=annotate-add]').click();
  store.clear(); s3log.length = 0;
  await ed.locator('[data-testid=capture-upload]').click();
  await ed.waitForSelector('[data-testid=capture-link]', { timeout: 10000 });
  const link = await ed.locator('[data-testid=capture-link] code').textContent();
  check('upload: PUT signed with SigV4 (verified by aws4), image/png + Cache-Control', s3log.length === 1 && s3log[0].ok && s3log[0].method === 'PUT' && s3log[0].ct === 'image/png' && /max-age/.test(s3log[0].cc || ''), JSON.stringify(s3log));
  check('upload: object stored under screenshots/YYYY/MM/<10 chars>.png', [...store.keys()].length === 1 && /^shots\/screenshots\/\d{4}\/\d\d\/[a-z0-9]{10}\.png$/.test([...store.keys()][0]), [...store.keys()].join());
  check('upload: link = public base + key', link === `${S3URL}/${[...store.keys()][0]}`, link);
  const got = await fetch(link); const buf = Buffer.from(await got.arrayBuffer());
  check('upload: fetching the returned link returns the uploaded (annotated) PNG', got.ok && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && buf.equals([...store.values()][0]));
  await page.bringToFront();
  const clipTxt = await page.evaluate(() => navigator.clipboard.readText());
  await ed.bringToFront();
  check('upload: link copied to the clipboard + "Link copied" toast + Copy link button', clipTxt === link && /Link copied/.test(await ed.locator('[data-testid=capture-toast]').first().textContent()) && await ed.locator('[data-testid=capture-copy-link]').count() === 1);
  const meta = await newest();
  check('upload: link remembered in the capture metadata', meta.link === link);
  await ed.screenshot({ path: path.join(SHOTS, 'capture-editor-uploaded.png') });
  await ed.close();
  // Recent shows a link icon
  await panel.locator('[data-testid=capture-button]').click(); await panel.locator('[data-action=capture-recent]').click();
  await panel.waitForSelector('[data-testid=capture-recent-item]');
  check('recent captures: link icon on uploaded capture', await panel.locator('[data-testid=capture-recent-link]').count() >= 1);
  await panel.locator('[data-testid=captures-view] [data-testid=back-button]').click();
  // presigned
  await setS3({ ...S3CFG, linkType: 'presigned', expiry: 3600, naming: 'timestamp' });
  const n1 = (await list()).length;
  await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
  const cap2 = await freshAfter(n1);
  const ed2 = await waitEditor(cap2.id); await ed2.waitForSelector('[data-testid=capture-upload]');
  store.clear(); s3log.length = 0;
  await ed2.locator('[data-testid=capture-upload]').click();
  await ed2.waitForSelector('[data-testid=capture-link]', { timeout: 10000 });
  const link2 = await ed2.locator('[data-testid=capture-link] code').textContent();
  check('presigned link: query-string SigV4 with X-Amz-Expires=3600', /X-Amz-Expires=3600/.test(link2) && /X-Amz-Signature=[0-9a-f]{64}/.test(link2) && /X-Amz-SignedHeaders=host/.test(link2), link2.slice(0, 160));
  check('timestamp naming: key is "Screenshot YYYY-MM-DD at HH.MM.SS.png"', /Screenshot%20\d{4}-\d\d-\d\d%20at%20\d\d\.\d\d\.\d\d\.png/.test(link2));
  const g2 = await fetch(link2);
  check('presigned link fetches the object (server verified the signature with aws4)', g2.ok && (await g2.arrayBuffer()).byteLength === [...store.values()][0].length);
  const tampered = await fetch(link2.replace(/X-Amz-Signature=(.)/, (m, c) => 'X-Amz-Signature=' + (c === '0' ? '1' : '0')));
  check('presigned link with a tampered signature is rejected', tampered.status === 403);
  await ed2.close();
  await setS3({ ...S3CFG });
}

// ------------------------------------------------------------------ thumbnail mode
{
  await setSync({ captureAfter: 'thumbnail' });
  await page.goto(`${SITE}/plain`); await page.bringToFront();
  const n0 = (await list()).length;
  await closeEditors();
  await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
  const cap = await freshAfter(n0);
  await page.waitForSelector('[data-testid=capture-card]', { timeout: 5000 });
  await sleep(300);
  check('thumbnail mode: card appears bottom-right, no editor opened', await page.locator('[data-testid=capture-card]').count() === 1 && editorPages().length === 0);
  const box = await page.locator('[data-testid=capture-card]').boundingBox();
  check('thumbnail card: bottom-right of the viewport', box.x + box.width > VW - 40 && box.y + box.height > VH - 40, JSON.stringify(box));
  check('thumbnail card: Copy, Save, Edit, Upload (configured), close', await page.locator('[data-testid=capture-card-copy]').count() === 1 && await page.locator('[data-testid=capture-card-save]').count() === 1 && await page.locator('[data-testid=capture-card-edit]').count() === 1 && await page.locator('[data-testid=capture-card-upload]').count() === 1 && await page.locator('[data-testid=capture-card-close]').count() === 1);
  await page.screenshot({ path: path.join(SHOTS, 'capture-thumbnail-card.png') });
  await page.locator('[data-testid=capture-card-copy]').click();
  await page.waitForFunction(() => /Copied/.test(document.querySelector('[data-sb-cap-ui]').shadowRoot.querySelector('.note').textContent), null, { timeout: 5000 }).catch(() => {});
  const noteTxt = await page.locator('[data-testid=capture-card-note]').textContent();
  const clip = await readClip();
  check('thumbnail card: Copy puts the PNG on the clipboard', /Copied/.test(noteTxt) && clip.t && clip.t.includes('image/png'), noteTxt + ' ' + JSON.stringify(clip));
  await sw.evaluate(() => { const o = chrome.downloads.download; self.__dl = []; chrome.downloads.download = function (a) { self.__dl.push({ filename: a.filename, saveAs: a.saveAs }); return o.apply(this, arguments); }; });
  await page.locator('[data-testid=capture-card-save]').click();
  await sleep(800);
  const req2 = await sw.evaluate(() => self.__dl);
  check('thumbnail card: Save requests Screenshots/Screenshot … .png (saveAs off by default)', req2.length === 1 && /^Screenshots\/Screenshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/.test(req2[0].filename) && req2[0].saveAs === false, JSON.stringify(req2));
  store.clear(); s3log.length = 0;
  await page.locator('[data-testid=capture-card-upload]').click();
  await page.waitForFunction(() => /Link copied/.test(document.querySelector('[data-sb-cap-ui]').shadowRoot.querySelector('.note').textContent), null, { timeout: 8000 });
  check('thumbnail card: Upload stores the object and copies the link', store.size === 1 && s3log[0].ok && (await page.evaluate(() => navigator.clipboard.readText())).startsWith(S3URL));
  // hover keeps it; it hides after ~6 s otherwise
  await page.locator('[data-testid=capture-card]').hover();
  await sleep(6800);
  check('thumbnail card: stays while hovered', await page.locator('[data-testid=capture-card]').count() === 1);
  await page.mouse.move(10, 10);
  await sleep(7000);
  check('thumbnail card: auto-hides after 6 s without hover', await page.locator('[data-testid=capture-card]').count() === 0);
  // Edit opens the editor
  await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
  await page.waitForSelector('[data-testid=capture-card]', { timeout: 5000 });
  await page.locator('[data-testid=capture-card-edit]').click();
  check('thumbnail card: Edit opens the editor', !!(await waitEditor(null, 5000)));
  await closeEditors();
}

// ------------------------------------------------------------------ copy-only mode
{
  await setSync({ captureAfter: 'copy' });
  await page.goto(`${SITE}/plain`); await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  const n0 = (await list()).length;
  await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
  const cap = await freshAfter(n0);
  await sleep(1000);
  const clip = await readClip();
  check('copy-only mode: picture copied immediately, no editor', clip.t && clip.t.includes('image/png') && editorPages().length === 0, JSON.stringify(clip));
  check('copy-only mode: toast on the page', await page.locator('.toast').count() >= 0 && /copied/i.test(await page.evaluate(() => document.querySelector('[data-sb-cap-ui]')?.shadowRoot.querySelector('.toast')?.textContent || '')));
  check('copy-only mode: capture still kept in Recent', !!cap);
}

// ------------------------------------------------------------------ "ask where to save" is honoured by the editor's Save
{
  await setSync({ captureAfter: 'editor', captureAskWhere: true });
  await page.goto(`${SITE}/plain`); await page.bringToFront();
  const n0 = (await list()).length;
  await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
  const cap = await freshAfter(n0);
  const ed = await waitEditor(cap.id); await ed.waitForSelector('[data-testid=capture-save]');
  await ed.evaluate(() => { window.__dl = []; chrome.downloads.download = (a) => { window.__dl.push({ saveAs: a.saveAs }); return Promise.resolve(1); }; });
  await ed.locator('[data-testid=capture-save]').click(); await sleep(400);
  check('ask where to save: Save passes saveAs: true', JSON.stringify(await ed.evaluate(() => window.__dl)) === '[{"saveAs":true}]');
  await ed.close(); await setSync({ captureAskWhere: false });
}

// ------------------------------------------------------------------ annotation tools off
{
  await setSync({ captureAfter: 'editor', captureAnnotate: false });
  await page.goto(`${SITE}/plain`); await page.bringToFront();
  const n0 = (await list()).length;
  await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
  const cap = await freshAfter(n0);
  const ed = await waitEditor(cap.id);
  await ed.waitForSelector('[data-testid=capture-editor]');
  check('annotation off: image only (no tools, no stage), export actions remain', await ed.locator('[data-testid=capture-plain] img').count() === 1 && await ed.locator('[data-testid^=annotate-tool-]').count() === 0 && await ed.locator('[data-testid=capture-copy]').count() === 1 && await ed.locator('[data-testid=capture-save]').count() === 1);
  await ed.locator('[data-testid=capture-copy]').click(); await ed.waitForSelector('[data-testid=capture-toast]');
  const clip = await readClip();
  check('annotation off: Copy still works', clip.size > 1000, JSON.stringify(clip));
  await ed.close();
  await setSync({ captureAnnotate: true });
}

// ------------------------------------------------------------------ store: keeps the last 30
{
  const r = await helper.evaluate(async () => {
    const { putCapture, listMeta } = await import('/capture/common.js');
    const blob = new Blob([new Uint8Array(10)], { type: 'image/png' });
    for (let i = 0; i < 34; i++) await putCapture({ id: 'bulk' + i, time: Date.now() + 1000 + i, url: '', title: 't' + i, mode: 'visible', width: 1, height: 1, dpr: 1, thumb: '', link: '' }, blob);
    const l = await listMeta();
    return { n: l.length, first: l[0].id, hasOld: l.some((m) => m.id === 'bulk0') };
  });
  check('store: only the last 30 captures are kept (older removed)', r.n === 30 && r.first === 'bulk33' && !r.hasOld, JSON.stringify(r));
  await send({ cmd: 'captureClear' });
  check('store: Clear all empties Recent', (await list()).length === 0);
}

// ------------------------------------------------------------------ editor in dark mode + screenshots
{
  await setSync({ captureAfter: 'editor', captureAnnotate: true });
  await page.goto(`${SITE}/plain`); await page.bringToFront();
  for (const theme of ['light', 'dark']) {
    const n0 = (await list()).length;
    await send({ cmd: 'captureStart', mode: 'visible', windowId: mainWin });
    const cap = await freshAfter(n0);
    const ed = (await waitEditor(cap.id));
    await ed.goto(`chrome-extension://${extId}/capture/capture.html?id=${cap.id}&theme=${theme}`);
    await ed.setViewportSize({ width: 1100, height: 760 });
    await ed.waitForSelector('[data-testid=annotate-stage]');
    const add = async (tool) => { await ed.locator(`[data-testid=annotate-tool-${tool}]`).click(); await ed.locator('[data-testid=annotate-add]').click(); };
    await add('rect'); await ed.keyboard.press('ArrowRight'); for (let i = 0; i < 4; i++) await ed.keyboard.press('Shift+ArrowRight');
    await add('arrow'); for (let i = 0; i < 6; i++) await ed.keyboard.press('Shift+ArrowDown');
    await add('badge'); for (let i = 0; i < 6; i++) await ed.keyboard.press('Shift+ArrowLeft');
    await add('text'); await ed.keyboard.type('Look here'); await ed.keyboard.press('Control+Enter');
    await ed.locator('[data-testid=annotate-tool-rect]').click();
    await ed.locator('[data-testid=annotate-color-orange]').click();
    await sleep(300);
    await ed.screenshot({ path: path.join(SHOTS, `capture-editor-${theme}.png`) });
    check(`editor ${theme}: four annotations drawn, screenshot saved`, await ed.locator('[data-testid=annotate-stage] svg > g, [data-testid=annotate-stage] svg > rect, [data-testid=annotate-stage] svg > line, [data-testid=annotate-stage] svg > text').count() >= 4);
    await ed.close();
  }
}

await ctx.close();
pages.close(); s3.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
