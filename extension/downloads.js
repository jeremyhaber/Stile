// v3.2: the downloads popover (hover the Archive button) and dragging finished files out into other apps.
// Self-contained: sidepanel.js hands in a few helpers and a "may I show?" predicate.
import { icon } from './icons.js';

const MAX_ROWS = 4;
const OPEN_DELAY = 250;
const CLOSE_DELAY = 300;
const POLL_MS = 500;

export const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

export function fmtBytes(n) {
  if (!(n >= 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return (i === 0 ? String(Math.round(v)) : v >= 100 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + u[i];
}

export function fileNameOf(d) {
  const b = baseName(d.filename);
  if (b) return b;
  try { return decodeURIComponent(baseName(new URL(d.finalUrl || d.url).pathname)) || 'Download'; } catch { return 'Download'; }
}

// Row text for a DownloadItem: { text, progress: null | 0..1 | -1 (unknown total) }.
export function describe(d) {
  if (d.state === 'in_progress') {
    const total = d.totalBytes > 0 ? d.totalBytes : 0;
    if (d.paused) return { text: total ? `Paused · ${fmtBytes(d.bytesReceived)} of ${fmtBytes(total)}` : 'Paused', progress: total ? d.bytesReceived / total : -1, paused: true };
    if (!total) return { text: d.bytesReceived ? `${fmtBytes(d.bytesReceived)} so far` : 'Starting…', progress: -1 };
    return { text: `${fmtBytes(d.bytesReceived)} of ${fmtBytes(total)}`, progress: Math.min(1, d.bytesReceived / total) };
  }
  if (d.state === 'interrupted') return { text: d.error === 'USER_CANCELED' ? 'Cancelled' : 'Failed', progress: null };
  if (d.danger && d.danger !== 'safe' && d.danger !== 'accepted') return { text: 'Check in Chrome', progress: null };
  if (d.exists === false) return { text: 'File moved or deleted', progress: null };
  const size = d.fileSize > 0 ? d.fileSize : d.totalBytes;
  return { text: size > 0 ? fmtBytes(size) : 'Done', progress: null };
}

export const isDraggable = (d) => d.state === 'complete' && d.exists !== false && !!d.filename && (!d.danger || d.danger === 'safe' || d.danger === 'accepted');

// ctx: { h, $, cmd, hostPost, OVERLAY, canShow(): boolean, busy(): boolean }
export function setupDownloads(ctx) {
  const { h, $, cmd } = ctx;
  const dl = chrome.downloads;
  if (!dl || typeof dl.search !== 'function') return { hide() {}, refresh() {} };
  const btn = $('archive-btn');
  let pop = null;
  let items = [];
  let openTimer = 0;
  let closeTimer = 0;
  let poll = 0;
  let seq = 0;
  const icons = new Map();   // download id -> data URL | null

  const safe = async (p) => { try { return await p; } catch { return undefined; } };

  async function fetchItems() {
    const list = await safe(dl.search({ orderBy: ['-startTime'], limit: MAX_ROWS * 3 }));
    return (list || []).filter((d) => d && d.state && !(d.state === 'interrupted' && d.error === 'USER_CANCELED' && !d.bytesReceived)).slice(0, MAX_ROWS);
  }

  function iconFor(id, img) {
    if (icons.has(id)) { const v = icons.get(id); if (v) img.src = v; return; }
    icons.set(id, null);
    Promise.resolve(safe(dl.getFileIcon(id, { size: 32 }))).then((u) => {
      if (typeof u === 'string' && u) { icons.set(id, u); const el = pop && pop.querySelector(`.dl-row[data-id="${id}"] img.dl-img`); if (el) { el.src = u; el.hidden = false; } }
    });
  }

  async function activate(d) {
    hide(true);
    if (d.state === 'complete' && d.exists !== false && typeof dl.open === 'function') {
      try { await dl.open(d.id); return; } catch { /* fall through to show */ }
    }
    await safe(dl.show(d.id));
  }

  function rowEl(d) {
    const info = describe(d);
    const drag = isDraggable(d);
    const img = h('img', { class: 'dl-img', alt: '', hidden: true, draggable: 'false' });
    const row = h('div', {
      class: 'dl-row' + (d.state === 'interrupted' ? ' is-failed' : ''), role: 'listitem', tabindex: '0', title: d.filename || d.url,
      'data-testid': 'download-row', 'data-id': d.id, 'data-state': d.state, 'data-name': fileNameOf(d), 'data-path': d.filename || '',
      draggable: drag ? 'true' : null,
      onclick: () => activate(d),
      onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(d); } },
      ondragstart: (ev) => {
        if (!drag) { ev.preventDefault(); return; }
        if (ctx.OVERLAY || typeof dl.drag !== 'function') {
          // The web drag can't leave the panel: the app starts a native file drag instead.
          ev.preventDefault();
          ctx.hostPost('dragDownload', { path: d.filename, clientX: Math.round(ev.clientX), clientY: Math.round(ev.clientY) });
        } else {
          try { dl.drag(d.id); } catch { ev.preventDefault(); }
        }
      }
    },
    h('span', { class: 'dl-ic' }, icon('file', 20), img),
    h('div', { class: 'dl-body' },
      h('div', { class: 'dl-name', text: fileNameOf(d) }),
      info.progress !== null
        ? h('div', { class: 'dl-progress' + (info.progress < 0 ? ' indeterminate' : '') + (info.paused ? ' paused' : ''), 'data-testid': 'download-progress', 'data-progress': info.progress < 0 ? '' : String(Math.round(info.progress * 100)), role: 'progressbar', 'aria-valuenow': info.progress < 0 ? null : String(Math.round(info.progress * 100)) },
          h('span', { class: 'dl-bar', style: info.progress < 0 ? null : `width:${Math.round(info.progress * 100)}%` }))
        : null,
      h('div', { class: 'dl-meta', 'data-testid': 'download-meta', text: info.text })));
    iconFor(d.id, img);
    img.addEventListener('load', () => { img.hidden = false; row.querySelector('.ic-file').hidden = true; });
    return row;
  }

  function paint() {
    if (!pop) return;
    pop.replaceChildren(
      h('div', { class: 'dl-list', role: 'list', 'aria-label': 'Recent downloads' }, items.map(rowEl)),
      h('button', { type: 'button', class: 'dl-all', 'data-testid': 'downloads-show-all', onclick: () => { hide(true); safe(chrome.tabs.create({ url: 'chrome://downloads' })); } },
        icon('download', 14), h('span', { text: 'Show all downloads' })));
  }

  async function refresh() {
    if (!pop) return;
    const my = ++seq;
    const next = await fetchItems();
    if (my !== seq || !pop) return;
    items = next;
    if (!items.length) { hide(true); return; }
    // Same rows, only text/progress changed: keep the DOM (hover, an ongoing drag) and patch in place.
    const rows = [...pop.querySelectorAll('.dl-row')];
    const same = rows.length === items.length && rows.every((r, i) => Number(r.dataset.id) === items[i].id && r.dataset.state === items[i].state && (r.draggable === isDraggable(items[i])));
    if (same) {
      items.forEach((d, i) => {
        const info = describe(d);
        const r = rows[i];
        r.querySelector('.dl-meta').textContent = info.text;
        const pr = r.querySelector('.dl-progress');
        if (pr && info.progress !== null && info.progress >= 0) {
          pr.dataset.progress = String(Math.round(info.progress * 100));
          pr.setAttribute('aria-valuenow', pr.dataset.progress);
          pr.firstElementChild.style.width = pr.dataset.progress + '%';
          pr.classList.toggle('paused', !!info.paused);
        }
      });
    } else paint();
    syncPoll();
  }

  function syncPoll() {
    const active = !!pop && items.some((d) => d.state === 'in_progress' && !d.paused);
    if (active && !poll) poll = setInterval(refresh, POLL_MS);
    else if (!active && poll) { clearInterval(poll); poll = 0; }
  }

  async function show() {
    clearTimeout(closeTimer);
    if (pop || !ctx.canShow()) return;
    const first = await fetchItems();
    if (pop || !first.length || !ctx.canShow()) return;
    items = first;
    pop = h('div', { class: 'dl-pop', role: 'dialog', 'aria-label': 'Downloads', 'data-testid': 'downloads-popover' });
    pop.addEventListener('pointerenter', () => clearTimeout(closeTimer));
    pop.addEventListener('pointerleave', () => scheduleHide());
    document.body.append(pop);
    const foot = $('footer');
    if (foot) pop.style.bottom = Math.max(0, window.innerHeight - foot.getBoundingClientRect().top - 2) + 'px';
    paint();
    syncPoll();
  }

  function hide(now) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (!now) return;
    if (pop) { pop.remove(); pop = null; }
    if (poll) { clearInterval(poll); poll = 0; }
    seq++;
  }
  function scheduleHide() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => hide(true), CLOSE_DELAY);
  }
  function scheduleShow() {
    clearTimeout(closeTimer);
    if (pop) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { if (!ctx.busy()) show(); }, OPEN_DELAY);
  }

  btn.addEventListener('pointerenter', scheduleShow);
  btn.addEventListener('pointerleave', scheduleHide);
  btn.addEventListener('focus', () => { if (btn.matches(':focus-visible')) scheduleShow(); });
  btn.addEventListener('blur', () => scheduleHide());
  btn.addEventListener('click', () => hide(true));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) hide(true); }, true);
  window.addEventListener('blur', () => hide(true));
  window.addEventListener('resize', () => hide(true));

  const live = () => { if (pop) refresh(); };
  for (const ev of ['onCreated', 'onChanged', 'onErased']) {
    try { dl[ev].addListener(live); } catch { /* event unavailable */ }
  }
  return { hide: () => hide(true), refresh };
}
