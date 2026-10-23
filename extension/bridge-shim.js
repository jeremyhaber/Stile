// Overlay shim: when the side panel UI runs outside the extension (Sidebar.app WKWebView, or a test page),
// install a `chrome` object whose calls travel over the bridge to the extension's service worker.
// In the real extension (chrome.tabs exists) this file does nothing.
(function () {
  'use strict';
  if (globalThis.chrome && globalThis.chrome.tabs) return;

  const params = new URLSearchParams(location.search);
  const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sidebarBridge;
  const httpBase = (params.get('bridgeHttp') || '').replace(/\/+$/, '');
  if (!wk && !httpBase) return;

  const log = (...a) => { try { console.debug('[sidebar-shim]', ...a); } catch (e) { /* ignore */ } };

  // ------------------------------------------------------------ transport
  let transportOpen = Promise.resolve();
  let rawSend;
  if (wk) {
    rawSend = (obj) => { wk.postMessage(JSON.stringify(obj)); };
  } else {
    rawSend = (obj) => {
      fetch(httpBase + '/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }).catch((e) => log('send failed', e));
    };
    transportOpen = new Promise((resolve) => {
      const es = new EventSource(httpBase + '/events');
      es.onopen = () => resolve();
      es.onmessage = (ev) => receive(ev.data);
      setTimeout(resolve, 4000);
    });
  }

  // ------------------------------------------------------------ events
  const eventTargets = new Map();   // 'tabs.onCreated' -> Set<fn>
  function makeEvent(name) {
    const set = new Set();
    eventTargets.set(name, set);
    return {
      addListener(fn) { if (typeof fn === 'function') set.add(fn); },
      removeListener(fn) { set.delete(fn); },
      hasListener(fn) { return set.has(fn); },
      hasListeners() { return set.size > 0; }
    };
  }

  // ------------------------------------------------------------ calls
  const pending = new Map();
  let nextId = 1;
  function call(name, args, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const id = 'p' + nextId++ + '-' + Math.random().toString(36).slice(2, 6);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Bridge call timed out: ' + name)); }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { rawSend({ type: 'bridge', id, call: name, args: args || [] }); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }

  const host = {
    last: null,
    post(action, value) {
      try { rawSend({ type: 'host', action, value }); } catch (e) { log('host post failed', e); }
    }
  };
  window.__sidebarHost = host;

  function receive(data) {
    let m;
    try { m = typeof data === 'string' ? JSON.parse(data) : data; } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'bridgeResult') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'Bridge error'));
    } else if (m.type === 'bridgeEvent') {
      const set = eventTargets.get(m.name);
      if (!set) return;
      for (const fn of [...set]) { try { fn(...(Array.isArray(m.args) ? m.args : [])); } catch (e) { console.error(e); } }
    } else if (m.type === 'hostState') {
      const st = { pinned: !!m.pinned, pinMode: m.pinMode, state: m.state };
      host.last = st;
      if (typeof window.__sidebarHostState === 'function') { try { window.__sidebarHostState(st); } catch (e) { console.error(e); } }
    }
  }
  window.__sidebarBridgeReceive = receive;

  // Wrap a bridge call as promise-or-callback API.
  function api(name) {
    return function (...args) {
      let cb = null;
      if (args.length && typeof args[args.length - 1] === 'function') cb = args.pop();
      const p = call(name, args);
      if (!cb) return p;
      p.then((r) => { chrome.runtime.lastError = undefined; cb(r); },
        (e) => { chrome.runtime.lastError = { message: String(e && e.message || e) }; try { cb(); } finally { chrome.runtime.lastError = undefined; } });
      return undefined;
    };
  }
  function ns(prefix, fns, events) {
    const o = {};
    for (const f of fns) o[f] = api(prefix + '.' + f);
    for (const e of events || []) o[e] = makeEvent(prefix + '.' + e);
    return o;
  }

  const windowId = Number(params.get('windowId')) || 0;
  let manifest = null;
  let extId = '';

  const chrome = {
    tabs: ns('tabs', ['query', 'get', 'create', 'update', 'remove', 'move', 'duplicate', 'reload', 'group', 'ungroup', 'highlight', 'getCurrent'],
      ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onMoved', 'onAttached', 'onDetached', 'onHighlighted', 'onReplaced']),
    windows: Object.assign(ns('windows', ['getAll', 'get', 'create', 'update', 'remove', 'getLastFocused'],
      ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']), {
      getCurrent(opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = undefined; }
        const p = windowId ? Promise.resolve({ id: windowId }) : call('windows.getLastFocused', []);
        if (cb) { p.then(cb); return undefined; }
        return p;
      },
      WINDOW_ID_CURRENT: -2,
      WINDOW_ID_NONE: -1
    }),
    bookmarks: ns('bookmarks', ['get', 'getChildren', 'getTree', 'getSubTree', 'create', 'update', 'move', 'remove', 'removeTree', 'search', 'getRecent'],
      ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded']),
    tabGroups: Object.assign(ns('tabGroups', ['query', 'get', 'update', 'move'], ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']), { TAB_GROUP_ID_NONE: -1 }),
    search: ns('search', ['query']),
    storage: {
      local: ns('storage.local', ['get', 'set', 'remove', 'clear']),
      sync: ns('storage.sync', ['get', 'set', 'remove', 'clear']),
      session: ns('storage.session', ['get', 'set', 'remove', 'clear']),
      onChanged: makeEvent('storage.onChanged')
    },
    sidePanel: { open: () => Promise.resolve(), setOptions: () => Promise.resolve() },
    runtime: {
      get id() { return extId; },
      lastError: undefined,
      getURL(path) { return `chrome-extension://${extId}/${String(path || '').replace(/^\/+/, '')}`; },
      getManifest() { return manifest || {}; },
      sendMessage(msg, cb) {
        const p = call('sidebar.cmd', [msg]);
        if (typeof cb === 'function') { p.then((r) => cb(r), () => cb()); return undefined; }
        return p;
      },
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } }
    }
  };
  globalThis.chrome = chrome;

  // ------------------------------------------------------------ ready: hello + capabilities
  window.__sidebarReady = (async () => {
    await transportOpen;
    // Retry hello for a while: the extension/helper may still be connecting.
    let hello = null;
    let lastErr = null;
    for (let i = 0; i < 20 && !hello; i++) {
      try { hello = await call('sidebar.hello', [], 4000); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500)); }
    }
    if (!hello) throw lastErr || new Error('Sidebar extension not reachable');
    extId = hello.extensionId || '';
    manifest = { version: hello.version, name: 'Sidebar', manifest_version: 3 };
    try { const full = await call('runtime.getManifest', []); if (full) manifest = full; } catch (e) { /* ignore */ }
    let caps = { split: false, tabGroups: false, userScripts: false };
    try { caps = await call('sidebar.capabilities', []); } catch (e) { /* ignore */ }
    if (caps.split) { chrome.tabs.createSplit = api('tabs.createSplit'); chrome.tabs.unsplit = api('tabs.unsplit'); }
    if (!caps.tabGroups) { delete chrome.tabGroups; delete chrome.tabs.group; delete chrome.tabs.ungroup; }
    chrome.__caps = caps;
    chrome.__hello = hello;
    return hello;
  })();
  window.__sidebarReady.catch((e) => console.error('[sidebar-shim] not ready', e));

  // ------------------------------------------------------------ favicons
  const favPromises = new Map();
  const EXT_RE = /^chrome-extension:\/\//i;
  function swapFavicon(url) {
    let p = favPromises.get(url);
    if (!p) {
      p = window.__sidebarReady.then(() => call('sidebar.favicon', [url]));
      favPromises.set(url, p);
      p.catch(() => favPromises.delete(url));
    }
    return p;
  }
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: srcDesc.enumerable,
      get() { return srcDesc.get.call(this); },
      set(v) {
        const s = String(v);
        if (!EXT_RE.test(s)) { this.__favTok = null; srcDesc.set.call(this, s); return; }
        const tok = (this.__favTok = {});
        swapFavicon(s).then((d) => { if (this.__favTok === tok) srcDesc.set.call(this, d); },
          (e) => { log('favicon swap failed', s, e && e.message); if (this.__favTok === tok) srcDesc.set.call(this, 'data:,'); });
      }
    });
  }
  function fixImg(img) {
    const s = img.getAttribute('src');
    if (s && EXT_RE.test(s)) img.src = s;   // goes through the patched setter (which then sets a data: URL)
  }
  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'IMG') fixImg(node);
    else if (node.querySelectorAll) node.querySelectorAll('img').forEach(fixImg);
  }
  const startObserver = () => {
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') { if (m.target.tagName === 'IMG') fixImg(m.target); }
        else m.addedNodes.forEach(scan);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  };
  startObserver();
})();
