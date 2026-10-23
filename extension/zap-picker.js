// Zap element picker. Injected via chrome.scripting.executeScript; idempotent.
(() => {
  if (window.__sidebarZap) { try { window.__sidebarZap.focus(); } catch {} return; }

  const host = document.createElement('div');
  host.setAttribute('data-sidebar-zap', '');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  .box{position:fixed;display:none;pointer-events:none;border:2px solid #f5a524;background:rgba(245,165,36,.16);border-radius:3px;transition:all 60ms linear}
  .lab{position:fixed;display:none;pointer-events:none;max-width:60vw;padding:2px 6px;border-radius:4px;background:#1c1c1e;color:#fff;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pill{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:999px;background:#1c1c1e;color:#fff;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:calc(100vw - 24px);user-select:none}
  .pill span{white-space:nowrap}
  .pill button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:rgba(255,255,255,.14);color:#fff}
  .pill button:hover{background:rgba(255,255,255,.26)}
  .pill button[disabled]{opacity:.35;pointer-events:none}
  .pill button.done{background:#f5a524;color:#1c1c1e}
  @media (max-width:520px){.pill span.t{display:none}}
</style>
<div class="box"></div><div class="lab"></div>
<div class="pill" data-testid="zap-pill"><span class="t">Zap — click elements to hide · Esc to finish</span><span class="n"></span><button class="undo" data-testid="zap-undo" disabled>Undo</button><button class="done" data-testid="zap-done">Done</button></div>`;
  const $ = (s) => root.querySelector(s);
  const box = $('.box'), lab = $('.lab'), undoBtn = $('.undo'), doneBtn = $('.done'), countEl = $('.n');
  const hideStyle = document.createElement('style');
  hideStyle.setAttribute('data-sidebar-zap-style', '');
  document.documentElement.append(host, hideStyle);

  const hostname = location.hostname;
  const zapped = []; // {id, selector, promise}
  let cur = null, stack = [], pt = null, active = true;

  // ---------- selector generation ----------
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const q = (s) => { try { return document.querySelectorAll(s); } catch { return []; } };
  const unique = (s, el) => { const r = q(s); return r.length === 1 && r[0] === el; };
  const digitRatio = (s) => (s.match(/\d/g) || []).length / s.length;
  function stableId(id) {
    if (!id || id.length >= 40) return false;
    if (digitRatio(id) > 0.35 || /^[0-9a-f]{8,}$/i.test(id) || /\d{4,}/.test(id)) return false;
    if (/^(:r|ember|react|radix|headlessui|__|uid)/i.test(id)) return false;
    return true;
  }
  const STATE = /^(active|hover|focus|focused|selected|open|opened|show|shown|visible|hidden|loading|loaded|disabled|checked|current|is-\w+|has-\w+)$/i;
  function stableClass(c) {
    if (!c || c.length > 32 || c.length < 2) return false;
    if (/^(css-|sc-|jsx-|_|svelte-|styled|emotion|Mui\w*-\w+-|ember\d)/.test(c)) return false;
    if (digitRatio(c) > 0.25 || /\d{3,}/.test(c)) return false;
    if (/[a-z][A-Z]{2,}|[A-Za-z]*\d[A-Za-z]+\d/.test(c) && c.length > 8) return false;
    if (/^[a-z0-9]{6,}$/i.test(c) && /\d/.test(c)) return false;
    if (STATE.test(c)) return false;
    return true;
  }
  const classesOf = (el) => (el.getAttribute('class') || '').split(/\s+/).filter(stableClass);
  const tagOf = (el) => el.localName;
  function segment(el, useCls = true) {
    let s = tagOf(el);
    if (useCls) { const cs = classesOf(el).slice(0, 2); for (const c of cs) s += '.' + esc(c); }
    return s;
  }
  function nth(el) {
    const p = el.parentElement; if (!p) return '';
    const same = [...p.children].filter((c) => c.localName === el.localName);
    return same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : '';
  }
  function makeSelector(el) {
    if (stableId(el.id) && unique('#' + esc(el.id), el)) return '#' + esc(el.id);
    // Walk up to an anchor (stable unique id) or body.
    const chain = []; let n = el, anchor = null;
    while (n && n !== document.documentElement) {
      if (n !== el && stableId(n.id) && unique('#' + esc(n.id), n)) { anchor = n; break; }
      if (n === document.body) break;
      chain.unshift(n); n = n.parentElement;
    }
    const head = anchor ? '#' + esc(anchor.id) : (n === document.body ? 'body' : '');
    const segs = chain.map((x) => segment(x));
    // 1) shortest suffix of the class-based path that is unique
    for (let k = 1; k <= segs.length; k++) {
      const s = segs.slice(-k).join(' > ');
      if (unique(s, el)) return s;
    }
    const full = (parts) => (head ? head + ' > ' : '') + parts.join(' > ');
    if (unique(full(segs), el)) return full(segs);
    // 2) add :nth-of-type progressively from the target upwards
    const parts = segs.slice();
    for (let i = parts.length - 1; i >= 0; i--) {
      parts[i] += nth(chain[i]);
      if (unique(full(parts), el)) return full(parts);
    }
    // 3) tag-only path with nth-of-type everywhere (always unique when anchored)
    const plain = chain.map((x) => tagOf(x) + nth(x));
    return full(plain);
  }
  function labelFor(el) {
    const clip = (s) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > 40 ? s.slice(0, 39) + '…' : s; };
    const aria = clip(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title'));
    if (aria) return aria;
    const desc = describe(el);
    if (desc.includes('.') || desc.includes('#')) return clip(desc);
    const t = clip(el.textContent);
    return t ? clip(`${desc} “${t}”`) : desc;
  }
  function describe(el) {
    let s = tagOf(el);
    if (el.id) s += '#' + el.id;
    const cs = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    if (cs.length) s += '.' + cs.slice(0, 2).join('.');
    return s;
  }

  // ---------- UI ----------
  const isOurs = (e) => { try { return e.composedPath().includes(host); } catch { return false; } };
  function pick(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host || host.contains(el) || el === document.documentElement) continue;
      return el;
    }
    return null;
  }
  function paint() {
    if (!cur || !cur.isConnected) { box.style.display = lab.style.display = 'none'; return; }
    const r = cur.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: Math.max(r.width, 2) + 4 + 'px', height: Math.max(r.height, 2) + 4 + 'px' });
    lab.textContent = describe(cur);
    lab.style.display = 'block';
    const above = r.top > 26;
    lab.style.left = Math.max(2, Math.min(r.left, innerWidth - 120)) + 'px';
    lab.style.top = (above ? r.top - 24 : Math.min(r.bottom + 4, innerHeight - 24)) + 'px';
  }
  function setCur(el) { cur = el; paint(); }
  function refreshPill() {
    undoBtn.disabled = !zapped.length;
    countEl.textContent = zapped.length ? `· ${zapped.length} hidden` : '';
  }
  function rebuildStyle() {
    hideStyle.textContent = zapped.map((z) => z.selector + '{display:none!important}').join('\n');
  }
  const send = (m) => new Promise((res) => {
    try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }); } catch { res(undefined); }
  });

  function zapCurrent() {
    const el = cur;
    if (!el || !el.isConnected || el === document.documentElement) return;
    const selector = makeSelector(el);
    const label = labelFor(el);
    const z = { id: null, selector, promise: null };
    zapped.push(z);
    rebuildStyle();
    z.promise = send({ cmd: 'addZap', hostname, selector, label }).then((r) => { z.id = r && r.zap && r.zap.id; return r; });
    stack = []; cur = null; paint(); refreshPill();
    if (pt) setTimeout(() => { if (active) setCur(pick(pt.x, pt.y)); }, 30);
  }
  async function undo() {
    const z = zapped.pop();
    if (!z) return;
    rebuildStyle(); refreshPill();
    await z.promise;
    if (z.id) await send({ cmd: 'removeZap', hostname, id: z.id });
    if (pt) setCur(pick(pt.x, pt.y));
  }
  async function stop() {
    if (!active) return;
    active = false;
    for (const [t, f] of listeners) window.removeEventListener(t, f, true);
    try { chrome.runtime.onMessage.removeListener(onMsg); } catch {}
    box.style.display = lab.style.display = 'none';
    host.style.display = 'none';
    await Promise.all(zapped.map((z) => z.promise));
    // The boost content script applies the stored zaps live; drop our temporary style a beat later.
    setTimeout(() => { hideStyle.remove(); host.remove(); delete window.__sidebarZap; }, 400);
  }

  // ---------- events ----------
  const listeners = [];
  const on = (t, f) => { listeners.push([t, f]); window.addEventListener(t, f, true); };
  on('mousemove', (e) => {
    pt = { x: e.clientX, y: e.clientY };
    if (isOurs(e)) { cur = null; paint(); return; }
    const el = pick(e.clientX, e.clientY);
    if (el !== cur) { stack = []; setCur(el); }
  });
  const swallow = (e) => { if (isOurs(e)) return false; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return true; };
  on('click', (e) => { if (!swallow(e)) return; if (e.clientX || e.clientY) pt = { x: e.clientX, y: e.clientY }; if (!cur) setCur(pick(e.clientX, e.clientY)); zapCurrent(); });
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu', 'submit']) on(t, swallow);
  on('scroll', () => paint());
  on('resize', () => paint());
  on('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); return; }
    if (e.key === 'ArrowUp' && cur) {
      e.preventDefault(); e.stopPropagation();
      const p = cur.parentElement;
      if (p && p !== document.documentElement) { stack.push(cur); setCur(p); }
    } else if (e.key === 'ArrowDown' && stack.length) {
      e.preventDefault(); e.stopPropagation();
      setCur(stack.pop());
    }
  });
  undoBtn.addEventListener('click', (e) => { e.stopPropagation(); undo(); });
  doneBtn.addEventListener('click', (e) => { e.stopPropagation(); stop(); });
  const onMsg = (m) => { if (m && m.cmd === 'stopZap') stop(); };
  try { chrome.runtime.onMessage.addListener(onMsg); } catch {}

  window.__sidebarZap = { focus() { try { window.focus(); } catch {} }, stop };
  refreshPill();
})();
