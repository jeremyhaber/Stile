// Sidebar service worker. All listeners are registered synchronously at top level.
// Nothing here relies on in-memory state surviving a restart (the only module-level
// state is the live native port and its pending-request table, which die with the worker).
import { registerBoostListeners, handleBoostCommand } from './boosts-sw.js';
import { registerBridgeListeners, handleBridgeMessage, emitBridgeEvent } from './bridge-sw.js';
import { getRoots, isBlankUrl, DEFAULT_ARCHIVE_MINUTES, GROUP_COLORS, hashStr } from './shared.js';

const HOST = 'com.sidebar.helper';
const ARCHIVE_CAP = 1000;
// Feature detection: split view arrived in newer Chrome builds; tab groups need the tabGroups permission.
const SPLIT_OK = typeof chrome.tabs.createSplit === 'function';
const NONE = (chrome.tabGroups && chrome.tabGroups.TAB_GROUP_ID_NONE !== undefined) ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1;
const isGrouped = (t) => t && typeof t.groupId === 'number' && t.groupId >= 0;
const splitId = (t) => (t && typeof t.splitViewId === 'number' && t.splitViewId >= 0 ? t.splitViewId : -1);
const PROFILE_ICONS = ['picture', 'initial', 'home', 'briefcase', 'code', 'star', 'heart', 'book', 'music', 'camera', 'palette', 'rocket', 'leaf', 'coffee', 'game', 'globe', 'bolt', 'moon'];

// ---------------------------------------------------------------- write queue
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(() => fn());
  chain = run.catch((e) => console.warn('[sidebar] task failed', e));
  return run;
}

// ---------------------------------------------------------------- storage helpers
async function sget(area, key, def) {
  try {
    const o = await chrome.storage[area].get(key);
    return o[key] === undefined ? def : o[key];
  } catch { return def; }
}
const getBindings = () => sget('session', 'bindings', {});
const setBindings = (b) => chrome.storage.session.set({ bindings: b });
const getLast = () => sget('local', 'lastActive', {});
const setLast = (l) => chrome.storage.local.set({ lastActive: l });
const getArchive = () => sget('local', 'archive', []);
const setArchive = (a) => chrome.storage.local.set({ archive: a.slice(0, ARCHIVE_CAP) });

async function tabExists(id) {
  try { await chrome.tabs.get(id); return true; } catch { return false; }
}

// ---------------------------------------------------------------- v1.2: tab names (SW-owned, storage.local.tabNames)
const getTabNames = () => sget('local', 'tabNames', {});
const setTabNames = (n) => chrome.storage.local.set({ tabNames: n });

// After a browser restart tab ids change: re-attach names by exact URL (first unclaimed match).
// 'init' stashes every stored name (stale ids could collide with new tabs); 'retry' tries again while the
// session is still restoring; 'final' also drops whatever is left.
async function rematchTabNames(mode) {
  let pending = await sget('local', 'tabNamesPending', []);
  let names = await getTabNames();
  if (mode === 'init') { pending = pending.concat(Object.values(names)); names = {}; }
  if (!pending.length && mode !== 'init') return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { /* ignore */ }
  const left = [];
  for (const p of pending) {
    const t = tabs.find((x) => !names[x.id] && (x.url || x.pendingUrl) === p.url);
    if (t) names[t.id] = { name: p.name, url: p.url };
    else left.push(p);
  }
  await chrome.storage.local.set({ tabNames: names, tabNamesPending: mode === 'final' ? [] : left });
}

// ---------------------------------------------------------------- v1.2: favicon cache (SW-owned, storage.local.faviconCache)
const FAV_CAP = 1000;
const favPending = new Map();
let favTimer = null;
function favHost(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : ''; } catch { return ''; }
}
function noteFavicon(tab) {
  try {
    const f = tab && tab.favIconUrl;
    if (!f || /^chrome(-extension)?:/i.test(f)) return;
    if (/^data:/i.test(f) && f.length > 20000) return;
    const host = favHost(tab.url || tab.pendingUrl || '');
    if (!host) return;
    favPending.set(host, f);
    clearTimeout(favTimer);
    favTimer = setTimeout(() => enqueue(flushFavicons).catch(() => {}), 500);
  } catch { /* ignore */ }
}
async function flushFavicons() {
  if (!favPending.size) return;
  const batch = [...favPending];
  favPending.clear();
  const cache = await sget('local', 'faviconCache', {});
  let changed = false;
  for (const [host, f] of batch) {
    if (cache[host] === f) continue;
    delete cache[host];
    cache[host] = f;
    changed = true;
  }
  if (!changed) return;
  const keys = Object.keys(cache);
  for (let i = 0; i < keys.length - FAV_CAP; i++) delete cache[keys[i]];
  await chrome.storage.local.set({ faviconCache: cache });
}

async function setHelper(patch) {
  const cur = await sget('session', 'helper', {});
  const next = { ...cur, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  await chrome.storage.session.set({ helper: next });
}

async function archiveThreshold() {
  const sync = await sget('sync', 'archiveMinutes', null);
  if (sync !== null && sync !== undefined) return sync;
  return await sget('local', 'globalDefaultMinutes', DEFAULT_ARCHIVE_MINUTES);
}

// ---------------------------------------------------------------- bookmarks helpers
function collectLeaves(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.url) out.push(n);
    else collectLeaves(n.children, out);
  }
  return out;
}
function collectIds(node, out = new Set()) {
  if (!node) return out;
  out.add(node.id);
  for (const c of node.children || []) collectIds(c, out);
  return out;
}

async function sidebarLeaves() {
  const roots = await getRoots({ create: false });
  if (!roots) return [];
  const [fav, pin] = await Promise.all([
    chrome.bookmarks.getSubTree(roots.favourites),
    chrome.bookmarks.getSubTree(roots.pinned)
  ]);
  return [...collectLeaves(fav[0].children), ...collectLeaves(pin[0].children)];
}

// ---------------------------------------------------------------- bindings
async function rebuildBindings() {
  const leaves = await sidebarLeaves();
  const bindings = await getBindings();
  let wins = [];
  try { wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }); } catch { /* ignore */ }
  let changed = false;
  for (const w of wins) {
    const tabs = w.tabs || [];
    const used = new Set();
    for (const t of tabs) if (bindings[t.id]) used.add(bindings[t.id]);
    for (const bm of leaves) {
      if (used.has(bm.id)) continue;
      const t = tabs.find((x) => !bindings[x.id] && x.url === bm.url);
      if (t) { bindings[t.id] = bm.id; used.add(bm.id); changed = true; }
    }
  }
  if (changed) await setBindings(bindings);
}

async function pruneBindings() {
  const bindings = await getBindings();
  const keys = Object.keys(bindings);
  if (!keys.length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  const live = new Set(tabs.map((t) => String(t.id)));
  const leafIds = new Set((await sidebarLeaves()).map((b) => b.id));
  let changed = false;
  for (const k of keys) {
    if (!live.has(k) || !leafIds.has(bindings[k])) { delete bindings[k]; changed = true; }
  }
  if (changed) await setBindings(bindings);
}

async function findBoundTab(bookmarkId, windowId, bindings) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ windowId }); } catch { return null; }
  return tabs.find((t) => bindings[t.id] === bookmarkId) || null;
}

// ---------------------------------------------------------------- archive
async function addToArchive(tabs, out) {
  const entries = [];
  const now = Date.now();
  for (const t of tabs) {
    const url = t.url || t.pendingUrl || '';
    if (isBlankUrl(url)) continue;
    const e = {
      id: crypto.randomUUID(),
      url,
      title: t.title || url,
      favIconUrl: t.favIconUrl || '',
      archivedAt: now
    };
    entries.push(e);
    if (out) out.set(t.id, e);
  }
  if (!entries.length) return 0;
  const cur = await getArchive();
  await setArchive([...entries.reverse(), ...cur]);
  return entries.length;
}

async function removeTabs(ids) {
  if (!ids.length) return;
  try { await chrome.tabs.remove(ids); } catch {
    for (const id of ids) { try { await chrome.tabs.remove(id); } catch { /* gone */ } }
  }
}

async function sweep() {
  const minutes = await archiveThreshold();
  const now = Date.now();
  let tabs = [];
  let wins = [];
  try {
    tabs = await chrome.tabs.query({});
    wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  } catch { return { archived: 0, closed: 0 }; }
  const archiveGrouped = await sget('sync', 'archiveGrouped', false);
  const normal = new Set(wins.filter((w) => w.type === 'normal' && !w.incognito).map((w) => w.id));
  const bindings = await getBindings();
  const stored = await getLast();
  const last = {};
  const ids = new Set(tabs.map((t) => String(t.id)));
  for (const k of Object.keys(stored)) if (ids.has(k)) last[k] = stored[k];
  let changed = Object.keys(last).length !== Object.keys(stored).length;
  const toArchive = [];
  const toClose = [];
  for (const t of tabs) {
    if (!normal.has(t.windowId) || t.incognito) continue;
    if (last[t.id] == null) { last[t.id] = now; changed = true; continue; }
    if (!minutes || minutes < 0) continue;
    if (t.active || t.pinned || bindings[t.id] || t.audible) continue;
    if (isGrouped(t) && !archiveGrouped) continue;
    if (now - last[t.id] < minutes * 60000) continue;
    (isBlankUrl(t.url || t.pendingUrl) ? toClose : toArchive).push(t);
  }
  if (changed) await setLast(last);
  const archived = await addToArchive(toArchive);
  await removeTabs([...toArchive, ...toClose].map((t) => t.id));
  return { archived, closed: toClose.length };
}

// ---------------------------------------------------------------- native helper
let port = null;
let nextReq = 1;
const waiting = new Map();

function nreq(msg, timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('helper not connected'));
    const requestId = 'r' + nextReq++;
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('helper timed out')); }, timeout);
    waiting.set(requestId, { resolve, reject, timer });
    try { port.postMessage({ ...msg, requestId }); } catch (e) {
      clearTimeout(timer); waiting.delete(requestId); reject(e);
    }
  });
}

function failAllWaiting(err) {
  for (const [id, w] of waiting) { clearTimeout(w.timer); w.reject(err); waiting.delete(id); }
}

async function resolveProfileDir(profiles) {
  const manual = await sget('local', 'profileDir', null);
  if (manual) return manual;
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    const email = (info && info.email || '').toLowerCase();
    if (email) {
      const m = profiles.filter((p) => (p.email || '').toLowerCase() === email);
      if (m.length === 1) return m[0].dir;
    }
  } catch { /* identity unavailable */ }
  if (profiles.length === 1) return profiles[0].dir;
  return null;
}

async function handshake(p) {
  try {
    const r = await nreq({ type: 'hello', extVersion: chrome.runtime.getManifest().version });
    if (port !== p) return;
    const profiles = Array.isArray(r.profiles) ? r.profiles : [];
    if (r.settings && typeof r.settings.archiveDefaultMinutes === 'number') {
      await chrome.storage.local.set({ globalDefaultMinutes: r.settings.archiveDefaultMinutes });
    }
    const dir = await resolveProfileDir(profiles);
    await enqueue(() => setHelper({ status: 'connected', error: undefined, profiles, currentProfileDir: dir }));
    if (dir) { try { await nreq({ type: 'identify', profileDir: dir }); } catch (e) { console.warn('identify failed', e); } }
  } catch (e) {
    if (port === p) await enqueue(() => setHelper({ status: 'error', error: String(e && e.message || e) }));
  }
}

function connectHelper() {
  if (port) return;
  let p;
  try { p = chrome.runtime.connectNative(HOST); } catch (e) {
    enqueue(() => setHelper({ status: 'error', error: String(e && e.message || e) })).catch(() => {});
    return;
  }
  port = p;
  p.onMessage.addListener((m) => { try { onHelperMessage(m); } catch (e) { console.warn(e); } });
  p.onDisconnect.addListener(() => {
    const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
    if (port === p) port = null;
    // No app on the other end any more: stop forwarding bridge events.
    handleBridgeMessage({ type: 'overlayStatus', connected: false }).catch(() => {});
    failAllWaiting(new Error(msg || 'helper disconnected'));
    const notInstalled = msg === 'Specified native messaging host not found.' || /host not found/i.test(msg);
    enqueue(() => setHelper(notInstalled
      ? { status: 'not_installed', error: undefined }
      : { status: 'error', error: msg || 'Helper disconnected' })).catch(() => {});
  });
  handshake(p);
}

function onHelperMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.requestId && waiting.has(m.requestId)) {
    const w = waiting.get(m.requestId);
    waiting.delete(m.requestId);
    clearTimeout(w.timer);
    w.resolve(m);
  }
  if (m.type === 'bridge' || m.type === 'overlayStatus') handleBridgeMessage(m).catch(() => {});
  else if (m.type === 'activate') activateWindow(m.bounds).catch(() => {});
  else if (m.type === 'profiles' && Array.isArray(m.profiles)) {
    enqueue(() => setHelper({ profiles: m.profiles })).catch(() => {});
  }
  else if (m.type === 'settings' && m.settings && typeof m.settings.archiveDefaultMinutes === 'number') {
    chrome.storage.local.set({ globalDefaultMinutes: m.settings.archiveDefaultMinutes }).catch(() => {});
  }
}

async function activateWindow(bounds) {
  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch { /* none */ }
  if (!win || win.type !== 'normal') {
    try { await chrome.windows.create({ focused: true }); } catch { /* ignore */ }
    return;
  }
  const upd = async (o) => { try { await chrome.windows.update(win.id, o); } catch { /* ignore */ } };
  if (win.state === 'minimized') await upd({ state: 'normal' });
  if (bounds && typeof bounds === 'object') {
    if (bounds.state === 'maximized' || bounds.state === 'fullscreen') await upd({ state: bounds.state });
    else {
      const o = { state: 'normal' };
      for (const k of ['left', 'top', 'width', 'height']) if (Number.isFinite(bounds[k])) o[k] = Math.round(bounds[k]);
      await upd(o);
    }
  }
  await upd({ focused: true });
}

function helperConnected() {
  return !!port;
}

// ---------------------------------------------------------------- v1.2: main window, snapshots, merging
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closingWindows = new Set();   // windows whose tabs are being removed because the window is closing
const mergingWindows = new Set();   // windows we are emptying on purpose (no merge-back when they close)
let snapTimer = null;

async function liveNormalIds() {
  try {
    const ws = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return ws.filter((w) => w.type === 'normal' && !w.incognito).map((w) => w.id).sort((a, b) => a - b);
  } catch { return null; }
}

// Adds live windows that are missing from windowOrder (never removes: removal happens in windows.onRemoved,
// so a worker woken by that very event still sees the closing window).
async function seedWindowOrder() {
  const live = await liveNormalIds();
  if (!live) return;
  const order = await sget('session', 'windowOrder', []);
  const next = order.slice();
  for (const id of live) if (!next.includes(id)) next.push(id);
  if (next.length !== order.length) await chrome.storage.session.set({ windowOrder: next });
}

// Effective main window: the explicit choice if it still exists, else the oldest live window.
async function resolveMain() {
  const live = await liveNormalIds();
  if (!live) return { main: null, order: [], live: [] };
  await seedWindowOrder();
  const order = (await sget('session', 'windowOrder', [])).filter((id) => live.includes(id));
  const explicit = await sget('session', 'mainWindowId', null);
  const main = explicit != null && live.includes(explicit) ? explicit : (order[0] != null ? order[0] : null);
  if (main !== explicit) {
    if (main == null) await chrome.storage.session.remove('mainWindowId');
    else await chrome.storage.session.set({ mainWindowId: main });
  }
  return { main, order, live };
}

function scheduleSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => enqueue(rebuildSnapshot).catch(() => {}), 300);
}

async function rebuildSnapshot() {
  let wins = [];
  let groups = [];
  try { wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }); } catch { return; }
  try { if (chrome.tabGroups) groups = await chrome.tabGroups.query({}); } catch { /* ignore */ }
  const gmap = new Map(groups.map((g) => [g.id, g]));
  const old = await sget('session', 'windowSnapshots', {});
  const snaps = {};
  for (const [k, v] of Object.entries(old)) if (k !== 'groups' && Array.isArray(v)) snaps[k] = v;   // keep windows we can't see (closing)
  const used = {};
  for (const w of wins) {
    if (w.type !== 'normal' || w.incognito || closingWindows.has(w.id)) continue;
    if (mergingWindows.has(w.id)) { delete snaps[w.id]; continue; }   // v2.5: a window being emptied by a merge has no snapshot
    const list = [];
    for (const t of (w.tabs || []).slice().sort((a, b) => a.index - b.index)) {
      const url = t.url || t.pendingUrl || '';
      if (isBlankUrl(url)) continue;
      const gk = isGrouped(t) ? String(t.groupId) : null;
      if (gk) {
        const g = gmap.get(t.groupId);
        used[gk] = { title: (g && g.title) || '', color: (g && g.color) || 'grey', collapsed: !!(g && g.collapsed) };
      }
      list.push({
        id: t.id, url, title: t.title || url, pinned: !!t.pinned, favIconUrl: t.favIconUrl || '',
        groupKey: gk, splitKey: splitId(t) >= 0 ? String(splitId(t)) : null, active: !!t.active
      });
    }
    snaps[w.id] = list;
  }
  snaps.groups = { ...(old.groups || {}), ...used };
  await chrome.storage.session.set({ windowSnapshots: snaps });
}

// Remove one tab from every stored snapshot right away (it left its window on purpose).
async function dropFromSnapshot(tabId, windowId) {
  const snaps = await sget('session', 'windowSnapshots', null);
  if (!snaps) return;
  let changed = false;
  for (const [k, v] of Object.entries(snaps)) {
    if (k === 'groups' || !Array.isArray(v)) continue;
    if (windowId != null && String(windowId) !== k) continue;
    const n = v.filter((e) => e.id !== tabId);
    if (n.length !== v.length) { snaps[k] = n; changed = true; }
  }
  if (changed) await chrome.storage.session.set({ windowSnapshots: snaps });
}

async function setLastMerge(info) {
  await chrome.storage.session.set({ lastMerge: { ...info, at: Date.now() } });
}

// Bind reopened tabs to sidebar items by URL when the main window has no tab bound to that item yet.
async function bindByUrl(created, windowId) {
  const leaves = await sidebarLeaves();
  if (!leaves.length) return;
  const b = await getBindings();
  let tabs = [];
  try { tabs = await chrome.tabs.query({ windowId }); } catch { return; }
  const used = new Set();
  for (const t of tabs) if (b[t.id]) used.add(b[t.id]);
  let changed = false;
  for (const c of created) {
    if (b[c.id]) continue;
    const bm = leaves.find((l) => l.url === c.url && !used.has(l.id));
    if (bm) { b[c.id] = bm.id; used.add(bm.id); changed = true; }
  }
  if (changed) await setBindings(b);
}

// Reopen the tabs of a closed pop-out window in the main window.
async function restoreClosed(entries, groupInfo) {
  const { main, live } = await resolveMain();
  if (main == null || !live.length) return;   // Chrome is quitting
  if (entries.length === 1) {
    const e = entries[0];
    const n = await addToArchive([{ url: e.url, title: e.title, favIconUrl: e.favIconUrl }]);
    if (n) await setLastMerge({ count: n, archived: true, fromClose: true });
    return;
  }
  const created = [];
  for (const e of entries) {
    try {
      const props = { windowId: main, url: e.url, active: false };
      if (e.pinned) props.pinned = true;
      const t = await chrome.tabs.create(props);
      created.push({ id: t.id, url: e.url, e });
    } catch (err) { console.warn('[sidebar] reopen failed', e.url, err && err.message); }
  }
  if (!created.length) return;
  // groups
  if (chrome.tabGroups && typeof chrome.tabs.group === 'function') {
    const byGroup = new Map();
    for (const c of created) if (c.e.groupKey && !c.e.pinned) { if (!byGroup.has(c.e.groupKey)) byGroup.set(c.e.groupKey, []); byGroup.get(c.e.groupKey).push(c.id); }
    for (const [gk, ids] of byGroup) {
      try {
        const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: main } });
        const gi = (groupInfo && groupInfo[gk]) || {};
        const upd = {};
        if (gi.title) upd.title = gi.title;
        if (gi.color) upd.color = gi.color;
        if (gi.collapsed) upd.collapsed = true;
        if (Object.keys(upd).length) await chrome.tabGroups.update(gid, upd);
      } catch (err) { console.warn('[sidebar] regroup failed', err && err.message); }
    }
  }
  // splits
  if (SPLIT_OK) {
    const bySplit = new Map();
    for (const c of created) if (c.e.splitKey) { if (!bySplit.has(c.e.splitKey)) bySplit.set(c.e.splitKey, []); bySplit.get(c.e.splitKey).push(c.id); }
    for (const ids of bySplit.values()) {
      if (ids.length !== 2) continue;
      try { await chrome.tabs.createSplit(ids); } catch (err) { console.warn('[sidebar] resplit failed', err && err.message); }
    }
  }
  try { await bindByUrl(created, main); } catch (err) { console.warn('[sidebar] rebind failed', err && err.message); }
  await setLastMerge({ count: created.length, fromClose: true });
}

async function onWindowClosed(windowId) {
  const snaps = await sget('session', 'windowSnapshots', {});
  const entries = Array.isArray(snaps[windowId]) ? snaps[windowId] : [];
  const groupInfo = snaps.groups || {};
  if (windowId in snaps) { delete snaps[windowId]; await chrome.storage.session.set({ windowSnapshots: snaps }); }
  closingWindows.delete(windowId);
  const mergedAway = mergingWindows.delete(windowId);
  const order = await sget('session', 'windowOrder', []);
  const explicit = await sget('session', 'mainWindowId', null);
  const wasMain = explicit != null ? explicit === windowId : order[0] === windowId;
  const nextOrder = order.filter((id) => id !== windowId);
  await chrome.storage.session.set({ windowOrder: nextOrder });
  if (wasMain) {
    if (nextOrder.length) await chrome.storage.session.set({ mainWindowId: nextOrder[0] });
    else await chrome.storage.session.remove('mainWindowId');
  }
  if (wasMain || mergedAway || !entries.length) return;
  if (!(await sget('sync', 'mergeOnClose', true))) return;
  setTimeout(() => enqueue(() => restoreClosed(entries, groupInfo)).catch((e) => console.warn('[sidebar] merge back failed', e)), 1500);
}

async function dropWindowSnapshot(winId) {
  const snaps = await sget('session', 'windowSnapshots', null);
  if (!snaps || !(String(winId) in snaps)) return;
  delete snaps[winId];
  await chrome.storage.session.set({ windowSnapshots: snaps });
}

// Move every tab of `winId` into `main`, live (no reloads). Returns the number of tabs moved.
async function mergeIntoMain(winId, main) {
  let tabs = [];
  try { tabs = (await chrome.tabs.query({ windowId: winId })).sort((a, b) => a.index - b.index); } catch { return 0; }
  if (!tabs.length) return 0;
  mergingWindows.add(winId);
  setTimeout(() => mergingWindows.delete(winId), 15000);
  await dropWindowSnapshot(winId);
  const active = tabs.find((t) => t.active);
  const done = new Set();
  let moved = 0;
  const keepSplits = async (members) => {
    if (!SPLIT_OK || typeof chrome.tabs.createSplit !== 'function') return;
    const bySplit = new Map();
    for (const t of members) if (splitId(t) >= 0) { if (!bySplit.has(splitId(t))) bySplit.set(splitId(t), []); bySplit.get(splitId(t)).push(t.id); }
    for (const ids of bySplit.values()) {
      if (ids.length !== 2) continue;
      try {
        const now = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
        if (now.some((t) => splitId(t) < 0)) await chrome.tabs.createSplit(ids);
      } catch { /* ignore */ }
    }
  };
  for (const t of tabs) {
    if (done.has(t.id)) continue;
    try {
      if (isGrouped(t) && chrome.tabGroups) {
        const members = tabs.filter((x) => x.groupId === t.groupId);
        members.forEach((x) => done.add(x.id));
        await chrome.tabGroups.move(t.groupId, { windowId: main, index: -1 });
        moved += members.length;
        await keepSplits(members);
      } else {
        let members = [t];
        if (splitId(t) >= 0) members = tabs.filter((x) => splitId(x) === splitId(t) && !isGrouped(x));
        members.forEach((x) => done.add(x.id));
        await chrome.tabs.move(members.map((x) => x.id), { windowId: main, index: -1 });
        moved += members.length;
        await keepSplits(members);
      }
    } catch (e) { console.warn('[sidebar] merge move failed', e && e.message); }
  }
  await sleep(500);
  await dropWindowSnapshot(winId);
  let left = 0;
  try { left = (await chrome.tabs.query({ windowId: winId })).length; } catch { left = -1; }
  if (left === 0) { try { await chrome.windows.remove(winId); } catch { /* already gone */ } }
  try { await chrome.windows.update(main, { focused: true }); } catch { /* ignore */ }
  if (active) { try { await chrome.tabs.update(active.id, { active: true }); } catch { /* gone */ } }
  return moved;
}

// ---------------------------------------------------------------- tracking events
async function touch(ids) {
  const last = await getLast();
  const now = Date.now();
  for (const id of ids) if (id != null) last[id] = now;
  await setLast(last);
}

async function resetAllLastActive() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { /* ignore */ }
  const now = Date.now();
  const last = {};
  for (const t of tabs) last[t.id] = now;
  await setLast(last);
}

async function ensureAlarm() {
  try {
    const a = await chrome.alarms.get('archive-sweep');
    if (!a) await chrome.alarms.create('archive-sweep', { periodInMinutes: 1, delayInMinutes: 1 });
  } catch { /* ignore */ }
}

async function setupCommon() {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch { /* ignore */ }
  try { await getRoots({ create: true }); } catch (e) { console.warn('roots', e); }
  await ensureAlarm();
}

async function boot() {
  await setupCommon();
  const { bindings } = await chrome.storage.session.get('bindings');
  if (bindings === undefined) { await setBindings({}); await rebuildBindings(); }
  else await pruneBindings();
  connectHelper();
  await seedWindowOrder();
  await resolveMain();
  await rebuildSnapshot();
  try { for (const t of await chrome.tabs.query({})) noteFavicon(t); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- v1.2: undo helpers, tidy
async function undoClear(u) {
  let win = null;
  try { win = await chrome.windows.get(u.windowId); } catch { /* gone */ }
  if (!win) return { ok: false, error: 'The window is gone' };
  const arch = await getArchive();
  const byId = new Map(arch.map((e) => [e.id, e]));
  const restored = new Set();
  const created = new Map();   // groupKey -> tab ids
  for (const it of u.items.slice().sort((a, b) => a.index - b.index)) {
    try {
      let count = 0;
      try { count = (await chrome.tabs.query({ windowId: u.windowId })).length; } catch { /* ignore */ }
      const t = await chrome.tabs.create({ windowId: u.windowId, url: it.url, index: Math.min(it.index, count), active: false });
      restored.add(it.archiveId);
      if (it.groupKey) { if (!created.has(it.groupKey)) created.set(it.groupKey, []); created.get(it.groupKey).push(t.id); }
    } catch (e) { console.warn('[sidebar] undo reopen failed', it.url, e && e.message); }
  }
  if (chrome.tabGroups && typeof chrome.tabs.group === 'function') {
    for (const [gk, ids] of created) {
      try {
        const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: u.windowId } });
        const gi = (u.groups && u.groups[gk]) || {};
        const upd = {};
        if (gi.title) upd.title = gi.title;
        if (gi.color) upd.color = gi.color;
        if (gi.collapsed) upd.collapsed = true;
        if (Object.keys(upd).length) await chrome.tabGroups.update(gid, upd);
      } catch (e) { console.warn('[sidebar] undo regroup failed', e && e.message); }
    }
  }
  if (restored.size) await setArchive((await getArchive()).filter((e) => !restored.has(e.id) || !byId.has(e.id)));
  // drop the placeholder tab that Clear opened if it is still untouched
  if (u.blankId != null && restored.size) {
    try {
      const b = await chrome.tabs.get(u.blankId);
      if (isBlankUrl(b.url || b.pendingUrl)) await chrome.tabs.remove(u.blankId);
    } catch { /* gone */ }
  }
  return { ok: true, restored: restored.size };
}

async function undoTidy(u) {
  const live = [];
  for (const id of u.grouped) { if (await tabExists(id)) live.push(id); }
  if (live.length) { try { await chrome.tabs.ungroup(live); } catch (e) { console.warn('[sidebar] undo ungroup', e && e.message); } }
  const want = u.original.filter((o) => live.includes(o.id)).sort((a, b) => a.index - b.index);
  for (const o of want) {
    try { await chrome.tabs.move(o.id, { windowId: u.windowId, index: o.index }); } catch { /* gone */ }
  }
  return { ok: true, restored: live.length };
}

const TWO_PART_SUFFIXES = new Set(['co.uk', 'com.au', 'co.jp', 'com.br', 'co.nz', 'org.uk', 'ac.uk', 'gov.uk']);
const HOST_NAMES = {
  'docs.google.com': 'Google Docs', 'mail.google.com': 'Gmail', 'drive.google.com': 'Google Drive'
};
const SITE_NAMES = {
  'github.com': 'GitHub', 'youtube.com': 'YouTube', 'google.com': 'Google', 'notion.so': 'Notion', 'notion.com': 'Notion',
  'figma.com': 'Figma', 'slack.com': 'Slack', 'linear.app': 'Linear', 'atlassian.net': 'Jira / Atlassian', 'atlassian.com': 'Jira / Atlassian',
  'stackoverflow.com': 'Stack Overflow', 'reddit.com': 'Reddit', 'wikipedia.org': 'Wikipedia', 'linkedin.com': 'LinkedIn',
  'x.com': 'X / Twitter', 'twitter.com': 'X / Twitter', 'amazon.com': 'Amazon'
};

function siteOf(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  if (!host) return null;
  if (HOST_NAMES[host]) return { key: host, name: HOST_NAMES[host] };
  let key = host;
  const labels = host.split('.');
  if (!/^[\d.]+$/.test(host) && !host.includes(':') && labels.length >= 3) {
    const two = labels.slice(-2).join('.');
    key = TWO_PART_SUFFIXES.has(two) ? labels.slice(-3).join('.') : two;
  }
  if (SITE_NAMES[key]) return { key, name: SITE_NAMES[key] };
  if (/^amazon\./.test(key)) return { key, name: 'Amazon' };
  if (/^[\d.]+$/.test(key) || key.includes(':')) return { key, name: key };
  const first = key.split('.')[0] || key;
  return { key, name: first.charAt(0).toUpperCase() + first.slice(1) };
}

// ---------------------------------------------------------------- commands
const unqueued = new Set(['switchProfile', 'setGlobalArchive', 'retryHelper', 'setProfileStyle']);

const commands = {
  async ensureRoots() {
    const roots = await getRoots({ create: true });
    return { ok: !!roots, roots };
  },

  async openItem({ bookmarkId, windowId }) {
    const [bm] = await chrome.bookmarks.get(bookmarkId);
    if (!bm || !bm.url) return { ok: false, error: 'not a bookmark' };
    const bindings = await getBindings();
    const tab = await findBoundTab(bookmarkId, windowId, bindings);
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      return { ok: true, tabId: tab.id, created: false };
    }
    const t = await chrome.tabs.create({ windowId, url: bm.url, active: true });
    const b = await getBindings();
    b[t.id] = bookmarkId;
    await setBindings(b);
    return { ok: true, tabId: t.id, created: true };
  },

  async closeItem({ bookmarkId, windowId }) {
    const bindings = await getBindings();
    const tab = await findBoundTab(bookmarkId, windowId, bindings);
    if (!tab) return { ok: true, closed: false };
    await removeTabs([tab.id]);
    return { ok: true, closed: true };
  },

  async resetItem({ bookmarkId, windowId }) {
    const [bm] = await chrome.bookmarks.get(bookmarkId);
    const bindings = await getBindings();
    const tab = await findBoundTab(bookmarkId, windowId, bindings);
    if (!tab || !bm || !bm.url) return { ok: false, error: 'not open' };
    await chrome.tabs.update(tab.id, { url: bm.url });
    return { ok: true };
  },

  async pinTab({ tabId, target, parentId, index, windowId }) {
    let tab = await chrome.tabs.get(tabId);
    if (windowId != null && tab.windowId !== windowId) {
      await chrome.tabs.move(tabId, { windowId, index: -1 });
      tab = await chrome.tabs.get(tabId);
    }
    const url = tab.url || tab.pendingUrl;
    if (!url) return { ok: false, error: 'tab has no url' };
    const roots = await getRoots({ create: true });
    if (!roots) return { ok: false, error: 'no bookmark root' };
    const parent = target === 'favourites' ? roots.favourites : (parentId || roots.pinned);
    const props = { parentId: parent, title: tab.title || url, url };
    if (Number.isInteger(index) && index >= 0) props.index = index;
    const bm = await chrome.bookmarks.create(props);
    const b = await getBindings();
    b[tabId] = bm.id;
    await setBindings(b);
    return { ok: true, bookmarkId: bm.id };
  },

  async unpin({ bookmarkId }) {
    try { await chrome.bookmarks.remove(bookmarkId); } catch { await chrome.bookmarks.removeTree(bookmarkId); }
    const b = await getBindings();
    let changed = false;
    for (const k of Object.keys(b)) if (b[k] === bookmarkId) { delete b[k]; changed = true; }
    if (changed) await setBindings(b);
    return { ok: true };
  },

  async archiveTab({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    await addToArchive([tab]);
    await removeTabs([tabId]);
    return { ok: true };
  },

  async clearToday({ windowId }) {
    const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
    const bindings = await getBindings();
    const list = tabs.filter((t) => !t.pinned && !bindings[t.id]);
    if (!list.length) return { ok: true, archived: 0, closed: 0 };
    let blankId = null;
    if (list.length === tabs.length) {
      try { const nt = await chrome.tabs.create({ windowId, active: true }); blankId = nt.id; } catch (e) { console.warn('[sidebar] new tab', e && e.message); }
    }
    const groupInfo = {};
    if (chrome.tabGroups) {
      for (const t of list) {
        if (isGrouped(t) && !groupInfo[t.groupId]) {
          try { const g = await chrome.tabGroups.get(t.groupId); groupInfo[t.groupId] = { title: g.title || '', color: g.color || 'grey', collapsed: !!g.collapsed }; } catch { /* gone */ }
        }
      }
    }
    const made = new Map();
    const archived = await addToArchive(list, made);
    const items = list.map((t) => {
      const e = made.get(t.id);
      return e ? { archiveId: e.id, url: e.url, index: t.index, groupKey: isGrouped(t) ? String(t.groupId) : null } : null;
    }).filter(Boolean);
    await removeTabs(list.map((t) => t.id));
    let undoId = null;
    if (items.length) {
      undoId = crypto.randomUUID();
      await chrome.storage.session.set({ lastUndo: { id: undoId, kind: 'clear', windowId, at: Date.now(), items, groups: groupInfo, blankId } });
    }
    return { ok: true, archived, closed: list.length, undoId };
  },

  async closeTabs({ windowId, tabId, which, dryRun }) {
    const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
    const pivot = tabs.find((t) => t.id === tabId);
    if (!pivot) return { ok: false, error: 'No such tab' };
    const bindings = await getBindings();
    const mine = new Set([pivot.id]);
    if (splitId(pivot) >= 0) for (const t of tabs) if (splitId(t) === splitId(pivot)) mine.add(t.id);
    const mi = tabs.filter((t) => mine.has(t.id)).map((t) => t.index);
    const lo = Math.min(...mi);
    const hi = Math.max(...mi);
    let scope;
    if (which === 'above') scope = tabs.filter((t) => t.index < lo);
    else if (which === 'below') scope = tabs.filter((t) => t.index > hi);
    else if (which === 'others') scope = tabs.filter((t) => !mine.has(t.id));
    else if (which === 'all') scope = tabs;
    else return { ok: false, error: 'Unknown scope' };
    const list = scope.filter((t) => !t.pinned && !bindings[t.id]);
    if (dryRun) return { ok: true, closed: list.length };
    if (!list.length) return { ok: true, closed: 0 };
    if (list.length === tabs.length) {
      try { await chrome.tabs.create({ windowId, active: true }); } catch (e) { console.warn('[sidebar] new tab', e && e.message); }
    }
    await removeTabs(list.map((t) => t.id));
    return { ok: true, closed: list.length };
  },

  async undo({ id }) {
    const u = await sget('session', 'lastUndo', null);
    if (!u || (id && u.id !== id)) return { ok: false, error: 'Nothing to undo' };
    if (Date.now() - u.at > 9000) return { ok: false, error: 'Too late to undo' };
    await chrome.storage.session.remove('lastUndo');
    if (u.kind === 'clear') return await undoClear(u);
    if (u.kind === 'tidy') return await undoTidy(u);
    return { ok: false, error: 'Nothing to undo' };
  },

  async lastUndo() {
    const u = await sget('session', 'lastUndo', null);
    return { ok: true, kind: u ? u.kind : null, ...(u || {}) };
  },

  async tidyWindow({ windowId }) {
    const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
    const bindings = await getBindings();
    const sites = new Map();   // key -> { name, tabs }
    for (const t of tabs) {
      if (isGrouped(t) || t.pinned || bindings[t.id]) continue;
      const url = t.url || t.pendingUrl || '';
      if (!/^https?:\/\//i.test(url)) continue;
      const s = siteOf(url);
      if (!s) continue;
      if (!sites.has(s.key)) sites.set(s.key, { key: s.key, name: s.name, tabs: [] });
      sites.get(s.key).tabs.push(t);
    }
    const todo = [...sites.values()].filter((x) => x.tabs.length >= 2);
    if (!todo.length) return { ok: true, tidied: 0, groups: 0 };
    if (!chrome.tabGroups || typeof chrome.tabs.group !== 'function') return { ok: false, error: 'Tab groups are not available' };
    let existing = [];
    try { existing = await chrome.tabGroups.query({ windowId }); } catch { /* none */ }
    const original = tabs.map((t) => ({ id: t.id, index: t.index }));
    const grouped = [];
    let nGroups = 0;
    for (const site of todo) {
      const ids = site.tabs.map((t) => t.id);
      try {
        const ex = existing.find((g) => g.title === site.name);
        if (ex) await chrome.tabs.group({ tabIds: ids, groupId: ex.id });
        else {
          const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
          await chrome.tabGroups.update(gid, { title: site.name, color: GROUP_COLORS[hashStr(site.key) % GROUP_COLORS.length] });
          existing.push({ id: gid, title: site.name });
        }
        grouped.push(...ids);
        nGroups++;
      } catch (e) { console.warn('[sidebar] tidy group failed', site.key, e && e.message); }
    }
    if (!grouped.length) return { ok: false, error: 'Could not tidy this window' };
    const undoId = crypto.randomUUID();
    await chrome.storage.session.set({ lastUndo: { id: undoId, kind: 'tidy', windowId, at: Date.now(), grouped, original } });
    return { ok: true, tidied: grouped.length, groups: nGroups, undoId };
  },

  async restoreArchived({ id, windowId }) {
    const arch = await getArchive();
    const e = arch.find((x) => x.id === id);
    if (!e) return { ok: false, error: 'not found' };
    await chrome.tabs.create({ windowId, url: e.url, active: true });
    await setArchive((await getArchive()).filter((x) => x.id !== id));
    return { ok: true };
  },

  async deleteArchived({ id }) {
    await setArchive((await getArchive()).filter((x) => x.id !== id));
    return { ok: true };
  },

  async clearArchive() {
    await setArchive([]);
    return { ok: true };
  },

  async switchProfile({ targetDir, windowId }) {
    if (!helperConnected()) return { ok: false, error: 'helper unavailable' };
    let bounds = null;
    let state = 'normal';
    try {
      const w = await chrome.windows.get(windowId);
      state = w.state === 'maximized' || w.state === 'fullscreen' ? w.state : 'normal';
      bounds = { left: w.left, top: w.top, width: w.width, height: w.height, state };
    } catch { /* window gone */ }
    let r;
    try { r = await nreq({ type: 'switchProfile', targetDir, bounds }, 15000); } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
    if (r && r.ok && state !== 'fullscreen') {
      setTimeout(async () => {
        try { await chrome.windows.update(windowId, { state: 'minimized' }); } catch { /* ignore */ }
      }, 350);
    }
    return { ok: !!(r && r.ok), method: r && r.method, error: r && r.error };
  },

  async setProfileArchive({ minutes }) {
    await chrome.storage.sync.set({ archiveMinutes: minutes === undefined ? null : minutes });
    return { ok: true };
  },

  async setGlobalArchive({ minutes }) {
    if (!helperConnected()) return { ok: false, error: 'helper unavailable' };
    try {
      const r = await nreq({ type: 'setGlobalSettings', settings: { archiveDefaultMinutes: minutes } });
      const v = r && r.settings && r.settings.archiveDefaultMinutes;
      await chrome.storage.local.set({ globalDefaultMinutes: typeof v === 'number' ? v : minutes });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  },

  async setProfileDir({ dir }) {
    if (dir) await chrome.storage.local.set({ profileDir: dir });
    else await chrome.storage.local.remove('profileDir');
    await setHelper({ currentProfileDir: dir || null });
    if (dir && helperConnected()) { try { await nreq({ type: 'identify', profileDir: dir }); } catch { /* ignore */ } }
    return { ok: true };
  },

  async retryHelper() {
    if (port) { const p = port; port = null; try { p.disconnect(); } catch { /* ignore */ } }
    failAllWaiting(new Error('retry'));
    connectHelper();
    return { ok: true };
  },

  async runArchiveNow() {
    return { ok: true, ...(await sweep()) };
  },

  // ---- v1.1: windows, groups, split view
  async bringTab({ tabId, windowId }) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId !== windowId) {
      let ids = [tabId];
      if (splitId(tab) >= 0) {
        const sib = (await chrome.tabs.query({ windowId: tab.windowId })).filter((t) => splitId(t) === splitId(tab)).sort((a, b) => a.index - b.index);
        if (sib.length) ids = sib.map((t) => t.id);
      }
      const src = tab.windowId;
      // If it is the source window's active tab, show that window's next tab (right, else left) instead of Chrome's pick.
      try {
        const all = (await chrome.tabs.query({ windowId: src })).sort((a, b) => a.index - b.index);
        const rest = all.filter((t) => !ids.includes(t.id));
        if (!rest.length) {
          mergingWindows.add(src);   // the window closes because we emptied it: not a merge-back case
          setTimeout(() => mergingWindows.delete(src), 8000);
        } else if (all.filter((t) => ids.includes(t.id)).some((t) => t.active)) {
          const maxIdx = Math.max(...all.filter((t) => ids.includes(t.id)).map((t) => t.index));
          const minIdx = Math.min(...all.filter((t) => ids.includes(t.id)).map((t) => t.index));
          const next = rest.find((t) => t.index > maxIdx) || rest.slice().reverse().find((t) => t.index < minIdx) || rest[0];
          if (next) await chrome.tabs.update(next.id, { active: true });
        }
      } catch (e) { console.warn('[sidebar] bringTab neighbour', e && e.message); }
      await chrome.tabs.move(ids, { windowId, index: -1 });
    }
    await chrome.tabs.update(tabId, { active: true });
    await touch([tabId]);
    return { ok: true };
  },

  async goToTab({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* ignore */ }
    await chrome.tabs.update(tabId, { active: true });
    return { ok: true };
  },

  // Move one or more tabs next to a reference tab (or into a group / window).
  // group: a group id to join, or -1 to end up ungrouped.
  async placeTab({ tabIds, refTabId, where, group, windowId }) {
    const ref = refTabId != null ? await chrome.tabs.get(refTabId) : null;
    const win = ref ? ref.windowId : windowId;
    const grp = typeof group === 'number' ? group : NONE;
    let prev = ref ? ref.id : null;
    let w = where === 'before' ? 'before' : 'after';
    for (const id of tabIds) {
      let t = await chrome.tabs.get(id);
      if (t.windowId !== win) { await chrome.tabs.move(id, { windowId: win, index: -1 }); t = await chrome.tabs.get(id); }
      if (grp >= 0) {
        if (t.groupId !== grp && typeof chrome.tabs.group === 'function') await chrome.tabs.group({ tabIds: [id], groupId: grp });
      } else if (isGrouped(t) && typeof chrome.tabs.ungroup === 'function') await chrome.tabs.ungroup(id);
      if (prev != null && prev !== id) {
        const r = await chrome.tabs.get(prev);
        t = await chrome.tabs.get(id);
        let idx = w === 'before' ? r.index : r.index + 1;
        if (t.windowId === r.windowId && t.index < idx) idx -= 1;
        if (t.index !== idx) await chrome.tabs.move(id, { index: idx });
      }
      prev = id;
      w = 'after';
    }
    return { ok: true };
  },

  async placeGroup({ groupId, refTabId, where, windowId }) {
    if (!chrome.tabGroups) return { ok: false, error: 'tab groups unavailable' };
    const g = await chrome.tabGroups.get(groupId);
    let dest = windowId != null ? windowId : g.windowId;
    let idx = -1;
    if (refTabId != null) {
      const ref = await chrome.tabs.get(refTabId);
      dest = ref.windowId;
      const wt = await chrome.tabs.query({ windowId: dest });
      let start = ref.index;
      let end = ref.index;
      if (isGrouped(ref) && ref.groupId !== groupId) {
        const m = wt.filter((t) => t.groupId === ref.groupId).map((t) => t.index);
        start = Math.min(...m); end = Math.max(...m);
      }
      idx = where === 'before' ? start : end + 1;
      if (g.windowId === dest) {
        const mine = wt.filter((t) => t.groupId === groupId).map((t) => t.index);
        if (mine.length && Math.min(...mine) < idx) idx -= mine.length;
      }
    }
    const props = { index: idx };
    if (dest !== g.windowId) props.windowId = dest;
    await chrome.tabGroups.move(groupId, props);
    return { ok: true };
  },

  async moveToNewWindow({ tabId, groupId, splitViewId }) {
    if (groupId != null) {
      if (!chrome.tabGroups) return { ok: false, error: 'tab groups unavailable' };
      const win = await chrome.windows.create({ focused: true });
      const blank = win.tabs && win.tabs[0];
      try { await chrome.tabGroups.move(groupId, { windowId: win.id, index: -1 }); } catch (e) {
        return { ok: false, windowId: win.id, error: String(e && e.message || e) };
      }
      if (blank) { try { await chrome.tabs.remove(blank.id); } catch { /* ignore */ } }
      return { ok: true, windowId: win.id };
    }
    let ids = [];
    if (splitViewId != null && splitViewId >= 0) {
      const all = await chrome.tabs.query({});
      ids = all.filter((t) => splitId(t) === splitViewId).sort((a, b) => a.index - b.index).map((t) => t.id);
    } else if (tabId != null) {
      const tab = await chrome.tabs.get(tabId);
      ids = [tabId];
      if (splitId(tab) >= 0) {
        const sib = (await chrome.tabs.query({ windowId: tab.windowId })).filter((t) => splitId(t) === splitId(tab)).sort((a, b) => a.index - b.index);
        if (sib.length) ids = sib.map((t) => t.id);
      }
    }
    if (!ids.length) return { ok: false, error: 'nothing to move' };
    const win = await chrome.windows.create({ tabId: ids[0], focused: true });
    if (ids.length > 1) { try { await chrome.tabs.move(ids.slice(1), { windowId: win.id, index: -1 }); } catch { /* ignore */ } }
    return { ok: true, windowId: win.id };
  },

  async archiveGroup({ groupId }) {
    const tabs = await chrome.tabs.query({ groupId });
    const bindings = await getBindings();
    const list = tabs.filter((t) => !bindings[t.id]);
    const archived = await addToArchive(list);
    await removeTabs(list.map((t) => t.id));
    return { ok: true, archived };
  },

  async splitTabs({ tabId, bookmarkId, targetTabId }) {
    if (!SPLIT_OK) return { ok: false, error: 'Split view needs Chrome 155+' };
    try {
      const target = await chrome.tabs.get(targetTabId);
      if (bookmarkId) {
        const [bm] = await chrome.bookmarks.get(bookmarkId);
        if (!bm || !bm.url) return { ok: false, error: 'not a bookmark' };
        const bindings = await getBindings();
        let t = await findBoundTab(bookmarkId, target.windowId, bindings);
        if (!t) {
          t = await chrome.tabs.create({ windowId: target.windowId, url: bm.url, active: false });
          const b = await getBindings();
          b[t.id] = bookmarkId;
          await setBindings(b);
        }
        tabId = t.id;
      }
      if (tabId == null || tabId === targetTabId) return { ok: false, error: 'pick two different tabs' };
      for (const id of [tabId, targetTabId]) {
        const t = await chrome.tabs.get(id);
        if (splitId(t) >= 0 && typeof chrome.tabs.unsplit === 'function') { try { await chrome.tabs.unsplit(splitId(t)); } catch { /* ignore */ } }
      }
      let tab = await chrome.tabs.get(tabId);
      let tg = await chrome.tabs.get(targetTabId);
      if (tab.windowId !== tg.windowId) {
        await chrome.tabs.move(tabId, { windowId: tg.windowId, index: tg.index + 1 });
        tab = await chrome.tabs.get(tabId); tg = await chrome.tabs.get(targetTabId);
      }
      if (!!tab.pinned !== !!tg.pinned) { await chrome.tabs.update(tabId, { pinned: !!tg.pinned }); tab = await chrome.tabs.get(tabId); tg = await chrome.tabs.get(targetTabId); }
      if (isGrouped(tg)) {
        if (tab.groupId !== tg.groupId) await chrome.tabs.group({ tabIds: [tabId], groupId: tg.groupId });
      } else if (isGrouped(tab) && typeof chrome.tabs.ungroup === 'function') await chrome.tabs.ungroup(tabId);
      tab = await chrome.tabs.get(tabId); tg = await chrome.tabs.get(targetTabId);
      const want = tab.index > tg.index ? tg.index + 1 : tg.index;
      if (tab.index !== tg.index + 1) await chrome.tabs.move(tabId, { index: want });
      await chrome.tabs.createSplit([targetTabId, tabId]);
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  },

  // Swap the two halves of a split view: move the right tab before the left one. Chrome may break the split when tabs move;
  // recreate it (new left, new right) when split view is supported. `tabIds` is a fallback for hosts without splitViewId.
  async swapSplit({ splitViewId, tabIds }) {
    try {
      let pair = [];
      if (typeof splitViewId === 'number' && splitViewId >= 0) {
        const all = await chrome.tabs.query({});
        pair = all.filter((t) => splitId(t) === splitViewId);
      }
      if (pair.length < 2 && Array.isArray(tabIds) && tabIds.length === 2) {
        pair = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
      }
      if (pair.length !== 2) return { ok: false, error: 'split view not found' };
      pair.sort((a, b) => a.index - b.index);
      const [left, right] = pair;
      if (left.windowId !== right.windowId) return { ok: false, error: 'split halves are in different windows' };
      await chrome.tabs.move(right.id, { index: left.index });
      if (SPLIT_OK && typeof chrome.tabs.createSplit === 'function') {
        const now = await Promise.all([right.id, left.id].map((id) => chrome.tabs.get(id)));
        if (now.some((t) => splitId(t) < 0 || splitId(t) !== splitId(now[0]))) {
          try { await chrome.tabs.createSplit([right.id, left.id]); } catch (err) { console.warn('[sidebar] resplit failed', err && err.message); }
        }
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  },

  async setProfileStyle({ dir, style }) {
    const okColor = style && typeof style.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(style.color);
    if (!style || !PROFILE_ICONS.includes(style.icon) || !okColor) return { ok: false, error: 'invalid style' };
    const clean = { icon: style.icon, color: style.color.toLowerCase() };
    const cur = await sget('session', 'helper', {});
    if (helperConnected() && cur.status === 'connected' && dir && dir !== '__own') {
      try {
        const r = await nreq({ type: 'setProfileStyle', dir, style: clean });
        if (r && r.ok === false) return { ok: false, error: r.error || 'helper refused' };
        if (r && Array.isArray(r.profiles)) await enqueue(() => setHelper({ profiles: r.profiles }));
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
    if (!dir || dir === '__own' || dir === cur.currentProfileDir || !helperConnected()) {
      await chrome.storage.sync.set({ ownStyle: clean });
      return { ok: true };
    }
    return { ok: false, error: 'helper unavailable' };
  },

  // ---- v1.2: tab names (Arc-style rename). Empty name resets.
  async renameTab({ tabId, name }) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false, error: 'No such tab' }; }
    const names = await getTabNames();
    const v = typeof name === 'string' ? name.trim().slice(0, 200) : '';
    if (v) names[tabId] = { name: v, url: tab.url || tab.pendingUrl || '' };
    else delete names[tabId];
    await setTabNames(names);
    return { ok: true, name: v };
  },

  // ---- v1.2: main window and pop-outs
  async setMainWindow({ windowId }) {
    const live = await liveNormalIds();
    if (!live || !live.includes(windowId)) return { ok: false, error: 'No such window' };
    await seedWindowOrder();
    await chrome.storage.session.set({ mainWindowId: windowId });
    return { ok: true };
  },

  async mergeWindow({ windowId }) {
    const { main } = await resolveMain();
    if (main == null) return { ok: false, error: 'No main window' };
    if (windowId === main) return { ok: false, error: 'That is already the main window' };
    const live = await liveNormalIds();
    if (!live || !live.includes(windowId)) return { ok: false, error: 'No such window' };
    const count = await mergeIntoMain(windowId, main);
    if (count) await setLastMerge({ count, fromClose: false });
    return { ok: true, count };
  },

  async mergeAll() {
    const { main, order } = await resolveMain();
    if (main == null) return { ok: false, error: 'No main window' };
    let count = 0;
    for (const id of order) {
      if (id === main) continue;
      count += await mergeIntoMain(id, main);
    }
    if (count) await setLastMerge({ count, fromClose: false });
    return { ok: true, count };
  },

  async debugState() {
    let windows = [];
    let groups = [];
    try {
      const ws = await chrome.windows.getAll({ populate: true });
      windows = ws.map((w) => ({
        id: w.id, focused: !!w.focused, type: w.type,
        tabs: (w.tabs || []).map((t) => ({ id: t.id, url: t.url || t.pendingUrl || '', groupId: t.groupId === undefined ? -1 : t.groupId, splitViewId: t.splitViewId === undefined ? -1 : t.splitViewId, index: t.index }))
      }));
    } catch { /* ignore */ }
    try { if (chrome.tabGroups) groups = await chrome.tabGroups.query({}); } catch { /* ignore */ }
    let mainInfo = { main: null, order: [] };
    try { mainInfo = await resolveMain(); } catch { /* ignore */ }
    const snapRaw = await sget('session', 'windowSnapshots', {});
    const snapshots = {};
    for (const [k, v] of Object.entries(snapRaw)) if (k !== 'groups' && Array.isArray(v)) snapshots[k] = v.length;
    return {
      ok: true,
      mainWindowId: mainInfo.main,
      windowOrder: mainInfo.order,
      snapshots,
      windows,
      groups,
      splitSupported: SPLIT_OK,
      tabNames: await getTabNames(),
      faviconCache: await sget('local', 'faviconCache', {}),

      bindings: await getBindings(),
      lastActive: await getLast(),
      archive: await getArchive(),
      helper: await sget('session', 'helper', null),
      settings: {
        archiveMinutes: await sget('sync', 'archiveMinutes', null),
        globalDefaultMinutes: await sget('local', 'globalDefaultMinutes', DEFAULT_ARCHIVE_MINUTES),
        profileDir: await sget('local', 'profileDir', null),
        mergeOnClose: await sget('sync', 'mergeOnClose', true),
        effectiveMinutes: await archiveThreshold()
      }
    };
  }
};

// ---------------------------------------------------------------- listeners (top level, synchronous)
chrome.runtime.onInstalled.addListener(() => {
  enqueue(async () => {
    await setupCommon();
    await resetAllLastActive();
    await setBindings({});
    await rebuildBindings();
    connectHelper();
    await chrome.storage.session.remove(['windowSnapshots', 'windowOrder', 'mainWindowId', 'lastMerge']);
    await seedWindowOrder();
    await resolveMain();
    await rebuildSnapshot();
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  enqueue(async () => {
    await rematchTabNames('init');
    await setupCommon();
    await resetAllLastActive();
    await setBindings({});
    await rebuildBindings();
    connectHelper();
    await chrome.storage.session.remove(['windowSnapshots', 'windowOrder', 'mainWindowId', 'lastMerge']);
    await seedWindowOrder();
    await resolveMain();
    await rebuildSnapshot();
  }).catch(() => {});
  // Session restore may still be creating tabs; the rebuild is purely additive.
  for (const ms of [3000, 10000]) {
    setTimeout(() => enqueue(rebuildBindings).catch(() => {}), ms);
    setTimeout(() => enqueue(() => rematchTabNames(ms === 10000 ? 'final' : 'retry')).catch(() => {}), ms);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  enqueue(() => touch([tab.id])).catch(() => {});
  scheduleSnapshot();
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  enqueue(async () => {
    const abw = await sget('session', 'activeByWindow', {});
    const prev = abw[windowId];
    abw[windowId] = tabId;
    await chrome.storage.session.set({ activeByWindow: abw });
    const ids = [tabId];
    if (prev != null && prev !== tabId && await tabExists(prev)) ids.push(prev);
    await touch(ids);
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  // A tab closed on its own leaves the snapshot at once; tabs of a closing window stay in it.
  if (info && info.isWindowClosing) closingWindows.add(info.windowId);
  else { enqueue(() => dropFromSnapshot(tabId, info && info.windowId)).catch(() => {}); scheduleSnapshot(); }
  enqueue(async () => {
    const last = await getLast();
    if (tabId in last) { delete last[tabId]; await setLast(last); }
    const b = await getBindings();
    if (tabId in b) { delete b[tabId]; await setBindings(b); }
    const names = await getTabNames();
    if (tabId in names) { delete names[tabId]; await setTabNames(names); }
  }).catch(() => {});
});

// A bound tab that moves into a window which already has a tab bound to the same bookmark is unbound
// (it then shows up in Today); otherwise it keeps its binding in the new window.
chrome.tabs.onAttached.addListener((tabId, info) => {
  scheduleSnapshot();
  enqueue(async () => {
    const b = await getBindings();
    const bid = b[tabId];
    if (!bid) return;
    const tabs = await chrome.tabs.query({ windowId: info.newWindowId });
    if (tabs.some((t) => t.id !== tabId && b[t.id] === bid)) { delete b[tabId]; await setBindings(b); }
  }).catch(() => {});
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  enqueue(async () => {
    const prev = await sget('session', 'lastFocusedWindow', null);
    await chrome.storage.session.set({ lastFocusedWindow: windowId });
    const ids = [];
    for (const w of [windowId, prev]) {
      if (w == null) continue;
      try {
        const tabs = await chrome.tabs.query({ active: true, windowId: w });
        for (const t of tabs) ids.push(t.id);
      } catch { /* window closed */ }
    }
    if (ids.length) await touch(ids);
  }).catch(() => {});
});

chrome.tabs.onDetached.addListener((tabId, info) => {
  enqueue(() => dropFromSnapshot(tabId, info && info.oldWindowId)).catch(() => {});
  scheduleSnapshot();
});
chrome.tabs.onMoved.addListener(() => scheduleSnapshot());
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if ('favIconUrl' in change) noteFavicon(tab);
  if ('url' in change && change.url) {
    enqueue(async () => {
      const names = await getTabNames();
      if (names[id] && names[id].url !== change.url) { names[id] = { ...names[id], url: change.url }; await setTabNames(names); }
    }).catch(() => {});
  }
  if ('url' in change || 'title' in change || 'pinned' in change || 'groupId' in change || 'splitViewId' in change) scheduleSnapshot();
});
if (chrome.tabGroups) {
  for (const ev of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) {
    try { chrome.tabGroups[ev].addListener(() => scheduleSnapshot()); } catch { /* ignore */ }
  }
}

chrome.windows.onCreated.addListener((win) => {
  if (!win || win.type !== 'normal' || win.incognito) return;
  enqueue(async () => {
    const order = await sget('session', 'windowOrder', []);
    if (!order.includes(win.id)) await chrome.storage.session.set({ windowOrder: [...order, win.id] });
    await resolveMain();
  }).catch(() => {});
  scheduleSnapshot();
});

chrome.windows.onRemoved.addListener((windowId) => {
  enqueue(() => onWindowClosed(windowId)).catch((e) => console.warn('[sidebar] window close failed', e));
  enqueue(async () => {
    const abw = await sget('session', 'activeByWindow', {});
    if (windowId in abw) { delete abw[windowId]; await chrome.storage.session.set({ activeByWindow: abw }); }
  }).catch(() => {});
});

chrome.bookmarks.onRemoved.addListener((id, info) => {
  enqueue(async () => {
    const ids = collectIds(info && info.node ? info.node : { id });
    ids.add(id);
    const b = await getBindings();
    let changed = false;
    for (const k of Object.keys(b)) if (ids.has(b[k])) { delete b[k]; changed = true; }
    if (changed) await setBindings(b);
  }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'archive-sweep') enqueue(sweep).catch(() => {});
  // Reconnect to the Mac app if it was restarted (the connector won't relaunch it after "Quit Sidebar").
  if (alarm.name === 'helper-retry' && !port) connectHelper();
});
chrome.alarms.get('helper-retry').then((a) => { if (!a) chrome.alarms.create('helper-retry', { periodInMinutes: 1 }); }).catch(() => {});

// Runs a side-panel command (also used by the overlay bridge's sidebar.cmd). Resolves to the response object.
function dispatchCommand(msg, sender) {
  if (!msg || typeof msg.cmd !== 'string') return Promise.resolve({ ok: false, error: 'Unknown command' });
  if (!Object.prototype.hasOwnProperty.call(commands, msg.cmd)) {
    // BOOST HOOK 2: unknown commands are offered to the boost module (returns a response object, or undefined when it is not a boost command).
    return Promise.resolve(handleBoostCommand(msg, sender)).then((r) => (r === undefined ? { ok: false, error: 'Unknown command' } : r));
  }
  const fn = () => commands[msg.cmd](msg);
  return unqueued.has(msg.cmd) ? fn() : enqueue(fn);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.cmd !== 'string') return false;
  dispatchCommand(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

registerBoostListeners();
// v2.5: the app learns which window is the main one and whether merge-on-close is on (sidebar.windowRoles / sidebar.windowRolesChanged).
async function windowRoles() {
  let main = null;
  try { main = (await resolveMain()).main; } catch { /* ignore */ }
  return { mainWindowId: main, mergeOnClose: (await sget('sync', 'mergeOnClose', true)) !== false };
}
let rolesTimer = null;
let lastRoles = null;
function scheduleRolesEvent() {
  clearTimeout(rolesTimer);
  rolesTimer = setTimeout(async () => {
    try {
      const r = await windowRoles();
      const k = JSON.stringify(r);
      if (k === lastRoles) return;
      lastRoles = k;
      emitBridgeEvent('sidebar.windowRolesChanged', [r]);
    } catch { /* ignore */ }
  }, 60);
}
chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if ((area === 'session' && keys.some((k) => k === 'mainWindowId' || k === 'windowOrder')) || (area === 'sync' && keys.includes('mergeOnClose'))) scheduleRolesEvent();
});
chrome.windows.onRemoved.addListener(() => setTimeout(scheduleRolesEvent, 300));
chrome.windows.onCreated.addListener(() => setTimeout(scheduleRolesEvent, 300));

registerBridgeListeners({ dispatchCommand, windowRoles, post: (m) => { if (port) port.postMessage(m); } });

// Runs every time the worker starts (including after idle shutdown).
enqueue(boot).catch((e) => console.warn('[sidebar] boot failed', e));
