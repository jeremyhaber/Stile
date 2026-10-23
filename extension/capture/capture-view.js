// Side panel / overlay UI for screenshots: camera button, Recent captures view, Settings section.
// Plain DOM like boost-view.js; talks to the service worker through ctx.cmd.
import { DEFAULT_S3, s3Configured, migrateS3, regionFromEndpoint, effectiveRegion, autoStyle } from './s3.js';

const svg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const MODE_LABEL = { visible: 'Visible area', full: 'Full page', region: 'Region' };

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
      '-',
      { label: 'Recent captures', action: 'capture-recent', run: () => ctx.openRecent() },
    ]);
    e.stopPropagation();
  });
  return b;
}

// ------------------------------------------------------------------ recent captures
const fmtTime = (t) => {
  const d = new Date(t), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + hm;
};
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
    list.textContent = '';
    clearBtn.hidden = !items.length;
    if (!items.length) { list.innerHTML = '<div class="cap-empty" data-testid="capture-recent-empty">No screenshots yet.<br>Use the camera button next to the address field.</div>'; return; }
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
const AFTER = [['editor', 'Open the editor'], ['thumbnail', 'Show a thumbnail'], ['copy', 'Copy to the clipboard only']];
const EXPIRY = [[3600, '1 hour'], [86400, '24 hours'], [604800, '7 days']];

export function renderCaptureSettings(containerEl, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'cap-settings'; wrap.setAttribute('data-testid', 'capture-settings');
  const row = (id, label, desc, ctl, cls = '') => `<div class="row ${cls}" data-row="${id}"><div class="lbl"><label class="t" for="${id}">${label}</label>${desc ? `<div class="d">${desc}</div>` : ''}</div><div class="ctl">${ctl}</div></div>`;
  const selBox = (inner) => `<span class="sel">${inner}</span>`;
  wrap.innerHTML = `
<div class="group">
  ${row('cap-after', 'After taking a screenshot', '', selBox(`<select id="cap-after" data-testid="capture-after">${AFTER.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`))}
  ${row('cap-annotate', 'Annotation tools in the editor', 'Draw, add text and blur parts of a screenshot before sharing it.', '<input type="checkbox" id="cap-annotate" data-testid="capture-annotate">')}
  ${row('cap-ask', 'Ask where to save each time', 'Off saves to Downloads / Screenshots.', '<input type="checkbox" id="cap-ask" data-testid="capture-ask-where">')}
</div>
<p class="note" id="cap-after-hint"></p>
<p class="note">Alt+Shift+3 selects a region. Set shortcuts for Visible area and Full page at <b>chrome://extensions/shortcuts</b>.</p>

<h2 class="group-h">Upload to your own storage</h2>
<div data-testid="capture-upload-settings">
<div class="group cap-upload">
  ${row('cap-endpoint', 'Endpoint URL', '', '<input id="cap-endpoint" data-testid="capture-s3-endpoint" type="url" spellcheck="false" autocomplete="off" placeholder="https://s3.us-east-1.amazonaws.com">', 'form')}
  ${row('cap-bucket', 'Bucket', '', '<input id="cap-bucket" type="text" data-testid="capture-s3-bucket" spellcheck="false" autocomplete="off">', 'form')}
  ${row('cap-akid', 'Access key ID', '', '<input id="cap-akid" type="text" data-testid="capture-s3-key" spellcheck="false" autocomplete="off">', 'form')}
  ${row('cap-secret', 'Secret access key', '', '<input id="cap-secret" type="password" data-testid="capture-s3-secret" spellcheck="false" autocomplete="new-password">', 'form')}
  ${row('cap-region', 'Region', 'Optional. Filled in from the endpoint when it can.', '<input id="cap-region" type="text" data-testid="capture-s3-region" spellcheck="false" autocomplete="off" placeholder="us-east-1">', 'form')}
  ${row('cap-prefix', 'Path prefix', '', '<input id="cap-prefix" type="text" data-testid="capture-s3-prefix" spellcheck="false" autocomplete="off" placeholder="screenshots/{yyyy}/{mm}/">', 'form')}
  ${row('cap-naming', 'File names', '', selBox('<select id="cap-naming" data-testid="capture-s3-naming"><option value="random">Random id</option><option value="timestamp">Timestamp</option></select>'))}
  ${row('cap-link', 'Link type', '', selBox('<select id="cap-link" data-testid="capture-s3-linktype"><option value="public">Public base URL</option><option value="presigned">Presigned link</option></select>'))}
  <div id="cap-public">${row('cap-base', 'Public base URL', 'Links are this address plus the file name.', '<input id="cap-base" type="url" data-testid="capture-s3-base" spellcheck="false" autocomplete="off" placeholder="https://shots.example.com/">', 'form')}</div>
  <div id="cap-expiry">${row('cap-exp', 'Link expires after', '', selBox(`<select id="cap-exp" data-testid="capture-s3-expiry">${EXPIRY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`))}</div>
  <div class="row"><div class="lbl"><div class="t">Advanced</div></div><div class="ctl"><button type="button" class="btn small" id="cap-adv" data-testid="capture-s3-advanced" aria-expanded="false">Show</button></div></div>
  <div id="cap-advanced" hidden>${row('cap-style', 'Addressing', '', selBox('<select id="cap-style" data-testid="capture-s3-style"><option value="auto">Automatic</option><option value="path">Path style</option><option value="virtual">Virtual-hosted</option></select>'))}<div class="row"><div class="lbl"><div class="d" id="cap-style-hint"></div></div></div></div>
  <div class="row actions">
    <button type="button" class="btn" data-testid="capture-s3-test">Test connection</button>
    <button type="button" class="btn danger" data-testid="capture-s3-clear">Clear credentials</button>
  </div>
</div>
<p class="note cap-result" id="cap-result" data-testid="capture-s3-result" role="status"></p>
<p class="note">Works with any S3-compatible service (AWS, Cloudflare R2, Backblaze B2, iDrive e2, Wasabi, MinIO, …). Your keys stay in this browser (never synced) and are only sent to the endpoint you enter here.</p>
</div>`;
  containerEl.append(wrap);
  const $ = (id) => wrap.querySelector('#' + id);
  const q = (t) => wrap.querySelector(`[data-testid=${t}]`);
  let dead = false;

  // ---- behaviour settings (storage.sync)
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
  $('cap-after').onchange = () => { chrome.storage.sync.set({ captureAfter: $('cap-after').value }); afterHint(); };
  $('cap-annotate').onchange = () => chrome.storage.sync.set({ captureAnnotate: $('cap-annotate').checked });
  $('cap-ask').onchange = () => chrome.storage.sync.set({ captureAskWhere: $('cap-ask').checked });

  // ---- upload (storage.local only)
  let cfg = { ...DEFAULT_S3 };
  const fields = { endpoint: 'cap-endpoint', region: 'cap-region', bucket: 'cap-bucket', accessKeyId: 'cap-akid', secretAccessKey: 'cap-secret', prefix: 'cap-prefix', style: 'cap-style', naming: 'cap-naming', linkType: 'cap-link', publicBase: 'cap-base' };
  const styleHint = () => {
    const a = autoStyle(cfg.endpoint);
    $('cap-style-hint').textContent = cfg.style === 'auto' ? `Automatic uses ${a === 'virtual' ? 'virtual-hosted' : 'path'} addressing for this endpoint (virtual-hosted for amazonaws.com, path-style for everything else).` : `Forced to ${cfg.style === 'virtual' ? 'virtual-hosted' : 'path'} addressing.`;
  };
  const paint = (except) => {
    for (const [k, id] of Object.entries(fields)) if (id !== except) $(id).value = cfg[k] ?? '';
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
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => chrome.storage.local.set({ captureS3: cfg }), 200); };
  // Region follows the endpoint until the user types their own.
  const followEndpoint = () => {
    if (cfg.regionAuto || !String(cfg.region || '').trim()) { cfg.region = regionFromEndpoint(cfg.endpoint) || 'us-east-1'; cfg.regionAuto = true; $('cap-region').value = cfg.region; }
  };
  for (const [k, id] of Object.entries(fields)) {
    const take = (e) => {
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
    clearTimeout(saveT); await chrome.storage.local.set({ captureS3: cfg });
    const r = await ctx.cmd('captureTestS3', { cfg });
    b.disabled = false;
    if (r && r.ok) result('Connected. A test file was written and deleted.'); else result((r && r.error) || 'Could not connect', true);
  };
  q('capture-s3-clear').onclick = async () => {
    cfg.accessKeyId = ''; cfg.secretAccessKey = '';
    await chrome.storage.local.set({ captureS3: cfg }); paint(); result('Credentials cleared.');
  };
  const onSt = (ch, area) => {
    if (!wrap.isConnected) { chrome.storage.onChanged.removeListener(onSt); return; }
    if (area === 'sync' && (ch.captureAfter || ch.captureAnnotate || ch.captureAskWhere)) loadBasic();
  };
  chrome.storage.onChanged.addListener(onSt);
  loadBasic(); loadS3();
  return () => { dead = true; chrome.storage.onChanged.removeListener(onSt); };
}
export { s3Configured };
