// settings.html?host=app (v3.5c): Stile.app's own settings window for capture-only mode. The same page and styles as the
// extension's settings, but there is no `chrome` object here: the page talks to the app through the `stileSettings`
// message handler (see AppSettingsWindow.swift). Only Capture and Recording (plus a few app rows) are shown.
import { renderCaptureSettings, renderRecordingSettings } from './capture/capture-view.js';

const $ = (id) => document.getElementById(id);
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.length > 2 && k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}
/** a request to the app (WKScriptMessageHandlerWithReply: resolves the app's reply, rejects with its error) */
const native = (msg) => window.webkit.messageHandlers.stileSettings.postMessage(msg);
function toast(msg, ms = 3200) {
  const el = h('div', { class: 'toast', role: 'status', 'data-testid': 'toast', text: msg });
  $('toast-root').append(el);
  setTimeout(() => el.remove(), ms);
}
function blobToBase64(b) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}
/** fetch through the app (URLSession): a bucket's CORS rules would refuse this page's origin */
async function appFetch(url, init = {}) {
  const body = init.body == null ? undefined : await blobToBase64(new Blob([init.body]));
  const r = await native({ op: 'fetch', url, method: init.method || 'GET', headers: init.headers || {}, body });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText || '', text: async () => r.body || '' };
}

const svgOf = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s; };
const NAV = [
  ['screenshots', 'Capture', '#ff375f', 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'],
  ['recording', 'Recording', '#ff453a', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  ['app', 'App', '#32d74b', 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 9h16M8 6.5h.01'],
];

export async function initAppSettings() {
  document.documentElement.dataset.host = 'app';
  let st = await native({ op: 'state' });
  const listeners = new Set();
  const capApp = {
    async state() { return st; },
    async set(patch) { await native({ op: 'set', patch }); },
    async full() { return native({ op: 'full' }); },
    async choose(kind) { await native({ op: 'chooseFolder', kind }); },
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    fetch: appFetch,
  };
  const appSetting = (name, value) => native({ op: 'appSetting', name, value }).catch((e) => toast(String((e && e.message) || e)));

  // ---- App pane
  const R = {};
  const row = (label, desc, ctl, key) => {
    const d = h('div', { class: 'd', text: desc || '' });
    if (key) R[key + 'D'] = d;
    return h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('div', { class: 't', text: label }), d), h('div', { class: 'ctl' }, ctl));
  };
  const sw = (testid, onchange) => { const i = h('input', { type: 'checkbox', 'data-testid': testid }); i.addEventListener('change', () => onchange(i.checked)); return i; };
  const btn = (testid, text, onclick, cls = 'btn') => h('button', { type: 'button', class: cls, 'data-testid': testid, text, onclick });
  R.useChrome = sw('app-use-chrome', (v) => appSetting('setUseChrome', v));
  R.login = sw('app-launch-login', (v) => appSetting('setLaunchAtLogin', v));
  R.menubar = sw('app-menubar-icon', (v) => appSetting('setShowMenuBarIcon', v));
  R.scStatus = h('span', { 'data-testid': 'app-screen-capture' });
  R.scOn = btn('app-screen-capture-on', 'Turn on', () => appSetting('requestScreenCapture', true));
  R.micStatus = h('span', { 'data-testid': 'app-microphone' });
  R.micOn = btn('app-microphone-on', 'Turn on', () => appSetting('requestMicrophone', true));
  R.version = h('span', { class: 'status', 'data-testid': 'app-version' });
  R.quit = btn('app-quit', 'Quit Stile', () => {
    if (R.quit.dataset.armed !== '1') { R.quit.dataset.armed = '1'; R.quit.textContent = 'Click again to quit'; setTimeout(() => { R.quit.dataset.armed = ''; R.quit.textContent = 'Quit Stile'; }, 3500); return; }
    appSetting('quitApp', true);
  }, 'btn danger');
  R.chromeNote = h('p', { class: 'note', 'data-testid': 'app-chrome-note', text: 'Open Chrome with the Stile extension to see sidebar, tab and profile settings here.' });
  const appPane = h('section', { 'data-testid': 'settings-app' },
    h('div', { class: 'group' },
      row('Use Stile with Chrome', 'On: the sidebar over Chrome’s tabs, plus screenshots (needs Accessibility and the Chrome extension). Off: capture only.', R.useChrome),
      row('Launch at login', 'Starts Stile when you sign in.', R.login),
      row('Show menu bar icon', 'Where the capture items live.', R.menubar)),
    R.chromeNote,
    h('h2', { class: 'group-h', text: 'Permissions' }),
    h('div', { class: 'group' },
      row('Screen Recording', 'Needed for every screenshot and recording.', [R.scStatus, R.scOn]),
      row('Microphone', 'Optional. For recordings with your voice.', [R.micStatus, R.micOn]),
      row('Permissions overview', 'All permissions in one place.', btn('app-review-permissions', 'Review permissions…', () => appSetting('reviewPermissions', true)))),
    h('h2', { class: 'group-h', text: 'About' }),
    h('div', { class: 'group' }, row('Version', '', R.version), row('Quit Stile', 'The menu bar icon disappears until you open Stile again.', R.quit)));
  const drawApp = () => {
    R.useChrome.checked = st.useChrome !== false;
    R.chromeNote.hidden = st.useChrome === false;
    R.login.checked = !!st.launchAtLogin;
    R.menubar.checked = st.showMenuBarIcon !== false;
    R.scStatus.textContent = st.screenCapture ? 'On' : ''; R.scStatus.hidden = !st.screenCapture; R.scOn.hidden = !!st.screenCapture;
    R.micStatus.textContent = st.microphone ? 'On' : ''; R.micStatus.hidden = !st.microphone; R.micOn.hidden = !!st.microphone;
    R.version.textContent = st.appVersion ? `Stile ${st.appVersion}` : '';
  };
  window.__stileSettingsPush = (s) => { st = s; drawApp(); for (const f of listeners) f(); };

  // ---- shell
  const capPane = h('section', { 'data-testid': 'settings-section-screenshots' });
  const recPane = h('section', { 'data-testid': 'settings-section-recording' });
  const panes = { screenshots: capPane, recording: recPane, app: appPane };
  const ctx = { cmd: async () => ({ ok: false }), toast, windowId: null, settingsUi: true, appHost: true, capApp };
  renderCaptureSettings(capPane, ctx);
  renderRecordingSettings(recPane, ctx);
  const nav = $('nav');
  const show = (id) => {
    for (const b of nav.querySelectorAll('.nav-item')) { if (b.dataset.section === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== id;
    $('pane-title').textContent = NAV.find((n) => n[0] === id)[1];
    $('pane-body').scrollTop = 0;
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  };
  for (const [id, label, color, d] of NAV) {
    const tile = h('span', { class: 'tile', 'aria-hidden': 'true' }, svgOf(d));
    tile.style.setProperty('--tc', color);
    nav.append(h('button', { type: 'button', class: 'nav-item', 'data-testid': 'settings-nav-' + id, 'data-section': id, onclick: () => show(id) }, tile, h('span', { class: 'nm', text: label })));
  }
  for (const el of Object.values(panes)) { el.classList.add('sec-pane'); $('pane-body').append(el); }
  drawApp();
  const want = location.hash.replace('#', '');
  show(NAV.some((n) => n[0] === want) ? want : 'screenshots');
}
