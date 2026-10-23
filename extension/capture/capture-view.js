// Side panel / overlay UI for screenshots: camera button, Recent captures view, Settings section.
// Plain DOM like boost-view.js; talks to the service worker through ctx.cmd.
import { PRESETS, DEFAULT_S3, s3Configured } from './s3.js';

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
const AFTER = [['editor', 'Open the editor'], ['thumbnail', 'Show a thumbnail'], ['copy', 'Copy to the clipboard only']];
const EXPIRY = [[3600, '1 hour'], [86400, '24 hours'], [604800, '7 days']];

export function renderCaptureSettings(containerEl, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'sec cap-settings'; wrap.setAttribute('data-testid', 'capture-settings');
  wrap.innerHTML = `<div class="sec-h"><h2>Screenshots</h2></div>
<div class="field">
  <label for="cap-after">After taking a screenshot</label>
  <select id="cap-after" data-testid="capture-after">${AFTER.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
  <p class="hint" id="cap-after-hint"></p>
  <label class="check sub"><input type="checkbox" id="cap-annotate" data-testid="capture-annotate"><span>Annotation tools in the editor</span></label>
  <label class="check sub"><input type="checkbox" id="cap-ask" data-testid="capture-ask-where"><span>Ask where to save each time</span></label>
  <p class="hint">Saved screenshots go to Downloads / Screenshots. Alt+Shift+3 selects a region; set shortcuts for Visible area and Full page at <b>chrome://extensions/shortcuts</b>.</p>
</div>
<div class="field cap-upload" data-testid="capture-upload-settings">
  <label>Upload to your own storage</label>
  <p class="hint">Any S3-compatible bucket. Your keys stay in this browser (never synced) and are only sent to the endpoint you enter here.</p>
  <label for="cap-preset" class="sublabel">Provider</label>
  <select id="cap-preset" data-testid="capture-s3-preset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select>
  <p class="hint" id="cap-preset-hint"></p>
  <label for="cap-endpoint" class="sublabel">Endpoint URL</label>
  <input id="cap-endpoint" class="cap-in" data-testid="capture-s3-endpoint" type="url" spellcheck="false" autocomplete="off" placeholder="https://s3.us-east-1.amazonaws.com">
  <div class="cap-two">
    <div><label for="cap-region" class="sublabel">Region</label><input id="cap-region" class="cap-in" data-testid="capture-s3-region" spellcheck="false" autocomplete="off"></div>
    <div><label for="cap-bucket" class="sublabel">Bucket</label><input id="cap-bucket" class="cap-in" data-testid="capture-s3-bucket" spellcheck="false" autocomplete="off"></div>
  </div>
  <label for="cap-akid" class="sublabel">Access key ID</label>
  <input id="cap-akid" class="cap-in" data-testid="capture-s3-key" spellcheck="false" autocomplete="off">
  <label for="cap-secret" class="sublabel">Secret access key</label>
  <input id="cap-secret" class="cap-in" data-testid="capture-s3-secret" type="password" spellcheck="false" autocomplete="new-password">
  <label for="cap-prefix" class="sublabel">Path prefix</label>
  <input id="cap-prefix" class="cap-in" data-testid="capture-s3-prefix" spellcheck="false" autocomplete="off" placeholder="screenshots/{yyyy}/{mm}/">
  <div class="cap-two">
    <div><label for="cap-style" class="sublabel">Addressing</label><select id="cap-style" data-testid="capture-s3-style"><option value="path">Path style</option><option value="virtual">Virtual-hosted</option></select></div>
    <div><label for="cap-naming" class="sublabel">File names</label><select id="cap-naming" data-testid="capture-s3-naming"><option value="random">Random id</option><option value="timestamp">Timestamp</option></select></div>
  </div>
  <label for="cap-link" class="sublabel">Link type</label>
  <select id="cap-link" data-testid="capture-s3-linktype"><option value="public">Public base URL</option><option value="presigned">Presigned link</option></select>
  <div id="cap-public"><label for="cap-base" class="sublabel">Public base URL</label><input id="cap-base" class="cap-in" data-testid="capture-s3-base" type="url" spellcheck="false" autocomplete="off" placeholder="https://shots.example.com/"></div>
  <div id="cap-expiry"><label for="cap-exp" class="sublabel">Link expires after</label><select id="cap-exp" data-testid="capture-s3-expiry">${EXPIRY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
  <div class="cap-actions">
    <button type="button" class="btn" data-testid="capture-s3-test">Test connection</button>
    <button type="button" class="btn danger" data-testid="capture-s3-clear">Clear credentials</button>
  </div>
  <p class="hint cap-result" id="cap-result" data-testid="capture-s3-result" role="status"></p>
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
  const paint = () => {
    for (const [k, id] of Object.entries(fields)) $(id).value = cfg[k] ?? '';
    $('cap-preset').value = cfg.preset in PRESETS ? cfg.preset : 'custom';
    $('cap-exp').value = String(cfg.expiry);
    $('cap-preset-hint').textContent = PRESETS[$('cap-preset').value].hint;
    $('cap-public').hidden = cfg.linkType === 'presigned';
    $('cap-expiry').hidden = cfg.linkType !== 'presigned';
  };
  const loadS3 = async () => {
    try { cfg = { ...DEFAULT_S3, ...((await chrome.storage.local.get('captureS3')).captureS3 || {}) }; } catch { /* ignore */ }
    paint();
  };
  let saveT = 0;
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => chrome.storage.local.set({ captureS3: cfg }), 200); };
  for (const [k, id] of Object.entries(fields)) {
    $(id).addEventListener('input', () => { cfg[k] = $(id).value.trim(); if (k === 'linkType') paint(); persist(); });
    $(id).addEventListener('change', () => { cfg[k] = $(id).value.trim(); paint(); persist(); });
  }
  $('cap-exp').onchange = () => { cfg.expiry = Number($('cap-exp').value); persist(); };
  $('cap-preset').onchange = () => {
    const p = PRESETS[$('cap-preset').value];
    cfg.preset = $('cap-preset').value; cfg.endpoint = p.endpoint; cfg.region = p.region; cfg.style = p.style;
    paint(); persist();
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
