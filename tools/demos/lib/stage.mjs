// A "stage": one extra headless page that composites screenshots of the real pages into a single frame, and draws the
// caption bar. Used by scenes that want a desktop-like picture (several windows, a zoom) and by any scene with
// `captions: true`. Nothing on the stage is hand-drawn to look like Stile: every layer is a screenshot of a real page;
// the stage only adds window frames, a wallpaper, a highlight ring and the caption text.
//
// Layers:   { id, page, x, y, w, h, scale?, z?, frame?: { title, bar? }, hidden?, clip? }
//   x,y     where the layer's top-left sits on the stage (stage px); w,h the page viewport in page px; scale how big it is drawn.
//   frame   wraps the layer in a plain window (traffic-light dots + title). `hidden` layers start out not shown.
// The caption bar sits BELOW the stage area (the canvas grows by capH), so it never covers anything.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { CURSOR_JS, isTiledFrame, scratchDir, sleep, until } from './harness.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

export const CAP_H = 56;
const BAR = 28;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Stage {
  // width/height: the stage area in px (caption bar not included). captions: reserve the caption bar below it.
  static async launch({ width, height, captions = false, dsf = 1, capFont = 18, capH = CAP_H }) {
    const s = new Stage({ width, height, captions, dsf, capFont });
    s.capH = captions ? capH : 0;
    s.browser = await chromium.launch({ channel: 'chromium', headless: true });
    s.ctx = await s.browser.newContext({ viewport: { width, height: height + s.capH }, deviceScaleFactor: dsf });
    s.page = await s.ctx.newPage();
    return s;
  }
  constructor(o) { Object.assign(this, o); this.layers = new Map(); this.dropped = 0; this.dir = null; }
  // an extra page in the stage browser (for a mock "other app"); it gets the same demo cursor as the real pages
  async newPage({ width, height }) {
    const ctx = await this.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    await ctx.addInitScript(CURSOR_JS);
    return ctx.newPage();
  }
  get totalH() { return this.height + this.capH; }

  // css / decor: extra stage CSS and HTML (e.g. a decorative window behind some layers)
  async build({ layers, css = '', decor = '' }) {
    this.dir ||= fs.mkdtempSync(path.join(scratchDir(), 'stage-'));
    for (const l of layers) this.layers.set(l.id, { scale: 1, z: 1, ...l, visible: !l.hidden, hasImg: false });
    const el = (l) => {
      const sw = l.w * l.scale, sh = l.h * l.scale;
      const img = `<img id="I-${l.id}" alt="">`;
      if (!l.frame) return `<div class="layer" id="L-${l.id}" style="left:${l.x}px;top:${l.y}px;width:${l.w}px;height:${l.h}px;transform:scale(${l.scale});z-index:${l.z};${l.hidden ? 'display:none' : ''}">${img}</div>`;
      const bar = l.frame.bar ?? BAR;
      return `<div class="win${l.hidden ? ' hidden' : ''}" id="W-${l.id}" style="left:${l.x - 1}px;top:${l.y - bar - 1}px;width:${sw + 2}px;height:${sh + bar + 2}px;z-index:${l.z}">
<div class="bar" style="height:${bar}px"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span id="T-${l.id}">${esc(l.frame.title || '')}</span></div>
<div class="layer" id="L-${l.id}" style="left:0;top:${bar}px;width:${l.w}px;height:${l.h}px;transform:scale(${l.scale})">${img}</div></div>`;
    };
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{width:${this.width}px;height:${this.totalH}px;position:relative;overflow:hidden;background:#fff;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
#viewport{position:absolute;left:0;top:0;width:${this.width}px;height:${this.height}px;overflow:hidden;background:linear-gradient(135deg,#cdd6e6,#e7ebf3 55%,#dfe6f1)}
#zoom{position:absolute;left:0;top:0;width:${this.width}px;height:${this.height}px;transform-origin:0 0}
.layer{position:absolute;transform-origin:0 0;overflow:hidden;background:#fff}
.layer img{display:block;width:100%;height:100%}
.win{position:absolute;border-radius:10px;overflow:hidden;background:#fff;border:1px solid rgba(0,0,0,.22);box-shadow:0 14px 34px rgba(20,30,60,.30),0 2px 6px rgba(20,30,60,.18);transition:opacity .25s ease,transform .25s ease}
.win.hidden{opacity:0;transform:scale(.95);pointer-events:none;visibility:hidden}
.bar{display:flex;align-items:center;gap:7px;padding:0 11px;background:linear-gradient(#f1f1f3,#dedfe3);border-bottom:1px solid rgba(0,0,0,.16);font-size:12px;color:#3a3a40;position:relative}
.bar i{width:11px;height:11px;border-radius:50%;display:block;flex:none}
.bar span{position:absolute;left:60px;right:60px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ring{position:absolute;pointer-events:none;border-radius:8px;border:3px solid #5566f0;box-shadow:0 0 0 3px rgba(85,102,240,.25);opacity:0;transition:opacity .2s;z-index:5;animation:pulse 1.1s ease-in-out infinite}
.ring.on{opacity:1}
@keyframes pulse{50%{box-shadow:0 0 0 7px rgba(85,102,240,.12)}}
#cap{position:absolute;left:0;top:${this.height}px;width:${this.width}px;height:${this.capH}px;background:#fbfbfd;border-top:1px solid #d3d7df;display:${this.capH ? 'flex' : 'none'};align-items:center;justify-content:center;padding:0 20px}
#capt{font-size:${this.capFont}px;font-weight:600;line-height:1.25;color:#1c1c1e;text-align:center;transition:opacity .18s ease;opacity:0}
${css}
</style></head><body><div id="viewport"><div id="zoom">${decor}${[...this.layers.values()].map(el).join('')}</div></div><div id="cap"><span id="capt"></span></div></body></html>`;
    const file = path.join(this.dir, 'stage.html'); fs.writeFileSync(file, html);
    await this.page.goto(pathToFileURL(file).href);
  }

  // automatic layout for scenes that only want captions: the shooters side by side, scaled to a common height
  static async auto(shooters, { height, captions, finalWidth, capFont = 18 }) {
    const probe = [];
    for (const [i, s] of shooters.entries()) {
      const f = path.join(scratchDir(), `probe-${process.pid}-${i}.png`);
      await s.page.screenshot({ path: f, clip: s.clip });
      const b = fs.readFileSync(f); probe.push({ w: b.readUInt32BE(16) / 2, h: b.readUInt32BE(20) / 2 }); fs.rmSync(f, { force: true });
    }
    const sc = probe.map((p) => height / p.h);
    const natW = Math.round(probe.reduce((a, p, i) => a + p.w * sc[i], 0));
    const k = (finalWidth || natW) / natW;           // how much the encoder will shrink the stage
    const stage = await Stage.launch({ width: natW, height, captions, dsf: 2, capFont: capFont / k, capH: Math.round(CAP_H / k) });
    let x = 0;
    await stage.build({ layers: shooters.map((s, i) => { const l = { id: 's' + i, page: s.page, clip: s.clip, x, y: 0, w: probe[i].w, h: probe[i].h, scale: sc[i] }; x += probe[i].w * sc[i]; return l; }) });
    return stage;
  }

  layer(id) { return this.layers.get(id); }
  // shooter-like entries for the clip guard: a layer is "recorded" only where it is visible on the composited frame
  guardShooters() {
    return [...this.layers.values()].filter((l) => l.page).map((l) => ({ page: l.page, layer: l.id, visible: (box) => this.visibleReason(l.id, box) }));
  }
  // null when `box` (page px of the layer's page) is fully on the frame and on top of everything else; else a reason
  async visibleReason(id, box) {
    return this.page.evaluate(({ id, box }) => {
      const L = document.getElementById('L-' + id); if (!L) return 'no such layer';
      const win = document.getElementById('W-' + id);
      if (win && win.classList.contains('hidden')) return 'its window is not shown';
      const r = L.getBoundingClientRect(); if (!r.width) return 'layer is not displayed';
      const s = r.width / L.offsetWidth, vp = document.getElementById('viewport').getBoundingClientRect();
      const pts = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height], [box.x + box.width / 2, box.y + box.height / 2]]
        .map(([x, y]) => [r.left + x * s, r.top + y * s]);
      for (const [x, y] of pts) if (x < vp.left - 0.5 || y < vp.top - 0.5 || x > vp.right + 0.5 || y > vp.bottom + 0.5) return `target maps to stage point (${Math.round(x)},${Math.round(y)}), outside the visible frame (zoomed out of view?)`;
      const c = pts[4], top = document.elementFromPoint(c[0], c[1]);
      if (!top || !L.contains(top)) return `target centre (${Math.round(c[0])},${Math.round(c[1])}) is covered by another element on the stage`;
      return null;
    }, { id, box });
  }

  async show(id, { title } = {}) {
    const l = this.layers.get(id); l.visible = true;
    await until(() => l.hasImg, 6000, 50);
    await this.page.evaluate(({ id, title }) => {
      if (title != null) { const t = document.getElementById('T-' + id); if (t) t.textContent = title; }
      const w = document.getElementById('W-' + id); if (w) w.classList.remove('hidden'); else document.getElementById('L-' + id).style.display = '';
    }, { id, title });
    await sleep(350);
  }
  async hide(id) {
    const l = this.layers.get(id); l.visible = false;
    await this.page.evaluate((id) => { const w = document.getElementById('W-' + id); if (w) w.classList.add('hidden'); else document.getElementById('L-' + id).style.display = 'none'; }, id);
  }
  // highlight ring around a box (page px of that layer's page); box = null removes it
  async ring(id, box, pad = 4) {
    await this.page.evaluate(({ id, box, pad }) => {
      const L = document.getElementById('L-' + id); let r = L.querySelector('.ring');
      if (!box) { if (r) r.classList.remove('on'); return; }
      if (!r) { r = document.createElement('div'); r.className = 'ring'; L.append(r); }
      Object.assign(r.style, { left: box.x - pad + 'px', top: box.y - pad + 'px', width: box.width + 2 * pad + 'px', height: box.height + 2 * pad + 'px' });
      requestAnimationFrame(() => r.classList.add('on'));
    }, { id, box, pad });
  }
  // zoom the stage area: { x, y, scale } puts stage point (x,y) at the top-left of the frame; null zooms back out
  async zoom(z, ms = 700) {
    await this.page.evaluate(({ z, ms }) => {
      const e = document.getElementById('zoom');
      e.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
      e.style.transform = z ? `scale(${z.scale}) translate(${-z.x}px,${-z.y}px)` : 'none';
    }, { z, ms });
    await sleep(ms + 80);
  }
  // switch the caption text with a short crossfade; null clears it (the bar stays, so the GIF size never changes)
  async caption(text) {
    if (!this.capH) throw new Error('captions are off: set `captions: true` in the scene');
    await this.page.evaluate(async (text) => {
      const e = document.getElementById('capt'); e.style.opacity = 0;
      await new Promise((r) => setTimeout(r, 190));
      e.textContent = text || ''; e.style.opacity = text ? 1 : 0;
    }, text);
    await sleep(220);
  }

  // one composited frame: fresh screenshots of every shown layer, laid out and screenshotted. Returns the PNG path.
  async frame(dir, i) {
    const live = [...this.layers.values()].filter((l) => l.page && l.visible);
    const shots = (await Promise.all(live.map(async (l) => {
      if (l.page.isClosed?.()) return null;
      const f = path.join(dir, `${String(i).padStart(5, '0')}-${l.id}.png`);
      try {
        for (let tries = 0; tries < 3; tries++) {   // retake a garbled (tiled) capture
          await l.page.screenshot({ path: f, clip: l.clip, animations: 'allow', caret: 'initial' });
          if (!isTiledFrame(f)) return [l, f];
          this.dropped++;
        }
      } catch { /* page navigating or just closed: keep its previous image */ }
      return null;
    }))).filter(Boolean);
    if (live.some((l) => !l.hasImg && !shots.some(([m]) => m === l))) throw new Error('a layer has no image yet');
    await this.page.evaluate(async (items) => {
      await Promise.all(items.map(async ([id, url]) => { const im = document.getElementById('I-' + id); im.src = url; try { await im.decode(); } catch { /* ignore */ } }));
    }, shots.map(([l, f]) => [l.id, pathToFileURL(f).href]));
    for (const [l] of shots) l.hasImg = true;
    const out = path.join(dir, `${String(i).padStart(5, '0')}.png`);
    await this.page.screenshot({ path: out, animations: 'allow' });
    for (const [, f] of shots) fs.rmSync(f, { force: true });
    return out;
  }
  async close() {
    try { await this.browser?.close(); } catch { /* ignore */ }
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
