// Injected into the page on demand (chrome.scripting.executeScript). Everything it draws lives in one shadow root.
// Messages from the service worker use { cap: '...' }; messages back use the normal { cmd: 'capture...' } commands.
(() => {
  if (window.__sbCapture) return;
  window.__sbCapture = true;

  const send = (m) => { try { return chrome.runtime.sendMessage(m).catch(() => undefined); } catch { return Promise.resolve(); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n) => new Promise((r) => { const step = (i) => (i <= 0 ? r() : requestAnimationFrame(() => step(i - 1))); step(n); });

  // ------------------------------------------------------------------ shadow host
  let host = null, root = null;
  function ensureHost() {
    if (host && host.isConnected) return root;
    host = document.createElement('div');
    host.setAttribute('data-sb-cap-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>`;
    (document.documentElement || document.body).append(host);
    return root;
  }
  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.ui{--bg:#fff;--fg:#1c1c1e;--dim:rgba(28,28,30,.56);--line:rgba(0,0,0,.1);--hover:rgba(28,28,30,.07);--accent:#5566f0;--shadow:0 8px 28px rgba(0,0,0,.22),0 1px 3px rgba(0,0,0,.12);
 font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--fg)}
@media (prefers-color-scheme:dark){.ui{--bg:#2c2d31;--fg:#ececf0;--dim:rgba(236,236,240,.6);--line:rgba(255,255,255,.12);--hover:rgba(255,255,255,.09);--accent:#8d98ff;--shadow:0 8px 28px rgba(0,0,0,.55),0 1px 3px rgba(0,0,0,.4)}}
button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;padding:0}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);pointer-events:auto;background:var(--bg);color:var(--fg);padding:8px 14px;border-radius:10px;box-shadow:var(--shadow),0 0 0 1px var(--line);animation:pop .14s ease-out}
.pill{position:fixed;left:50%;top:14px;transform:translateX(-50%);pointer-events:auto;cursor:pointer;display:flex;gap:8px;align-items:center;background:var(--bg);color:var(--fg);padding:7px 14px;border-radius:999px;box-shadow:var(--shadow),0 0 0 1px var(--line);font-weight:600}
.pill i{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite}
.pill span{font-weight:400;color:var(--dim)}
.card{position:fixed;right:18px;bottom:18px;width:248px;pointer-events:auto;background:var(--bg);border-radius:12px;box-shadow:var(--shadow),0 0 0 1px var(--line);overflow:hidden;animation:slide .18s cubic-bezier(.2,.8,.2,1)}
.card.out{opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}
.card .img{display:grid;place-items:center;height:150px;background:var(--hover);cursor:pointer;position:relative}
.card img{max-width:100%;max-height:150px;display:block;box-shadow:0 0 0 1px var(--line)}
.card .meta{position:absolute;left:8px;bottom:6px;background:rgba(0,0,0,.6);color:#fff;border-radius:6px;padding:1px 6px;font-size:11px}
.card .bar{display:flex;gap:2px;padding:6px}
.card .bar button{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;height:28px;border-radius:7px;font-weight:600}
.card .bar button:hover,.card .bar button:focus-visible{background:var(--hover);outline:none}
.card .bar svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.card .x{position:absolute;top:6px;right:6px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;display:grid;place-items:center;opacity:0;transition:opacity .12s}
.card:hover .x,.card .x:focus-visible{opacity:1}
.card .x svg{width:12px;height:12px;stroke:currentColor;stroke-width:2.2;fill:none;stroke-linecap:round}
.card .note{padding:0 10px 8px;color:var(--dim);font-size:11.5px;min-height:0;word-break:break-all}
.card .note:empty{display:none}
.reg{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;user-select:none;-webkit-user-select:none;overflow:hidden;touch-action:none}
.reg img.frozen{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
.reg .dim{position:absolute;inset:0;background:rgba(0,0,0,.42);pointer-events:none}
.reg .sel{position:absolute;box-shadow:0 0 0 100vmax rgba(0,0,0,.45);outline:1px solid #fff;outline-offset:-1px;cursor:move}
.reg .sel::after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);pointer-events:none}
.reg .lbl{position:absolute;left:0;top:-26px;background:rgba(20,20,22,.88);color:#fff;border-radius:6px;padding:2px 7px;font:600 11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;pointer-events:none}
.reg .lbl.in{top:6px;left:6px}
.reg .h{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;background:#fff;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.55)}
.reg .hint{position:absolute;left:50%;top:14px;transform:translateX(-50%);background:rgba(20,20,22,.88);color:#fff;border-radius:999px;padding:6px 14px;font-size:12px;pointer-events:none;white-space:nowrap}
.reg .hint b{font-weight:600}
.reg .hint button{pointer-events:auto;margin-left:6px;padding:1px 8px;border-radius:999px;background:rgba(255,255,255,.16);color:#fff;font-size:12px}
.reg .hint button:hover{background:rgba(255,255,255,.3)}
@keyframes pop{from{opacity:0;transform:translate(-50%,6px)}}
@keyframes slide{from{opacity:0;transform:translateY(14px)}}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
  const ui = () => { const r = ensureHost(); let u = r.querySelector('.ui'); if (!u) { u = document.createElement('div'); u.className = 'ui'; r.append(u); } return u; };
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

  // ------------------------------------------------------------------ toast
  let toastTimer = 0;
  function toast(text) {
    const u = ui(); u.querySelector('.toast')?.remove();
    const t = el('<div class="toast" role="status"></div>'); t.textContent = text; u.append(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 2600);
  }

  // ------------------------------------------------------------------ progress pill (full page)
  let pill = null, cancelKey = null;
  function setPill(on) {
    if (!on) { pill?.remove(); pill = null; if (cancelKey) { removeEventListener('keydown', cancelKey, true); cancelKey = null; } return; }
    if (pill) return;
    pill = el('<div class="pill" data-testid="capture-pill" title="Click or press Esc to cancel"><i></i>Capturing… <span>Esc to cancel</span></div>');
    pill.addEventListener('click', () => send({ cmd: 'captureCancel' }));
    ui().append(pill);
    cancelKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); send({ cmd: 'captureCancel' }); } };
    addEventListener('keydown', cancelKey, true);
  }

  // ------------------------------------------------------------------ full page helpers
  let saved = null, hiddenEls = [];
  const sc = () => document.scrollingElement || document.documentElement;
  function measure() {
    const s = sc();
    const ch = innerHeight;
    return { sh: Math.max(s.scrollHeight, document.body ? document.body.scrollHeight : 0), ch, cw: innerWidth, dpr: devicePixelRatio || 1, sy: s.scrollTop, sx: s.scrollLeft };
  }
  function prepare() {
    const s = sc();
    if (!saved) {
      saved = { x: s.scrollLeft, y: s.scrollTop };
      const st = document.createElement('style');
      st.setAttribute('data-sb-cap-style', '');
      st.textContent = 'html,body{scroll-behavior:auto!important}[data-sb-cap-hide]{visibility:hidden!important}';
      document.documentElement.append(st);
    }
  }
  function hideFixed() {
    prepare();
    for (const e of document.body ? document.body.querySelectorAll('*') : []) {
      if (e === host) continue;
      const p = getComputedStyle(e).position;
      if (p === 'fixed' || p === 'sticky') { e.setAttribute('data-sb-cap-hide', ''); hiddenEls.push(e); }
    }
  }
  function restore() {
    for (const e of hiddenEls) e.removeAttribute('data-sb-cap-hide');
    hiddenEls = [];
    document.querySelectorAll('style[data-sb-cap-style]').forEach((n) => n.remove());
    if (saved) { const s = sc(); s.scrollTo?.(saved.x, saved.y); if (s.scrollTop !== saved.y) window.scrollTo(saved.x, saved.y); saved = null; }
    setPill(false);
  }
  async function scrollTo(y) {
    prepare();
    window.scrollTo(saved.x, y);
    await frames(2); await sleep(120);
    return sc().scrollTop;
  }

  // ------------------------------------------------------------------ region selection
  let regionCleanup = null;
  function startRegion({ token, dataUrl, dpr }) {
    regionCleanup?.();
    const u = ui();
    const reg = el(`<div class="reg" data-testid="capture-region-overlay"><img class="frozen" alt=""><div class="dim"></div><div class="sel" hidden data-testid="capture-region-sel"><div class="lbl" data-testid="capture-region-label"></div></div><div class="hint"><b>Drag</b> to select · <b>Enter</b> to capture · <b>Esc</b> to cancel · <b>Space</b> moves<button type="button" data-testid="capture-region-cancel">Cancel</button></div></div>`);
    reg.querySelector('img').src = dataUrl;
    const sel = reg.querySelector('.sel'), dim = reg.querySelector('.dim'), lbl = reg.querySelector('.lbl'), hint = reg.querySelector('.hint');
    const HANDLES = { nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5] };
    for (const k of Object.keys(HANDLES)) { const h = document.createElement('div'); h.className = 'h'; h.dataset.h = k; h.style.cursor = (k === 'n' || k === 's') ? 'ns-resize' : (k === 'e' || k === 'w') ? 'ew-resize' : (k === 'nw' || k === 'se') ? 'nwse-resize' : 'nesw-resize'; sel.append(h); }
    u.append(reg);
    let r = null; // {x,y,w,h} in CSS px
    let drag = null, space = false;
    const W = () => innerWidth, H = () => innerHeight;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const render = () => {
      if (!r) { sel.hidden = true; dim.hidden = false; return; }
      sel.hidden = false; dim.hidden = true;
      Object.assign(sel.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      for (const [k, [fx, fy]] of Object.entries(HANDLES)) { const h = sel.querySelector(`[data-h="${k}"]`); h.style.left = fx * r.w + 'px'; h.style.top = fy * r.h + 'px'; }
      lbl.textContent = `${Math.round(r.w * dpr)} × ${Math.round(r.h * dpr)}`;
      lbl.classList.toggle('in', r.y < 30);
    };
    const finish = (ok) => {
      regionCleanup = null;
      clearInterval(keep);
      removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKeyUp, true);
      reg.remove();
      if (ok && r) send({ cmd: 'captureRegionDone', token, rect: r, vw: W(), vh: H() });
      else send({ cmd: 'captureRegionCancel', token });
    };
    // the service worker holds the frozen picture: keep it from idling out while the person is still choosing
    const keep = setInterval(() => send({ cmd: 'capturePing' }), 15000);
    regionCleanup = () => { clearInterval(keep); removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKeyUp, true); reg.remove(); regionCleanup = null; };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (r && r.w >= 2 && r.h >= 2) finish(true); }
      else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); space = true; }
      else if (r && e.key.startsWith('Arrow')) {
        e.preventDefault(); e.stopPropagation();
        const d = e.shiftKey ? 10 : 1;
        if (e.altKey) { if (e.key === 'ArrowRight') r.w += d; if (e.key === 'ArrowLeft') r.w = Math.max(2, r.w - d); if (e.key === 'ArrowDown') r.h += d; if (e.key === 'ArrowUp') r.h = Math.max(2, r.h - d); }
        else { if (e.key === 'ArrowRight') r.x += d; if (e.key === 'ArrowLeft') r.x -= d; if (e.key === 'ArrowDown') r.y += d; if (e.key === 'ArrowUp') r.y -= d; }
        r.x = clamp(r.x, 0, W() - r.w); r.y = clamp(r.y, 0, H() - r.h); r.w = Math.min(r.w, W() - r.x); r.h = Math.min(r.h, H() - r.y); render();
      } else { e.stopPropagation(); }
    };
    const onKeyUp = (e) => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); space = false; } };
    addEventListener('keydown', onKey, true); addEventListener('keyup', onKeyUp, true);

    reg.querySelector('.hint button').addEventListener('click', (e) => { e.stopPropagation(); finish(false); });
    reg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.hint')) return;
      e.preventDefault();
      reg.setPointerCapture(e.pointerId);
      const x = e.clientX, y = e.clientY;
      const hk = e.target.dataset && e.target.dataset.h;
      if (r && hk) drag = { mode: 'resize', hk, o: { ...r }, x, y };
      else if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) drag = { mode: 'move', o: { ...r }, x, y };
      else { r = null; drag = { mode: 'new', ax: x, ay: y, x, y, o: null }; }
      render();
    });
    reg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = clamp(e.clientX, 0, W()), y = clamp(e.clientY, 0, H());
      if (drag.mode === 'new') {
        if (space && r) { // Space while drawing: the whole selection moves with the pointer
          const dx = x - drag.x, dy = y - drag.y;
          r.x = clamp(r.x + dx, 0, W() - r.w); r.y = clamp(r.y + dy, 0, H() - r.h);
          drag.ax = r.x; drag.ay = r.y;
        } else {
          const ax = drag.ax, ay = drag.ay;
          r = { x: Math.min(ax, x), y: Math.min(ay, y), w: Math.abs(x - ax), h: Math.abs(y - ay) };
          if (r.w < 1 && r.h < 1) r = null;
        }
        drag.x = x; drag.y = y;
      } else if (drag.mode === 'move') {
        const o = drag.o;
        r = { x: clamp(o.x + x - drag.x, 0, W() - o.w), y: clamp(o.y + y - drag.y, 0, H() - o.h), w: o.w, h: o.h };
      } else {
        const o = drag.o, k = drag.hk;
        let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
        if (k.includes('w')) x1 = x; if (k.includes('e')) x2 = x; if (k.includes('n')) y1 = y; if (k.includes('s')) y2 = y;
        r = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      }
      render();
    });
    const up = () => { if (drag && r && (r.w < 4 || r.h < 4)) r = null; drag = null; render(); };
    reg.addEventListener('pointerup', up);
    reg.addEventListener('pointercancel', up);
    reg.addEventListener('dblclick', () => { if (r && r.w >= 2 && r.h >= 2) finish(true); });
    render();
  }

  // ------------------------------------------------------------------ thumbnail card
  let cardTimer = 0;
  const IC = {
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1L19 8a2.1 2.1 0 0 0-3-3L5 16z"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 16V5M7 9l5-5 5 5M5 20h14"/></svg>',
  };
  function showCard(c) {
    const u = ui(); u.querySelector('.card')?.remove(); clearTimeout(cardTimer);
    const card = el(`<div class="card" data-testid="capture-card" role="group" aria-label="Screenshot taken">
      <div class="img" data-testid="capture-card-image" title="Open in the editor"><img alt="Screenshot preview"><span class="meta"></span></div>
      <div class="bar"><button data-a="copy" data-testid="capture-card-copy" title="Copy to the clipboard">${IC.copy}Copy</button><button data-a="save" data-testid="capture-card-save" title="Save to Downloads">${IC.save}Save</button><button data-a="edit" data-testid="capture-card-edit" title="Open in the editor">${IC.edit}Edit</button>${c.s3 ? `<button data-a="upload" data-testid="capture-card-upload" title="Upload and copy the link">${IC.up}Upload</button>` : ''}</div>
      <div class="note" data-testid="capture-card-note" aria-live="polite"></div>
      <button class="x" data-a="close" data-testid="capture-card-close" aria-label="Dismiss"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`);
    card.querySelector('img').src = c.thumb;
    card.querySelector('.meta').textContent = `${c.w} × ${c.h}`;
    const note = card.querySelector('.note');
    // stays while the pointer is over it or a button inside has focus; otherwise it hides 6 s after the last interaction
    const held = () => card.matches(':hover') || card.matches(':focus-within');
    const arm = () => { clearTimeout(cardTimer); cardTimer = setTimeout(() => { if (!held()) dismiss(); else arm(); }, 6000); };
    const dismiss = () => { card.classList.add('out'); setTimeout(() => card.remove(), 200); };
    const say = (t) => { note.textContent = t; };
    if (c.note) say(c.note);
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a], .img');
      if (!b) return;
      const a = b.dataset.a || 'edit';
      if (a === 'close') return dismiss();
      if (a === 'edit') { send({ cmd: 'captureOpen', id: c.id }); return dismiss(); }
      if (a === 'copy') {
        const r = await send({ cmd: 'captureImage', id: c.id });
        if (r && r.ok && await copyImage(r.dataUrl).then(() => true, () => false)) say('Copied to the clipboard'); else say('Couldn’t copy. Open the editor and press Copy.');
      } else if (a === 'save') {
        const r = await send({ cmd: 'captureSave', id: c.id });
        say(r && r.ok ? 'Saved to Downloads' : (r && r.error) || 'Couldn’t save');
      } else if (a === 'upload') {
        say('Uploading…'); b.disabled = true;
        const r = await send({ cmd: 'captureUpload', id: c.id });
        b.disabled = false;
        if (r && r.ok) { await copyText(r.url).catch(() => {}); say('Link copied: ' + r.url); } else say((r && r.error) || 'Upload failed');
      }
      arm();
    });
    u.append(card);
    arm();
  }

  // ------------------------------------------------------------------ clipboard
  function dataToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const type = /data:([^;]+)/.exec(head)?.[1] || 'image/png';
    const bin = atob(b64); const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type });
  }
  async function copyImage(dataUrl) {
    const blob = dataToBlob(dataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return; } catch { /* fall through */ }
    const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    if (!ok) throw new Error('copy failed');
  }

  // ------------------------------------------------------------------ messages
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (!m || typeof m.cap !== 'string') return false;
    (async () => {
      try {
        switch (m.cap) {
          case 'ping': return { ok: true };
          case 'measure': return { ok: true, ...measure() };
          case 'scrollTo': return { ok: true, y: await scrollTo(m.y) };
          case 'hideFixed': hideFixed(); await frames(2); return { ok: true };
          case 'restore': restore(); return { ok: true };
          case 'pill': setPill(!!m.on); return { ok: true };
          case 'pillVisible': if (pill) { pill.style.visibility = m.visible ? 'visible' : 'hidden'; await frames(2); await sleep(30); } return { ok: true };
          case 'region': startRegion(m); return { ok: true };
          case 'regionCancel': regionCleanup?.(); return { ok: true };
          case 'card': showCard(m); return { ok: true };
          case 'toast': toast(m.text); return { ok: true };
          case 'copy': await copyImage(m.dataUrl); return { ok: true };
          case 'copyText': await copyText(m.text); return { ok: true };
          default: return { ok: false, error: 'unknown' };
        }
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    })().then(reply);
    return true;
  });
})();
