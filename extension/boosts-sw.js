// Boosts: service-worker side. Owns storage.local.boosts and the userScripts registrations.
const KEY = 'boosts';
const HOST_RE = /^[a-z0-9._\-\[\]:]{1,253}$/;

let wq = Promise.resolve();
function enqueue(fn) {
  const run = wq.then(fn);
  wq = run.then(() => {}, () => {});
  return run;
}

const normHost = (h) => (typeof h === 'string' && HOST_RE.test(h.trim().toLowerCase()) ? h.trim().toLowerCase() : '');
const isEmpty = (b) => !b.zaps.length && !(b.css || '').trim() && !(b.js || '').trim();
const blank = () => ({ enabled: true, zaps: [], css: '', js: '', updatedAt: 0 });
function clean(b) {
  const o = Object.assign(blank(), b || {});
  if (!Array.isArray(o.zaps)) o.zaps = [];
  o.enabled = o.enabled !== false;
  o.css = typeof o.css === 'string' ? o.css : '';
  o.js = typeof o.js === 'string' ? o.js : '';
  return o;
}

async function readAll() {
  const { [KEY]: b } = await chrome.storage.local.get(KEY);
  return b && typeof b === 'object' ? b : {};
}

// Boosts are a global setting: a local edit is also pushed to Stile.app (background.js sets the hook). Boosts applied FROM
// the app are written to storage directly by background.js, so they never echo back; the storage.onChanged listener below
// re-registers the user scripts for both.
let pushHook = null;
export function setBoostPush(fn) { pushHook = fn; }
async function writeAll(all) {
  await chrome.storage.local.set({ [KEY]: all });
  if (pushHook) { try { pushHook(all); } catch { /* ignore */ } }
}

// Serialized read-modify-write of one hostname's boost. fn(boost) mutates and returns a result.
function mutate(hostname, fn) {
  return enqueue(async () => {
    const all = await readAll();
    const b = clean(all[hostname]);
    const result = fn(b);
    b.updatedAt = Date.now();
    if (isEmpty(b) && b.enabled) delete all[hostname]; else all[hostname] = b;
    await writeAll(all);
    return result;
  });
}

// ---- user scripts ----
export async function userScriptsAvailable() {
  try {
    if (!chrome.userScripts) return false;
    await chrome.userScripts.getScripts();
    return true;
  } catch { return false; }
}

let syncing = null, syncAgain = false;
function syncUserScripts() {
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    do {
      syncAgain = false;
      try {
        if (!(await userScriptsAvailable())) break;
        const all = await readAll();
        const want = new Map();
        for (const [host, raw] of Object.entries(all)) {
          const b = clean(raw);
          if (!normHost(host) || !b.enabled || !b.js.trim()) continue;
          want.set('boost-' + host, { id: 'boost-' + host, matches: [`*://${host}/*`], js: [{ code: b.js }], world: 'MAIN', runAt: 'document_idle' });
        }
        const have = new Map((await chrome.userScripts.getScripts()).filter((s) => s.id.startsWith('boost-')).map((s) => [s.id, s]));
        const drop = [...have.keys()].filter((id) => !want.has(id));
        if (drop.length) await chrome.userScripts.unregister({ ids: drop });
        const add = [], upd = [];
        for (const [id, w] of want) {
          const h = have.get(id);
          if (!h) add.push(w);
          else if ((h.js?.[0]?.code ?? '') !== w.js[0].code || (h.matches || []).join() !== w.matches.join()) upd.push(w);
        }
        for (const w of add) { try { await chrome.userScripts.register([w]); } catch (e) { console.warn('boost register', w.id, e); } }
        for (const w of upd) { try { await chrome.userScripts.update([w]); } catch (e) { console.warn('boost update', w.id, e); } }
      } catch (e) { console.warn('boost sync', e); }
    } while (syncAgain);
    syncing = null;
  })();
  return syncing;
}

export function registerBoostListeners() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) syncUserScripts();
  });
  chrome.runtime.onStartup.addListener(() => { syncUserScripts(); });
  chrome.runtime.onInstalled.addListener(() => { syncUserScripts(); });
  syncUserScripts();
}

// ---- commands ----
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export async function handleBoostCommand(msg, sender) {
  if (!msg || typeof msg.cmd !== 'string') return undefined;
  const bad = { ok: false, error: 'bad hostname' };
  try {
    switch (msg.cmd) {
      case 'getBoost': {
        const h = normHost(msg.hostname); if (!h) return bad;
        const all = await readAll();
        return { ok: true, hostname: h, boost: clean(all[h]), exists: !!all[h] };
      }
      case 'listBoosts': {
        const all = await readAll();
        return { ok: true, boosts: Object.fromEntries(Object.entries(all).map(([h, b]) => [h, clean(b)])) };
      }
      case 'saveBoost': {
        const h = normHost(msg.hostname); if (!h) return bad;
        const p = msg.patch || {};
        const boost = await mutate(h, (b) => {
          if ('enabled' in p) b.enabled = !!p.enabled;
          if ('css' in p) b.css = String(p.css ?? '');
          if ('js' in p) b.js = String(p.js ?? '');
          return JSON.parse(JSON.stringify(b));
        });
        return { ok: true, boost };
      }
      case 'addZap': {
        const h = normHost(msg.hostname); if (!h || !msg.selector) return bad;
        const zap = await mutate(h, (b) => {
          const ex = b.zaps.find((z) => z.selector === msg.selector);
          if (ex) return ex;
          const z = { id: rid(), selector: String(msg.selector), label: String(msg.label || msg.selector).slice(0, 80), createdAt: Date.now() };
          b.zaps.push(z);
          return z;
        });
        return { ok: true, zap };
      }
      case 'removeZap': {
        const h = normHost(msg.hostname); if (!h) return bad;
        await mutate(h, (b) => { b.zaps = b.zaps.filter((z) => z.id !== msg.id); });
        return { ok: true };
      }
      case 'clearZaps': {
        const h = normHost(msg.hostname); if (!h) return bad;
        await mutate(h, (b) => { b.zaps = []; });
        return { ok: true };
      }
      case 'deleteBoost': {
        const h = normHost(msg.hostname); if (!h) return bad;
        await enqueue(async () => {
          const all = await readAll();
          delete all[h];
          await writeAll(all);
        });
        return { ok: true };
      }
      case 'startZap': {
        const tabId = msg.tabId;
        await chrome.scripting.executeScript({ target: { tabId }, files: ['zap-picker.js'] });
        try {
          const t = await chrome.tabs.get(tabId);
          await chrome.windows.update(t.windowId, { focused: true });
          await chrome.tabs.update(tabId, { active: true });
        } catch {}
        return { ok: true };
      }
      case 'stopZap': {
        try { await chrome.tabs.sendMessage(msg.tabId, { cmd: 'stopZap' }); } catch {}
        return { ok: true };
      }
      case 'userScriptsStatus':
        return { ok: true, available: await userScriptsAvailable() };
      case 'getTabName': {
        const id = sender?.tab?.id;
        const { tabNames } = await chrome.storage.local.get('tabNames');
        return { ok: true, name: (id != null && tabNames?.[id]?.name) || '' };
      }
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  return undefined;
}
