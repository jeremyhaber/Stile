// Overlay bridge (service worker side): executes chrome.* calls for the Mac app and forwards chrome.* events.
// Messages travel over the native port (helper relay): app -> {type:'bridge', id, call, args} -> here,
// replies/events go back as {type:'bridgeResult'|'bridgeEvent'}. No module-level state needs to survive a restart
// except the "overlay connected" flag, which is mirrored in storage.session.overlayConnected.

let deps = { dispatchCommand: null, post: null };
let connected = false;
let loaded = null;
const faviconCache = new Map();

const NS_TWO = new Set(['tabs', 'windows', 'bookmarks', 'tabGroups']);
const STORAGE_FNS = new Set(['get', 'set', 'remove', 'clear']);
const STORAGE_AREAS = new Set(['local', 'sync', 'session']);

const EVENTS = {
  tabs: ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onMoved', 'onAttached', 'onDetached', 'onHighlighted', 'onReplaced'],
  windows: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'],
  bookmarks: ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered'],
  tabGroups: ['onCreated', 'onUpdated', 'onRemoved', 'onMoved'],
  storage: ['onChanged']
};

function safeJson(v) {
  if (v === undefined) return null;
  try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
}

function send(msg) {
  try { if (deps.post) deps.post(msg); } catch { /* port gone: drop silently */ }
}

async function loadFlag() {
  try {
    const o = await chrome.storage.session.get('overlayConnected');
    connected = !!o.overlayConnected;
  } catch { /* ignore */ }
}

function forward(name, args) {
  (loaded || Promise.resolve()).then(() => {
    if (!connected) return;
    if (name === 'storage.onChanged') {
      const ch = args[0] || {};
      const keys = Object.keys(ch);
      if (keys.length && keys.every((k) => k === 'overlayConnected')) return;
    }
    send({ type: 'bridgeEvent', name, args: safeJson(args) || [] });
  });
}

export function registerBridgeListeners(d) {
  deps = { ...deps, ...(d || {}) };
  loaded = loadFlag();
  for (const [ns, evs] of Object.entries(EVENTS)) {
    for (const ev of evs) {
      try {
        const target = chrome[ns] && chrome[ns][ev];
        if (target && typeof target.addListener === 'function') target.addListener((...args) => forward(`${ns}.${ev}`, args));
      } catch { /* API unavailable (e.g. tabGroups) */ }
    }
  }
}

function resolveCall(call) {
  const parts = String(call || '').split('.');
  if (parts[0] === 'storage' && parts.length === 3 && STORAGE_AREAS.has(parts[1]) && STORAGE_FNS.has(parts[2])) {
    const area = chrome.storage[parts[1]];
    return area && typeof area[parts[2]] === 'function' ? (...a) => area[parts[2]](...a) : null;
  }
  if (parts.length !== 2) return null;
  const [ns, fn] = parts;
  const ok = NS_TWO.has(ns) || (ns === 'search' && fn === 'query') || (ns === 'runtime' && fn === 'getManifest');
  if (!ok || !chrome[ns] || typeof chrome[ns][fn] !== 'function') return null;
  return (...a) => chrome[ns][fn](...a);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function favicon(url) {
  let u = String(url || '');
  if (!/^chrome-extension:\/\//i.test(u)) u = chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(u) + '&size=32');
  if (faviconCache.has(u)) { const v = faviconCache.get(u); faviconCache.delete(u); faviconCache.set(u, v); return v; }
  const res = await fetch(u);
  if (!res.ok) throw new Error('favicon HTTP ' + res.status);
  const type = res.headers.get('content-type') || 'image/png';
  const data = `data:${type};base64,${bufToB64(await res.arrayBuffer())}`;
  faviconCache.set(u, data);
  while (faviconCache.size > 500) faviconCache.delete(faviconCache.keys().next().value);
  return data;
}

async function profileDir() {
  try { const o = await chrome.storage.session.get('helper'); return (o.helper && o.helper.currentProfileDir) || null; } catch { return null; }
}

async function run(call, args) {
  args = Array.isArray(args) ? args : [];
  if (call === 'sidebar.cmd') {
    if (!deps.dispatchCommand) throw new Error('dispatcher unavailable');
    return await deps.dispatchCommand(args[0], { bridge: true });
  }
  if (call === 'sidebar.favicon') return await favicon(args[0]);
  if (call === 'sidebar.hello') {
    const m = chrome.runtime.getManifest();
    return { extensionId: chrome.runtime.id, version: m.version, profileDir: await profileDir() };
  }
  if (call === 'sidebar.capabilities') {
    return {
      split: typeof (chrome.tabs && chrome.tabs.createSplit) === 'function',
      tabGroups: !!chrome.tabGroups && typeof chrome.tabs.group === 'function',
      userScripts: !!chrome.userScripts
    };
  }
  const fn = resolveCall(call);
  if (!fn) throw new Error('Call not allowed: ' + call);
  return await fn(...args);
}

export async function handleBridgeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'overlayStatus') {
    connected = !!msg.connected;
    try { await chrome.storage.session.set({ overlayConnected: connected }); } catch { /* ignore */ }
    return;
  }
  if (msg.type !== 'bridge') return;
  const id = msg.id;
  try {
    const result = await run(msg.call, msg.args);
    send({ type: 'bridgeResult', id, ok: true, result: safeJson(result) });
  } catch (e) {
    send({ type: 'bridgeResult', id, ok: false, error: String((e && e.message) || e) });
  }
}
