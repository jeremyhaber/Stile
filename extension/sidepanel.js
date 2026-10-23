import {
  getRoots, faviconUrl, normUrl, fmtMinutes, ARCHIVE_CHOICES, DEFAULT_ARCHIVE_MINUTES,
  looksLikeUrl, toUrl, resolveStyle, onColor, PROFILE_COLORS, PROFILE_GLYPHS, GROUP_COLORS, hashStr
} from './shared.js';
import { icon } from './icons.js';
import { renderBoostView, createBoostButton, renderBoostSettings } from './boost-view.js';
import { createCaptureButton, renderCaptureRecent, renderCaptureSettings } from './capture/capture-view.js';

// Overlay mode (Sidebar.app): chrome.* is provided by bridge-shim.js and must be ready before anything touches it.
if (window.__sidebarReady) {
  try { await window.__sidebarReady; } catch (e) {
    const m = document.createElement('p');
    m.setAttribute('data-testid', 'bridge-error');
    m.style.cssText = 'padding:16px;font:13px system-ui;color:#888';
    m.textContent = 'Waiting for the Sidebar extension. Make sure it is installed and enabled in Chrome.';
    document.body.replaceChildren(m);
    throw e;
  }
}
const OVERLAY = new URLSearchParams(location.search).get('mode') === 'overlay';

// ------------------------------------------------------------------ tiny helpers
const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.length > 2 && k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}

// One background element per row: the full-width pill when expanded, a centred rounded square in the compact strip (CSS animates between them).
const rbg = () => h('span', { class: 'rbg', 'aria-hidden': 'true' });

const safe = async (p) => { try { return await p; } catch (e) { console.debug('[sidebar]', e && e.message); return undefined; } };

async function cmd(name, args = {}) {
  try { return await chrome.runtime.sendMessage({ cmd: name, ...args }); } catch (e) {
    console.debug('[sidebar] cmd failed', name, e && e.message);
    return { ok: false, error: String(e && e.message || e) };
  }
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

// Favicon chain: open tab's own icon, then the SW's per-host cache, then Chrome's _favicon (page URL, then origin;
// skipping Chrome's generic default), then a letter tile.
const probeCache = new Map();   // _favicon src -> true when it is Chrome's generic default image
let defaultFavProbe = null;
function pixelsOf(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      try {
        const w = im.naturalWidth || 32;
        const hh = im.naturalHeight || 32;
        const c = document.createElement('canvas');
        c.width = w; c.height = hh;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, w, hh).data;
        let x = 2166136261;
        let opaque = 0;
        for (let i = 0; i < d.length; i++) { x ^= d[i]; x = Math.imul(x, 16777619); if (i % 4 === 3 && d[i]) opaque++; }
        resolve({ hash: `${x >>> 0}:${w}x${hh}`, blank: opaque === 0 });
      } catch { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
}
async function isDefaultFavicon(src) {
  if (probeCache.has(src)) return probeCache.get(src);
  if (!defaultFavProbe) defaultFavProbe = pixelsOf(faviconUrl('https://example.invalid/', 32));
  const [a, d] = await Promise.all([pixelsOf(src), defaultFavProbe]);
  const res = !a || a.blank || (!!d && a.hash === d.hash);
  probeCache.set(src, res);
  return res;
}

function letterTile(host) {
  const t = h('span', { class: 'lt', 'data-testid': 'fav-letter', text: ((host || '?').replace(/^www\./, '')[0] || '?').toUpperCase() });
  t.style.setProperty('--lh', String(hashStr(host) % 360));
  return t;
}

function favEl(url, tabFav) {
  const wrap = h('span', { class: 'fav-ic' });
  const web = /^https?:/i.test(url || '');
  const host = web ? hostOf(url) : '';
  const steps = [];
  if (tabFav && /^(https?:|data:)/i.test(tabFav)) steps.push({ src: tabFav });
  const cached = host && S.favCache[host];
  if (cached) steps.push({ src: cached });
  if (url) {
    steps.push({ src: faviconUrl(url, 32), probe: web });
    if (web) {
      try { const o = new URL(url).origin + '/'; if (o !== url) steps.push({ src: faviconUrl(o, 32), probe: true }); } catch { /* ignore */ }
    }
  }
  const fallback = () => wrap.replaceChildren(host ? letterTile(host) : icon('globe'));
  if (!steps.length) { fallback(); return wrap; }
  const img = h('img', { alt: '', draggable: 'false' });
  let i = 0;
  const tryStep = () => {
    if (i >= steps.length) { fallback(); return; }
    const st = steps[i];
    if (st.probe && probeCache.get(st.src) === true) { i++; tryStep(); return; }
    const unverified = st.probe && !probeCache.has(st.src);
    img.style.visibility = unverified ? 'hidden' : '';
    img.onerror = () => { i++; tryStep(); };
    img.onload = unverified ? () => { isDefaultFavicon(st.src).then((def) => { if (def) { i++; tryStep(); } else img.style.visibility = ''; }); } : null;
    img.src = st.src;
  };
  wrap.append(img);
  tryStep();
  return wrap;
}

// Feature detection (Chromium 141 has neither split view nor, necessarily, tab groups API access).
const SPLIT_OK = typeof chrome.tabs.createSplit === 'function';
const HAS_GROUPS = !!chrome.tabGroups && typeof chrome.tabs.group === 'function';
const gidOf = (t) => (t && typeof t.groupId === 'number' && t.groupId >= 0 ? t.groupId : -1);
const sidOf = (t) => (t && typeof t.splitViewId === 'number' && t.splitViewId >= 0 ? t.splitViewId : -1);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(msg, opts = {}) {
  const el = h('div', { class: 'toast', role: 'status', 'data-testid': 'toast' }, h('span', { class: 'tmsg', text: msg }));
  if (opts.undo) {
    el.append(h('button', {
      type: 'button', class: 'toast-btn', 'data-testid': 'toast-undo', text: 'Undo',
      onclick: () => { el.remove(); opts.undo(); }
    }));
  }
  $('toast-root').append(el);
  setTimeout(() => el.remove(), opts.ms || 3800);
}

async function doUndo(id) {
  const r = await cmd('undo', { id });
  if (!r || !r.ok) toast((r && r.error) || 'Could not undo');
  else toast(r.restored ? `Restored ${plural(r.restored, 'tab')}` : 'Undone');
}

async function openSidePanelFor(windowId) {
  if (windowId == null) return;
  try { await chrome.sidePanel.open({ windowId }); } catch { /* needs a user gesture; fine */ }
}

// ------------------------------------------------------------------ state
const S = {
  windowId: null,
  tabs: [],
  bindings: {},
  lastActive: {},
  roots: null,
  favs: [],
  pinned: [],
  archive: [],
  helper: null,
  appEverConnected: false,
  overlayEnabled: true,
  archiveMinutes: null,
  globalMinutes: DEFAULT_ARCHIVE_MINUTES,
  profileDir: null,
  collapsed: {},
  collapsedWindows: {},
  archiveGrouped: false,
  ownStyle: null,
  sidebarColor: { mode: 'auto' },
  leftHintDismissed: false,
  mergeOnClose: true,
  tabNames: {},
  lockedTabs: {},
  incognito: false,
  temporary: [],
  littleIds: new Set(),
  littleStyle: 'minimal',
  littleMaxOpen: 3,
  temporaryMinutes: 360,
  pinnedReset: true,
  defaultBrowser: false,
  favCache: {},
  boundAny: new Map(),
  mainWindowId: null,
  normalCount: 1,
  lastMerge: null,
  otherWins: [],
  groups: new Map(),
  groupTabs: new Map(),
  sections: [],
  ownUnits: [],
  styleEditing: null,
  view: 'main',
  // derived
  bmMap: new Map(),
  flat: [],
  flatById: new Map(),
  boundByBm: new Map(),
  today: []
};
let seenMergeAt = 0;
let renamingId = null;
let dragging = null;
let dirty = false;
let renderTimer = null;
let loading = false;
let reloadAgain = false;
let triedEnsure = false;
let loaded = false;

// ------------------------------------------------------------------ load + derive
async function load() {
  let [tabs, wins, groups, ses, loc, syn] = await Promise.all([
    chrome.tabs.query({ windowId: S.windowId }).catch(() => []),
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }).catch(() => []),
    (chrome.tabGroups ? chrome.tabGroups.query({}).catch(() => []) : Promise.resolve([])),
    chrome.storage.session.get(['bindings', 'helper', 'mainWindowId', 'windowOrder', 'lastMerge', 'incTabNames', 'incLockedTabs', 'littleWindows']).catch(() => ({})),
    chrome.storage.local.get(['lastActive', 'archive', 'globalDefaultMinutes', 'profileDir', 'collapsed', 'collapsedWindows', 'leftHintDismissed', 'tabNames', 'lockedTabs', 'faviconCache', 'appEverConnected', 'overlayEnabled', 'temporary', 'defaultBrowser']).catch(() => ({})),
    chrome.storage.sync.get(['archiveMinutes', 'archiveGrouped', 'ownStyle', 'mergeOnClose', 'sidebarColor', 'littleStyle', 'littleMaxOpen', 'temporaryMinutes', 'pinnedResetOnRestart']).catch(() => ({}))
  ]);
  let roots = await getRoots().catch(() => null);
  if (!roots && !triedEnsure) {
    triedEnsure = true;
    await cmd('ensureRoots');
    roots = await getRoots().catch(() => null);
  }
  let favs = [];
  let pinned = [];
  if (roots) {
    try {
      favs = await chrome.bookmarks.getChildren(roots.favourites);
      pinned = (await chrome.bookmarks.getSubTree(roots.pinned))[0].children || [];
    } catch { roots = null; }
  }
  S.tabs = tabs.slice().sort((a, b) => a.index - b.index);
  // v2.6: incognito is a separate world. A panel in an incognito window lists only incognito windows, a normal one only normal windows.
  {
    let own = wins.find((w) => w.id === S.windowId);
    if (!own) own = await chrome.windows.get(S.windowId).catch(() => null);
    S.incognito = !!(own && own.incognito) || (S.tabs.length > 0 && S.tabs.every((t) => t.incognito));
  }
  const sameWorld = (w) => !!w.incognito === S.incognito;
  // v2.8: little windows (regular style are 'normal' windows) are never listed as windows of Today
  S.littleIds = new Set(Object.keys(ses.littleWindows || {}).map(Number));
  wins = wins.filter((w) => !S.littleIds.has(w.id));
  S.otherWins = wins.filter((w) => w.id !== S.windowId && w.type === 'normal' && sameWorld(w))
    .map((w) => ({ id: w.id, focused: !!w.focused, tabs: (w.tabs || []).slice().sort((a, b) => a.index - b.index) }));
  S.groups = new Map((groups || []).map((g) => [g.id, g]));
  S.groupTabs = new Map();
  for (const t of [...S.tabs, ...S.otherWins.flatMap((w) => w.tabs)]) {
    const g = gidOf(t);
    if (g >= 0) { if (!S.groupTabs.has(g)) S.groupTabs.set(g, []); S.groupTabs.get(g).push(t); }
  }
  {
    // prune collapse state of windows that no longer exist
    const live = new Set([String(S.windowId), ...S.otherWins.map((w) => String(w.id))]);
    const cw = loc.collapsedWindows || {};
    const kept = Object.fromEntries(Object.entries(cw).filter(([k]) => live.has(k)));
    S.collapsedWindows = kept;
    if (Object.keys(kept).length !== Object.keys(cw).length) chrome.storage.local.set({ collapsedWindows: kept }).catch(() => {});
  }
  S.archiveGrouped = !!syn.archiveGrouped;
  S.sidebarColor = normSidebarColor(syn.sidebarColor);
  S.mergeOnClose = syn.mergeOnClose !== false;
  S.littleStyle = syn.littleStyle === 'regular' ? 'regular' : 'minimal';
  S.littleMaxOpen = Number.isFinite(Number(syn.littleMaxOpen)) && syn.littleMaxOpen !== undefined ? Math.min(5, Math.max(1, Math.round(Number(syn.littleMaxOpen)))) : 3;
  S.temporaryMinutes = typeof syn.temporaryMinutes === 'number' && syn.temporaryMinutes >= 0 ? syn.temporaryMinutes : 360;
  S.pinnedReset = syn.pinnedResetOnRestart !== false;
  S.defaultBrowser = !!loc.defaultBrowser;
  // Temporary is per profile and never for incognito; an unused littlesearch.html window is not a link yet
  S.temporary = S.incognito ? [] : (Array.isArray(loc.temporary) ? loc.temporary : []).filter((e) => e && e.url && !isSearchUrl(e.url));
  S.normalCount = wins.filter((w) => w.type === 'normal' && sameWorld(w)).length;
  {
    const order = Array.isArray(ses.windowOrder) ? ses.windowOrder : [];
    S.mainWindowId = ses.mainWindowId != null ? ses.mainWindowId : (order[0] != null ? order[0] : null);
    const lm = ses.lastMerge || null;
    if (!loaded) seenMergeAt = lm ? lm.at : 0;
    else if (lm && lm.at > seenMergeAt) {
      seenMergeAt = lm.at;
      if (lm.fromClose && S.windowId === S.mainWindowId) {
        toast(lm.archived ? `Archived ${plural(lm.count, 'tab')} from the closed window` : `Moved ${plural(lm.count, 'tab')} back to the main window`);
      }
    }
    S.lastMerge = lm;
  }
  S.ownStyle = syn.ownStyle || null;
  S.leftHintDismissed = !!loc.leftHintDismissed;
  S.tabNames = { ...(ses.incTabNames || {}), ...(loc.tabNames || {}) };
  S.lockedTabs = { ...(ses.incLockedTabs || {}), ...(loc.lockedTabs || {}) };
  S.favCache = loc.faviconCache || {};
  S.bindings = ses.bindings || {};
  S.helper = ses.helper || null;
  S.appEverConnected = !!loc.appEverConnected;
  S.overlayEnabled = loc.overlayEnabled !== false;
  S.lastActive = loc.lastActive || {};
  S.archive = loc.archive || [];
  S.globalMinutes = typeof loc.globalDefaultMinutes === 'number' ? loc.globalDefaultMinutes : DEFAULT_ARCHIVE_MINUTES;
  S.profileDir = loc.profileDir || null;
  S.collapsed = loc.collapsed || {};
  S.archiveMinutes = syn.archiveMinutes === undefined ? null : syn.archiveMinutes;
  S.roots = roots;
  S.favs = favs;
  S.pinned = pinned;
  derive();
  loaded = true;
}

function isPopout() {
  if (S.incognito) return false;   // v2.6: no main window / pop-out logic in the incognito world
  return S.mainWindowId != null && S.windowId !== S.mainWindowId && S.normalCount > 0;
}

function derive() {
  S.bmMap = new Map();
  for (const n of S.favs) S.bmMap.set(n.id, { n, parentId: n.parentId });
  const walk = (nodes) => { for (const n of nodes) { S.bmMap.set(n.id, { n, parentId: n.parentId }); if (!n.url) walk(n.children || []); } };
  walk(S.pinned);
  S.flat = [];
  S.flatById = new Map();
  const flatten = (nodes, depth) => {
    nodes.forEach((n, i) => {
      const e = { n, depth, index: i, parentId: n.parentId };
      S.flat.push(e);
      S.flatById.set(n.id, e);
      if (!n.url && !S.collapsed[n.id]) flatten(n.children || [], depth + 1);
    });
  };
  flatten(S.pinned, 0);
  S.boundByBm = new Map();
  S.today = [];
  S.ownUnits = [];
  S.sections = [];
  const visibleOf = (tabs, own) => {
    const claimed = new Set();
    const visible = [];
    for (const t of tabs) {
      const bid = S.bindings[t.id];
      const node = bid && S.bmMap.get(bid);
      if (node && node.n.url && !claimed.has(bid)) { claimed.add(bid); if (own) S.boundByBm.set(bid, t); }
      else visible.push(t);
    }
    return visible;
  };
  const own = visibleOf(S.tabs, true);
  S.today = own;
  S.boundAny = new Map(S.boundByBm);
  for (const w of S.otherWins) {
    for (const t of w.tabs) {
      const bid = S.bindings[t.id];
      if (bid && !S.boundAny.has(bid)) S.boundAny.set(bid, t);
    }
  }
  S.ownUnits = buildUnits(own);
  for (const w of S.otherWins) {
    const visible = visibleOf(w.tabs, false);
    if (!visible.length) continue;
    S.sections.push({ id: w.id, tabs: w.tabs, visible, units: buildUnits(visible) });
  }
}

// Turn a window's visible tabs into display units: plain tabs, split pairs and tab groups.
function buildUnits(visible) {
  const units = [];
  const bySplit = new Map();
  for (const t of visible) if (sidOf(t) >= 0) { if (!bySplit.has(sidOf(t))) bySplit.set(sidOf(t), []); bySplit.get(sidOf(t)).push(t); }
  const seen = new Set();
  let cur = null;
  for (const t of visible) {
    if (seen.has(t.id)) continue;
    const mates = sidOf(t) >= 0 ? bySplit.get(sidOf(t)) : null;
    let unit;
    if (mates && mates.length >= 2) {
      const pair = mates.slice(0, 2);
      pair.forEach((x) => seen.add(x.id));
      unit = { kind: 'split', tabs: pair, splitId: sidOf(t) };
    } else { seen.add(t.id); unit = { kind: 'tab', tab: t }; }
    const g = gidOf(t);
    if (g >= 0) {
      if (!cur || cur.groupId !== g) {
        cur = { kind: 'group', groupId: g, group: S.groups.get(g) || { id: g, title: '', color: 'grey', collapsed: false, windowId: t.windowId }, units: [] };
        units.push(cur);
      }
      cur.units.push(unit);
    } else { cur = null; units.push(unit); }
  }
  return units;
}

function unitTabs(u) {
  if (u.kind === 'tab') return [u.tab];
  if (u.kind === 'split') return u.tabs;
  return u.units.flatMap(unitTabs);
}

function effectiveMinutes() { return S.archiveMinutes ?? S.globalMinutes; }

function activeTab() { return S.tabs.find((t) => t.active) || null; }

// ------------------------------------------------------------------ rendering
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(run, 50);
}

async function run() {
  if (dragging) { dirty = true; return; }
  if (renamingId && document.querySelector('.rename-input')) { dirty = true; return; }
  if (loading) { reloadAgain = true; return; }
  loading = true;
  try {
    do {
      reloadAgain = false;
      dirty = false;
      await load();
    } while (reloadAgain);
    draw();
  } catch (e) {
    console.warn('[sidebar] render failed', e);
  } finally {
    loading = false;
  }
}

function draw() {
  const focusKey = (() => {
    const a = document.activeElement;
    if (!a || !a.closest || a.classList.contains('rename-input')) return null;
    const k = a.closest('[data-key]');
    return k && (k === a || !a.matches('input,select')) ? k.dataset.key + (k === a ? '' : '|child') : null;
  })();
  drawTheme();
  drawProfiles();
  drawPopoutBar();
  drawOfflineCard();
  // Overlay compact mode is the same DOM as expanded (clipped by the app), so the lists stay drawn behind settings/archive too.
  if (S.view === 'main' || (OVERLAY && isCompact())) { drawHint(); drawFavs(); drawPinned(); drawTemp(); drawToday(); }
  drawFooter();
  if (OVERLAY) postActiveTitle();
  if (S.view === 'archive') drawArchive();
  if (S.view === 'settings') drawSettings();
  if (focusKey) {
    const key = focusKey.replace('|child', '');
    const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

// The profile this panel belongs to, with its resolved icon/colour; null when unknown.
function currentProfile() {
  const hs = S.helper;
  const profiles = (hs && hs.status === 'connected' && hs.profiles) || [];
  const dir = hs && hs.currentProfileDir;
  const p = dir && profiles.find((x) => x.dir === dir);
  if (p) return { p, style: resolveStyle(p), dir: p.dir };
  if (S.ownStyle) {
    const pp = { dir: '__own', name: 'This profile', picture: null };
    return { p: pp, style: resolveStyle(pp, S.ownStyle), dir: null, own: true };
  }
  return null;
}

const HEX6 = /^#[0-9a-f]{6}$/i;
function normSidebarColor(v) {
  if (v && v.mode === 'custom' && typeof v.color === 'string' && HEX6.test(v.color)) return { mode: 'custom', color: v.color.toLowerCase() };
  return { mode: 'auto' };
}
const customColor = () => (S.sidebarColor.mode === 'custom' ? S.sidebarColor.color : null);
const CUSTOM_VARS = ['--bg', '--fg', '--dim', '--faint', '--hover', '--active', '--ring', '--tile', '--input', '--dash'];

function drawTheme() {
  const cur = currentProfile();
  const root = document.documentElement;
  if (OVERLAY) {
    // Overlay mode matches Chrome's own theme (see drawChromeTheme); the v1.1 profile tint is not used.
    root.classList.remove('has-profile');
    root.style.removeProperty('--profile');
    root.style.removeProperty('--on-profile');
    drawChromeTheme(cur);
    postTheme(cur ? cur.style.color : null);
    drawSidebarColorUi();
    return;
  }
  const cc = customColor();
  if (cur) {
    root.classList.add('has-profile');
    root.style.setProperty('--profile', cur.style.color);
    root.style.setProperty('--on-profile', onColor(cur.style.color));
  } else {
    root.classList.remove('has-profile');
    root.style.removeProperty('--profile');
    root.style.removeProperty('--on-profile');
  }
  if (cc) {
    // Custom colour: exactly as picked; text/hover/active derived from its luminance.
    const dark = hexLuminance(cc) < 0.5;
    const fg = dark ? '#ececf0' : '#1c1c1e';
    const mix = (pct) => `color-mix(in srgb, ${fg} ${pct}%, ${cc})`;
    const v = { '--bg': cc, '--fg': fg, '--dim': `color-mix(in srgb, ${fg} 58%, transparent)`, '--faint': `color-mix(in srgb, ${fg} 36%, transparent)`,
      '--hover': mix(6), '--active': mix(12), '--ring': mix(24), '--tile': mix(6), '--input': mix(8), '--dash': `color-mix(in srgb, ${fg} 24%, transparent)` };
    for (const k in v) root.style.setProperty(k, v[k]);
    root.style.colorScheme = dark ? 'dark' : 'light';
  } else {
    for (const k of CUSTOM_VARS) root.style.removeProperty(k);
    root.style.colorScheme = '';
  }
  drawSidebarColorUi();
}

// Overlay mode: colours come from the Chrome profile's theme (`chromeTheme`, read from Preferences by the host).
// data-theme is always "light" or "dark" here: a forced Chrome colour scheme wins over the OS setting.
let resolvedDark = false;
function drawChromeTheme(cur) {
  const root = document.documentElement;
  const ct = (cur && cur.p && cur.p.chromeTheme) || null;
  const color = ct && typeof ct.userColor === 'string' && /^#[0-9a-f]{6}$/i.test(ct.userColor) ? ct.userColor : null;
  if (color) root.style.setProperty('--chrome-user', color); else root.style.removeProperty('--chrome-user');
  root.classList.toggle('has-chrome-color', !!color);
  const scheme = ct && ct.colorScheme;
  resolvedDark = scheme === 'dark' ? true : scheme === 'light' ? false : !!(darkMq && darkMq.matches);
  // The host's sampled Chrome colour is the exact background; text colour follows its luminance and the
  // hover/active colours are mixed from it in CSS.
  // Effective background: custom > exact host sample > theme colour estimate > profile colour (seeds are softened).
  const custom = customColor();
  const sample = HOSTS.chromeColor;
  const seed = color || (cur && cur.style && cur.style.color) || null;
  let bg = null, src = 'none';
  if (custom) { bg = custom; src = 'custom'; resolvedDark = hexLuminance(custom) < 0.5; }
  else if (sample) { bg = sample; src = 'chrome'; resolvedDark = hexLuminance(sample) < 0.5; }
  else if (seed) {
    bg = resolvedDark ? `color-mix(in oklab, ${seed} 28%, #1f1f1f)` : `color-mix(in oklab, ${seed} 22%, white)`;
    src = color ? 'theme' : 'profile';
  }
  sbColorSource = src;
  root.classList.toggle('has-chrome-bg', !!bg);
  if (bg) root.style.setProperty('--overlay-bg', bg); else root.style.removeProperty('--overlay-bg');
  root.dataset.theme = resolvedDark ? 'dark' : 'light';
}
let sbColorSource = 'none';
function hexLuminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// Round avatar (button or span) for a profile in its resolved style.
function avatarEl(tag, p, style, props = {}, big = false) {
  const inner = style.icon === 'picture' && p.picture
    ? h('img', { src: p.picture, alt: '', draggable: 'false' })
    : style.icon === 'initial'
      ? h('span', { class: 'letter', text: ((p.name || p.dir || '?').trim()[0] || '?').toUpperCase() })
      : icon(style.icon, big ? 18 : 16);
  const el = h(tag, { class: 'pbtn' + (big ? ' big' : ''), ...props }, inner);
  el.style.setProperty('--pc', style.color);
  el.style.setProperty('--pf', onColor(style.color));
  return el;
}

function drawProfiles() {
  const el = $('profiles');
  const hs = S.helper;
  const profiles = (hs && hs.status === 'connected' && hs.profiles) || [];
  if (profiles.length < 2) { el.hidden = true; el.replaceChildren(); return; }
  el.hidden = false;
  const cur = hs.currentProfileDir;
  if (!cur || !profiles.some((p) => p.dir === cur)) {
    const sel = h('select', { 'aria-label': 'Which profile is this?', 'data-testid': 'profile-identify' },
      h('option', { value: '', text: 'Choose…' }),
      profiles.map((p) => h('option', { value: p.dir, text: p.name + (p.email ? ` (${p.email})` : '') })));
    sel.value = '';
    sel.addEventListener('change', () => { if (sel.value) cmd('setProfileDir', { dir: sel.value }); });
    el.replaceChildren(h('label', { class: 'profile-ask' }, h('span', { text: 'Which profile is this?' }), sel));
    return;
  }
  el.replaceChildren(...profiles.map((p) => {
    const current = p.dir === cur;
    const st = resolveStyle(p);
    return avatarEl('button', p, st, {
      type: 'button', 'aria-pressed': current ? 'true' : 'false', 'aria-label': `Profile ${p.name}`,
      title: p.email ? `${p.name} (${p.email})` : p.name,
      'data-testid': 'profile-pill', 'data-dir': p.dir, 'data-current': current ? 'true' : 'false', 'data-icon': st.icon, 'data-color': st.color,
      onclick: () => { if (!current) cmd('switchProfile', { targetDir: p.dir, windowId: S.windowId }); },
      oncontextmenu: (ev) => {
        ev.preventDefault();
        showMenu(ev, [{ label: 'Change icon and colour…', action: 'change-style', run: () => editProfileStyle(p.dir) }]);
      }
    });
  }));
}

function drawPopoutBar() {
  const pop = isPopout();
  $('popout-bar').hidden = !pop;
  $('merge-all').hidden = S.normalCount < 2 || S.incognito;
}

function mergeToast(r) {
  if (!r || !r.ok) toast((r && r.error) || 'Could not merge the windows');
  else if (r.count) toast(`Merged ${plural(r.count, 'tab')} into the main window`);
}
async function mergeWindowCmd(windowId) { mergeToast(await cmd('mergeWindow', { windowId })); }
async function mergeAllCmd() { mergeToast(await cmd('mergeAll')); }
const goToWindow = (windowId) => safe(chrome.windows.update(windowId, { focused: true }));

function showWindowMenu(ev, wid) {
  const isMain = wid === S.mainWindowId;
  showMenu(ev, [
    !isMain && !S.incognito ? { label: 'Merge into main window', action: 'merge-window', run: () => mergeWindowCmd(wid) } : null,
    !isMain && !S.incognito ? { label: 'Make this the main window', action: 'make-main', run: () => cmd('setMainWindow', { windowId: wid }) } : null,
    wid !== S.windowId ? { label: 'Go to window', action: 'go-to-window', run: () => goToWindow(wid) } : null
  ]);
}

function editProfileStyle(dir) {
  S.styleEditing = dir;
  setView('settings');
  requestAnimationFrame(() => { const f = $('field-styles'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'start' }); });
}

function drawHint() {
  $('left-hint').hidden = S.leftHintDismissed;
  // Chrome is in horizontal-tabs mode (the app found no rail): explain how to get the full sidebar.
  $('vt-hint').hidden = !(OVERLAY && HOSTS.railFound === false && !vtHintDismissed);
}

// ---- favourites
function drawFavs() {
  const grid = $('favs');
  grid.classList.remove('drop-into');
  grid.closest('.sec').classList.toggle('sec-empty', !S.favs.length);
  if (!S.favs.length) {
    grid.replaceChildren(h('div', { class: 'fav-empty', 'data-testid': 'favourites-empty', text: 'Drag tabs here for favourites' }));
    return;
  }
  const act = activeTab();
  grid.replaceChildren(...S.favs.map((n) => {
    const tab = S.boundByBm.get(n.id);
    const isActive = !!(tab && act && tab.id === act.id);
    const tabUrl = tab && (tab.url || tab.pendingUrl);
    const diverged = !!(tab && tabUrl && normUrl(tabUrl) !== normUrl(n.url));
    const tile = h('button', {
      type: 'button', class: 'fav-tile' + (isActive ? ' active' : ''), role: 'listitem', draggable: 'true',
      title: isActive && diverged ? 'Back to pinned page' : (n.title || n.url), 'aria-label': n.title || n.url,
      'data-testid': 'favourite-tile', 'data-key': 'b' + n.id, 'data-id': n.id, 'data-nav': '', 'data-url': n.url,
      'data-title': n.title, 'data-open': tab ? 'true' : 'false', 'data-active': isActive ? 'true' : 'false',
      onclick: () => cmd(isActive && diverged ? 'resetItem' : 'openItem', { bookmarkId: n.id, windowId: S.windowId }),
      oncontextmenu: (e) => { e.preventDefault(); showItemMenu(e, n); },
      ondragstart: (e) => startDrag(e, { type: 'bm', id: n.id, isFolder: false }, tile),
      ondragend: endDrag
    }, favEl(n.url, (tab || S.boundAny.get(n.id) || {}).favIconUrl), tab ? h('span', { class: 'odot', 'data-testid': 'open-dot' }) : null);
    return tile;
  }));
}

// ---- pinned
function drawPinned() {
  const tree = $('pinned');
  tree.classList.remove('drop-end', 'drop-into');
  $('sec-pinned').classList.toggle('sec-empty', !S.flat.length);
  if (!S.flat.length) {
    tree.replaceChildren(h('div', { class: 'empty-drop', 'data-testid': 'pinned-empty', text: 'Drag tabs here to pin them' }));
    return;
  }
  const act = activeTab();
  tree.replaceChildren(...S.flat.map((e) => pinnedRow(e, act)));
}

function pinnedRow(e, act) {
  const n = e.n;
  const isFolder = !n.url;
  const renaming = renamingId === n.id;
  const common = {
    class: 'row prow', role: 'treeitem', tabindex: '0', draggable: renaming ? null : 'true',
    'data-key': 'b' + n.id, 'data-id': n.id, 'data-nav': '', 'data-title': n.title, 'data-kind': isFolder ? 'folder' : 'item',
    ondragend: endDrag,
    onkeydown: (ev) => onPinnedKey(ev, n, isFolder)
  };
  let row;
  if (isFolder) {
    const open = !S.collapsed[n.id];
    row = h('div', {
      ...common, 'aria-expanded': open ? 'true' : 'false', 'data-testid': 'pinned-folder', 'data-open': open ? 'true' : 'false',
      onclick: (ev) => { if (!renaming && !ev.target.closest('.rename-input')) toggleFolder(n.id); },
      oncontextmenu: (ev) => { ev.preventDefault(); showFolderMenu(ev, n); },
      ondragstart: (ev) => startDrag(ev, { type: 'bm', id: n.id, isFolder: true }, row)
    },
    h('span', { class: 'chev' }, icon('chevron', 14)),
    h('span', { class: 'fico' }, icon('folder', 16)),
    renaming ? renameInput(n.title, (v) => chrome.bookmarks.update(n.id, { title: v })) : h('span', { class: 'title', text: n.title || 'Untitled folder' }));
  } else {
    const tab = S.boundByBm.get(n.id);
    const open = !!tab;
    const isActive = !!(tab && act && tab.id === act.id);
    const tabUrl = tab && (tab.url || tab.pendingUrl);
    const diverged = !!(tab && tabUrl && normUrl(tabUrl) !== normUrl(n.url));
    const fav = favEl(n.url, (tab || S.boundAny.get(n.id) || {}).favIconUrl);
    const resettable = isActive && diverged;
    if (resettable) { fav.title = 'Back to pinned page'; fav.classList.add('resettable'); fav.dataset.testid = 'pinned-favicon-reset'; }
    const curHost = diverged ? hostOf(tabUrl) : '';
    row = h('div', {
      ...common, class: 'row prow' + (isActive ? ' active' : '') + (curHost ? ' has-host' : ''), 'data-testid': 'pinned-row', 'data-open': open ? 'true' : 'false',
      'data-active': isActive ? 'true' : 'false', 'data-url': n.url, 'aria-current': isActive ? 'true' : null,
      title: n.title,
      onclick: (ev) => {
        if (ev.target.closest('.act') || ev.target.closest('.rename-input')) return;
        if (resettable && ev.target.closest('.fav-ic')) { cmd('resetItem', { bookmarkId: n.id, windowId: S.windowId }); return; }
        cmd('openItem', { bookmarkId: n.id, windowId: S.windowId });
      },
      oncontextmenu: (ev) => { ev.preventDefault(); showItemMenu(ev, n); },
      ondblclick: (ev) => { if (ev.target.closest('.title')) startRename(n.id); },
      ondragstart: (ev) => startDrag(ev, { type: 'bm', id: n.id, isFolder: false }, row)
    },
    h('span', { class: 'chev' }),
    fav,
    renaming ? renameInput(n.title, (v) => chrome.bookmarks.update(n.id, { title: v })) : h('span', { class: 'title', text: n.title || n.url }),
    curHost && !renaming ? h('span', { class: 'sub cur-host', 'data-testid': 'pinned-host', title: tabUrl, text: '/ ' + curHost }) : null,
    diverged ? h('button', {
      type: 'button', class: 'icon-btn act back', title: 'Back to pinned page', 'aria-label': 'Back to pinned page', 'data-testid': 'pinned-back',
      onclick: (ev) => { ev.stopPropagation(); cmd('resetItem', { bookmarkId: n.id, windowId: S.windowId }); }
    }, icon('back', 14)) : null,
    open ? h('button', {
      type: 'button', class: 'icon-btn act close', title: 'Close tab', 'aria-label': 'Close tab', 'data-testid': 'pinned-close',
      onclick: (ev) => { ev.stopPropagation(); cmd('closeItem', { bookmarkId: n.id, windowId: S.windowId }); }
    }, icon('x', 14)) : null);
    // the (empty) chevron slot keeps item icons aligned with folder icons
    row.querySelector('.chev').style.visibility = 'hidden';
  }
  row.prepend(rbg());
  row.style.setProperty('--depth', String(e.depth));
  if (e.depth > 0) row.append(h('span', { class: 'guide', 'aria-hidden': 'true' }));
  return row;
}

function onPinnedKey(ev, n, isFolder) {
  if (ev.target.closest('.rename-input')) return;
  if (ev.target !== ev.currentTarget) return;
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    if (isFolder) toggleFolder(n.id); else cmd('openItem', { bookmarkId: n.id, windowId: S.windowId });
  } else if (ev.key === 'F2') { ev.preventDefault(); startRename(n.id); }
  else if (!isFolder && (ev.key === 'Delete' || ev.key === 'Backspace') && S.boundByBm.has(n.id)) {
    ev.preventDefault();
    cmd('closeItem', { bookmarkId: n.id, windowId: S.windowId });
  } else if (isFolder && ev.key === 'ArrowRight' && S.collapsed[n.id]) { setCollapsed(n.id, false); }
  else if (isFolder && ev.key === 'ArrowLeft' && !S.collapsed[n.id]) { setCollapsed(n.id, true); }
}

function toggleFolder(id) { setCollapsed(id, !S.collapsed[id]); }

function setCollapsed(id, v) {
  const c = { ...S.collapsed };
  if (v) c[id] = true; else delete c[id];
  S.collapsed = c;
  chrome.storage.local.set({ collapsed: c }).catch(() => {});
  derive();
  draw();
}

// ---- temporary (v2.8): links opened in little windows or parked from Today
function tempTitle(e) { return e.title || hostOf(e.url) || e.url; }
function drawTemp() {
  const sec = $('sec-temp');
  const list = S.temporary;
  sec.classList.toggle('sec-empty', !list.length);
  $('temp-count').textContent = list.length ? String(list.length) : '';
  $('temp-count').hidden = !list.length;
  $('temp-list').replaceChildren(...list.map(tempRow));
}

function tempRow(e) {
  const open = e.windowId != null && S.littleIds.has(e.windowId);
  const title = tempTitle(e);
  const row = h('div', {
    class: 'row temp-row' + (open ? ' is-open' : ''), role: 'listitem', tabindex: '0', 'data-testid': 'temp-row', 'data-key': 'p' + e.id, 'data-nav': '',
    'data-entry-id': e.id, 'data-url': e.url, 'data-title': title, 'data-open': open ? 'true' : 'false', title: e.url,
    onclick: (ev) => { if (!ev.target.closest('.act')) cmd('reopenLittle', { entryId: e.id }); },
    oncontextmenu: (ev) => { ev.preventDefault(); showTempMenu(ev, e); },
    onkeydown: (ev) => {
      if (ev.target !== ev.currentTarget) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); cmd('reopenLittle', { entryId: e.id }); }
      else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); focusNeighbour(row); cmd('removeTemporary', { entryId: e.id }); }
    }
  },
  rbg(),
  favEl(e.url, e.favIconUrl),
  h('span', { class: 'title', text: title }),
  open ? h('span', { class: 'temp-dot', 'data-testid': 'temp-open-dot', title: 'Open in a little window' }) : null,
  h('button', {
    type: 'button', class: 'icon-btn act', title: 'Make full tab', 'aria-label': 'Make full tab', 'data-testid': 'temp-promote',
    onclick: (ev) => { ev.stopPropagation(); promoteTemp(e); }
  }, icon('arrowUpRight', 14)),
  h('button', {
    type: 'button', class: 'icon-btn act close', title: 'Remove (moves to Archive)', 'aria-label': 'Remove', 'data-testid': 'temp-remove',
    onclick: (ev) => { ev.stopPropagation(); cmd('removeTemporary', { entryId: e.id }); }
  }, icon('x', 14)));
  return row;
}

async function promoteTemp(e) {
  const r = await cmd('promoteLittle', { entryId: e.id });
  if (r && !r.ok) toast(r.error || 'Could not open it as a tab');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;left:-1000px' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function showTempMenu(ev, e) {
  showMenu(ev, [
    { label: 'Make full tab', action: 'temp-promote', run: () => promoteTemp(e) },
    { label: 'Open in little window', action: 'temp-open', run: () => cmd('reopenLittle', { entryId: e.id }) },
    { label: 'Copy link', action: 'temp-copy', run: async () => { if (await copyText(e.url)) toast('Link copied'); } },
    '-',
    { label: 'Remove', action: 'temp-remove', danger: true, run: () => cmd('removeTemporary', { entryId: e.id }) }
  ]);
}

// ---- today
function drawToday() {
  const list = $('today');
  list.classList.remove('drop-into');
  const newRow = h('div', {
    class: 'row new-tab-row', role: 'button', tabindex: '0', 'data-testid': 'new-tab-row', 'data-key': 'newtab', 'data-nav': '', 'aria-label': 'New tab',
    onclick: () => safe(chrome.tabs.create({ windowId: S.windowId, active: true })),
    onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); safe(chrome.tabs.create({ windowId: S.windowId, active: true })); } }
  }, rbg(), h('span', { class: 'fav-ic' }, icon('plus')), h('span', { class: 'title', text: 'New tab' }), h('span', { class: 'kbd-hint', 'aria-hidden': 'true', text: '\u2318T' }));
  list.replaceChildren(newRow, ...renderUnits(S.ownUnits, false), ...S.sections.map(sectionEl));
}

function renderUnits(units, other) {
  const act = activeTab();
  const out = [];
  for (const u of units) {
    if (u.kind === 'tab') out.push(todayRow(u.tab, act, other));
    else if (u.kind === 'split') out.push(splitRow(u, act, other));
    else {
      const g = u.group;
      const collapsed = !!g.collapsed;
      out.push(groupRow(u, other));
      if (!collapsed) {
        const body = h('div', { class: 'group-body', 'data-gc': g.color || 'grey', 'data-group-id': g.id });
        body.append(...renderUnits(u.units, other), h('span', { class: 'gout', 'data-testid': 'group-outline', 'aria-hidden': 'true' }));
        out.push(body);
      }
    }
  }
  return out;
}

function toggleWindow(id) {
  const c = { ...S.collapsedWindows };
  if (c[id]) delete c[id]; else c[id] = true;
  S.collapsedWindows = c;
  chrome.storage.local.set({ collapsedWindows: c }).catch(() => {});
  draw();
}

function sectionEl(sec) {
  const open = !S.collapsedWindows[sec.id];
  const isMain = isPopout() && sec.id === S.mainWindowId;
  const active = sec.tabs.find((t) => t.active);
  const head = h('div', {
    class: 'row window-head', role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false',
    'data-testid': 'window-head', 'data-key': 'w' + sec.id, 'data-nav': '', 'data-window-id': sec.id,
    onclick: () => toggleWindow(sec.id),
    oncontextmenu: (ev) => { ev.preventDefault(); showWindowMenu(ev, sec.id); },
    onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleWindow(sec.id); } }
  },
  rbg(),
  h('span', { class: 'chev' }, icon('chevron', 14)),
  h('span', { class: 'wmeta', text: `${isMain ? 'Main window' : 'Window'} · ${plural(sec.visible.length, 'tab')}` }),
  h('span', { class: 'wsub', text: active ? (active.title || '') : '' }),
  isMain || S.incognito ? null : h('button', {
    type: 'button', class: 'text-btn wmerge', title: 'Merge into main window', 'aria-label': 'Merge into main window', 'data-testid': 'window-merge', text: 'Merge',
    onclick: (ev) => { ev.stopPropagation(); mergeWindowCmd(sec.id); },
    onkeydown: (ev) => ev.stopPropagation()
  }));
  return h('div', { class: 'window-section', 'data-testid': 'window-section', 'data-window-id': sec.id, 'data-open': open ? 'true' : 'false' },
    head, open ? h('div', { class: 'window-body' }, ...renderUnits(sec.units, true)) : null);
}

function groupRow(u, other) {
  const g = u.group;
  const collapsed = !!g.collapsed;
  const renaming = renamingId === 'g' + g.id;
  const count = unitTabs(u).length;
  const toggle = () => { if (chrome.tabGroups) safe(chrome.tabGroups.update(g.id, { collapsed: !collapsed })); };
  const row = h('div', {
    class: 'row group-row' + (g.title ? '' : ' unnamed'), role: 'listitem', tabindex: '0', draggable: renaming ? null : 'true',
    'aria-expanded': collapsed ? 'false' : 'true', 'data-gc': g.color || 'grey',
    title: g.title || 'Unnamed group',
    'data-testid': 'group-row', 'data-group-id': g.id, 'data-collapsed': collapsed ? 'true' : 'false', 'data-key': 'g' + g.id, 'data-nav': '',
    'data-title': g.title || 'Unnamed group', 'data-window-id': g.windowId,
    onclick: (ev) => { if (!renaming && !ev.target.closest('.rename-input')) toggle(); },
    oncontextmenu: (ev) => { ev.preventDefault(); showGroupMenu(ev, g, other); },
    ondragstart: (ev) => startDrag(ev, { type: 'group', groupId: g.id, windowId: g.windowId }, row),
    ondragend: endDrag,
    onkeydown: (ev) => {
      if (ev.target !== ev.currentTarget) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      else if (ev.key === 'F2') { ev.preventDefault(); startRename('g' + g.id); }
    }
  },
  rbg(),
  h('span', { class: 'chev' }, icon('chevron', 14)),
  h('span', { class: 'gdot' }),
  renaming
    ? renameInput(g.title || '', (v) => chrome.tabGroups.update(g.id, { title: v }), true)
    : h('span', { class: 'title', text: g.title || 'Unnamed group' }),
  collapsed && !renaming ? h('span', { class: 'gcount', 'data-testid': 'group-count', title: plural(count, 'tab'), text: String(count) }) : null,
  collapsed && !renaming ? h('span', { class: 'gcbadge', 'aria-hidden': 'true', text: String(count) }) : null);
  return row;
}

function openTab(tab) {
  if (tab.windowId !== S.windowId) return cmd('bringTab', { tabId: tab.id, windowId: S.windowId });
  return safe(chrome.tabs.update(tab.id, { active: true }));
}

function archiveClock(tab, isActive) {
  const minutes = effectiveMinutes();
  if (minutes > 0 && !isActive && !tab.pinned && !tab.audible && !tab.incognito && !S.incognito && !S.lockedTabs[tab.id] && S.lastActive[tab.id] && (gidOf(tab) < 0 || S.archiveGrouped)) {
    const remaining = minutes * 60000 - (Date.now() - S.lastActive[tab.id]);
    if (remaining > 0 && remaining < 3600000) {
      const mins = Math.max(1, Math.ceil(remaining / 60000));
      return h('span', { class: 'badge-ic', title: `Archives in ${mins} min`, 'data-testid': 'archive-soon' }, icon('clock', 13));
    }
  }
  return null;
}

function todayRow(tab, act, other) {
  const isActive = !other && !!(act && act.id === tab.id);
  const url = tab.url || tab.pendingUrl || '';
  const real = tab.title || url || 'New Tab';
  const named = nameOf(tab);
  const title = named || real;
  const renaming = renamingId === 'n' + tab.id;
  const clock = archiveClock(tab, isActive || tab.active);
  const row = h('div', {
    class: 'row today-row' + (isActive ? ' active' : '') + (named ? ' named' : '') + (isLocked(tab) ? ' locked' : ''), role: 'listitem', tabindex: '0', draggable: renaming ? null : 'true',
    'data-testid': 'today-row', 'data-key': 't' + tab.id, 'data-tab-id': tab.id, 'data-window-id': tab.windowId, 'data-nav': '', 'data-url': url, 'data-title': title,
    'data-active': isActive ? 'true' : 'false', 'aria-current': isActive ? 'true' : null, title: named ? `${named} — ${real}` : title,
    'data-named': named ? 'true' : null,
    onclick: (ev) => { if (!ev.target.closest('.act, .rename-input')) openTab(tab); },
    oncontextmenu: (ev) => { ev.preventDefault(); showTabMenu(ev, tab); },
    ondragstart: (ev) => startDrag(ev, { type: 'tab', tabId: tab.id, windowId: tab.windowId }, row),
    ondragend: endDrag,
    onkeydown: (ev) => {
      if (ev.target !== ev.currentTarget) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openTab(tab); }
      else if (ev.key === 'F2') { ev.preventDefault(); startRename('n' + tab.id); }
      else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); focusNeighbour(row); safe(chrome.tabs.remove(tab.id)); }
    }
  },
  sidOf(tab) >= 0 ? h('span', { class: 'split-ic', title: 'In a split view' }, icon('split', 13)) : null,
  favEl(url, tab.favIconUrl),
  renaming
    ? renameInput(title, (v) => cmd('renameTab', { tabId: tab.id, name: v }), true)
    : h('span', { class: 'title', text: title, ondblclick: (ev) => { ev.stopPropagation(); startRename('n' + tab.id); } }),
  lockBadge(tab),
  tab.audible ? h('span', { class: 'badge-ic audio', title: 'Playing audio', 'data-testid': 'audible-icon' }, icon('speaker', 13)) : null,
  clock,
  h('button', {
    type: 'button', class: 'icon-btn act close', title: 'Close tab', 'aria-label': 'Close tab', 'data-testid': 'today-close',
    onclick: (ev) => { ev.stopPropagation(); safe(chrome.tabs.remove(tab.id)); }
  }, icon('x', 14)));
  row.prepend(rbg());
  return row;
}

function splitRow(u, act, other) {
  const [a, b] = u.tabs;
  const half = (t) => {
    const url = t.url || t.pendingUrl || '';
    const real = t.title || url || 'New Tab';
    const named = nameOf(t);
    const title = named || real;
    const renaming = renamingId === 'n' + t.id;
    const isActive = !other && !!(act && act.id === t.id);
    return h('div', {
      class: 'half' + (isActive ? ' active' : '') + (isLocked(t) ? ' locked' : ''), tabindex: '0', draggable: renaming || other ? null : 'true',
      ondragstart: (ev) => { ev.stopPropagation(); startDrag(ev, { type: 'tab', tabId: t.id, windowId: t.windowId, fromSplit: u.splitId, splitTabIds: [a.id, b.id] }, ev.currentTarget); },
      ondragend: endDrag, title: named ? `${named} — ${real}` : title, 'data-testid': 'split-half', 'data-tab-id': t.id, 'data-key': 't' + t.id, 'data-nav': '',
      'data-active': isActive ? 'true' : 'false',
      onclick: (ev) => { if (!ev.target.closest('.act, .rename-input')) openTab(t); },
      onkeydown: (ev) => {
        if (ev.target !== ev.currentTarget) return;
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openTab(t); }
        else if (ev.key === 'F2') { ev.preventDefault(); startRename('n' + t.id); }
        else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); safe(chrome.tabs.remove(t.id)); }
      }
    },
    favEl(url, t.favIconUrl),
    renaming
      ? renameInput(title, (v) => cmd('renameTab', { tabId: t.id, name: v }), true)
      : h('span', { class: 'title', text: title, ondblclick: (ev) => { ev.stopPropagation(); startRename('n' + t.id); } }),
    lockBadge(t),
    h('button', {
      type: 'button', class: 'icon-btn act close', title: 'Close tab', 'aria-label': 'Close tab', 'data-testid': 'today-close',
      onclick: (ev) => { ev.stopPropagation(); safe(chrome.tabs.remove(t.id)); }
    }, icon('x', 12)));
  };
  const row = h('div', {
    class: 'row split-row' + (!other && act && (act.id === a.id || act.id === b.id) ? ' has-active' : ''), role: 'listitem', draggable: 'true', 'data-testid': 'split-row', 'data-split-id': u.splitId,
    'data-tab-ids': `${a.id},${b.id}`, 'data-window-id': a.windowId, 'data-title': `${a.title || ''} | ${b.title || ''}`,
    oncontextmenu: (ev) => {
      ev.preventDefault();
      const hf = ev.target.closest && ev.target.closest('.half');
      const t = hf && String(b.id) === hf.dataset.tabId ? b : a;
      showTabMenu(ev, t, { split: u });
    },
    ondragstart: (ev) => startDrag(ev, { type: 'split', splitId: u.splitId, tabIds: [a.id, b.id], windowId: a.windowId }, row),
    ondragend: endDrag
  },
  rbg(),
  h('span', { class: 'split-ic', title: 'Split view' }, icon('split', 14)),
  half(a), h('span', { class: 'divider' }), half(b));
  return row;
}

const isSearchUrl = (u) => typeof u === 'string' && u.startsWith(chrome.runtime.getURL('littlesearch.html'));
const nameOf = (t) => (t && S.tabNames[t.id] && S.tabNames[t.id].name) || '';
const isLocked = (t) => !!(t && S.lockedTabs[t.id]);
const lockBadge = (t) => (isLocked(t) ? h('span', { class: 'badge-ic lock', title: 'Locked', 'data-testid': 'lock-icon' }, icon('lock', 12)) : null);

function winTabs(wid) {
  if (wid === S.windowId) return S.tabs;
  const w = S.otherWins.find((x) => x.id === wid);
  return w ? w.tabs : [];
}

// Tabs that "Close tabs above/below/others/all" would close for this tab (mirrors the service worker).
function closeScope(tab, which) {
  const tabs = winTabs(tab.windowId);
  const mine = new Set([tab.id]);
  if (sidOf(tab) >= 0) for (const t of tabs) if (sidOf(t) === sidOf(tab)) mine.add(t.id);
  const idx = tabs.filter((t) => mine.has(t.id)).map((t) => t.index);
  if (!idx.length) return [];
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);
  const scope = which === 'above' ? tabs.filter((t) => t.index < lo)
    : which === 'below' ? tabs.filter((t) => t.index > hi)
      : which === 'others' ? tabs.filter((t) => !mine.has(t.id)) : tabs;
  return scope.filter((t) => !t.pinned && !S.bindings[t.id] && !S.lockedTabs[t.id]);
}

async function closeMany(tab, which) {
  const n = closeScope(tab, which).length;
  if (which === 'all' && n > 5) {
    const ok = await confirmDialog({ title: `Close ${n} tabs?`, message: 'These tabs will be closed, not archived.', okLabel: 'Close tabs', danger: true });
    if (!ok) return;
  }
  const r = await cmd('closeTabs', { windowId: tab.windowId, tabId: tab.id, which });
  if (r && !r.ok) toast(r.error || 'Could not close tabs');
}

function focusNeighbour(el) {
  const items = [...document.querySelectorAll('#view-main [data-nav]')];
  const i = items.indexOf(el);
  const next = items[i + 1] || items[i - 1];
  if (next) next.focus({ preventScroll: true });
}

// ---- footer
function drawFooter() {
  const n = S.archive.length;
  const c = $('archive-count');
  c.hidden = n === 0;
  c.textContent = String(n);
  $('archive-btn').setAttribute('aria-pressed', S.view === 'archive' ? 'true' : 'false');
  $('archive-btn').setAttribute('aria-label', n ? `Archive, ${n} tabs` : 'Archive');
  $('settings-btn').setAttribute('aria-pressed', S.view === 'settings' ? 'true' : 'false');
  $('clear').title = S.incognito ? 'Close all of Today\u2019s tabs (incognito tabs aren\u2019t archived)' : "Archive all of Today's tabs";
}

// ---- archive view
function dayLabel(ts) {
  const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((sod(new Date()) - sod(new Date(ts))) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function drawArchive() {
  const q = $('archive-search').value.trim().toLowerCase();
  const all = S.archive;
  const list = q ? all.filter((e) => (e.title || '').toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q)) : all;
  const box = $('archive-list');
  const m = effectiveMinutes();
  $('archive-hint').textContent = m > 0 ? `Tabs you haven't used for ${fmtMinutes(m)} end up here.` : 'Automatic archiving is off.';
  $('archive-clear').disabled = all.length === 0;
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty-note', 'data-testid': 'archive-empty', text: all.length ? 'No matches' : 'Nothing archived yet' }));
    return;
  }
  const out = [];
  let lastLabel = null;
  for (const e of list.slice(0, 500)) {
    const label = dayLabel(e.archivedAt);
    if (label !== lastLabel) { out.push(h('div', { class: 'group-title', 'data-testid': 'archive-group', text: label })); lastLabel = label; }
    out.push(h('div', {
      class: 'row archive-row', role: 'listitem', tabindex: '0', 'data-testid': 'archive-row', 'data-archive-id': e.id, 'data-url': e.url,
      'data-title': e.title, title: e.url, 'data-key': 'a' + e.id,
      onclick: (ev) => { if (!ev.target.closest('.act')) cmd('restoreArchived', { id: e.id, windowId: S.windowId }); },
      onkeydown: (ev) => {
        if (ev.target !== ev.currentTarget) return;
        if (ev.key === 'Enter') cmd('restoreArchived', { id: e.id, windowId: S.windowId });
        else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); cmd('deleteArchived', { id: e.id }); }
      }
    },
    favEl(e.url, e.favIconUrl),
    h('span', { class: 'title', text: e.title || e.url }),
    e.source === 'temporary' ? h('span', { class: 'tag', 'data-testid': 'archive-temp-tag', text: 'Temporary' }) : null,
    h('span', { class: 'sub', text: hostOf(e.url) }),
    h('button', {
      type: 'button', class: 'icon-btn act', title: 'Delete from archive', 'aria-label': 'Delete from archive', 'data-testid': 'archive-delete',
      onclick: (ev) => { ev.stopPropagation(); cmd('deleteArchived', { id: e.id }); }
    }, icon('x', 14))));
  }
  box.replaceChildren(...out);
}

// ---- settings view
function fillSelect(sel, values, withDefault, current) {
  const opts = [];
  if (withDefault) opts.push(['', `Default for all profiles (${fmtMinutes(S.globalMinutes)})`]);
  for (const v of ARCHIVE_CHOICES) opts.push([String(v), fmtMinutes(v)]);
  if (current !== '' && !ARCHIVE_CHOICES.includes(Number(current))) opts.push([String(current), fmtMinutes(Number(current))]);
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig !== sig) {
    sel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v, text: l })));
    sel.dataset.sig = sig;
  }
  sel.value = String(current);
}

function drawSidebarColorUi() {
  const f = $('field-sidebar-color');
  if (!f) return;
  const custom = customColor();
  for (const b of f.querySelectorAll('.seg-b')) b.setAttribute('aria-pressed', String((b.dataset.mode === 'custom') === !!custom));
  $('sbc-custom').hidden = !custom;
  const cur = currentProfile();
  const hasSwatches = $('sbc-swatches').children.length > 0;
  if (!hasSwatches) {
    const tones = ['#e9eef6', '#f3e8ff', '#e6f4ea', '#fff4e5'];
    $('sbc-swatches').replaceChildren(...[...PROFILE_COLORS.map((c) => ({ hex: c.hex, name: c.name })), ...tones.map((t) => ({ hex: t, name: t }))].map((c) =>
      h('button', { type: 'button', class: 'sbc-sw', 'data-testid': 'sidebar-color-swatch', 'data-color': c.hex, title: c.name, 'aria-label': c.name,
        onclick: () => setSidebarColor({ mode: 'custom', color: c.hex }, true) })));
    for (const b of $('sbc-swatches').children) b.style.setProperty('--sw', b.dataset.color);
  }
  for (const b of $('sbc-swatches').children) b.setAttribute('aria-pressed', String(!!custom && b.dataset.color === custom));
  if (custom && document.activeElement !== $('sbc-picker')) $('sbc-picker').value = custom;
  const note = $('sbc-note');
  let text = '';
  if (!custom) {
    if (OVERLAY) text = sbColorSource === 'chrome' ? 'Matching Chrome exactly' : sbColorSource === 'theme' ? 'From your Chrome theme colour' : sbColorSource === 'profile' ? 'From your profile colour' : 'Using the default colour';
    else text = cur ? 'From your profile colour' : 'Using the default colour';
  }
  note.textContent = text;
  note.hidden = !text;
}
let sbSaveTimer = 0;
function setSidebarColor(v, save) {
  S.sidebarColor = normSidebarColor(v);
  drawTheme();
  clearTimeout(sbSaveTimer);
  const persist = () => chrome.storage.sync.set({ sidebarColor: S.sidebarColor }).catch(() => {});
  if (save) persist(); else sbSaveTimer = setTimeout(persist, 300);
}

function drawSettings() {
  drawSidebarColorUi();
  const hs = S.helper;
  const connected = !!(hs && hs.status === 'connected');
  fillSelect($('set-profile-archive'), ARCHIVE_CHOICES, true, S.archiveMinutes === null ? '' : S.archiveMinutes);
  const g = $('set-global-archive');
  fillSelect(g, ARCHIVE_CHOICES, false, S.globalMinutes);
  g.disabled = !connected;
  $('global-hint').textContent = connected
    ? 'Shared by every Chrome profile that has Sidebar installed.'
    : 'Needs the profile helper. Until it is installed the default stays at 12 hours.';

  $('set-archive-grouped').checked = S.archiveGrouped;
  $('set-merge-on-close').checked = S.mergeOnClose;
  $('set-pinned-reset').checked = S.pinnedReset;
  drawLittleSettings(connected);
  if (OVERLAY) drawAppSettings();
  drawStyleList();
  const profiles = (connected && hs.profiles) || [];
  $('field-profile').hidden = !connected || !profiles.length;
  const pick = $('set-profile-pick');
  if (connected && profiles.length) {
    const cur = hs.currentProfileDir || '';
    const opts = [];
    if (!cur || !profiles.some((p) => p.dir === cur)) opts.push(h('option', { value: '', text: 'Choose…' }));
    for (const p of profiles) opts.push(h('option', { value: p.dir, text: p.name + (p.email ? ` (${p.email})` : '') }));
    pick.replaceChildren(...opts);
    pick.value = profiles.some((p) => p.dir === cur) ? cur : '';
  }

  const dot = $('helper-dot');
  const status = $('helper-status');
  dot.className = 'status-dot';
  if (!hs || !hs.status) { status.textContent = 'Checking…'; }
  else if (hs.status === 'connected') { status.textContent = 'Connected'; dot.classList.add('ok'); }
  else if (hs.status === 'not_installed') { status.textContent = 'Sidebar app not running — open Sidebar.app, then Retry'; dot.classList.add('bad'); }
  else { status.textContent = `Error: ${hs.error || 'unknown'}`; dot.classList.add('bad'); }
  status.dataset.status = (hs && hs.status) || 'checking';
  $('helper-retry').hidden = connected;
  $('field-overlay-enabled').hidden = !connected;
  $('set-overlay-enabled').checked = S.overlayEnabled;
}

// v2.8: Settings > Little windows
const TEMP_EXPIRY_CHOICES = [60, 360, 720, 1440, 0];
function drawLittleSettings(connected) {
  const cb = $('set-little-default');
  cb.checked = connected && S.defaultBrowser;
  cb.disabled = !connected;
  $('little-default-hint').textContent = connected
    ? 'Sidebar.app asks macOS to make it your default browser; links it can\u2019t show go to Chrome as usual.'
    : 'Needs Sidebar.app. Open it, then turn this on.';
  for (const b of document.querySelectorAll('[data-testid="little-style"] .seg-b')) b.setAttribute('aria-pressed', String(b.dataset.style === S.littleStyle));
  $('little-style-hint').textContent = S.littleStyle === 'minimal'
    ? 'Just the page and a slim address bar. \u201cMake full tab\u201d reopens the page in your main window.'
    : 'A regular Chrome window with toolbar and tabs. \u201cMake full tab\u201d moves the live tab, keeping its page state.';
  const mx = $('set-little-max');
  if (!mx.children.length) mx.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h('option', { value: String(n), text: String(n) })));
  mx.value = String(S.littleMaxOpen);
  const ex = $('set-temp-expiry');
  const opts = TEMP_EXPIRY_CHOICES.slice();
  if (!opts.includes(S.temporaryMinutes)) opts.push(S.temporaryMinutes);
  const sig = JSON.stringify(opts);
  if (ex.dataset.sig !== sig) { ex.replaceChildren(...opts.map((v) => h('option', { value: String(v), text: fmtMinutes(v) }))); ex.dataset.sig = sig; }
  ex.value = String(S.temporaryMinutes);
}

// v2.7: card shown when the Mac app isn't connected (only once it has connected before, so side-panel-only users aren't nagged).
let offlineTryAt = 0;
let offlineFailed = false;
let offlineTimer = null;
function drawOfflineCard() {
  const hs = S.helper;
  const down = !OVERLAY && S.appEverConnected && !!(hs && (hs.status === 'not_installed' || hs.status === 'error'));
  $('app-offline').hidden = !down;
  if (!down) { offlineFailed = false; offlineTryAt = 0; return; }
  $('app-offline-msg').textContent = offlineFailed
    ? "Couldn't start it. Open Sidebar.app from your Applications folder."
    : "Open it to cover Chrome's tabs with this sidebar.";
}
async function offlineRetry(launch) {
  offlineFailed = false;
  offlineTryAt = Date.now();
  await cmd('retryHelper');
  drawOfflineCard();
  if (!launch) return;
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => {
    const hs = S.helper;
    if (!(hs && hs.status === 'connected')) { offlineFailed = true; drawOfflineCard(); }
  }, 5000);
}

// ---- profile icon + colour editor (Settings > Profiles)
async function saveStyle(en, style) {
  const hs = S.helper;
  if (en.own) S.ownStyle = style;
  else if (hs && hs.profiles) S.helper = { ...hs, profiles: hs.profiles.map((p) => (p.dir === en.dir ? { ...p, style } : p)) };
  draw();
  const r = await cmd('setProfileStyle', { dir: en.dir, style });
  if (!r || !r.ok) { toast((r && r.error) || 'Could not save the profile style'); scheduleRender(); }
}

function styleEditor(en) {
  const cur = en.style;
  const names = [];
  if (en.p.picture) names.push('picture');
  names.push('initial', ...PROFILE_GLYPHS);
  const iconBtns = names.map((name) => {
    const inner = name === 'picture' ? h('img', { src: en.p.picture, alt: '', draggable: 'false' })
      : name === 'initial' ? h('span', { class: 'letter', text: ((en.p.name || '?').trim()[0] || '?').toUpperCase() })
        : icon(name, 18);
    const b = h('button', {
      type: 'button', class: 'style-icon', title: name, 'aria-label': `Icon: ${name}`, 'aria-pressed': cur.icon === name ? 'true' : 'false',
      'data-testid': 'style-icon', 'data-icon': name,
      onclick: () => saveStyle(en, { icon: name, color: cur.color })
    }, inner);
    b.style.setProperty('--sc', cur.color);
    b.style.setProperty('--sf', onColor(cur.color));
    return b;
  });
  const colorBtns = PROFILE_COLORS.map((c) => {
    const b = h('button', {
      type: 'button', class: 'style-color', title: c.name, 'aria-label': `Colour: ${c.name}`, 'aria-pressed': cur.color === c.hex ? 'true' : 'false',
      'data-testid': 'style-color', 'data-color': c.hex,
      onclick: () => saveStyle(en, { icon: cur.icon, color: c.hex })
    }, cur.color === c.hex ? icon('check', 14) : null);
    b.style.setProperty('--c', c.hex);
    b.style.setProperty('--cf', onColor(c.hex));
    return b;
  });
  return h('div', { class: 'style-editor', 'data-testid': 'style-editor', 'data-dir': en.dir },
    h('div', {}, h('p', { class: 'cap', text: 'Icon' }), h('div', { class: 'icon-grid' }, ...iconBtns)),
    h('div', {}, h('p', { class: 'cap', text: 'Colour' }), h('div', { class: 'color-grid' }, ...colorBtns)));
}

function drawStyleList() {
  const box = $('profile-styles');
  const hs = S.helper;
  const connected = !!(hs && hs.status === 'connected' && hs.profiles && hs.profiles.length);
  let entries;
  if (connected) entries = hs.profiles.map((p) => ({ p, dir: p.dir, style: resolveStyle(p), current: p.dir === hs.currentProfileDir }));
  else {
    const pp = { dir: '__own', name: 'This profile', picture: null };
    entries = [{ p: pp, dir: '__own', style: resolveStyle(pp, S.ownStyle), current: true, own: true }];
  }
  const kids = [];
  for (const en of entries) {
    const open = S.styleEditing === en.dir;
    const sub = en.own ? 'Without the helper, only this profile can be styled' : (en.p.email || (en.current ? 'This profile' : ''));
    kids.push(h('button', {
      type: 'button', class: 'pstyle-row', 'aria-expanded': open ? 'true' : 'false', 'data-testid': 'profile-style-row', 'data-dir': en.dir,
      onclick: () => { S.styleEditing = open ? null : en.dir; drawStyleList(); }
    },
    avatarEl('span', en.p, en.style, { 'aria-hidden': 'true' }, true),
    h('span', { class: 'pname' }, en.p.name || en.dir, sub ? h('small', { text: en.current && en.p.email ? `${en.p.email} · this profile` : sub }) : null),
    h('span', { class: 'chev' }, icon('chevron', 14))));
    if (open) kids.push(styleEditor(en));
  }
  box.replaceChildren(...kids);
}

// ------------------------------------------------------------------ views
let boostCleanup = null;
function leaveBoost() {
  if (boostCleanup) { try { boostCleanup(); } catch (e) { console.warn('[sidebar] boost cleanup', e); } boostCleanup = null; }
  $('view-boost').replaceChildren();
  if (captureCleanup) { try { captureCleanup(); } catch (e) { console.warn('[sidebar] capture cleanup', e); } captureCleanup = null; }
  $('view-captures').replaceChildren();
  if (captureSettingsCleanup) { try { captureSettingsCleanup(); } catch { /* ignore */ } captureSettingsCleanup = null; }
}
let captureCleanup = null;
let captureSettingsCleanup = null;

function setView(v) {
  leaveBoost();
  S.view = v;
  $('view-main').hidden = v !== 'main';
  $('view-archive').hidden = v !== 'archive';
  $('view-settings').hidden = v !== 'settings';
  $('view-boost').hidden = v !== 'boost';
  $('view-captures').hidden = v !== 'captures';
  if (v === 'captures') {
    try {
      const c = renderCaptureRecent($('view-captures'), makeCaptureCtx());
      captureCleanup = typeof c === 'function' ? c : null;
    } catch (e) { console.warn('[sidebar] captures view', e); }
  }
  if (v === 'boost') {
    try {
      const c = renderBoostView($('view-boost'), makeBoostCtx());
      boostCleanup = typeof c === 'function' ? c : null;
    } catch (e) { console.warn('[sidebar] boost view', e); }
  }
  if (v === 'settings') { mountBoostSettings(); mountCaptureSettings(); }
  try { if (v !== 'boost' && v !== 'captures') sessionStorage.setItem('view', v); } catch { /* ignore */ }
  if (loaded) draw();
}

// ------------------------------------------------------------------ boost integration points
function makeBoostCtx() {
  return {
    get windowId() { return S.windowId; },
    cmd,
    goBack: () => setView('main'),
    toast,
    openBoost: () => setView('boost')   // extra: lets the address-row button open the Boost view
  };
}

function mountBoostSettings() {
  const box = $('boost-settings-slot');
  box.replaceChildren();
  try { renderBoostSettings(box, makeBoostCtx()); } catch (e) { console.warn('[sidebar] boost settings', e); }
}

// ---- screenshots (v2.9): camera button, Recent captures view, Settings section
function makeCaptureCtx() {
  return {
    get windowId() { return S.windowId; },
    cmd,
    toast,
    showMenu,
    goBack: () => setView('main'),
    openRecent: () => setView('captures')
  };
}
function mountCaptureSettings() {
  const box = $('capture-settings-slot');
  box.replaceChildren();
  try { const c = renderCaptureSettings(box, makeCaptureCtx()); captureSettingsCleanup = typeof c === 'function' ? c : null; } catch (e) { console.warn('[sidebar] capture settings', e); }
}
function mountCaptureButton() {
  try { $('capture-slot').replaceChildren(createCaptureButton(makeCaptureCtx())); } catch (e) { console.warn('[sidebar] capture button', e); }
  // the service worker reports problems ("Screenshots aren't available on this page") through session storage
  let lastToast = 0;
  chrome.storage.onChanged.addListener((ch, area) => {
    const t = ch.capToast && ch.capToast.newValue;
    if (area === 'session' && t && t.n !== lastToast && (t.windowId == null || t.windowId === S.windowId)) { lastToast = t.n; toast(t.text); }
  });
}

function mountBoostButton() {
  try {
    const b = createBoostButton(makeBoostCtx());
    if (b) $('boost-slot').replaceChildren(b);
  } catch (e) { console.warn('[sidebar] boost button', e); }
}


// ------------------------------------------------------------------ inline rename
function startRename(id) {
  renamingId = id;
  draw();
}

function renameInput(current, onCommit, allowEmpty = false) {
  const inp = h('input', { class: 'rename-input', type: 'text', 'aria-label': 'Rename', 'data-testid': 'rename-input', spellcheck: 'false' });
  inp.value = current;
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    renamingId = null;
    const v = inp.value.trim();
    if (commit && (v || allowEmpty) && v !== current) await safe(onCommit(v));
    scheduleRender();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (e) => e.stopPropagation());
  inp.addEventListener('dblclick', (e) => e.stopPropagation());
  requestAnimationFrame(() => { inp.focus(); inp.select(); });
  return inp;
}

async function newFolder(parentId) {
  const roots = S.roots || (await cmd('ensureRoots')).roots;
  if (!roots) return;
  const parent = parentId || roots.pinned;
  if (S.collapsed[parent]) { const c = { ...S.collapsed }; delete c[parent]; S.collapsed = c; await safe(chrome.storage.local.set({ collapsed: c })); }
  const f = await safe(chrome.bookmarks.create({ parentId: parent, title: 'New folder' }));
  if (f) { renamingId = f.id; scheduleRender(); }
}

// ------------------------------------------------------------------ context menus + dialogs
let menuEl = null;

function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

// Native (overlay) menus: items are serialised for the app; handlers stay here, keyed by id.
let nativeMenu = null; // { handlers: Map } while a native menu is open
const useNativeMenu = () => OVERLAY && !!window.__sidebarHost;

// HTML menus have no nesting: a submenu is flattened inline, under a heading (unless `plain`), exactly like before.
function flattenMenu(items) {
  const out = [];
  for (const it of items) {
    if (it && it.submenu) {
      const subs = flattenMenu(it.submenu.filter(Boolean));
      if (!subs.length) continue;
      if (!it.plain) out.push({ heading: it.label });
      for (const s of subs) out.push(s.label && !s.heading && !it.plain ? { ...s, indent: true } : s);
    } else out.push(it);
  }
  return out;
}

function toNativeItems(items, handlers) {
  const out = [];
  const add = (d) => out.push(d);
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { if (out.length && !out[out.length - 1].separator) add({ separator: true }); continue; }
    if (it.heading) { add({ header: true, label: it.heading, enabled: false }); continue; }
    if (it.swatches) {
      add({ label: it.label || 'Colour', enabled: true, submenu: it.swatches.map((c) => {
        const id = 'm' + (handlers.size + 1); handlers.set(id, () => it.onPick(c));
        return { id, label: c.charAt(0).toUpperCase() + c.slice(1), enabled: true, checked: c === it.current };
      }) });
      continue;
    }
    if (it.submenu) {
      const sub = toNativeItems(it.submenu, handlers);
      if (sub.length) add({ label: it.label, enabled: !it.disabled && sub.some((d) => d.enabled), submenu: sub });
      continue;
    }
    const id = 'm' + (handlers.size + 1);
    handlers.set(id, it.run);
    add({ id, label: it.label, enabled: !it.disabled, ...(it.checked ? { checked: true } : {}) });
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

window.__sidebarMenuResult = (id) => {
  const nm = nativeMenu;
  if (!nm) return;
  nativeMenu = null;
  updateBusy();
  const fn = id != null ? nm.handlers.get(String(id)) : null;
  if (typeof fn === 'function') { try { const r = fn(); if (r && r.catch) r.catch(console.error); } catch (e) { console.error(e); } }
};

function showMenu(ev, items) {
  closeMenu();
  if (useNativeMenu()) {
    if (nativeMenu) return;
    const handlers = new Map();
    const native = toNativeItems(items, handlers);
    if (!native.length) return;
    nativeMenu = { handlers };
    updateBusy();
    hostPost('contextMenu', { x: ev.clientX, y: ev.clientY, items: native });
    return;
  }
  items = flattenMenu(items);
  const menu = h('div', { class: 'menu', role: 'menu', 'data-testid': 'context-menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(h('hr')); continue; }
    if (it.heading) { menu.append(h('div', { class: 'mh', text: it.heading })); continue; }
    if (it.swatches) {
      const box = h('div', { class: 'swatches', role: 'group', 'aria-label': it.label || 'Colour' });
      for (const c of it.swatches) {
        const b = h('button', {
          type: 'button', class: 'sw', role: 'menuitemradio', 'aria-checked': c === it.current ? 'true' : 'false', 'aria-label': c, title: c,
          'data-testid': 'group-color', 'data-color': c, 'data-gc': c,
          onclick: (e) => { e.stopPropagation(); closeMenu(); it.onPick(c); }
        }, c === it.current ? icon('check', 12) : null);
        box.append(b);
      }
      menu.append(box);
      continue;
    }
    const btn = h('button', {
      type: 'button', role: 'menuitem', class: (it.danger ? 'danger' : '') + (it.indent ? ' indent' : ''), disabled: it.disabled, 'data-testid': 'context-menu-item', 'data-action': it.action,
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.run(); }
    }, it.dot ? h('span', { class: 'mdot', 'data-gc': it.dot }) : null, h('span', { class: 'ml', text: it.label }));
    menu.append(btn);
  }
  $('menu-root').append(menu);
  menuEl = menu;
  const r = menu.getBoundingClientRect();
  const x = Math.max(4, Math.min(ev.clientX, window.innerWidth - r.width - 4));
  const y = Math.max(4, Math.min(ev.clientY, window.innerHeight - r.height - 4));
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  const first = menu.querySelector('button:not(:disabled)');
  if (first) first.focus({ preventScroll: true });
}

function showItemMenu(ev, n) {
  const tab = S.boundByBm.get(n.id);
  const tabUrl = tab && (tab.url || tab.pendingUrl);
  const diverged = !!(tab && tabUrl && normUrl(tabUrl) !== normUrl(n.url));
  showMenu(ev, [
    diverged ? { label: 'Go back to pinned page', action: 'reset', run: () => cmd('resetItem', { bookmarkId: n.id, windowId: S.windowId }) } : null,
    diverged ? '-' : null,
    { label: 'Rename', action: 'rename', run: () => startRename(n.id) },
    { label: 'Replace with current page URL', action: 'replace-url', disabled: !tab, run: async () => {
      const t = tab && await safe(chrome.tabs.get(tab.id));
      const url = t && (t.url || t.pendingUrl);
      if (url) await safe(chrome.bookmarks.update(n.id, { url }));
    } },
    '-',
    { label: 'Unpin', action: 'unpin', danger: true, run: () => cmd('unpin', { bookmarkId: n.id }) }
  ]);
}

function showFolderMenu(ev, n) {
  showMenu(ev, [
    { label: 'Rename', action: 'rename', run: () => startRename(n.id) },
    { label: 'New folder inside', action: 'new-folder', run: () => newFolder(n.id) },
    '-',
    { label: 'Delete folder', action: 'delete-folder', danger: true, run: async () => {
      const kids = (n.children || []).length;
      if (kids) {
        const ok = await confirmDialog({ title: 'Delete folder?', message: `“${n.title}” and the ${kids} item${kids === 1 ? '' : 's'} inside it will be removed.`, okLabel: 'Delete', danger: true });
        if (!ok) return;
        await safe(chrome.bookmarks.removeTree(n.id));
      } else await safe(chrome.bookmarks.remove(n.id));
    } }
  ]);
}

function windowVisibleTabs(wid) {
  if (wid === S.windowId) return S.today;
  const sec = S.sections.find((x) => x.id === wid);
  return sec ? sec.visible : [];
}

async function toNewWindow(args) {
  const r = await cmd('moveToNewWindow', args);
  if (r && r.windowId != null) await openSidePanelFor(r.windowId);
  if (r && !r.ok && r.error) toast(r.error);
}

async function newGroupWith(tab) {
  const id = await safe(chrome.tabs.group({ tabIds: [tab.id] }));
  if (id != null) { renamingId = 'g' + id; scheduleRender(); }
}

async function splitWith(tabId, targetTabId) {
  const r = await cmd('splitTabs', { tabId, targetTabId });
  if (r && !r.ok) toast(r.error || 'Could not split these tabs');
}

async function unsplit(t) {
  if (typeof chrome.tabs.unsplit === 'function' && sidOf(t) >= 0) await safe(chrome.tabs.unsplit(sidOf(t)));
}

async function swapSides(u) {
  const [a, b] = u.tabs;
  if (!b) return;
  const r = await cmd('swapSplit', { splitViewId: u.splitId != null ? u.splitId : sidOf(a), tabIds: [a.id, b.id] });
  if (r && !r.ok) toast(r.error || 'Could not swap the split view');
}

function showTabMenu(ev, tab, opts = {}) {
  const other = tab.windowId !== S.windowId;
  const inSplit = opts.split || (sidOf(tab) >= 0 ? { kind: 'split', splitId: sidOf(tab), tabs: [tab] } : null);
  const items = [];
  if (other) items.push({ label: 'Go to its window', action: 'go-window', run: () => cmd('goToTab', { tabId: tab.id }) }, '-');
  items.push(
    { label: 'Add to Favourites', action: 'add-favourite', run: () => cmd('pinTab', { tabId: tab.id, target: 'favourites', windowId: S.windowId }) },
    { label: 'Pin', action: 'pin', run: () => cmd('pinTab', { tabId: tab.id, target: 'pinned', windowId: S.windowId }) },
    '-'
  );
  if (HAS_GROUPS) {
    items.push({ label: 'Add to new group', action: 'new-group', run: () => newGroupWith(tab) });
    const gs = [...S.groups.values()].filter((g) => g.windowId === tab.windowId && g.id !== gidOf(tab));
    if (gs.length) {
      items.push({ label: 'Add to group', submenu: gs.map((g) => (
        { label: g.title || 'Unnamed group', action: 'add-to-group', dot: g.color || 'grey', run: () => safe(chrome.tabs.group({ tabIds: [tab.id], groupId: g.id })) })) });
    }
    if (gidOf(tab) >= 0) items.push({ label: 'Remove from group', action: 'remove-from-group', run: () => safe(chrome.tabs.ungroup(tab.id)) });
    items.push('-');
  }
  if (inSplit) {
    if (typeof chrome.tabs.unsplit === 'function') items.push({ label: 'Separate split view', action: 'unsplit', run: () => unsplit(tab) });
    if (inSplit.tabs && inSplit.tabs.length === 2) items.push({ label: 'Swap sides', action: 'swap-split', run: () => swapSides(inSplit) });
    items.push({ label: 'Move to new window', action: 'new-window', run: () => toNewWindow({ splitViewId: sidOf(tab) }) });
    items.push('-');
  } else {
    if (SPLIT_OK) {
      const cands = windowVisibleTabs(tab.windowId).filter((t) => t.id !== tab.id).slice(0, 8);
      if (cands.length) {
        items.push({ label: 'Split with…', submenu: cands.map((t) => (
          { label: (t.title || t.url || 'New Tab').slice(0, 40), action: 'split-with', run: () => splitWith(tab.id, t.id) })) });
      }
    } else items.push({ label: 'Split view needs Chrome 155+', action: 'split-unsupported', disabled: true, run: () => {} });
    items.push('-', { label: 'Move to new window', action: 'new-window', run: () => toNewWindow({ tabId: tab.id }) }, '-');
  }
  items.push({ label: 'Rename tab', action: 'rename-tab', run: () => startRename('n' + tab.id) });
  if (nameOf(tab)) items.push({ label: 'Reset name', action: 'reset-name', run: () => cmd('renameTab', { tabId: tab.id, name: '' }) });
  const locked = isLocked(tab);
  items.push({ label: locked ? 'Unlock tab' : 'Lock tab', action: locked ? 'unlock' : 'lock', run: () => cmd('setTabLock', { tabId: tab.id, locked: !locked }) });
  items.push(
    S.incognito || tab.incognito ? null : { label: 'Archive tab', action: 'archive', run: () => cmd('archiveTab', { tabId: tab.id }) },
    S.incognito || tab.incognito || locked || S.bindings[tab.id] ? null : { label: 'Move to Temporary', action: 'to-temporary', run: async () => {
      const r = await cmd('moveToTemporary', { tabId: tab.id });
      if (r && !r.ok) toast(r.error || 'Could not move it to Temporary');
    } },
    '-',
    { label: 'Duplicate tab', action: 'duplicate', run: () => safe(chrome.tabs.duplicate(tab.id)) },
    { label: 'Close tab', action: 'close', run: () => safe(chrome.tabs.remove(tab.id)) },
    { label: 'Close…', plain: true, submenu: [
      { label: 'Close tabs above', action: 'close-above', disabled: !closeScope(tab, 'above').length, run: () => closeMany(tab, 'above') },
      { label: 'Close tabs below', action: 'close-below', disabled: !closeScope(tab, 'below').length, run: () => closeMany(tab, 'below') },
      { label: 'Close other tabs', action: 'close-others', disabled: !closeScope(tab, 'others').length, run: () => closeMany(tab, 'others') },
      { label: 'Close all tabs', action: 'close-all', disabled: !closeScope(tab, 'all').length, run: () => closeMany(tab, 'all') }
    ] }
  );
  showMenu(ev, items);
}

function showGroupMenu(ev, g, other) {
  const tabsOf = async () => (await safe(chrome.tabs.query({ groupId: g.id }))) || [];
  showMenu(ev, [
    { label: 'Rename', action: 'rename-group', run: () => startRename('g' + g.id) },
    { swatches: GROUP_COLORS, current: g.color, label: 'Colour', onPick: (c) => safe(chrome.tabGroups.update(g.id, { color: c })) },
    { label: 'New tab in group', action: 'new-tab-in-group', run: async () => {
      const t = await safe(chrome.tabs.create({ windowId: g.windowId, active: true }));
      if (t) await safe(chrome.tabs.group({ tabIds: [t.id], groupId: g.id }));
    } },
    { label: 'Move to new window', action: 'new-window', run: () => toNewWindow({ groupId: g.id }) },
    other ? { label: 'Move group to this window', action: 'move-group-here', run: () => safe(chrome.tabGroups.move(g.id, { windowId: S.windowId, index: -1 })) } : null,
    '-',
    { label: 'Ungroup', action: 'ungroup', run: async () => { const ts = await tabsOf(); if (ts.length) await safe(chrome.tabs.ungroup(ts.map((t) => t.id))); } },
    { label: 'Archive group', action: 'archive-group', run: () => cmd('archiveGroup', { groupId: g.id }) },
    { label: 'Close group', action: 'close-group', danger: true, run: async () => { const ts = await tabsOf(); if (ts.length) await safe(chrome.tabs.remove(ts.map((t) => t.id))); } }
  ]);
}

function confirmDialog({ title, message, okLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const finish = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && document.activeElement && document.activeElement.id !== 'dlg-cancel') { e.preventDefault(); e.stopPropagation(); finish(true); }
    };
    const scrim = h('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) finish(false); } },
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, 'data-testid': 'confirm-dialog' },
        h('h3', { text: title }),
        h('p', { text: message }),
        h('div', { class: 'btns' },
          h('button', { type: 'button', id: 'dlg-cancel', class: 'btn', 'data-testid': 'confirm-cancel', text: 'Cancel', onclick: () => finish(false) }),
          h('button', { type: 'button', id: 'dlg-ok', class: 'btn primary' + (danger ? ' danger' : ''), 'data-testid': 'confirm-ok', text: okLabel, onclick: () => finish(true) }))));
    $('dialog-root').append(scrim);
    document.addEventListener('keydown', onKey, true);
    $('dlg-ok').focus();
  });
}

// ------------------------------------------------------------------ drag and drop
function startDrag(e, payload, el) {
  if (OVERLAY && isCompact()) { e.preventDefault(); return; }   // no drag and drop while compact
  if (e.target.closest && e.target.closest('.rename-input')) { e.preventDefault(); return; }
  dragging = payload;
  closeMenu();
  try {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.title || el.dataset.url || '');
  } catch { /* ignore */ }
  document.body.classList.add('dragging');
  // defer so the drag image is captured before dimming
  requestAnimationFrame(() => {
    el.classList.add('dragged');
    if (dragging) document.body.classList.add('drag-reveal');   // v2.5: empty Favourites / Pinned appear while dragging
    if (dragging && dragging.type !== 'bm') $('new-window-drop').hidden = false;
  });
}

function endDrag() {
  dragging = null;
  document.body.classList.remove('dragging', 'drag-reveal');
  $('new-window-drop').hidden = true;
  $('new-window-drop').classList.remove('over');
  clearMarks();
  document.querySelectorAll('.dragged').forEach((x) => x.classList.remove('dragged'));
  if (dirty) scheduleRender();
}

function clearMarks() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-into,.drop-end,.split-target,.swap-target,.swap-over').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-end', 'split-target', 'swap-target', 'swap-over'));
}

function isDescendantOrSelf(id, ancestorId) {
  let cur = id;
  let guard = 0;
  while (cur && guard++ < 100) {
    if (cur === ancestorId) return true;
    const e = S.bmMap.get(cur);
    cur = e && e.parentId;
  }
  return false;
}

function allowDrag(kind) {
  if (!dragging) return false;
  if (kind === 'favs') return dragging.type === 'tab' || (dragging.type === 'bm' && !dragging.isFolder);
  if (kind === 'pinned') return dragging.type === 'tab' || dragging.type === 'bm';
  if (kind === 'today') return ['tab', 'split', 'group'].includes(dragging.type) || (dragging.type === 'bm' && !dragging.isFolder);
  return false;
}

function wireDrop(el, kind, targetFn, applyFn) {
  el.addEventListener('dragover', (e) => {
    if (!allowDrag(kind)) return;
    const t = targetFn(e);
    clearMarks();
    if (!t) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.mark();
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) clearMarks();
  });
  el.addEventListener('drop', async (e) => {
    if (!allowDrag(kind)) return;
    e.preventDefault();
    const t = targetFn(e);
    const d = dragging;
    clearMarks();
    if (t && d) await applyFn(d, t);
    endDrag();
  });
}

// favourites: nearest tile + left/right half
function favTarget(e) {
  const grid = $('favs');
  const tiles = [...grid.querySelectorAll('.fav-tile')];
  if (!tiles.length) return { index: 0, mark: () => grid.classList.add('drop-into') };
  let best = null;
  let bd = Infinity;
  tiles.forEach((t, i) => {
    const r = t.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d = Math.abs(e.clientY - cy) * 4 + Math.abs(e.clientX - cx);
    if (d < bd) { bd = d; best = { t, i, cx }; }
  });
  const before = e.clientX < best.cx;
  const index = best.i + (before ? 0 : 1);
  return {
    index,
    noop: dragging && dragging.type === 'bm' && (best.t.dataset.id === dragging.id),
    mark: () => best.t.classList.add(before ? 'drop-before' : 'drop-after')
  };
}

// pinned: row + vertical zone
function pinnedTarget(e) {
  const tree = $('pinned');
  const roots = S.roots;
  if (!roots) return null;
  const rowEl = e.target.closest && e.target.closest('.prow');
  const forbid = (parentId) => dragging.type === 'bm' && isDescendantOrSelf(parentId, dragging.id);
  if (!rowEl || !tree.contains(rowEl)) {
    const parentId = roots.pinned;
    if (forbid(parentId)) return null;
    return { parentId, index: S.pinned.length, mark: () => tree.classList.add(S.flat.length ? 'drop-end' : 'drop-into') };
  }
  const entry = S.flatById.get(rowEl.dataset.id);
  if (!entry) return null;
  if (dragging.type === 'bm' && dragging.id === entry.n.id) return null;
  const rect = rowEl.getBoundingClientRect();
  const y = (e.clientY - rect.top) / rect.height;
  const n = entry.n;
  const before = { parentId: entry.parentId, index: entry.index, mark: () => rowEl.classList.add('drop-before') };
  const after = { parentId: entry.parentId, index: entry.index + 1, mark: () => rowEl.classList.add('drop-after') };
  let t;
  if (!n.url) {
    const open = !S.collapsed[n.id];
    if (y < 0.28) t = before;
    else if (open) t = { parentId: n.id, index: 0, mark: () => rowEl.classList.add('drop-into') };
    else if (y > 0.72) t = after;
    else t = { parentId: n.id, index: (n.children || []).length, mark: () => rowEl.classList.add('drop-into') };
  } else t = y < 0.5 ? before : after;
  if (forbid(t.parentId)) return null;
  return t;
}

// today: rows from every window, group headers, split rows, window headers
function lastOwnTab() { return S.today.length ? S.today[S.today.length - 1] : null; }
function firstOwnTab() { return S.today.length ? S.today[0] : null; }
function tabById(id) {
  return S.tabs.find((t) => t.id === id) || S.otherWins.flatMap((w) => w.tabs).find((t) => t.id === id) || null;
}

// Which group should a tab dropped before/after `ref` end up in?
function groupForDrop(ref, where) {
  const g = gidOf(ref);
  if (g < 0) return -1;
  const sec = ref.windowId === S.windowId ? S.today : (S.sections.find((x) => x.id === ref.windowId) || { visible: [] }).visible;
  const mates = sec.filter((t) => gidOf(t) === g);
  if (where === 'before' && mates.length && mates[0].id === ref.id) return -1;
  return g;
}

function todayTarget(e) {
  const list = $('today');
  const d = dragging;
  const tgt = e.target && e.target.closest ? e.target : null;
  const rowEl = tgt && tgt.closest('.today-row, .split-row, .group-row');
  const headEl = tgt && tgt.closest('.window-head');
  const secEl = tgt && tgt.closest('.window-section');
  const yOf = (el) => { const r = el.getBoundingClientRect(); return (e.clientY - r.top) / r.height; };
  const fail = (r) => { if (r && !r.ok && r.error) toast(r.error); };

  if (d.type === 'bm') {
    if (SPLIT_OK && rowEl && rowEl.classList.contains('today-row')) {
      const y = yOf(rowEl);
      if (y > 0.25 && y < 0.75) {
        const targetTabId = Number(rowEl.dataset.tabId);
        return { mark: () => rowEl.classList.add('split-target'), apply: async (dd) => fail(await cmd('splitTabs', { bookmarkId: dd.id, targetTabId })) };
      }
    }
    return { mark: () => list.classList.add('drop-into'), apply: (dd) => cmd('unpin', { bookmarkId: dd.id }) };
  }

  const tabIds = d.type === 'tab' ? [d.tabId] : d.type === 'split' ? d.tabIds : null;

  // dropped on a window header: append to that window
  if (headEl) {
    const wid = Number(headEl.dataset.windowId);
    return {
      mark: () => headEl.classList.add('drop-into'),
      apply: (dd) => dd.type === 'group'
        ? cmd('placeGroup', { groupId: dd.groupId, windowId: wid })
        : cmd('placeTab', { tabIds, windowId: wid, group: -1 })
    };
  }

  if (rowEl) {
    const y = yOf(rowEl);
    const isGroup = rowEl.classList.contains('group-row');
    const isSplit = rowEl.classList.contains('split-row');
    // group header
    if (isGroup) {
      const groupId = Number(rowEl.dataset.groupId);
      const members = S.groupTabs.get(groupId) || [];
      const first = members.slice().sort((a, b) => a.index - b.index)[0];
      const g = S.groups.get(groupId);
      if (d.type === 'group') {
        if (d.groupId === groupId || !first) return null;
        const where = y < 0.5 ? 'before' : 'after';
        return {
          mark: () => rowEl.classList.add(where === 'before' ? 'drop-before' : 'drop-after'),
          apply: (dd) => cmd('placeGroup', { groupId: dd.groupId, refTabId: first.id, where, windowId: first.windowId })
        };
      }
      if (y < 0.25 && first) {
        return { mark: () => rowEl.classList.add('drop-before'), apply: () => cmd('placeTab', { tabIds, refTabId: first.id, where: 'before', group: -1 }) };
      }
      if (!g) return null;
      return { mark: () => rowEl.classList.add('drop-into'), apply: () => cmd('placeTab', { tabIds, group: groupId, windowId: g.windowId }) };
    }
    // tab or split row
    let ref;
    let where = y < 0.5 ? 'before' : 'after';
    if (isSplit && d.type === 'tab' && d.fromSplit != null) {
      const ids = rowEl.dataset.tabIds.split(',').map(Number);
      const halfEl = tgt.closest('.half');
      if (ids.includes(d.tabId) && halfEl && Number(halfEl.dataset.tabId) !== d.tabId) {
        return {
          swap: true,
          mark: () => { rowEl.classList.add('swap-target'); halfEl.classList.add('swap-over'); },
          apply: () => cmd('swapSplit', { splitViewId: Number(rowEl.dataset.splitId), tabIds: ids })
        };
      }
    }
    if (isSplit) {
      const ids = rowEl.dataset.tabIds.split(',').map(Number);
      ref = tabById(where === 'before' ? ids[0] : ids[1]);
    } else ref = tabById(Number(rowEl.dataset.tabId));
    if (!ref) return null;
    if (tabIds && tabIds.includes(ref.id)) return null;
    if (d.type === 'tab' && SPLIT_OK && !isSplit && y > 0.25 && y < 0.75) {
      return { mark: () => rowEl.classList.add('split-target'), apply: async (dd) => fail(await cmd('splitTabs', { tabId: dd.tabId, targetTabId: ref.id })) };
    }
    if (d.type === 'group') {
      if (gidOf(ref) === d.groupId) return null;
      return {
        mark: () => rowEl.classList.add(where === 'before' ? 'drop-before' : 'drop-after'),
        apply: (dd) => cmd('placeGroup', { groupId: dd.groupId, refTabId: ref.id, where, windowId: ref.windowId })
      };
    }
    const group = groupForDrop(ref, where);
    return {
      mark: () => rowEl.classList.add(where === 'before' ? 'drop-before' : 'drop-after'),
      apply: () => cmd('placeTab', { tabIds, refTabId: ref.id, where, group })
    };
  }

  // empty space inside another window's section: append there
  if (secEl && !tgt.closest('.new-tab-row')) {
    const wid = Number(secEl.dataset.windowId);
    return {
      mark: () => secEl.querySelector('.window-head').classList.add('drop-into'),
      apply: (dd) => dd.type === 'group' ? cmd('placeGroup', { groupId: dd.groupId, windowId: wid }) : cmd('placeTab', { tabIds, windowId: wid, group: -1 })
    };
  }

  // new-tab row: top of this window; elsewhere: end of this window
  const onNew = tgt && tgt.closest('.new-tab-row');
  const ref = onNew ? firstOwnTab() : lastOwnTab();
  const where = onNew ? 'before' : 'after';
  const firstEl = list.querySelector('.today-row, .split-row, .group-row');
  return {
    mark: () => { if (onNew && firstEl) firstEl.classList.add('drop-before'); else list.classList.add('drop-into'); },
    apply: (dd) => {
      if (dd.type === 'group') {
        return cmd('placeGroup', { groupId: dd.groupId, refTabId: ref && ref.id, where, windowId: S.windowId });
      }
      return cmd('placeTab', { tabIds, refTabId: ref && ref.id, where, windowId: S.windowId, group: -1 });
    }
  };
}

function setupDnd() {
  wireDrop($('favs'), 'favs', favTarget, async (d, t) => {
    if (t.noop) return;
    if (d.type === 'tab') await cmd('pinTab', { tabId: d.tabId, target: 'favourites', index: t.index, windowId: S.windowId });
    else if (S.roots) await safe(chrome.bookmarks.move(d.id, { parentId: S.roots.favourites, index: t.index }));
  });
  wireDrop($('pinned'), 'pinned', pinnedTarget, async (d, t) => {
    if (d.type === 'tab') await cmd('pinTab', { tabId: d.tabId, target: 'pinned', parentId: t.parentId, index: t.index, windowId: S.windowId });
    else await safe(chrome.bookmarks.move(d.id, { parentId: t.parentId, index: t.index }));
  });
  wireDrop($('today'), 'today', todayTarget, async (d, t) => {
    // a half dragged out of its split row: separate the pair first, then place the tab (existing reorder logic)
    if (d.type === 'tab' && d.fromSplit != null && !t.swap && typeof chrome.tabs.unsplit === 'function') await safe(chrome.tabs.unsplit(d.fromSplit));
    const r = await t.apply(d);
    if (r && r.ok === false && r.error) toast(r.error);
  });
  const nw = $('new-window-drop');
  nw.addEventListener('dragover', (e) => {
    if (!dragging || dragging.type === 'bm') return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
    nw.classList.add('over');
  });
  nw.addEventListener('dragleave', (e) => { if (!nw.contains(e.relatedTarget)) nw.classList.remove('over'); });
  nw.addEventListener('drop', async (e) => {
    e.preventDefault();
    const d = dragging;
    endDrag();
    if (!d || d.type === 'bm') return;
    if (d.type === 'tab') await toNewWindow({ tabId: d.tabId });
    else if (d.type === 'group') await toNewWindow({ groupId: d.groupId });
    else if (d.type === 'split') await toNewWindow({ splitViewId: d.splitId });
  });
}

// ------------------------------------------------------------------ misc wiring
function setupAddress() {
  const input = $('addr');
  $('addr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (looksLikeUrl(text)) await safe(chrome.tabs.create({ windowId: S.windowId, url: toUrl(text), active: true }));
    else await safe(chrome.search.query({ text, disposition: 'NEW_TAB' }));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); input.value = ''; }
  });
}

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (menuEl) { e.preventDefault(); closeMenu(); return; }
      if (S.view !== 'main' && !e.target.closest('input,textarea')) { e.preventDefault(); setView('main'); }
      return;
    }
    if (menuEl) {
      const items = [...menuEl.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); closeMenu(); }
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest && e.target.closest('[data-nav]') === e.target) {
      const items = [...document.querySelectorAll('#view-main [data-nav]')];
      const i = items.indexOf(e.target);
      const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.classList && e.target.classList.contains('fav-tile')) {
      const items = [...document.querySelectorAll('.fav-tile')];
      const next = items[items.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
    }
  });
  document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('contextmenu', (e) => {
    // custom menus handle their own targets; keep the native one for text fields only
    if (!e.target.closest('input,textarea')) e.preventDefault();
  });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  document.addEventListener('scroll', closeMenu, true);
}

function setupStatic() {
  $('addr-ic').append(icon('search', 15));
  $('new-folder').append(icon('folderPlus', 15));
  $('archive-ic').append(icon('archive', 15));
  $('settings-btn').append(icon('gear', 16));
  for (const id of ['archive-back', 'settings-back']) {
    $(id).append(icon('arrowLeft', 16));
    $(id).addEventListener('click', () => setView('main'));
  }
  $('new-folder').addEventListener('click', () => newFolder(null));
  // v2.5: Pinned is hidden while empty, so offer a new pinned folder from the Today section's own context menu
  $('today').closest('.sec').addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('.today-row, .split-row, .group-row, .window-head, input, textarea')) return;
    ev.preventDefault();
    showMenu(ev, [{ label: 'New pinned folder', action: 'new-pinned-folder', run: () => newFolder(null) }]);
  });
  $('clear').addEventListener('click', async () => {
    const r = await cmd('clearToday', { windowId: S.windowId });
    if (!r || !r.ok) toast((r && r.error) || 'Could not clear Today');
    else if (r.incognito) toast(`Closed ${plural(r.closed, 'tab')}. Incognito tabs aren\u2019t archived`, { ms: 5000 });
    else if (r.archived > 0) toast(`Archived ${plural(r.archived, 'tab')}`, { undo: () => doUndo(r.undoId), ms: 8000 });
  });
  $('tidy').hidden = !HAS_GROUPS;
  $('tidy').addEventListener('click', async () => {
    const r = await cmd('tidyWindow', { windowId: S.windowId });
    if (!r || !r.ok) toast((r && r.error) || 'Could not tidy this window');
    else if (!r.tidied) toast('Nothing to tidy');
    else toast(`Tidied ${plural(r.tidied, 'tab')} into ${plural(r.groups, 'group')}`, { undo: () => doUndo(r.undoId), ms: 8000 });
  });
  $('archive-btn').addEventListener('click', () => setView(S.view === 'archive' ? 'main' : 'archive'));
  $('settings-btn').addEventListener('click', () => setView(S.view === 'settings' ? 'main' : 'settings'));
  $('archive-search').addEventListener('input', () => drawArchive());
  $('archive-clear').addEventListener('click', async () => {
    if (!S.archive.length) return;
    const ok = await confirmDialog({ title: 'Clear archive?', message: `${S.archive.length} archived tab${S.archive.length === 1 ? '' : 's'} will be permanently removed.`, okLabel: 'Clear archive', danger: true });
    if (ok) await cmd('clearArchive');
  });
  $('set-profile-archive').addEventListener('change', (e) => {
    cmd('setProfileArchive', { minutes: e.target.value === '' ? null : Number(e.target.value) });
  });
  $('set-global-archive').addEventListener('change', async (e) => {
    const r = await cmd('setGlobalArchive', { minutes: Number(e.target.value) });
    if (!r || !r.ok) scheduleRender();
  });
  $('set-profile-pick').addEventListener('change', (e) => { if (e.target.value) cmd('setProfileDir', { dir: e.target.value }); });
  $('helper-retry').addEventListener('click', () => cmd('retryHelper'));
  $('app-offline-open').addEventListener('click', () => offlineRetry(true));
  $('app-offline-retry').addEventListener('click', () => offlineRetry(false));
  $('set-overlay-enabled').addEventListener('change', async (e) => {
    const r = await cmd('setOverlayEnabled', { enabled: e.target.checked });
    if (!r || !r.ok) scheduleRender();
  });
  $('shortcut-btn').addEventListener('click', () => safe(chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })));
  const openLeft = () => safe(chrome.tabs.create({ url: 'chrome://settings/appearance' }));
  $('left-btn').addEventListener('click', openLeft);
  $('left-hint-btn').addEventListener('click', openLeft);
  $('left-hint-close').append(icon('x', 14));
  $('left-hint-close').addEventListener('click', () => {
    S.leftHintDismissed = true;
    chrome.storage.local.set({ leftHintDismissed: true }).catch(() => {});
    drawHint();
  });
  for (const b of document.querySelectorAll('#field-sidebar-color .seg-b')) {
    b.addEventListener('click', () => {
      if (b.dataset.mode === 'auto') setSidebarColor({ mode: 'auto' }, true);
      else setSidebarColor({ mode: 'custom', color: $('sbc-picker').value || '#e9eef6' }, true);
    });
  }
  $('sbc-picker').addEventListener('input', (e) => setSidebarColor({ mode: 'custom', color: e.target.value }, false));
  $('sbc-picker').addEventListener('change', (e) => setSidebarColor({ mode: 'custom', color: e.target.value }, true));
  $('set-archive-grouped').addEventListener('change', (e) => {
    S.archiveGrouped = e.target.checked;
    chrome.storage.sync.set({ archiveGrouped: e.target.checked }).catch(() => {});
  });
  $('set-merge-on-close').addEventListener('change', (e) => {
    S.mergeOnClose = e.target.checked;
    chrome.storage.sync.set({ mergeOnClose: e.target.checked }).catch(() => {});
  });
  $('set-pinned-reset').addEventListener('change', (e) => {
    S.pinnedReset = e.target.checked;
    chrome.storage.sync.set({ pinnedResetOnRestart: e.target.checked }).catch(() => {});
  });
  $('set-little-default').addEventListener('change', async (e) => {
    const r = await cmd('setDefaultBrowser', { enabled: e.target.checked });
    if (!r || !r.ok) toast((r && r.error) || 'Could not change the default browser');
    scheduleRender();
  });
  for (const b of document.querySelectorAll('[data-testid="little-style"] .seg-b')) {
    b.addEventListener('click', () => {
      S.littleStyle = b.dataset.style;
      chrome.storage.sync.set({ littleStyle: S.littleStyle }).catch(() => {});
      drawLittleSettings(!!(S.helper && S.helper.status === 'connected'));
    });
  }
  $('set-little-max').addEventListener('change', (e) => {
    S.littleMaxOpen = Number(e.target.value);
    chrome.storage.sync.set({ littleMaxOpen: S.littleMaxOpen }).catch(() => {});
  });
  $('set-temp-expiry').addEventListener('change', (e) => {
    S.temporaryMinutes = Number(e.target.value);
    chrome.storage.sync.set({ temporaryMinutes: S.temporaryMinutes }).catch(() => {});
  });
  $('temp-clear').addEventListener('click', async () => {
    const n = S.temporary.length;
    const r = await cmd('clearTemporary');
    if (!r || !r.ok) toast((r && r.error) || 'Could not clear Temporary');
    else if (n) toast(`Archived ${plural(n, 'temporary link')}`);
  });
  $('popout-merge').addEventListener('click', () => mergeWindowCmd(S.windowId));
  $('popout-bar').addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    showMenu(ev, [{ label: 'Make this the main window', action: 'make-main', run: () => cmd('setMainWindow', { windowId: S.windowId }) }]);
  });
  $('merge-all').addEventListener('click', mergeAllCmd);
  $('newwin-btn').append(icon('newWindow', 16));
  $('newwin-drop-ic').append(icon('newWindow', 18));
  $('newwin-btn').addEventListener('click', async () => {
    const w = await safe(chrome.windows.create({ focused: true }));
    if (w) await openSidePanelFor(w.id);
  });
}

function setupListeners() {
  const r = () => scheduleRender();
  chrome.tabs.onCreated.addListener(r);
  chrome.tabs.onRemoved.addListener(r);
  chrome.tabs.onMoved.addListener(r);
  chrome.tabs.onActivated.addListener(r);
  chrome.tabs.onAttached.addListener(r);
  chrome.tabs.onDetached.addListener(r);
  chrome.tabs.onReplaced.addListener(r);
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if ('title' in change || 'url' in change || 'favIconUrl' in change || 'audible' in change || 'pinned' in change || 'groupId' in change || 'splitViewId' in change) scheduleRender();
  });
  chrome.windows.onCreated.addListener(r);
  chrome.windows.onRemoved.addListener(r);
  if (chrome.tabGroups) {
    for (const ev of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) {
      try { chrome.tabGroups[ev].addListener(r); } catch { /* ignore */ }
    }
  }
  for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
    chrome.bookmarks[ev].addListener(() => scheduleRender());
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    const keys = Object.keys(changes);
    const rel = {
      session: ['bindings', 'helper', 'mainWindowId', 'windowOrder', 'lastMerge', 'overlayConnected', 'incTabNames', 'incLockedTabs', 'littleWindows'],
      local: ['lastActive', 'archive', 'globalDefaultMinutes', 'profileDir', 'collapsed', 'roots', 'collapsedWindows', 'leftHintDismissed', 'tabNames', 'lockedTabs', 'appEverConnected', 'overlayEnabled', 'temporary', 'defaultBrowser'],
      sync: ['archiveMinutes', 'archiveGrouped', 'ownStyle', 'mergeOnClose', 'sidebarColor', 'littleStyle', 'littleMaxOpen', 'temporaryMinutes', 'pinnedResetOnRestart']
    }[area];
    if (rel && keys.some((k) => rel.includes(k))) {
      // lastActive changes constantly; only the Today list reads it
      if (area === 'local' && keys.every((k) => k === 'lastActive') && S.view !== 'main') return;
      scheduleRender();
    }
  });
  chrome.windows.onFocusChanged.addListener(() => scheduleRender());
  setInterval(() => { if (S.view === 'main') scheduleRender(); }, 30000);
}

// ------------------------------------------------------------------ overlay mode (host protocol)
// Host state pushed by the app (`__sidebarHostState`): state is "collapsed" | "peek" | "pinned".
const HOSTS = { state: 'peek', compact: false, railWidth: 48, chromeColor: null, screenCapture: null, railFound: null, railControllable: true, launchAtLogin: false, lockstep: true, accessibility: null, appVersion: '', pinMode: 'push' };
let vtHintDismissed = false;
try { vtHintDismissed = localStorage.getItem('vtHintDismissed') === '1'; } catch { /* storage unavailable */ }
const hostPost = (action, value) => { try { if (window.__sidebarHost) window.__sidebarHost.post(action, value); } catch { /* ignore */ } };
const lastPosted = {};
function postOnce(action, value) {
  const k = JSON.stringify(value);
  if (lastPosted[action] === k) return;
  lastPosted[action] = k;
  hostPost(action, value);
}
const darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let themeColor = null;
function postTheme(color) {
  if (color !== undefined) themeColor = color;
  postOnce('theme', { color: themeColor, dark: OVERLAY ? resolvedDark : !!(darkMq && darkMq.matches) });
}
function postActiveTitle() {
  const t = activeTab();
  if (!t) return;
  postOnce('activeTitle', { title: t.title || '', favIconUrl: t.favIconUrl || '' });
}
function isBusy() {
  return !!(dragging || nativeMenu || document.body.classList.contains('dragging') ||
    document.querySelector('#menu-root .menu, #dialog-root .scrim, .rename-input, #view-boost textarea'));
}
function updateBusy() { postOnce('busy', isBusy()); }

const isPinned = () => HOSTS.state === 'pinned';
const isCompact = () => HOSTS.compact;

function applyHostState(st) {
  if (!st) return;
  const wasCompact = HOSTS.compact;
  const oldColor = HOSTS.chromeColor;
  if (st.state === 'collapsed' || st.state === 'peek' || st.state === 'pinned') HOSTS.state = st.state;
  else if (typeof st.pinned === 'boolean') HOSTS.state = st.pinned ? 'pinned' : 'peek'; // older hosts
  if ('compact' in st) HOSTS.compact = !!st.compact;
  else if (st.state) HOSTS.compact = HOSTS.state === 'collapsed';
  if (typeof st.railWidth === 'number' && st.railWidth >= 24 && st.railWidth <= 200) HOSTS.railWidth = st.railWidth;
  if ('chromeColor' in st) HOSTS.chromeColor = typeof st.chromeColor === 'string' && /^#[0-9a-f]{6}$/i.test(st.chromeColor) ? st.chromeColor.toLowerCase() : null;
  if ('screenCapture' in st) HOSTS.screenCapture = typeof st.screenCapture === 'boolean' ? st.screenCapture : null;
  if ('railFound' in st) HOSTS.railFound = typeof st.railFound === 'boolean' ? st.railFound : null;
  if ('railControllable' in st) HOSTS.railControllable = st.railControllable !== false;
  if ('launchAtLogin' in st) HOSTS.launchAtLogin = !!st.launchAtLogin;
  if ('lockstep' in st) HOSTS.lockstep = st.lockstep !== false;
  if ('accessibility' in st) HOSTS.accessibility = typeof st.accessibility === 'boolean' ? st.accessibility : null;
  if (typeof st.appVersion === 'string') HOSTS.appVersion = st.appVersion;
  const root = document.documentElement;
  root.style.setProperty('--icon-x', `${HOSTS.railWidth / 2}px`);
  root.classList.toggle('overlay-float', HOSTS.state === 'peek' || (isPinned() && !HOSTS.railControllable));
  if (wasCompact !== HOSTS.compact) setCompact(HOSTS.compact);
  const btn = $('pin-toggle');
  btn.setAttribute('aria-pressed', isPinned() ? 'true' : 'false');
  const lbl = isPinned() ? 'Unpin sidebar' : 'Pin sidebar';
  btn.title = lbl; btn.setAttribute('aria-label', lbl);
  drawAppSettings();
  if (loaded) {
    if (oldColor !== HOSTS.chromeColor) { drawTheme(); }
    drawHint();
  }
}

// Compact = the same layout as expanded, with fades (CSS on html.compact). The favourites grid <-> column change and the
// sections under it are animated with FLIP so nothing jumps.
function setCompact(on) {
  const root = document.documentElement;
  const flipEls = () => [...document.querySelectorAll('.fav-tile, .sec:not(.sec-favs)')];
  const first = loaded && root.offsetParent !== undefined ? new Map(flipEls().map((el) => [el, el.getBoundingClientRect()])) : null;
  root.classList.toggle('compact', on);
  const list = $('scroll-main');
  if (on) list.setAttribute('data-testid', 'compact-strip'); else list.removeAttribute('data-testid');
  if (!first || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  const moved = [];
  for (const [el, r1] of first) {
    if (!el.isConnected) continue;
    const r2 = el.getBoundingClientRect();
    const dx = r1.left - r2.left, dy = r1.top - r2.top;
    const sx = r2.width ? r1.width / r2.width : 1, sy = r2.height ? r1.height / r2.height : 1;
    const isTile = el.classList.contains('fav-tile');
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && (!isTile || (Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01))) continue;
    el.style.transition = 'none';
    el.style.transformOrigin = '0 0';
    el.style.transform = isTile ? `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` : `translate(${dx}px, ${dy}px)`;
    moved.push(el);
  }
  if (!moved.length) return;
  void root.offsetWidth; // commit the inverted state
  for (const el of moved) {
    el.style.transition = 'transform 160ms ease';
    el.style.transform = '';
  }
  setTimeout(() => { for (const el of moved) { el.style.transition = ''; el.style.transformOrigin = ''; } }, 220);
}

// Settings > App (overlay mode only): mirrors the host state; changes are posted to the app.
function drawAppSettings() {
  if (!OVERLAY) return;
  $('field-app').hidden = false;
  $('app-pinned').checked = isPinned();
  $('app-login').checked = HOSTS.launchAtLogin;
  $('app-lockstep').checked = HOSTS.lockstep;
  const ax = HOSTS.accessibility;
  $('app-ax-status').textContent = ax === true ? 'Accessibility access granted' : ax === false ? 'Accessibility access needed' : 'Accessibility access unknown';
  $('app-ax-dot').className = 'status-dot' + (ax === true ? ' ok' : ax === false ? ' bad' : '');
  $('app-ax-open').hidden = ax !== false;
  const sc = HOSTS.screenCapture;
  $('app-sc-status').textContent = sc === true ? 'On' : '';
  $('app-sc-on').hidden = sc === true;
  $('app-sc-note').hidden = sc === true;
  $('app-float-note').hidden = !(HOSTS.railFound !== false && !HOSTS.railControllable);
  $('app-version').textContent = HOSTS.appVersion ? `Sidebar ${HOSTS.appVersion}` : '';
}

// v2.5: tell the app whether an editable element has focus, so it can pass other keys through to Chrome.
const NON_TEXT_INPUT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);
function isEditableEl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT.has((el.getAttribute('type') || 'text').toLowerCase());
  return !!el.isContentEditable;
}
function setupEditingReport() {
  let timer = 0;
  lastPosted.editing = 'false';
  const sync = () => {
    clearTimeout(timer);
    timer = setTimeout(() => postOnce('editing', isEditableEl(document.activeElement) && document.hasFocus()), 30);
  };
  document.addEventListener('focusin', sync, true);
  document.addEventListener('focusout', sync, true);
  window.addEventListener('focus', sync);
  window.addEventListener('blur', () => { clearTimeout(timer); postOnce('editing', false); });
}

function setupOverlay() {
  document.documentElement.classList.add('overlay');
  drawChromeTheme(null);
  $('pin-toggle').hidden = false;
  $('pin-toggle').append(icon('pin', 15));
  $('pin-toggle').addEventListener('click', () => hostPost('setPinned', !isPinned()));
  $('set-pin-mode').addEventListener('change', (e) => hostPost('setPinMode', e.target.value));
  $('app-pinned').addEventListener('change', (e) => hostPost('setPinned', e.target.checked));
  $('app-login').addEventListener('change', (e) => hostPost('setLaunchAtLogin', e.target.checked));
  $('app-lockstep').addEventListener('change', (e) => hostPost('setLockstep', e.target.checked));
  $('app-ax-open').addEventListener('click', () => hostPost('openAccessibilitySettings', true));
  $('app-sc-on').addEventListener('click', () => hostPost('requestScreenCapture', true));
  $('app-rescan').addEventListener('click', () => hostPost('rescanRail', true));
  $('app-quit').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Quit Sidebar?', message: 'The sidebar will disappear until you open Sidebar again.', okLabel: 'Quit Sidebar', danger: true });
    if (ok) hostPost('quitApp', true);
  });
  $('vt-hint-close').append(icon('x', 14));
  $('vt-hint-close').addEventListener('click', () => {
    vtHintDismissed = true;
    try { localStorage.setItem('vtHintDismissed', '1'); } catch { /* ignore */ }
    drawHint();
  });
  setupEditingReport();
  window.__sidebarHostState = applyHostState;
  drawAppSettings();
  if (window.__sidebarHost && window.__sidebarHost.last) applyHostState(window.__sidebarHost.last);
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', () => { if (loaded) drawTheme(); });
  new MutationObserver(updateBusy).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('dragstart', () => setTimeout(updateBusy, 0), true);
  document.addEventListener('dragend', () => setTimeout(updateBusy, 0), true);
}

// ------------------------------------------------------------------ init
(async function init() {
  if (OVERLAY) setupOverlay();
  setupStatic();
  setupAddress();
  setupKeyboard();
  setupDnd();
  try {
    // ?windowId=N lets the panel be previewed in a tab for another window (used by tests).
    const forced = Number(new URLSearchParams(location.search).get('windowId'));
    const w = forced ? { id: forced } : await chrome.windows.getCurrent();
    S.windowId = w.id;
  } catch {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    S.windowId = tabs[0] ? tabs[0].windowId : chrome.windows.WINDOW_ID_CURRENT;
  }
  setupListeners();
  mountBoostButton();
  mountCaptureButton();
  try { const v = sessionStorage.getItem('view'); if (v === 'archive' || v === 'settings') S.view = v; } catch { /* ignore */ }
  await run();
  setView(S.view);
  if (OVERLAY) { postTheme(); postActiveTitle(); updateBusy(); hostPost('ready', true); }
})();
