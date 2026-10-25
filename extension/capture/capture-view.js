// Side panel / overlay UI for screenshots: camera button, Recent captures view, Settings section.
// Plain DOM like boost-view.js; talks to the service worker through ctx.cmd.
import { DEFAULT_S3, PRESIGN_MAX, s3Configured, migrateS3, regionFromEndpoint, effectiveRegion, autoStyle, testConnection } from './s3.js';

const svg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  film: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18M8 5v14M16 5v14"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const MODE_LABEL = { visible: 'Visible area', full: 'Full page', region: 'Region', screen: 'Screen', area: 'Area', window: 'Window', activeWindow: 'Active window', repeatArea: 'Repeated area', delayed: 'Delayed screen', file: 'Opened image', clipboard: 'Clipboard', scroll: 'Scrolling capture' };

// ------------------------------------------------------------------ the button + its menu
export function createCaptureButton(ctx) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn cap-btn';
  b.setAttribute('data-testid', 'capture-button');
  b.title = 'Screenshot'; b.setAttribute('aria-label', 'Screenshot'); b.setAttribute('aria-haspopup', 'menu');
  b.innerHTML = ICONS.camera;
  const start = async (mode) => {
    const r = await ctx.cmd('captureStart', { mode, windowId: ctx.windowId });
    if (r && r.ok === false && r.error && !/Cancelled/.test(r.error)) ctx.toast(r.error);
  };
  b.addEventListener('click', (e) => {
    const r = b.getBoundingClientRect();
    ctx.showMenu({ clientX: Math.round(r.right), clientY: Math.round(r.bottom + 4), preventDefault() {}, stopPropagation() {} }, [
      { label: 'Visible area', action: 'capture-visible', run: () => start('visible') },
      { label: 'Full page', action: 'capture-full', run: () => start('full') },
      { label: 'Region…', action: 'capture-region', run: () => start('region') },
      { label: 'Pick color from screen…', action: 'capture-color', run: () => pickScreenColor(ctx) },
      '-',
      { label: 'Recent captures', action: 'capture-recent', run: () => ctx.openRecent() },
    ]);
    e.stopPropagation();
  });
  return b;
}

// ------------------------------------------------------------------ color picker
// Picks a color from anywhere on the screen and copies its hex. Overlay mode asks Stile.app (macOS's color sampler: the
// system loupe, no Screen Recording needed; the app copies to the pasteboard). The side panel uses Chrome's EyeDropper,
// which also reaches outside the browser; it needs the click's user gesture, so this must run straight from the menu.
export async function pickScreenColor(ctx) {
  if (window.__sidebarHost) {
    const hex = await new Promise((resolve) => {
      window.__sidebarColorPicked = (h) => { window.__sidebarColorPicked = null; resolve(h); };
      window.__sidebarHost.post('pickScreenColor');
    });
    if (hex) ctx.toast(`Copied ${hex}`);
    return hex || null;
  }
  if (typeof window.EyeDropper !== 'function') { ctx.toast('Color picking isn’t available here'); return null; }
  let hex;
  try {
    hex = (await new window.EyeDropper().open()).sRGBHex;
  } catch (e) {
    if (e && e.name !== 'AbortError') ctx.toast('Couldn’t pick a color');
    return null;
  }
  try { await navigator.clipboard.writeText(hex); ctx.toast(`Copied ${hex}`); }
  catch { ctx.toast(`Picked ${hex} (couldn’t copy it)`); }
  return hex;
}

// ------------------------------------------------------------------ recent captures
const fmtTime = (t) => {
  const d = new Date(t), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + hm;
};
const fmtDuration = (s) => { s = Math.round(Number(s) || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

export function renderCaptureRecent(rootEl, ctx) {
  let dead = false;
  rootEl.textContent = '';
  const view = document.createElement('div');
  view.className = 'cap-view'; view.setAttribute('data-testid', 'capture-recent-view');
  view.innerHTML = `<div class="cap-head"><button type="button" class="icon-btn" data-testid="back-button" aria-label="Back" title="Back">${ICONS.back}</button><h1>Recent captures</h1><span class="cap-sp"></span><button type="button" class="btn small" data-testid="capture-clear-all" hidden>Clear all</button></div><div class="cap-list" role="list" data-testid="capture-recent-list"></div>`;
  rootEl.append(view);
  const list = view.querySelector('.cap-list');
  const clearBtn = view.querySelector('[data-testid=capture-clear-all]');
  view.querySelector('[data-testid=back-button]').onclick = () => ctx.goBack();
  let armed = false;
  clearBtn.onclick = async () => {
    if (!armed) { armed = true; clearBtn.textContent = 'Click again to clear'; setTimeout(() => { armed = false; clearBtn.textContent = 'Clear all'; }, 3000); return; }
    await ctx.cmd('captureClear', {}); draw();
  };
  const draw = async () => {
    const r = await ctx.cmd('captureList', {});
    if (dead) return;
    const items = (r && r.captures) || [];
    const recs = (r && r.recordings) || [];
    list.textContent = '';
    clearBtn.hidden = !items.length;
    if (!items.length && !recs.length) { list.innerHTML = '<div class="cap-empty" data-testid="capture-recent-empty">No screenshots yet.<br>Use the camera button next to the address field.</div>'; return; }
    // v3.6: recordings made by Stile.app (the app keeps the video; this is the thumbnail, the title and the link)
    if (recs.length) {
      const h = document.createElement('div'); h.className = 'cap-sub'; h.textContent = 'Recordings'; list.append(h);
      for (const c of recs) {
        const row = document.createElement('div');
        row.className = 'cap-item'; row.setAttribute('role', 'listitem'); row.setAttribute('data-testid', 'capture-recording-item'); row.dataset.id = c.id;
        const meta = [fmtDuration(c.duration), fmtTime(c.time), c.link ? '' : 'Not uploaded'].filter(Boolean).join(' · ');
        const inner = `<span class="cap-thumb">${c.thumb ? `<img alt="" src="data:image/jpeg;base64,${esc(c.thumb)}">` : ICONS.film}</span><span class="cap-txt"><b>${esc(c.title || 'Recording')}</b><small>${esc(meta)}</small></span>`;
        row.innerHTML = c.link
          ? `<a class="cap-open" data-testid="capture-recording-open" href="${esc(c.link)}" target="_blank" rel="noopener" title="Open the link">${inner}</a><button type="button" class="icon-btn cap-del" data-testid="capture-recording-copy" aria-label="Copy link" title="Copy link">${ICONS.link}</button>`
          : `<div class="cap-open" title="Recorded with Stile.app. Open it from the menu bar.">${inner}</div>`;
        const copy = row.querySelector('[data-testid=capture-recording-copy]');
        if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(c.link); } catch { /* ignore */ } copy.title = 'Copied'; setTimeout(() => { copy.title = 'Copy link'; }, 1500); };
        list.append(row);
      }
      if (items.length) { const h2 = document.createElement('div'); h2.className = 'cap-sub'; h2.textContent = 'Screenshots'; list.append(h2); }
    }
    for (const c of items) {
      const row = document.createElement('div');
      row.className = 'cap-item'; row.setAttribute('role', 'listitem'); row.setAttribute('data-testid', 'capture-recent-item'); row.dataset.id = c.id;
      const meta = [MODE_LABEL[c.mode] || c.mode, fmtTime(c.time), `${c.width}×${c.height}`].join(' · ');
      row.innerHTML = `<button type="button" class="cap-open" title="Open in the editor"><span class="cap-thumb"><img alt="" src="${esc(c.thumb)}"></span><span class="cap-txt"><b>${esc(c.title || hostOf(c.url) || 'Screenshot')}</b><small>${esc(meta)}</small></span>${c.link ? `<span class="cap-linked" data-testid="capture-recent-link" title="${esc(c.link)}">${ICONS.link}</span>` : ''}</button><button type="button" class="icon-btn cap-del" data-testid="capture-recent-delete" aria-label="Delete" title="Delete">${ICONS.trash}</button>`;
      row.querySelector('.cap-open').onclick = () => ctx.cmd('captureOpen', { id: c.id });
      row.querySelector('.cap-del').onclick = async () => { await ctx.cmd('captureDelete', { id: c.id }); draw(); };
      list.append(row);
    }
  };
  const onSt = (ch, area) => { if (area === 'session' && ch.capTick) { if (!view.isConnected) { chrome.storage.onChanged.removeListener(onSt); return; } draw(); } };
  chrome.storage.onChanged.addListener(onSt);
  draw();
  return () => { dead = true; chrome.storage.onChanged.removeListener(onSt); };
}

// ------------------------------------------------------------------ settings
// Rendered by settings.html (Screenshots section) with the window's own row styles (.group / .row / .lbl / .ctl).
// Two sources: this browser's own storage (side panel only) and, while Stile.app is connected (or in the app's own
// settings window, `settings.html?host=app`), the app, which owns the capture settings (v3.5c): rows marked
// data-app-only appear, data-ext-only ones go.
const AFTER = [['editor', 'Open the editor'], ['thumbnail', 'Show a thumbnail'], ['copy', 'Copy to the clipboard only']];
const EXPIRY = [[900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours'], [86400, '24 hours'], [259200, '3 days'], [PRESIGN_MAX, '7 days (the longest allowed)']];
const S3_KEYS = ['endpoint', 'region', 'regionAuto', 'bucket', 'accessKeyId', 'prefix', 'style', 'naming', 'linkType', 'recordingShare', 'publicBase', 'expiry'];

/**
 * Where the app-owned capture settings come from. The app's own settings window supplies `ctx.capApp`; an extension
 * page reads them from the `appState` the app pushes (session storage) and writes through the service worker, which
 * relays to the app. `state()` resolves { capture, microphones, ... } or null when there is no app.
 */
export function appBackend(ctx) {
  if (ctx.capApp) return ctx.capApp;
  return {
    async state() {
      let s = {};
      try { s = await chrome.storage.session.get(['helper', 'appState']); } catch { /* ignore */ }
      if (!s.helper || s.helper.status !== 'connected' || !s.appState || !s.appState.capture) return null;
      return { ...s.appState };
    },
    async set(patch) {
      const r = await ctx.cmd('captureAppSet', { patch });
      if (!r || !r.ok) ctx.toast((r && r.error) || 'Stile.app didn’t respond');
    },
    async full() { const r = await ctx.cmd('captureAppFull'); return r && r.ok ? r.settings : null; },
    async choose(kind) { await ctx.cmd('captureAppChoose', { kind }); },
    subscribe(cb) {
      const f = (ch, area) => { if (area === 'session' && (ch.appState || ch.helper)) cb(); };
      chrome.storage.onChanged.addListener(f);
      return () => chrome.storage.onChanged.removeListener(f);
    },
  };
}

export function renderCaptureSettings(containerEl, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'cap-settings'; wrap.setAttribute('data-testid', 'capture-settings');
  const row = (id, label, desc, ctl, cls = '', attr = '') => `<div class="row ${cls}" data-row="${id}" ${attr}><div class="lbl"><label class="t" for="${id}">${label}</label>${desc ? `<div class="d">${desc}</div>` : ''}</div><div class="ctl">${ctl}</div></div>`;
  const selBox = (inner) => `<span class="sel">${inner}</span>`;
  wrap.innerHTML = `
${ctx.appHost ? '<h2 class="group-h">Screenshots</h2>' : ''}
<div class="group" id="cap-grp-shots">
  ${row('cap-after', 'After taking a screenshot', '', selBox(`<select id="cap-after" data-testid="capture-after">${AFTER.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`), '', 'data-ext-only')}
  ${row('cap-annotate', 'Annotation tools in the editor', 'Draw, add text and blur parts of a screenshot before sharing it.', '<input type="checkbox" id="cap-annotate" data-testid="capture-annotate">')}
  ${row('cap-ask', 'Ask where to save each time', '<span id="cap-ask-d">Off saves to Downloads / Screenshots.</span>', '<input type="checkbox" id="cap-ask" data-testid="capture-ask-where">')}
  ${row('cap-folder-choose', 'Save screenshots to', 'Where screenshots go when you save them.', '<span class="status" id="cap-folder-path" data-testid="capture-folder"></span><button type="button" class="btn" id="cap-folder-choose" data-testid="capture-folder-choose">Choose…</button>', '', 'data-app-only hidden')}
  ${row('cap-shadow', 'Shadow on window screenshots', 'Keeps macOS’s shadow and rounded corners around a captured window.', '<input type="checkbox" id="cap-shadow" data-testid="capture-shadow">', '', 'data-app-only hidden')}
</div>
<p class="note" id="cap-after-hint" data-ext-only></p>
<p class="note" data-ext-only>Alt+Shift+3 selects a region. Set shortcuts for Visible area and Full page at <b>chrome://extensions/shortcuts</b>.</p>

<div data-app-only hidden>
  <h2 class="group-h">Screenshots and recordings</h2>
  <div class="group" id="cap-grp-shared">
    ${row('cap-pattern', 'File name', 'Tokens: {yyyy} {mm} {dd} {hh} {min} {ss} {app}', '<input id="cap-pattern" type="text" data-testid="capture-pattern" spellcheck="false" autocomplete="off">', 'form')}
  </div>
  <p class="note">These apply to both screenshots and screen recordings.</p>
</div>

<h2 class="group-h" id="cap-upload-h">Upload to your own storage</h2>
<div data-testid="capture-upload-settings">
<div class="group cap-upload">
  ${row('cap-endpoint', 'Endpoint URL', '', '<input id="cap-endpoint" data-testid="capture-s3-endpoint" type="url" spellcheck="false" autocomplete="off" placeholder="https://s3.us-east-1.amazonaws.com">', 'form')}
  ${row('cap-bucket', 'Bucket', '', '<input id="cap-bucket" type="text" data-testid="capture-s3-bucket" spellcheck="false" autocomplete="off">', 'form')}
  ${row('cap-akid', 'Access key ID', '', '<input id="cap-akid" type="text" data-testid="capture-s3-key" spellcheck="false" autocomplete="off">', 'form')}
  ${row('cap-secret', 'Secret access key', '', '<input id="cap-secret" type="password" data-testid="capture-s3-secret" spellcheck="false" autocomplete="new-password">', 'form')}
  ${row('cap-region', 'Region', 'Optional. Filled in from the endpoint when it can.', '<input id="cap-region" type="text" data-testid="capture-s3-region" spellcheck="false" autocomplete="off" placeholder="us-east-1">', 'form')}
  ${row('cap-prefix', 'Path prefix', '', '<input id="cap-prefix" type="text" data-testid="capture-s3-prefix" spellcheck="false" autocomplete="off" placeholder="screenshots/{yyyy}/{mm}/">', 'form')}
  ${row('cap-naming', 'File names', '', selBox('<select id="cap-naming" data-testid="capture-s3-naming"><option value="random">Random id</option><option value="timestamp">Timestamp</option></select>'))}
  ${row('cap-link', 'Link type', '', selBox('<select id="cap-link" data-testid="capture-s3-linktype"><option value="presigned">Presigned link</option><option value="public">Public base URL</option></select>'))}
  ${row('cap-share', 'Link for recordings', 'Page: a small share page with a player. Direct file: the video itself.', selBox('<select id="cap-share" data-testid="capture-s3-recordshare"><option value="page">Share page</option><option value="file">Direct file</option></select>'), '', 'data-app-only hidden')}
  <div id="cap-public">${row('cap-base', 'Public base URL', 'Links are this address plus the file name.', '<input id="cap-base" type="url" data-testid="capture-s3-base" spellcheck="false" autocomplete="off" placeholder="https://shots.example.com/">', 'form')}</div>
  <div id="cap-expiry">${row('cap-exp', 'Link expires after', 'Presigned links can’t last longer than 7 days. For links that never expire, make the bucket (or a CDN in front of it) public and use a public base URL.', selBox(`<select id="cap-exp" data-testid="capture-s3-expiry">${EXPIRY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`))}</div>
  <div class="row"><div class="lbl"><div class="t">Advanced</div></div><div class="ctl"><button type="button" class="btn small" id="cap-adv" data-testid="capture-s3-advanced" aria-expanded="false">Show</button></div></div>
  <div id="cap-advanced" hidden>${row('cap-style', 'Addressing', '', selBox('<select id="cap-style" data-testid="capture-s3-style"><option value="auto">Automatic</option><option value="path">Path style</option><option value="virtual">Virtual-hosted</option></select>'))}<div class="row"><div class="lbl"><div class="d" id="cap-style-hint"></div></div></div></div>
  <div class="row actions">
    <button type="button" class="btn" data-testid="capture-s3-test">Test connection</button>
    <button type="button" class="btn danger" data-testid="capture-s3-clear">Clear credentials</button>
  </div>
</div>
<p class="note cap-result" id="cap-result" data-testid="capture-s3-result" role="status"></p>
<p class="note">Works with any S3-compatible service (AWS, Cloudflare R2, Backblaze B2, iDrive e2, Wasabi, MinIO, …). <span id="cap-keys-note">Your keys stay in this browser (never synced) and are only sent to the endpoint you enter here.</span></p>
</div>`;
  containerEl.append(wrap);
  const $ = (id) => wrap.querySelector('#' + id);
  const q = (t) => wrap.querySelector(`[data-testid=${t}]`);
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage;
  let dead = false;
  let api = null;                         // the app, when it owns the settings
  let appSt = null;                       // its latest state { capture, microphones, ... }
  let pendingSecret = null;               // a secret typed in the app's settings and not sent yet
  const backend = appBackend(ctx);

  // ---- behaviour settings: storage.sync here, or the app
  const loadBasic = async () => {
    let s = {};
    try { s = await chrome.storage.sync.get({ captureAfter: 'editor', captureAnnotate: true, captureAskWhere: false }); } catch { /* ignore */ }
    $('cap-after').value = s.captureAfter;
    $('cap-annotate').checked = s.captureAnnotate !== false;
    $('cap-ask').checked = !!s.captureAskWhere;
    afterHint();
  };
  const afterHint = () => {
    $('cap-after-hint').textContent = { editor: 'Opens in a window where you can annotate, copy, save or upload.', thumbnail: 'A small card appears bottom-right with Copy, Save, Edit and Upload. It hides after 6 seconds.', copy: 'The picture goes straight to the clipboard.' }[$('cap-after').value];
  };
  // Global settings: through the service worker's setShared (the app keeps them) when this page has a command channel.
  const putShared = (v) => (hasChrome && ctx && ctx.cmd ? ctx.cmd('setShared', { values: v }) : chrome.storage.sync.set(v));
  $('cap-after').onchange = () => { putShared({ captureAfter: $('cap-after').value }); afterHint(); };
  $('cap-annotate').onchange = () => (api ? api.set({ annotate: $('cap-annotate').checked }) : putShared({ captureAnnotate: $('cap-annotate').checked }));
  $('cap-ask').onchange = () => (api ? api.set({ askWhere: $('cap-ask').checked }) : putShared({ captureAskWhere: $('cap-ask').checked }));
  $('cap-folder-choose').onclick = () => api && api.choose('screenshots');
  $('cap-pattern').addEventListener('input', () => api && api.set({ filenamePattern: $('cap-pattern').value }));
  $('cap-shadow').onchange = () => api && api.set({ windowShadow: $('cap-shadow').checked });

  // ---- upload
  let cfg = { ...DEFAULT_S3 };
  const fields = { endpoint: 'cap-endpoint', region: 'cap-region', bucket: 'cap-bucket', accessKeyId: 'cap-akid', secretAccessKey: 'cap-secret', prefix: 'cap-prefix', style: 'cap-style', naming: 'cap-naming', linkType: 'cap-link', recordingShare: 'cap-share', publicBase: 'cap-base' };
  const styleHint = () => {
    const a = autoStyle(cfg.endpoint);
    $('cap-style-hint').textContent = cfg.style === 'auto' ? `Automatic uses ${a === 'virtual' ? 'virtual-hosted' : 'path'} addressing for this endpoint (virtual-hosted for amazonaws.com, path-style for everything else).` : `Forced to ${cfg.style === 'virtual' ? 'virtual-hosted' : 'path'} addressing.`;
  };
  const active = () => (wrap.contains(document.activeElement) ? document.activeElement.id : null);
  const paint = (except) => {
    for (const [k, id] of Object.entries(fields)) {
      if (id === except) continue;
      if (k === 'secretAccessKey' && api) { if (pendingSecret === null) $(id).value = ''; continue; }
      $(id).value = cfg[k] ?? (k === 'recordingShare' ? 'page' : '');
    }
    $('cap-secret').placeholder = api && appSt && appSt.capture.s3.secretSet && pendingSecret === null ? '•••••••• saved in the Keychain' : '';
    $('cap-exp').value = String(cfg.expiry);
    $('cap-region').placeholder = regionFromEndpoint(cfg.endpoint) || 'us-east-1';
    $('cap-public').hidden = cfg.linkType === 'presigned';
    $('cap-expiry').hidden = cfg.linkType !== 'presigned';
    styleHint();
  };
  const loadS3 = async () => {
    try {
      const m = migrateS3((await chrome.storage.local.get('captureS3')).captureS3 || {});
      cfg = m.cfg;
      if (m.changed) await chrome.storage.local.set({ captureS3: cfg });
    } catch { /* ignore */ }
    paint();
  };
  let saveT = 0;
  const flush = async () => {
    clearTimeout(saveT);
    if (api) {
      const s3 = {};
      for (const k of S3_KEYS) s3[k] = cfg[k];
      await api.set({ s3 });
    } else await chrome.storage.local.set({ captureS3: cfg });
  };
  // the secret goes to the app on its own, once the field is left: never with other fields, never empty
  const commitSecret = async () => {
    if (!api || pendingSecret === null) return;
    const v = pendingSecret; pendingSecret = null;
    cfg.secretAccessKey = ''; $('cap-secret').value = '';
    await api.set({ s3: { secretAccessKey: v } });
  };
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => flush().catch(() => {}), 200); };
  // Region follows the endpoint until the user types their own.
  const followEndpoint = () => {
    if (cfg.regionAuto || !String(cfg.region || '').trim()) { cfg.region = regionFromEndpoint(cfg.endpoint) || 'us-east-1'; cfg.regionAuto = true; $('cap-region').value = cfg.region; }
  };
  for (const [k, id] of Object.entries(fields)) {
    const take = (e) => {
      if (api && k === 'secretAccessKey') {
        // the app keeps the secret: sent once the field is left (not per key), never sent empty (Clear credentials does that),
        // and the field is emptied again afterwards
        if (!$(id).value) return;
        pendingSecret = $(id).value.trim();
        if (e && e.type === 'change') commitSecret().catch(() => {});
        return;
      }
      cfg[k] = $(id).value.trim();
      if (k === 'region') { cfg.regionAuto = !cfg.region; if (cfg.regionAuto) followEndpoint(); }
      if (k === 'endpoint') { followEndpoint(); }
      if (k === 'linkType' || k === 'style' || k === 'endpoint') paint(id);
      persist();
    };
    $(id).addEventListener('input', take);
    $(id).addEventListener('change', take);
  }
  $('cap-exp').onchange = () => { cfg.expiry = Number($('cap-exp').value); persist(); };
  q('capture-s3-advanced').onclick = () => {
    const open = $('cap-advanced').hidden;
    $('cap-advanced').hidden = !open;
    q('capture-s3-advanced').textContent = open ? 'Hide' : 'Show';
    q('capture-s3-advanced').setAttribute('aria-expanded', String(open));
  };
  const result = (t, bad) => { const r = $('cap-result'); r.textContent = t; r.dataset.bad = bad ? 'true' : 'false'; };
  q('capture-s3-test').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; result('Testing…');
    try {
      await flush(); await commitSecret();
      let r;
      if (api) {
        // the secret never sits in this page: ask the app for the full settings just for the test
        const full = await api.full();
        const c = { ...DEFAULT_S3, ...(full && full.s3) };
        r = ctx.capApp
          ? await testConnection(c, { fetch: api.fetch }).then(() => ({ ok: true }), (err) => ({ ok: false, error: String((err && err.message) || err) }))
          : await ctx.cmd('captureTestS3', { cfg: c });
      } else r = await ctx.cmd('captureTestS3', { cfg });
      if (r && r.ok) result('Connected. A test file was written and deleted.'); else result((r && r.error) || 'Could not connect', true);
    } finally { b.disabled = false; }
  };
  q('capture-s3-clear').onclick = async () => {
    cfg.accessKeyId = ''; cfg.secretAccessKey = '';
    if (api) { pendingSecret = null; await api.set({ s3: { accessKeyId: '', secretAccessKey: '' } }); } else await chrome.storage.local.set({ captureS3: cfg });
    paint(); result('Credentials cleared.');
  };

  // ---- source: the app when it owns the settings, else this browser
  const paintApp = () => {
    const c = appSt.capture;
    $('cap-annotate').checked = c.annotate !== false;
    $('cap-ask').checked = !!c.askWhere;
    $('cap-folder-path').textContent = c.screenshotFolder;
    $('cap-folder-path').title = c.screenshotFolder;
    if (active() !== 'cap-pattern') $('cap-pattern').value = c.filenamePattern;
    $('cap-shadow').checked = c.windowShadow !== false;
    cfg = { ...DEFAULT_S3, ...c.s3, secretAccessKey: '' };
    delete cfg.secretSet;
    paint(active());
  };
  const refreshSource = async () => {
    if (dead) return;
    const st = await backend.state();
    api = st ? backend : null;
    appSt = st;
    wrap.dataset.source = api ? 'app' : 'extension';
    for (const e of wrap.querySelectorAll('[data-ext-only]')) e.hidden = !!api;
    for (const e of wrap.querySelectorAll('[data-app-only]')) e.hidden = !api;
    // one cap-ask row: with the screenshots when alone, in the shared group when the app owns settings
    const askRow = wrap.querySelector('[data-row=cap-ask]');
    if (api) $('cap-grp-shared').prepend(askRow);
    else $('cap-grp-shots').insertBefore(askRow, wrap.querySelector('[data-row=cap-annotate]').nextSibling);
    $('cap-ask-d').textContent = api ? 'Off saves screenshots and recordings to their folders.' : 'Off saves to Downloads / Screenshots.';
    $('cap-upload-h').textContent = api ? 'Upload screenshots and recordings to your own storage' : 'Upload to your own storage';
    $('cap-keys-note').textContent = api ? 'The secret key is kept in the macOS Keychain, and only sent to the endpoint you enter here.' : 'Your keys stay in this browser (never synced) and are only sent to the endpoint you enter here.';
    if (api) paintApp();
    else if (hasChrome) { loadBasic(); loadS3(); }
  };
  const onSt = (ch, area) => {
    if (!wrap.isConnected) { chrome.storage.onChanged.removeListener(onSt); return; }
    if (area === 'sync' && (ch.captureAfter || ch.captureAnnotate || ch.captureAskWhere) && !api) loadBasic();
  };
  if (hasChrome) chrome.storage.onChanged.addListener(onSt);
  const unsub = backend.subscribe ? backend.subscribe(() => refreshSource()) : null;
  refreshSource();
  return () => { dead = true; if (hasChrome) chrome.storage.onChanged.removeListener(onSt); if (unsub) unsub(); };
}

// Recording defaults (the recorder itself arrives in 3.6): visible only while the app owns the settings.
export function renderRecordingSettings(containerEl, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'cap-recording'; wrap.setAttribute('data-testid', 'recording-settings');
  wrap.hidden = true;
  const selBox = (inner) => `<span class="sel">${inner}</span>`;
  const opts = (pairs) => pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const row = (id, label, desc, ctl) => `<div class="row"><div class="lbl"><label class="t" for="${id}">${label}</label>${desc ? `<div class="d">${desc}</div>` : ''}</div><div class="ctl">${ctl}</div></div>`;
  wrap.innerHTML = `${ctx.appHost ? '' : '<h2 class="group-h">Recording</h2>'}
<div class="group">
  ${row('rec-folder-choose', 'Save recordings to', '<span id="rec-folder-d">Screen recordings go to the screenshot folder unless you pick another.</span>', '<span class="status" id="rec-folder-path" data-testid="recording-folder"></span><button type="button" class="btn" id="rec-folder-reset" data-testid="recording-folder-reset" hidden>Use screenshot folder</button><button type="button" class="btn" id="rec-folder-choose" data-testid="recording-folder-choose">Choose…</button>')}
  ${row('rec-countdown', 'Countdown before recording', '3, 2, 1, then recording starts.', '<input type="checkbox" id="rec-countdown" data-testid="recording-countdown">')}
  ${row('rec-cursor', 'Show the cursor', '', '<input type="checkbox" id="rec-cursor" data-testid="recording-cursor">')}
  ${row('rec-sys', 'Record system audio', '', '<input type="checkbox" id="rec-sys" data-testid="recording-system-audio">')}
  ${row('rec-mic', 'Microphone', 'Asks for permission the first time you record with it.', selBox('<select id="rec-mic" data-testid="recording-mic"></select>'))}
  ${row('rec-fps', 'Frame rate', '', selBox(`<select id="rec-fps" data-testid="recording-fps">${opts([[30, '30 fps'], [60, '60 fps']])}</select>`))}
  ${row('rec-codec', 'Format', 'H.264 plays everywhere; HEVC makes smaller files.', selBox(`<select id="rec-codec" data-testid="recording-codec">${opts([['h264', 'H.264'], ['hevc', 'HEVC']])}</select>`))}
  ${row('rec-res', 'Largest size', 'Retina screens are scaled down to this height.', selBox(`<select id="rec-res" data-testid="recording-max-resolution">${opts([['1080p', '1080p'], ['1440p', '1440p'], ['native', 'Full resolution']])}</select>`))}
</div>
<p class="note">Screen recording is coming in a later update. These are the defaults it will use.</p>`;
  containerEl.append(wrap);
  const $ = (id) => wrap.querySelector('#' + id);
  const backend = appBackend(ctx);
  let api = null, dead = false;
  const rec = (patch) => api && api.set({ recording: patch });
  $('rec-folder-choose').onclick = () => api && api.choose('recordings');
  $('rec-folder-reset').onclick = () => api && api.set({ recordingFolder: '' });   // "" = same as screenshots
  $('rec-countdown').onchange = () => rec({ countdown: $('rec-countdown').checked });
  $('rec-cursor').onchange = () => rec({ showCursor: $('rec-cursor').checked });
  $('rec-sys').onchange = () => rec({ systemAudio: $('rec-sys').checked });
  $('rec-mic').onchange = () => rec({ micDeviceId: $('rec-mic').value });
  $('rec-fps').onchange = () => rec({ fps: Number($('rec-fps').value) });
  $('rec-codec').onchange = () => rec({ codec: $('rec-codec').value });
  $('rec-res').onchange = () => rec({ maxResolution: $('rec-res').value });
  const draw = async () => {
    if (dead) return;
    const st = await backend.state();
    api = st ? backend : null;
    wrap.hidden = !st;
    if (!st) return;
    const c = st.capture, r = c.recording || {};
    const follows = typeof c.recordingFolderFollowsScreenshots === 'boolean' ? c.recordingFolderFollowsScreenshots : c.recordingFolder === c.screenshotFolder;
    $('rec-folder-path').textContent = follows ? 'Same as screenshots' : c.recordingFolder;
    $('rec-folder-path').title = c.recordingFolder;
    $('rec-folder-reset').hidden = follows;
    $('rec-countdown').checked = r.countdown !== false;
    $('rec-cursor').checked = r.showCursor !== false;
    $('rec-sys').checked = !!r.systemAudio;
    const mics = [['', 'None'], ...(st.microphones || []).map((m) => [m.id, m.name])];
    if (r.micDeviceId && !mics.some(([v]) => v === r.micDeviceId)) mics.push([r.micDeviceId, 'Unavailable device']);
    const sig = JSON.stringify(mics);
    if ($('rec-mic').dataset.sig !== sig) { $('rec-mic').replaceChildren(...mics.map(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; return o; })); $('rec-mic').dataset.sig = sig; }
    $('rec-mic').value = r.micDeviceId || '';
    $('rec-fps').value = String(r.fps === 60 ? 60 : 30);
    $('rec-codec').value = r.codec === 'hevc' ? 'hevc' : 'h264';
    $('rec-res').value = r.maxResolution || '1080p';
  };
  const unsub = backend.subscribe ? backend.subscribe(() => draw()) : null;
  draw();
  return () => { dead = true; if (unsub) unsub(); };
}
export { s3Configured };
