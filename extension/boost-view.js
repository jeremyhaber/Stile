// Overlay mode: the bridge shim must be ready before any chrome.* use.
if (window.__sidebarReady) { try { await window.__sidebarReady; } catch { /* sidepanel.js reports it */ } }

import { faviconUrl } from './shared.js';

// Boost UI for the side panel: toolbar button, Boost view, Settings section.
const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true">${body}</svg>`;
export const BOOST_ICONS = {
  bolt: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  braces: svg('<path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>'),
  sparkles: svg('<path d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8z"/><path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  reload: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseTab(tab) {
  const url = tab?.url || tab?.pendingUrl || '';
  let u; try { u = new URL(url); } catch { return { ok: false, hostname: '', tabId: tab?.id }; }
  const okProto = u.protocol === 'http:' || u.protocol === 'https:';
  const store = u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
  return { ok: okProto && !!u.hostname && !store, hostname: u.hostname, url, tabId: tab.id };
}
async function activeTab(windowId) {
  try { const [t] = await chrome.tabs.query({ active: true, windowId }); return t || null; } catch { return null; }
}
const boostsOf = async () => { try { return (await chrome.storage.local.get('boosts')).boosts || {}; } catch { return {}; } };

// ---------------- toolbar button ----------------
export function createBoostButton(ctx) {
  const b = document.createElement('button');
  b.className = 'icon-btn bx-btn';
  b.dataset.testid = 'boost-button';
  b.setAttribute('data-testid', 'boost-button');
  b.title = 'Boost this site'; b.setAttribute('aria-label', 'Boost this site');
  b.innerHTML = BOOST_ICONS.sparkles;
  let seq = 0;
  const refresh = async () => {
    const n = ++seq;
    const tab = await activeTab(ctx.windowId);
    const p = parseTab(tab);
    const boosts = await boostsOf();
    if (n !== seq) return;
    const bo = p.ok ? boosts[p.hostname] : null;
    b.dataset.active = bo && bo.enabled !== false ? 'true' : 'false';
    b.dataset.off = p.ok ? 'false' : 'true';
    b.setAttribute('aria-pressed', b.dataset.active);
  };
  b.addEventListener('click', () => ctx.openBoost());
  const onAct = (i) => { if (i.windowId === ctx.windowId) refresh(); };
  const onUpd = (id, ch, tab) => { if (tab.windowId === ctx.windowId && tab.active && (ch.url || ch.status)) refresh(); };
  const onSt = (ch, area) => { if (area === 'local' && ch.boosts) refresh(); };
  chrome.tabs.onActivated.addListener(onAct);
  chrome.tabs.onUpdated.addListener(onUpd);
  chrome.storage.onChanged.addListener(onSt);
  b._dispose = () => { chrome.tabs.onActivated.removeListener(onAct); chrome.tabs.onUpdated.removeListener(onUpd); chrome.storage.onChanged.removeListener(onSt); };
  refresh();
  return b;
}

// ---------------- Boost view ----------------
export async function renderBoostView(rootEl, ctx) {
  const st = { p: null, boost: null, exists: false, us: true, codeOpen: false, tab: 'css', draft: { css: null, js: null }, saved: { css: '', js: '' }, zapping: false, confirmDel: false, note: '', gen: 0 };
  let dead = false;

  const load = async (full) => {
    const gen = ++st.gen;
    const tab = await activeTab(ctx.windowId);
    const p = parseTab(tab);
    let boost = null, exists = false, us = st.us;
    if (p.ok) {
      const r = await ctx.cmd('getBoost', { hostname: p.hostname });
      if (r && r.ok) { boost = r.boost; exists = r.exists; }
      if (full) { const s = await ctx.cmd('userScriptsStatus', {}); us = !!(s && s.available); }
    }
    if (dead || gen !== st.gen) return;
    if (st.p && st.p.hostname !== p.hostname) { st.draft = { css: null, js: null }; st.codeOpen = false; st.zapping = false; st.confirmDel = false; st.note = ''; }
    Object.assign(st, { p, boost, exists, us });
    if (boost) {
      for (const k of ['css', 'js']) {
        if (st.draft[k] === null || st.draft[k] === st.saved[k]) st.draft[k] = boost[k];
        st.saved[k] = boost[k];
      }
    }
    draw();
  };

  const dirty = (k) => st.draft[k] !== null && st.draft[k] !== st.saved[k];
  const patch = async (pt) => {
    if (!st.p?.ok) return;
    const r = await ctx.cmd('saveBoost', { hostname: st.p.hostname, patch: pt });
    return r;
  };

  const save = async () => {
    const k = st.tab;
    const r = await patch({ [k]: st.draft[k] });
    if (r && r.ok) {
      st.saved[k] = st.draft[k];
      st.note = k === 'js' ? (st.us ? 'Saved. Runs on next load' : 'Saved') : 'Saved';
      draw();
    }
  };

  function draw() {
    if (dead) return;
    const hadFocus = rootEl.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
    const selStart = hadFocus ? document.activeElement.selectionStart : 0, selEnd = hadFocus ? document.activeElement.selectionEnd : 0;
    rootEl.textContent = '';
    const v = document.createElement('div');
    v.className = 'bx-view'; v.dataset.testid = 'boost-view'; v.setAttribute('data-testid', 'boost-view');
    const p = st.p;
    const head = document.createElement('div'); head.className = 'bx-head';
    head.innerHTML = `<button class="icon-btn" data-testid="back-button" aria-label="Back" title="Back"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
      ${p?.ok ? '<span class="bx-fav"><img alt="" draggable="false"></span>' : ''}<span class="bx-host" data-testid="boost-hostname">${p?.ok ? esc(p.hostname) : 'Boost'}</span>`;
    head.querySelector('[data-testid=back-button]').onclick = () => ctx.goBack();
    if (p?.ok) {
      const im = head.querySelector('.bx-fav img');
      im.onerror = () => { head.querySelector('.bx-fav')?.remove(); };
      try { im.src = faviconUrl(p.url || ('https://' + p.hostname + '/'), 32); } catch { head.querySelector('.bx-fav')?.remove(); }
    }
    if (p?.ok && st.boost) {
      const sw = document.createElement('button');
      sw.className = 'bx-switch'; sw.setAttribute('role', 'switch'); sw.dataset.testid = 'boost-enabled'; sw.setAttribute('data-testid', 'boost-enabled');
      sw.setAttribute('aria-checked', String(st.boost.enabled !== false)); sw.title = 'Boost on/off'; sw.setAttribute('aria-label', 'Boost enabled');
      sw.onclick = async () => { await patch({ enabled: st.boost.enabled === false }); };
      head.append(sw);
    }
    v.append(head);
    if (!p?.ok) {
      const e = document.createElement('div'); e.className = 'bx-empty'; e.dataset.testid = 'boost-unavailable'; e.setAttribute('data-testid', 'boost-unavailable');
      e.textContent = "Boosts aren't available on this page";
      v.append(e); rootEl.append(v); return;
    }
    const sub = document.createElement('div'); sub.className = 'bx-sub'; sub.textContent = 'Applies to this exact hostname only';
    v.append(sub);

    // Zap card
    const zapN = (st.boost?.zaps || []).length;
    const zap = document.createElement('button');
    zap.className = 'bx-card' + (st.zapping ? ' bx-armed' : ''); zap.setAttribute('data-testid', 'zap-button'); zap.type = 'button';
    zap.innerHTML = `<span class="bx-tile bx-t-zap">${BOOST_ICONS.bolt}</span><span class="bx-ct"><b>${st.zapping ? 'Zapping…' : 'Zap'}</b><small>${st.zapping ? 'Click what to hide. Esc to finish' : 'Hide parts of this page'}</small></span><span class="bx-status">${st.zapping ? 'Esc' : zapN ? `${zapN} hidden` : BOOST_ICONS.chevron}</span>`;
    zap.onclick = async () => {
      if (st.zapping) { await ctx.cmd('stopZap', { tabId: p.tabId }); st.zapping = false; draw(); return; }
      const r = await ctx.cmd('startZap', { tabId: p.tabId });
      if (r && r.ok) { st.zapping = true; draw(); } else ctx.toast?.("Couldn't start Zap on this page");
    };
    v.append(zap);
    const zaps = st.boost?.zaps || [];
    if (zaps.length) {
      const h = document.createElement('div'); h.className = 'bx-zap-h';
      h.innerHTML = `<span>Hidden on this site (${zaps.length})</span>`;
      if (zaps.length >= 2) {
        const c = document.createElement('button'); c.className = 'text-btn'; c.textContent = 'Unhide all'; c.setAttribute('data-testid', 'zap-clear');
        c.onclick = () => ctx.cmd('clearZaps', { hostname: p.hostname });
        h.append(c);
      }
      v.append(h);
      const list = document.createElement('div'); list.className = 'bx-zaps';
      for (const z of zaps) {
        const r = document.createElement('div'); r.className = 'bx-zap'; r.setAttribute('data-testid', 'zap-row');
        r.innerHTML = `<div class="bx-zl"><b>${esc(z.label || z.selector)}</b><code>${esc(z.selector)}</code></div>`;
        const x = document.createElement('button'); x.className = 'icon-btn'; x.setAttribute('data-testid', 'zap-remove');
        x.title = 'Unhide'; x.setAttribute('aria-label', 'Unhide'); x.innerHTML = BOOST_ICONS.close;
        x.onclick = () => ctx.cmd('removeZap', { hostname: p.hostname, id: z.id });
        r.append(x); list.append(r);
      }
      v.append(list);
    }

    // Code card
    const kinds = [st.boost?.css?.trim() ? 'CSS' : '', st.boost?.js?.trim() ? 'JS' : ''].filter(Boolean).join(' · ');
    const code = document.createElement('button');
    code.className = 'bx-card'; code.type = 'button'; code.setAttribute('data-testid', 'code-button'); code.setAttribute('aria-expanded', String(st.codeOpen));
    code.innerHTML = `<span class="bx-tile bx-t-code">${BOOST_ICONS.braces}</span><span class="bx-ct"><b>Code</b><small>Add your own CSS or JavaScript</small></span><span class="bx-status${st.codeOpen ? ' open' : ''}">${kinds ? esc(kinds) + '<i class="bx-chev">' + BOOST_ICONS.chevron + '</i>' : '<i class="bx-chev">' + BOOST_ICONS.chevron + '</i>'}</span>`;
    code.onclick = async () => { st.codeOpen = !st.codeOpen; if (st.codeOpen) { const s = await ctx.cmd('userScriptsStatus', {}); st.us = !!(s && s.available); } draw(); };
    v.append(code);
    if (st.codeOpen) v.append(codePanel());

    if (st.exists) {
      const del = document.createElement('button');
      del.className = 'btn danger bx-del'; del.setAttribute('data-testid', 'boost-delete');
      del.textContent = st.confirmDel ? 'Click again to delete this boost' : 'Delete boost';
      if (st.confirmDel) del.classList.add('primary');
      del.onclick = async () => {
        if (!st.confirmDel) { st.confirmDel = true; draw(); setTimeout(() => { if (st.confirmDel && !dead) { st.confirmDel = false; draw(); } }, 4000); return; }
        st.confirmDel = false; st.draft = { css: null, js: null }; st.saved = { css: '', js: '' };
        await ctx.cmd('deleteBoost', { hostname: p.hostname });
      };
      v.append(del);
    }
    rootEl.append(v);
    if (hadFocus) { const t = v.querySelector('textarea'); if (t) { t.focus(); try { t.setSelectionRange(selStart, selEnd); } catch {} } }
  }

  function codePanel() {
    const w = document.createElement('div'); w.className = 'bx-code';
    const k = st.tab;
    const tabs = document.createElement('div'); tabs.className = 'bx-tabs'; tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['css', 'CSS'], ['js', 'JS']]) {
      const t = document.createElement('button'); t.textContent = label; t.setAttribute('role', 'tab'); t.setAttribute('data-testid', 'code-tab-' + id);
      t.setAttribute('aria-selected', String(k === id));
      t.onclick = () => { st.tab = id; st.note = ''; draw(); };
      tabs.append(t);
    }
    w.append(tabs);
    if (k === 'js' && !st.us) {
      const m = document.createElement('div'); m.className = 'bx-warn'; m.setAttribute('data-testid', 'userscripts-help');
      m.innerHTML = '<p>To run custom JavaScript, turn on <b>Allow User Scripts</b> for Sidebar.</p>';
      const b = document.createElement('button'); b.className = 'btn small'; b.setAttribute('data-testid', 'userscripts-open');
      b.textContent = 'Open extension settings';
      b.onclick = () => { try { chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }); } catch {} };
      const b2 = document.createElement('button'); b2.className = 'btn small'; b2.textContent = 'Check again'; b2.style.marginLeft = '6px';
      b2.onclick = async () => { const s = await ctx.cmd('userScriptsStatus', {}); st.us = !!(s && s.available); draw(); };
      m.append(b, b2); w.append(m);
    }
    const ta = document.createElement('textarea');
    ta.className = 'bx-editor'; ta.setAttribute('data-testid', 'code-editor'); ta.spellcheck = false;
    ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocomplete', 'off');
    ta.placeholder = k === 'css' ? '/* custom CSS for this site */\nbody { }' : '// custom JavaScript, runs in the page';
    ta.value = st.draft[k] ?? '';
    ta.oninput = () => { st.draft[k] = ta.value; st.note = ''; stateEl.textContent = stateText(); stateEl.classList.toggle('dirty', dirty(k)); };
    ta.onkeydown = (e) => {
      if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.setRangeText('  ', s, en, 'end'); ta.dispatchEvent(new Event('input'));
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    };
    w.append(ta);
    const stateText = () => (dirty(k) ? 'Unsaved changes' : st.note || (k === 'js' ? 'Runs on next load' : 'Saved · applies live'));
    const row = document.createElement('div'); row.className = 'bx-row';
    const stateEl = document.createElement('span'); stateEl.className = 'bx-state' + (dirty(k) ? ' dirty' : ''); stateEl.setAttribute('data-testid', 'code-state');
    stateEl.textContent = stateText();
    const sv = document.createElement('button'); sv.className = 'btn small primary'; sv.textContent = 'Save'; sv.setAttribute('data-testid', 'code-save');
    sv.onclick = save;
    const rl = document.createElement('button'); rl.className = 'btn small'; rl.setAttribute('data-testid', 'code-reload'); rl.textContent = 'Reload page'; rl.title = 'Reload page';
    rl.onclick = () => { try { chrome.tabs.reload(st.p.tabId); } catch {} };
    row.append(stateEl, rl, sv);
    w.append(row);
    return w;
  }

  // ---- live updates ----
  const onSt = (ch, area) => { if (area === 'local' && ch.boosts) load(false); };
  const onAct = (i) => { if (i.windowId === ctx.windowId) load(true); };
  const onUpd = (id, ch, tab) => { if (tab.windowId === ctx.windowId && tab.active && ch.url) load(true); };
  const onFocus = () => { if (st.zapping) { st.zapping = false; draw(); } };
  window.addEventListener('focus', onFocus);
  chrome.storage.onChanged.addListener(onSt);
  chrome.tabs.onActivated.addListener(onAct);
  chrome.tabs.onUpdated.addListener(onUpd);
  await load(true);
  return () => {
    dead = true;
    window.removeEventListener('focus', onFocus);
    chrome.storage.onChanged.removeListener(onSt);
    chrome.tabs.onActivated.removeListener(onAct);
    chrome.tabs.onUpdated.removeListener(onUpd);
  };
}

// ---------------- Settings section ----------------
export function renderBoostSettings(containerEl, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'bx-settings'; wrap.setAttribute('data-testid', 'boost-settings');
  const list = document.createElement('div'); list.className = 'bx-sites group';
  const note = document.createElement('p'); note.className = 'note hint'; note.textContent = 'A boost applies to one exact hostname. Zap hides parts of a page; Code adds your own CSS or JavaScript. Open Boost from the sparkle button in the sidebar\u2019s footer.';
  wrap.append(list, note); containerEl.append(wrap);
  const draw = async () => {
    const r = await ctx.cmd('listBoosts', {});
    const boosts = (r && r.boosts) || {};
    list.textContent = '';
    const hosts = Object.keys(boosts).sort();
    if (!hosts.length) { const h = document.createElement('div'); h.className = 'empty'; h.textContent = 'No boosts yet. Use the sparkle button in the sidebar\u2019s footer.'; list.append(h); return; }
    for (const h of hosts) {
      const b = boosts[h];
      const row = document.createElement('div'); row.className = 'bx-site'; row.setAttribute('data-testid', 'boost-site-row'); row.dataset.hostname = h;
      const meta = [b.zaps.length ? `${b.zaps.length} hidden` : '', b.css.trim() ? 'CSS' : '', b.js.trim() ? 'JS' : ''].filter(Boolean).join(' · ');
      row.innerHTML = `<span class="bx-sn">${esc(h)}<span class="bx-sm">${esc(meta || 'No changes yet')}</span></span>`;
      const sw = document.createElement('button'); sw.className = 'bx-switch'; sw.setAttribute('role', 'switch'); sw.setAttribute('data-testid', 'boost-site-toggle');
      sw.setAttribute('aria-checked', String(b.enabled !== false)); sw.setAttribute('aria-label', `Enable boost for ${h}`);
      sw.onclick = () => ctx.cmd('saveBoost', { hostname: h, patch: { enabled: b.enabled === false } });
      const del = document.createElement('button'); del.className = 'icon-btn'; del.setAttribute('data-testid', 'boost-site-delete');
      del.title = 'Delete boost'; del.setAttribute('aria-label', `Delete boost for ${h}`); del.innerHTML = BOOST_ICONS.trash;
      let armed = false;
      del.onclick = () => {
        if (!armed) { armed = true; del.style.color = 'var(--danger)'; del.title = 'Click again to delete'; setTimeout(() => { armed = false; del.style.color = ''; del.title = 'Delete boost'; }, 3000); return; }
        ctx.cmd('deleteBoost', { hostname: h });
      };
      row.append(sw, del); list.append(row);
    }
  };
  const onSt = (ch, area) => { if (area === 'local' && ch.boosts) { if (!wrap.isConnected) { chrome.storage.onChanged.removeListener(onSt); return; } draw(); } };
  chrome.storage.onChanged.addListener(onSt);
  draw();
  return () => chrome.storage.onChanged.removeListener(onSt);
}
