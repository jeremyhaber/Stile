// Shared by the service worker, the editor page and the side panel: settings, filenames, the capture store.
import { DEFAULT_S3, migrateS3 } from './s3.js';

export const MAX_RECENT = 30;
export const SETTING_DEFAULTS = { captureAfter: 'editor', captureAnnotate: true, captureAskWhere: false };

export async function getCaptureSettings() {
  let s = {};
  try { s = await chrome.storage.sync.get(SETTING_DEFAULTS); } catch { /* ignore */ }
  const after = ['editor', 'thumbnail', 'copy'].includes(s.captureAfter) ? s.captureAfter : 'editor';
  return { captureAfter: after, captureAnnotate: s.captureAnnotate !== false, captureAskWhere: !!s.captureAskWhere };
}
export async function getS3Config() {
  try {
    const raw = (await chrome.storage.local.get('captureS3')).captureS3 || {};
    const { cfg, changed } = migrateS3(raw);   // v3.0: provider presets are gone; old stored settings migrate on first read
    if (changed) { try { await chrome.storage.local.set({ captureS3: cfg }); } catch { /* ignore */ } }
    return cfg;
  } catch { return { ...DEFAULT_S3 }; }
}
export async function setS3Config(patch) {
  const cur = await getS3Config();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ captureS3: next });
  return next;
}

const pad = (n) => String(n).padStart(2, '0');
/** "Screenshot 2026-10-23 at 14.03.22.png" (macOS style) */
export function screenshotFilename(d = new Date()) {
  return `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`;
}

export const MODE_LABEL = { visible: 'Visible area', full: 'Full page', region: 'Region' };

// ------------------------------------------------------------------ IndexedDB store (never synced)
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open('sidebar-captures', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('meta', { keyPath: 'id' });
      d.createObjectStore('blobs');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}
const tx = (stores, mode, fn) => db().then((d) => new Promise((resolve, reject) => {
  const t = d.transaction(stores, mode);
  let out;
  Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
  t.oncomplete = () => resolve(out);
  t.onerror = () => reject(t.error);
  t.onabort = () => reject(t.error);
}));
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function putCapture(meta, blob) {
  await tx(['meta', 'blobs'], 'readwrite', (t) => { t.objectStore('meta').put(meta); t.objectStore('blobs').put(blob, meta.id); });
  await prune();
}
export async function listMeta() {
  const all = await tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').getAll()));
  return all.sort((a, b) => b.time - a.time);
}
export async function getMeta(id) { return tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').get(id))); }
export async function getBlob(id) { return tx(['blobs'], 'readonly', (t) => req(t.objectStore('blobs').get(id))); }
export async function updateMeta(id, patch) {
  return tx(['meta'], 'readwrite', async (t) => {
    const s = t.objectStore('meta');
    const cur = await req(s.get(id));
    if (!cur) return null;
    const next = { ...cur, ...patch, id };
    s.put(next);
    return next;
  });
}
export async function removeCapture(id) {
  await tx(['meta', 'blobs'], 'readwrite', (t) => { t.objectStore('meta').delete(id); t.objectStore('blobs').delete(id); });
}
export async function prune(max = MAX_RECENT) {
  const all = await listMeta();
  for (const m of all.slice(max)) await removeCapture(m.id);
}
