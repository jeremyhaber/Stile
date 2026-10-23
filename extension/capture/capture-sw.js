// Screenshots: capture modes, after-capture handling, recent captures, upload. Imported by background.js.
import { getCaptureSettings, getS3Config, putCapture, listMeta, getMeta, getBlob, updateMeta, removeCapture, screenshotFilename, MODE_LABEL } from './common.js';
import { s3Configured, uploadPng, testConnection } from './s3.js';

const PAGE_JS = 'capture/page.js';
const MENU_PARENT = 'sbcap';
const MENUS = [['sbcap-visible', 'Visible area', 'visible'], ['sbcap-full', 'Full page', 'full'], ['sbcap-region', 'Region', 'region']];
const SHOT_GAP = 620;                    // Chrome allows 2 captureVisibleTab calls per second
const MAX_CSS_H = 20000, MAX_SIDE = 32767, MAX_PIXELS = 268_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const incognitoStore = new Map();        // id -> { meta, blob }: private-window captures live in memory only
const frozen = new Map();                // region token -> { blob, windowId, tabId, tab, incognito, timer }
let busy = null;                         // { cancelled, tabId } while a capture runs
let lastShot = 0;

// ------------------------------------------------------------------ helpers
const tick = () => chrome.storage.session.set({ capTick: Date.now() }).catch(() => {});
const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buf) => {
    const a = new Uint8Array(buf); let s = '';
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/png'};base64,${btoa(s)}`;
  });
}
const dataUrlToBlob = (u) => fetch(u).then((r) => r.blob());

function pageOk(url) {
  if (!url) return false;
  let u; try { u = new URL(url); } catch { return false; }
  if (!['http:', 'https:', 'file:', 'ftp:'].includes(u.protocol)) return false;
  if (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) return false;
  return true;
}
const UNAVAILABLE = 'Screenshots aren’t available on this page';

function toastAll(text, tabId, windowId = null) {
  chrome.storage.session.set({ capToast: { text, n: Date.now(), windowId } }).catch(() => {});
  if (tabId != null) chrome.tabs.sendMessage(tabId, { cap: 'toast', text }).catch(() => {});
  else { try { chrome.action.setBadgeText({ text: '!' }); setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 2500); } catch { /* ignore */ } }
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [PAGE_JS] });
}
const tellTab = (tabId, m) => chrome.tabs.sendMessage(tabId, m);

async function shoot(windowId) {
  const wait = SHOT_GAP - (Date.now() - lastShot);
  if (wait > 0) await sleep(wait);
  lastShot = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function activeTab(windowId) {
  const [t] = await chrome.tabs.query({ active: true, windowId });
  return t || null;
}
async function lastFocusedNormal() {
  try { return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id; } catch { return null; }
}

async function thumbOf(bitmap) {
  const k = Math.min(1, 360 / bitmap.width, 270 / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, w, h);
  return blobToDataUrl(await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 }));
}

// ------------------------------------------------------------------ the modes
async function dprOf(tab, fallbackW) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => devicePixelRatio });
    if (r && r.result) return r.result;
  } catch { /* fall back */ }
  return tab.width && fallbackW ? fallbackW / tab.width : 1;
}

async function captureVisible(tab) {
  const blob = await dataUrlToBlob(await shoot(tab.windowId));
  return { blob, dpr: await dprOf(tab, (await createImageBitmap(blob)).width) };
}

async function captureFull(tab) {
  const tabId = tab.id;
  const m = await tellTab(tabId, { cap: 'measure' });
  if (!m || !m.ok) throw new Error(UNAVAILABLE);
  const { cw, ch, dpr } = m;
  let sh = m.sh, capped = null;
  const maxH = Math.min(MAX_CSS_H, Math.floor(MAX_SIDE / dpr), Math.floor(MAX_PIXELS / (cw * dpr * dpr)));
  if (sh > maxH) { capped = `Page is ${Math.round(sh)} px tall; captured the first ${maxH} px`; sh = maxH; }
  await tellTab(tabId, { cap: 'pill', on: true });
  const parts = [];
  let covered = 0, canvas = null, g = null, outW = 0;
  try {
    for (let y = 0, i = 0; covered < sh; i++) {
      if (busy?.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const wantY = Math.min(y, Math.max(0, m.sh - ch));   // the last frame is pulled back so it ends at the page bottom
      const r = await tellTab(tabId, { cap: 'scrollTo', y: wantY });
      const gotY = r && r.ok ? r.y : wantY;
      await tellTab(tabId, { cap: 'pillVisible', visible: false });
      let url;
      try { url = await shoot(tab.windowId); } finally { await tellTab(tabId, { cap: 'pillVisible', visible: true }).catch(() => {}); }
      if (busy?.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const bmp = await createImageBitmap(await dataUrlToBlob(url));
      if (!canvas) {
        outW = bmp.width;
        const hPx = Math.round(sh * (bmp.width / cw));
        canvas = new OffscreenCanvas(outW, Math.max(1, hPx));
        g = canvas.getContext('2d');
      }
      const k = bmp.width / cw;                    // device px per CSS px as actually captured
      const fh = bmp.height / k;                   // CSS height of what this frame really shows
      const top = Math.max(gotY, covered);         // the part of this frame that is new
      const srcY = (top - gotY) * k, destY = top * k;
      const hh = Math.min(bmp.height - srcY, canvas.height - destY);
      if (hh > 0) g.drawImage(bmp, 0, srcY, bmp.width, hh, 0, destY, bmp.width, hh);
      bmp.close?.();
      covered = Math.min(sh, gotY + fh);
      parts.push(gotY);
      if (i === 0) await tellTab(tabId, { cap: 'hideFixed' });
      if (gotY + fh >= m.sh || gotY + fh >= sh) break;
      y = gotY + fh;
    }
  } finally {
    await tellTab(tabId, { cap: 'restore' }).catch(() => {});
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, note: capped, dpr };
}

async function captureRegionStart(tab) {
  const blob = await dataUrlToBlob(await shoot(tab.windowId));
  const bmp = await createImageBitmap(blob);
  const token = rid();
  const dpr = await dprOf(tab, bmp.width);
  bmp.close?.();
  const timer = setTimeout(() => { frozen.delete(token); }, 10 * 60 * 1000);
  frozen.set(token, { blob, windowId: tab.windowId, tabId: tab.id, tab, timer, dpr });
  await tellTab(tab.id, { cap: 'region', token, dataUrl: await blobToDataUrl(blob), dpr });
  return token;
}

async function finishRegion(token, rect, vw) {
  const f = frozen.get(token);
  if (!f) return { ok: false, error: 'The selection expired' };
  clearTimeout(f.timer); frozen.delete(token);
  const bmp = await createImageBitmap(f.blob);
  const k = bmp.width / vw;
  const sx = Math.max(0, Math.round(rect.x * k)), sy = Math.max(0, Math.round(rect.y * k));
  const w = Math.max(1, Math.min(bmp.width - sx, Math.round(rect.w * k))), h = Math.max(1, Math.min(bmp.height - sy, Math.round(rect.h * k)));
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, sx, sy, w, h, 0, 0, w, h);
  bmp.close?.();
  const blob = await c.convertToBlob({ type: 'image/png' });
  await afterCapture({ blob, mode: 'region', tab: f.tab, dpr: f.dpr });
  return { ok: true };
}

// ------------------------------------------------------------------ run + after
export async function startCapture(mode, windowId) {
  if (busy) return { ok: false, error: 'A screenshot is already in progress' };
  try {
    if (windowId == null) windowId = await lastFocusedNormal();
    const tab = windowId != null ? await activeTab(windowId) : null;
    if (!tab || !pageOk(tab.url || tab.pendingUrl)) { toastAll(UNAVAILABLE, null, windowId); return { ok: false, error: UNAVAILABLE }; }
    busy = { cancelled: false, tabId: tab.id };
    try {
      if (mode === 'full' || mode === 'region') await inject(tab.id);
      let r;
      if (mode === 'full') r = await captureFull(tab);
      else if (mode === 'region') { await captureRegionStart(tab); return { ok: true, pending: true }; }
      else r = await captureVisible(tab);
      await afterCapture({ ...r, mode, tab });
      return { ok: true };
    } finally { busy = null; }
  } catch (e) {
    busy = null;
    if (e && e.cancelled) { toastAll('Screenshot cancelled', null, windowId); return { ok: false, error: 'Cancelled' }; }
    const msg = String((e && e.message) || e);
    const friendly = /cannot access|extensions gallery|permission|not allowed|chrome:\/\/|Receiving end|Frame with ID/i.test(msg) ? UNAVAILABLE : `Screenshot failed: ${msg}`;
    toastAll(friendly, null, windowId);
    return { ok: false, error: friendly };
  }
}

async function afterCapture({ blob, mode, tab, note, dpr }) {
  const bmp = await createImageBitmap(blob);
  const id = rid();
  const meta = { id, time: Date.now(), url: tab.url || '', title: tab.title || '', mode, width: bmp.width, height: bmp.height, dpr: dpr || 1, note: note || '', incognito: !!tab.incognito, link: '', thumb: await thumbOf(bmp), windowId: tab.windowId };
  bmp.close?.();
  if (tab.incognito) incognitoStore.set(id, { meta, blob }); else await putCapture(meta, blob);
  tick();
  const st = await getCaptureSettings();
  if (st.captureAfter === 'thumbnail') {
    try { await inject(tab.id); await tellTab(tab.id, { cap: 'card', id, thumb: meta.thumb, w: meta.width, h: meta.height, s3: s3Configured(await getS3Config()), note: meta.note }); return; } catch { /* fall back to the editor */ }
  } else if (st.captureAfter === 'copy') {
    if (await copyFromPage(tab.id, blob)) { toastAll('Screenshot copied', tab.id); return; }
    try { await inject(tab.id); await tellTab(tab.id, { cap: 'card', id, thumb: meta.thumb, w: meta.width, h: meta.height, s3: s3Configured(await getS3Config()), note: 'Couldn’t copy automatically. Press Copy.' }); return; } catch { /* fall back to the editor */ }
  }
  await openEditor(id);
}

async function copyFromPage(tabId, blob) {
  try {
    await inject(tabId);
    const r = await tellTab(tabId, { cap: 'copy', dataUrl: await blobToDataUrl(blob) });
    if (r && r.ok) return true;
  } catch { /* ignore */ }
  return false;
}

export async function openEditor(id, opts = {}) {
  const url = chrome.runtime.getURL(`capture/capture.html?id=${encodeURIComponent(id)}${opts.theme ? '&theme=' + opts.theme : ''}`);
  // reuse an editor window that already shows this capture
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('capture/capture.html*') }).catch(() => []);
  const ex = tabs.find((t) => new URL(t.url).searchParams.get('id') === id);
  if (ex) { await chrome.windows.update(ex.windowId, { focused: true }); return { ok: true, windowId: ex.windowId }; }
  const m = incognitoStore.get(id)?.meta;
  let w;
  try { w = await chrome.windows.create({ url, type: 'popup', width: 1000, height: 720, focused: true, incognito: !!m?.incognito }); }
  catch { w = await chrome.windows.create({ url, type: 'popup', width: 1000, height: 720, focused: true }); }
  return { ok: true, windowId: w.id };
}

// ------------------------------------------------------------------ store access (memory for private windows)
async function metaOf(id) { return incognitoStore.get(id)?.meta || getMeta(id); }
async function blobOf(id) { return incognitoStore.get(id)?.blob || getBlob(id); }

async function saveToDownloads(id) {
  const blob = await blobOf(id);
  if (!blob) return { ok: false, error: 'That screenshot is gone' };
  const askWhere = (await getCaptureSettings()).captureAskWhere;
  await chrome.downloads.download({ url: await blobToDataUrl(blob), filename: `Screenshots/${screenshotFilename(new Date())}`, saveAs: askWhere, conflictAction: 'uniquify' });
  return { ok: true };
}

async function uploadCapture(id) {
  const blob = await blobOf(id);
  if (!blob) return { ok: false, error: 'That screenshot is gone' };
  const r = await uploadPng(await getS3Config(), blob);
  await setLink(id, r.url);
  return { ok: true, url: r.url };
}
async function setLink(id, link) {
  const mem = incognitoStore.get(id);
  if (mem) mem.meta.link = link; else await updateMeta(id, { link });
  tick();
}

// ------------------------------------------------------------------ menus, shortcuts
export const captureMenuIds = [];       // exposed through debugState for tests
let menuTimer = 0;
export function createCaptureMenus() {
  if (!chrome.contextMenus) return;
  const done = () => void chrome.runtime.lastError;
  clearTimeout(menuTimer);                // several callers (boot, onInstalled, syncMenu) collapse into one rebuild
  menuTimer = setTimeout(() => {
    for (const id of [MENU_PARENT, ...MENUS.map((m) => m[0])]) chrome.contextMenus.remove(id, done);
    captureMenuIds.length = 0;
    const ctxs = ['page', 'image', 'link', 'selection'];
    chrome.contextMenus.create({ id: MENU_PARENT, title: 'Screenshot', contexts: ctxs }, () => { if (!chrome.runtime.lastError) captureMenuIds.push(MENU_PARENT); });
    for (const [id, title] of MENUS) chrome.contextMenus.create({ id, parentId: MENU_PARENT, title, contexts: ctxs }, () => { if (!chrome.runtime.lastError) captureMenuIds.push(id); });
  }, 50);
}

export function registerCaptureListeners() {
  chrome.runtime.onInstalled.addListener(() => createCaptureMenus());
  chrome.runtime.onStartup.addListener(() => createCaptureMenus());
  createCaptureMenus();
  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    const m = MENUS.find((x) => x[0] === info.menuItemId);
    if (m) startCapture(m[2], tab?.windowId);
  });
  chrome.commands?.onCommand.addListener((c) => {
    const mode = { 'capture-visible': 'visible', 'capture-full': 'full', 'capture-region': 'region' }[c];
    if (mode) startCapture(mode, null);
  });
  chrome.windows?.onRemoved.addListener(async (wid) => {
    // private captures are discarded once their editor window is gone
    for (const [id, v] of incognitoStore) {
      if (v.editorWindow === wid) incognitoStore.delete(id);
    }
  });
}

// ------------------------------------------------------------------ commands (side panel, editor, page)
export async function handleCaptureCommand(msg, sender) {
  if (!msg || typeof msg.cmd !== 'string' || !msg.cmd.startsWith('capture')) return undefined;
  try {
    switch (msg.cmd) {
      case 'captureStart': return await startCapture(msg.mode, msg.windowId);
      case 'capturePing': return { ok: true };
      case 'captureCancel': if (busy) busy.cancelled = true; return { ok: true };
      case 'captureRegionDone': return await finishRegion(msg.token, msg.rect, msg.vw);
      case 'captureRegionCancel': { const f = frozen.get(msg.token); if (f) { clearTimeout(f.timer); frozen.delete(msg.token); } return { ok: true }; }
      case 'captureList': {
        const all = [...(await listMeta()), ...[...incognitoStore.values()].map((v) => v.meta)].sort((a, b) => b.time - a.time);
        return { ok: true, captures: all, s3: s3Configured(await getS3Config()) };
      }
      case 'captureOpen': return await openEditor(msg.id, { theme: msg.theme });
      case 'captureDelete': { incognitoStore.delete(msg.id); await removeCapture(msg.id); tick(); return { ok: true }; }
      case 'captureClear': { incognitoStore.clear(); for (const m of await listMeta()) await removeCapture(m.id); tick(); return { ok: true }; }
      case 'captureImage': { const b = await blobOf(msg.id); return b ? { ok: true, dataUrl: await blobToDataUrl(b) } : { ok: false, error: 'That screenshot is gone' }; }
      case 'captureMeta': { const m = await metaOf(msg.id); return m ? { ok: true, meta: m } : { ok: false, error: 'That screenshot is gone' }; }
      case 'captureSave': return await saveToDownloads(msg.id);
      case 'captureUpload': return await uploadCapture(msg.id);
      case 'captureSetLink': await setLink(msg.id, msg.link || ''); return { ok: true };
      case 'captureDiscard': incognitoStore.delete(msg.id); return { ok: true };
      case 'captureEditorOpened': { const v = incognitoStore.get(msg.id); if (v) v.editorWindow = sender?.tab?.windowId; return { ok: true }; }
      case 'captureTestS3': try { await testConnection(msg.cfg || await getS3Config()); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  return undefined;
}
export { MODE_LABEL };
