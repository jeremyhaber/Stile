// Settings window (v3.0). An extension page opened by the sidebar's gear in its own popup window.
// Left navigation + one pane per section. App-only settings go through the service worker (`appSetting`),
// which relays them to Sidebar.app; the app's latest state comes back as `appState`.
import { ARCHIVE_CHOICES, DEFAULT_ARCHIVE_MINUTES, fmtMinutes, resolveStyle, onColor, PROFILE_COLORS, PROFILE_GLYPHS } from './shared.js';
import { icon } from './icons.js';
import { renderBoostSettings } from './boost-view.js';
import { renderCaptureSettings } from './capture/capture-view.js';

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
async function cmd(name, args = {}) {
  try { return await chrome.runtime.sendMessage({ cmd: name, ...args }); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
function toast(msg, ms = 3200) {
  const el = h('div', { class: 'toast', role: 'status', 'data-testid': 'toast', text: msg });
  $('toast-root').append(el);
  setTimeout(() => el.remove(), ms);
}

// ------------------------------------------------------------------ state
const S = {
  helper: null, app: null,
  archiveMinutes: null, globalMinutes: DEFAULT_ARCHIVE_MINUTES, archiveGrouped: false, mergeOnClose: true, pinnedReset: true,
  sidebarColor: { mode: 'auto' }, ownStyle: null, overlayEnabled: true, defaultBrowser: false,
  littleStyle: 'minimal', littleMaxOpen: 3, temporaryMinutes: 360, styleEditing: null
};
const HEX6 = /^#[0-9a-f]{6}$/i;
const normSidebarColor = (v) => (v && v.mode === 'custom' && typeof v.color === 'string' && HEX6.test(v.color) ? { mode: 'custom', color: v.color.toLowerCase() } : { mode: 'auto' });

async function load() {
  const [ses, loc, syn] = await Promise.all([
    chrome.storage.session.get(['helper', 'appState']).catch(() => ({})),
    chrome.storage.local.get(['globalDefaultMinutes', 'overlayEnabled', 'defaultBrowser']).catch(() => ({})),
    chrome.storage.sync.get(['archiveMinutes', 'archiveGrouped', 'ownStyle', 'mergeOnClose', 'sidebarColor', 'littleStyle', 'littleMaxOpen', 'temporaryMinutes', 'pinnedResetOnRestart']).catch(() => ({}))
  ]);
  S.helper = ses.helper || null;
  S.app = ses.appState && typeof ses.appState === 'object' ? ses.appState : null;
  S.globalMinutes = typeof loc.globalDefaultMinutes === 'number' ? loc.globalDefaultMinutes : DEFAULT_ARCHIVE_MINUTES;
  S.overlayEnabled = loc.overlayEnabled !== false;
  S.defaultBrowser = !!loc.defaultBrowser;
  S.archiveMinutes = syn.archiveMinutes === undefined ? null : syn.archiveMinutes;
  S.archiveGrouped = !!syn.archiveGrouped;
  S.mergeOnClose = syn.mergeOnClose !== false;
  S.pinnedReset = syn.pinnedResetOnRestart !== false;
  S.sidebarColor = normSidebarColor(syn.sidebarColor);
  S.ownStyle = syn.ownStyle || null;
  S.littleStyle = syn.littleStyle === 'regular' ? 'regular' : 'minimal';
  S.littleMaxOpen = Number.isFinite(Number(syn.littleMaxOpen)) && syn.littleMaxOpen !== undefined ? Math.min(5, Math.max(1, Math.round(Number(syn.littleMaxOpen)))) : 3;
  S.temporaryMinutes = typeof syn.temporaryMinutes === 'number' && syn.temporaryMinutes >= 0 ? syn.temporaryMinutes : 360;
}
const connected = () => !!(S.helper && S.helper.status === 'connected');
const profiles = () => (connected() && S.helper.profiles) || [];
function currentProfile() {
  const dir = S.helper && S.helper.currentProfileDir;
  const p = dir && profiles().find((x) => x.dir === dir);
  if (p) return { p, style: resolveStyle(p), dir: p.dir };
  if (S.ownStyle) { const pp = { dir: '__own', name: 'This profile', picture: null }; return { p: pp, style: resolveStyle(pp, S.ownStyle), dir: null, own: true }; }
  return null;
}
const appOn = () => connected() && !!S.app;   // the app is running and has reported its state

// ------------------------------------------------------------------ building blocks
const NAV = [
  ['general', 'General', '#8e8e93', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3z'],
  ['appearance', 'Appearance', '#bf5af2', 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z'],
  ['tabs', 'Tabs & Archive', '#ff9f0a', 'M3 5h18v4H3zM5 9v10h14V9M10 13h4'],
  ['windows', 'Windows', '#0a84ff', 'M3 5h18v14H3zM3 9h18'],
  ['little', 'Little windows', '#30b0c7', 'M5 6h14v10H5zM9 20h6M12 16v4'],
  ['screenshots', 'Screenshots', '#ff375f', 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'],
  ['boosts', 'Boosts', '#ffb000', 'M13 2 4 14h7l-1 8 9-12h-7z'],
  ['profiles', 'Profiles', '#5e5ce6', 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c0-4 3.6-6 8-6s8 2 8 6'],
  ['app', 'App', '#32d74b', 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 9h16M8 6.5h.01']
];
const svgOf = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s; };

const R = {};   // element refs by key
const setRow = (label, desc, ctl, o = {}) => {
  const d = h('div', { class: 'd', text: desc || '' });
  if (o.descKey) R[o.descKey] = d;
  if (o.descTestid) d.setAttribute('data-testid', o.descTestid);
  const r = h('div', { class: 'row' + (o.cls ? ' ' + o.cls : '') }, h('div', { class: 'lbl' }, h('div', { class: 't', text: label }), d), h('div', { class: 'ctl' }, ctl));
  if (o.key) R[o.key] = r;
  return r;
};
const group = (...rows) => h('div', { class: 'group' }, rows.filter(Boolean));
const groupHead = (t) => h('h2', { class: 'group-h', text: t });
const sw = (testid, onchange) => { const i = h('input', { type: 'checkbox', 'data-testid': testid }); i.addEventListener('change', () => onchange(i.checked)); return i; };
const sel = (testid, onchange, id) => { const s = h('select', { 'data-testid': testid, id }); s.addEventListener('change', () => onchange(s.value)); return [h('span', { class: 'sel' }, s), s]; };
const seg = (testid, pairs, attr, onpick) => {
  const el = h('div', { class: 'seg', role: 'group', 'data-testid': testid });
  for (const [v, label] of pairs) el.append(h('button', { type: 'button', class: 'seg-b', [`data-${attr}`]: v, 'aria-pressed': 'false', text: label, onclick: () => onpick(v) }));
  return el;
};
const setSegPressed = (el, attr, v) => { for (const b of el.querySelectorAll('.seg-b')) b.setAttribute('aria-pressed', String(b.dataset[attr] === v)); };
const syncSet = (obj) => chrome.storage.sync.set(obj).catch(() => {});
function fillOptions(s, opts, cur) {
  const sig = JSON.stringify(opts);
  if (s.dataset.sig !== sig) { s.replaceChildren(...opts.map(([v, l]) => h('option', { value: v, text: l }))); s.dataset.sig = sig; }
  s.value = String(cur);
}
const appSetting = async (name, value) => {
  const r = await cmd('appSetting', { name, value });
  if (!r || !r.ok) toast((r && r.error) || 'Sidebar.app didn’t respond');
  return r;
};

// ------------------------------------------------------------------ sections
const sections = {};

sections.general = () => {
  const root = h('section', { 'data-testid': 'settings-section-general' });
  const [pickWrap, pick] = sel('settings-profile-picker', (v) => { if (v) cmd('setProfileDir', { dir: v }); });
  R.pick = pick;
  R.curProfile = h('span', { class: 'status', 'data-testid': 'settings-current-profile' });
  const shortcutBtn = h('button', { type: 'button', class: 'btn', 'data-testid': 'shortcut-button', text: 'Change…', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {}) });
  const leftBtn = h('button', { type: 'button', class: 'btn', 'data-testid': 'left-button', text: 'Show panel on the left', onclick: () => chrome.tabs.create({ url: 'chrome://settings/appearance' }).catch(() => {}) });
  root.append(
    group(
      setRow('This profile', 'Which Chrome profile this window belongs to.', [R.curProfile, pickWrap], { key: 'rowProfile' })
    ),
    R.kbd = h('div', {}, groupHead('In Chrome’s side panel'),
      group(
        setRow('Keyboard shortcut', 'Opens and closes the Sidebar panel.', shortcutBtn),
        setRow('Panel position', 'Set Side panel to Left in Chrome’s appearance settings.', leftBtn)
      ))
  );
  return root;
};

sections.appearance = () => {
  const root = h('section', { 'data-testid': 'settings-section-appearance' });
  R.sbcMode = seg('sidebar-color-mode', [['auto', 'Automatic'], ['custom', 'Custom']], 'mode', (m) => {
    if (m === 'auto') setSidebarColor({ mode: 'auto' }); else setSidebarColor({ mode: 'custom', color: R.sbcPicker.value || '#e9eef6' });
  });
  R.sbcNote = h('div', { class: 'd', 'data-testid': 'sidebar-color-note' });
  R.sbcPicker = h('input', { type: 'color', 'data-testid': 'sidebar-color-picker', value: '#e9eef6' });
  R.sbcPicker.addEventListener('input', () => setSidebarColor({ mode: 'custom', color: R.sbcPicker.value }, false));
  R.sbcPicker.addEventListener('change', () => setSidebarColor({ mode: 'custom', color: R.sbcPicker.value }));
  const tones = ['#e9eef6', '#f3e8ff', '#e6f4ea', '#fff4e5'];
  R.sbcSwatches = h('div', { class: 'sbc-swatches', role: 'group', 'aria-label': 'Sidebar colour swatches' },
    [...PROFILE_COLORS.map((c) => ({ hex: c.hex, name: c.name })), ...tones.map((t) => ({ hex: t, name: t }))].map((c) => {
      const b = h('button', { type: 'button', class: 'sbc-sw', 'data-testid': 'sidebar-color-swatch', 'data-color': c.hex, title: c.name, 'aria-label': c.name, 'aria-pressed': 'false', onclick: () => setSidebarColor({ mode: 'custom', color: c.hex }) });
      b.style.setProperty('--sw', c.hex);
      return b;
    }));
  R.sbcCustom = h('div', { class: 'row block', 'data-testid': 'sidebar-color-custom' }, R.sbcSwatches,
    h('div', { class: 'sbc-pick', style: 'margin-top:12px' }, h('span', { text: 'Any colour' }), R.sbcPicker));
  const colourRow = h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('div', { class: 't', text: 'Sidebar colour' }), R.sbcNote), h('div', { class: 'ctl' }, R.sbcMode));
  R.pinned = sw('app-pinned', (v) => appSetting('setPinned', v));
  R.pinnedRow = setRow('Keep the sidebar open', 'Stays beside the page. Off collapses it to a slim strip that opens when you point at it.', R.pinned, { key: 'pinnedRowEl' });
  R.pinnedHint = h('p', { class: 'note', 'data-testid': 'app-needed-appearance' });
  root.append(groupHead('Colour'), h('div', { class: 'group' }, colourRow, R.sbcCustom), groupHead('Behaviour'), group(R.pinnedRow), R.pinnedHint);
  return root;
};

sections.tabs = () => {
  const root = h('section', { 'data-testid': 'settings-section-tabs' });
  const [pw, ps] = sel('settings-archive-profile', (v) => cmd('setProfileArchive', { minutes: v === '' ? null : Number(v) }));
  const [gw, gs] = sel('settings-archive-global', async (v) => { const r = await cmd('setGlobalArchive', { minutes: Number(v) }); if (!r || !r.ok) refresh(); });
  R.archProfile = ps; R.archGlobal = gs;
  R.archGrouped = sw('settings-archive-grouped', (v) => { S.archiveGrouped = v; syncSet({ archiveGrouped: v }); });
  R.pinnedReset = sw('pinned-reset-on-restart', (v) => { S.pinnedReset = v; syncSet({ pinnedResetOnRestart: v }); });
  root.append(
    groupHead('Archive'),
    group(
      setRow('Archive tabs after', 'Unused tabs in this profile move to the archive. Tabs pinned to Favourites or Pinned are never archived.', pw),
      setRow('Default for all profiles', '', gw, { descKey: 'globalHint', descTestid: 'global-hint' }),
      setRow('Also archive tabs in groups', 'Tabs inside tab groups are kept by default, including when you press Clear.', R.archGrouped)
    ),
    groupHead('Pinned tabs'),
    group(setRow('Reset pinned tabs when Chrome restarts', 'Favourites and Pinned tabs that wandered off go back to their original page. The back button still resets one by hand.', R.pinnedReset))
  );
  return root;
};

sections.windows = () => {
  const root = h('section', { 'data-testid': 'settings-section-windows' });
  R.mergeOnClose = sw('settings-merge-on-close', (v) => { S.mergeOnClose = v; syncSet({ mergeOnClose: v }); });
  const [gbWrap, gbSel] = sel('green-button-action', (v) => appSetting('setGreenButtonAction', v));
  fillOptions(gbSel, [['full', 'Full screen'], ['fill', 'Fill screen']], 'full');
  R.greenSel = gbSel;
  R.greenRow = setRow('Green button', 'What the green window button does in Chrome. Fill screen enlarges the window to the screen without entering full screen.', gbWrap);
  root.append(group(setRow('Move tabs back when a pop-out closes', 'Closing a pop-out with a single tab archives that tab instead. The main window is the first window of the session; right-click a window in Today to change it.', R.mergeOnClose), R.greenRow));
  return root;
};

const TEMP_EXPIRY = [60, 360, 720, 1440, 0];
sections.little = () => {
  const root = h('section', { 'data-testid': 'settings-little' });
  R.littleDefault = sw('little-default-browser', async (v) => {
    const r = await cmd('setDefaultBrowser', { enabled: v });
    if (!r || !r.ok) toast((r && r.error) || 'Could not change the default browser');
    refresh();
  });
  R.littleStyle = seg('little-style', [['minimal', 'Minimal'], ['regular', 'Regular']], 'style', (v) => { S.littleStyle = v; syncSet({ littleStyle: v }); drawLittle(); });
  const [mw, ms] = sel('little-max-open', (v) => { S.littleMaxOpen = Number(v); syncSet({ littleMaxOpen: S.littleMaxOpen }); });
  const [ew, es] = sel('temporary-expiry', (v) => { S.temporaryMinutes = Number(v); syncSet({ temporaryMinutes: S.temporaryMinutes }); });
  R.littleMax = ms; R.littleExpiry = es;
  root.append(
    group(setRow('Open links from other apps in little windows', '', R.littleDefault, { descKey: 'littleDefaultHint', descTestid: 'little-default-hint' })),
    groupHead('Windows'),
    group(
      setRow('Window style', '', R.littleStyle, { descKey: 'littleStyleHint' }),
      setRow('Keep open at most', 'Older little windows close, and their links stay in Temporary.', mw),
      setRow('Move temporary links to Archive after', '', ew)
    ),
    h('p', { class: 'note', text: 'Control+Option+N opens a little window from anywhere.' })
  );
  R.littleStyleHint.id = 'little-style-hint';
  return root;
};

sections.screenshots = () => {
  const root = h('section', { 'data-testid': 'settings-section-screenshots' });
  R.capHost = h('div');
  root.append(R.capHost);
  return root;
};
sections.boosts = () => {
  const root = h('section', { 'data-testid': 'settings-section-boosts' });
  R.boostHost = h('div');
  root.append(R.boostHost);
  return root;
};

sections.profiles = () => {
  const root = h('section', { 'data-testid': 'settings-section-profiles' });
  R.pstyles = h('div', { class: 'group', 'data-testid': 'settings-profiles' });
  root.append(h('p', { class: 'note', style: 'margin:6px 4px 10px', text: 'Pick an icon and colour for each Chrome profile. They show in the sidebar’s profile switcher.' }), R.pstyles);
  return root;
};

sections.app = () => {
  const root = h('section', { 'data-testid': 'settings-app' });
  R.helperDot = h('span', { class: 'status-dot' });
  R.helperStatus = h('span', { 'data-testid': 'helper-status' });
  R.helperRetry = h('button', { type: 'button', class: 'btn', 'data-testid': 'helper-retry', text: 'Retry', onclick: () => cmd('retryHelper') });
  R.overlayEnabled = sw('overlay-enabled', async (v) => { const r = await cmd('setOverlayEnabled', { enabled: v }); if (!r || !r.ok) refresh(); });
  R.login = sw('app-launch-login', (v) => appSetting('setLaunchAtLogin', v));
  R.lockstep = sw('app-lockstep', (v) => appSetting('setLockstep', v));
  R.menubar = sw('app-menubar-icon', (v) => appSetting('setShowMenuBarIcon', v));
  R.axDot = h('span', { class: 'status-dot' });
  R.axStatus = h('span', { 'data-testid': 'app-accessibility' });
  R.axOpen = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-accessibility-open', text: 'Open settings', onclick: () => appSetting('openAccessibilitySettings', true) });
  R.scStatus = h('span', { 'data-testid': 'app-screen-capture' });
  R.scOn = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-screen-capture-on', text: 'Turn on', onclick: () => appSetting('requestScreenCapture', true) });
  R.floatNote = h('p', { class: 'note', 'data-testid': 'app-float-note', text: 'Couldn’t control Chrome’s tab rail; a pinned sidebar will float over the page.' });
  R.rescan = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-rescan', text: 'Find again', onclick: () => appSetting('rescanRail', true) });
  R.review = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-review-permissions', text: 'Review permissions…', onclick: () => appSetting('reviewPermissions', true) });
  R.version = h('span', { class: 'status', 'data-testid': 'app-version' });
  R.quit = h('button', { type: 'button', class: 'btn danger', 'data-testid': 'app-quit', text: 'Quit Sidebar', onclick: async () => {
    if (R.quit.dataset.armed !== '1') { R.quit.dataset.armed = '1'; R.quit.textContent = 'Click again to quit'; setTimeout(() => { R.quit.dataset.armed = ''; R.quit.textContent = 'Quit Sidebar'; }, 3500); return; }
    R.quit.dataset.armed = ''; R.quit.textContent = 'Quit Sidebar';
    appSetting('quitApp', true);
  } });
  R.appNeeded = h('p', { class: 'note', 'data-testid': 'app-needed' });
  R.appRows = [];
  const arow = (label, desc, ctl, o) => { const r = setRow(label, desc, ctl, o); R.appRows.push(r); return r; };
  root.append(
    group(
      setRow('Sidebar app', '', [h('span', { class: 'status' }, R.helperDot, R.helperStatus), R.helperRetry]),
      setRow('Show sidebar over Chrome’s tabs', 'Covers Chrome’s own tab rail with this sidebar.', R.overlayEnabled, { key: 'overlayRow' })
    ),
    R.appNeeded,
    groupHead('Behaviour'),
    group(
      arow('Launch at login', 'Starts Sidebar.app when you sign in.', R.login),
      arow('Move Chrome and the sidebar together', 'Sidebar.app moves Chrome’s window itself while you drag it, so the two stay together. Turn off if window snapping or other window tools misbehave.', R.lockstep),
      arow('Show menu bar icon', 'Puts Sidebar in the menu bar, with shortcuts for the sidebar, settings and quitting.', R.menubar)
    ),
    groupHead('Permissions'),
    group(
      arow('Accessibility', 'Lets Sidebar follow and move Chrome’s windows.', [h('span', { class: 'status' }, R.axDot, R.axStatus), R.axOpen]),
      arow('Match Chrome’s colour exactly', 'Needs Screen Recording permission. Sidebar only looks at Chrome’s window.', [R.scStatus, R.scOn], { descKey: 'scNote', descTestid: 'app-screen-capture-note' }),
      arow('Permissions overview', 'Accessibility, Screen Recording, launch at login and the Chrome extension in one place.', R.review)
    ),
    R.floatNote,
    groupHead('Chrome’s tab rail'),
    group(arow('Find Chrome’s tab rail again', 'Use this if Chrome’s vertical tabs moved and the sidebar no longer lines up.', R.rescan)),
    groupHead('About'),
    group(arow('Version', '', R.version), arow('Quit Sidebar', 'The sidebar disappears until you open Sidebar.app again.', R.quit))
  );
  return root;
};

// ------------------------------------------------------------------ behaviours
let sbSaveTimer = 0;
function setSidebarColor(v, save = true) {
  S.sidebarColor = normSidebarColor(v);
  drawColour();
  clearTimeout(sbSaveTimer);
  const persist = () => syncSet({ sidebarColor: S.sidebarColor });
  if (save) persist(); else sbSaveTimer = setTimeout(persist, 250);
}
function colourSource() {
  if (S.sidebarColor.mode === 'custom') return 'custom';
  if (appOn() && typeof S.app.chromeColor === 'string' && HEX6.test(S.app.chromeColor)) return 'chrome';
  const cur = currentProfile();
  const ct = cur && cur.p && cur.p.chromeTheme;
  if (ct && typeof ct.userColor === 'string' && HEX6.test(ct.userColor)) return 'theme';
  return 'default';
}
function drawColour() {
  const custom = S.sidebarColor.mode === 'custom' ? S.sidebarColor.color : null;
  setSegPressed(R.sbcMode, 'mode', custom ? 'custom' : 'auto');
  R.sbcCustom.hidden = !custom;
  for (const b of R.sbcSwatches.children) b.setAttribute('aria-pressed', String(!!custom && b.dataset.color === custom));
  if (custom && document.activeElement !== R.sbcPicker) R.sbcPicker.value = custom;
  const src = colourSource();
  R.sbcNote.textContent = { chrome: 'Matching Chrome exactly', theme: 'From your Chrome theme colour', profile: 'From your profile colour', default: 'Chrome’s default colour', custom: 'Using the colour you picked' }[src];
}

function drawLittle() {
  const c = connected();
  R.littleDefault.checked = c && S.defaultBrowser;
  R.littleDefault.disabled = !c;
  R.littleDefaultHint.textContent = c
    ? 'Sidebar.app asks macOS to make it your default browser; links it can’t show go to Chrome as usual.'
    : 'Needs Sidebar.app. Open it, then turn this on.';
  setSegPressed(R.littleStyle, 'style', S.littleStyle);
  R.littleStyleHint.textContent = S.littleStyle === 'minimal'
    ? 'Just the page and a slim address bar. “Make full tab” reopens the page in your main window.'
    : 'A regular Chrome window with toolbar and tabs. “Make full tab” moves the live tab, keeping its page state.';
  fillOptions(R.littleMax, [1, 2, 3, 4, 5].map((n) => [String(n), String(n)]), S.littleMaxOpen);
  const opts = TEMP_EXPIRY.slice();
  if (!opts.includes(S.temporaryMinutes)) opts.push(S.temporaryMinutes);
  fillOptions(R.littleExpiry, opts.map((v) => [String(v), fmtMinutes(v)]), S.temporaryMinutes);
}

function avatarEl(tag, p, style, props = {}, big = false) {
  const inner = style.icon === 'picture' && p.picture
    ? h('img', { src: p.picture, alt: '', draggable: 'false' })
    : style.icon === 'initial'
      ? h('span', { class: 'letter', text: ((p.name || p.dir || '?').trim()[0] || '?').toUpperCase() })
      : icon(style.icon, big ? 18 : 16);
  const el = h(tag, { class: 'pbtn' + (big ? ' big' : ''), ...props }, inner);
  el.style.setProperty('--pc', style.color);
  el.style.setProperty('--pf', onColor(style.color));
  return el;
}

async function saveStyle(en, style) {
  if (en.own) S.ownStyle = style;
  else if (S.helper && S.helper.profiles) S.helper = { ...S.helper, profiles: S.helper.profiles.map((p) => (p.dir === en.dir ? { ...p, style } : p)) };
  drawProfiles();
  const r = await cmd('setProfileStyle', { dir: en.dir, style });
  if (!r || !r.ok) { toast((r && r.error) || 'Could not save the profile style'); refresh(); }
}
function styleEditor(en) {
  const cur = en.style;
  const names = [];
  if (en.p.picture) names.push('picture');
  names.push('initial', ...PROFILE_GLYPHS);
  const iconBtns = names.map((name) => {
    const inner = name === 'picture' ? h('img', { src: en.p.picture, alt: '', draggable: 'false' })
      : name === 'initial' ? h('span', { class: 'letter', text: ((en.p.name || '?').trim()[0] || '?').toUpperCase() }) : icon(name, 18);
    const b = h('button', { type: 'button', class: 'style-icon', title: name, 'aria-label': `Icon: ${name}`, 'aria-pressed': cur.icon === name ? 'true' : 'false', 'data-testid': 'style-icon', 'data-icon': name,
      onclick: () => saveStyle(en, { icon: name, color: cur.color }) }, inner);
    b.style.setProperty('--sc', cur.color); b.style.setProperty('--sf', onColor(cur.color));
    return b;
  });
  const colorBtns = PROFILE_COLORS.map((c) => {
    const b = h('button', { type: 'button', class: 'style-color', title: c.name, 'aria-label': `Colour: ${c.name}`, 'aria-pressed': cur.color === c.hex ? 'true' : 'false', 'data-testid': 'style-color', 'data-color': c.hex,
      onclick: () => saveStyle(en, { icon: cur.icon, color: c.hex }) }, cur.color === c.hex ? icon('check', 14) : null);
    b.style.setProperty('--c', c.hex); b.style.setProperty('--cf', onColor(c.hex));
    return b;
  });
  return h('div', { class: 'style-editor', 'data-testid': 'style-editor', 'data-dir': en.dir },
    h('div', {}, h('p', { class: 'cap', text: 'Icon' }), h('div', { class: 'icon-grid' }, ...iconBtns)),
    h('div', {}, h('p', { class: 'cap', text: 'Colour' }), h('div', { class: 'color-grid' }, ...colorBtns)));
}
function drawProfiles() {
  const hs = S.helper;
  const ok = connected() && hs.profiles && hs.profiles.length;
  let entries;
  if (ok) entries = hs.profiles.map((p) => ({ p, dir: p.dir, style: resolveStyle(p), current: p.dir === hs.currentProfileDir }));
  else { const pp = { dir: '__own', name: 'This profile', picture: null }; entries = [{ p: pp, dir: '__own', style: resolveStyle(pp, S.ownStyle), current: true, own: true }]; }
  const kids = [];
  for (const en of entries) {
    const open = S.styleEditing === en.dir;
    const sub = en.own ? 'Without Sidebar.app, only this profile can be styled' : (en.p.email || (en.current ? 'This profile' : ''));
    kids.push(h('button', { type: 'button', class: 'pstyle-row', 'aria-expanded': open ? 'true' : 'false', 'data-testid': 'profile-style-row', 'data-dir': en.dir, onclick: () => { S.styleEditing = open ? null : en.dir; drawProfiles(); } },
      avatarEl('span', en.p, en.style, { 'aria-hidden': 'true' }, true),
      h('span', { class: 'pname' }, en.p.name || en.dir, sub ? h('small', { text: en.current && en.p.email ? `${en.p.email} · this profile` : sub }) : null),
      h('span', { class: 'chev' }, icon('chevron', 14))));
    if (open) kids.push(styleEditor(en));
  }
  R.pstyles.replaceChildren(...kids);
}

function drawApp() {
  const hs = S.helper;
  const c = connected();
  R.helperDot.className = 'status-dot' + (c ? ' ok' : hs && hs.status && hs.status !== 'connected' ? ' bad' : '');
  const st = R.helperStatus;
  if (!hs || !hs.status) st.textContent = 'Checking…';
  else if (hs.status === 'connected') st.textContent = 'Connected';
  else if (hs.status === 'not_installed') st.textContent = 'Not running. Open Sidebar.app, then Retry';
  else st.textContent = `Error: ${hs.error || 'unknown'}`;
  st.dataset.status = (hs && hs.status) || 'checking';
  R.helperRetry.hidden = c;
  R.overlayRow.hidden = !c;
  R.overlayEnabled.checked = S.overlayEnabled;
  const on = appOn();
  for (const r of R.appRows) { r.classList.toggle('disabled', !on); for (const b of r.querySelectorAll('button, input')) b.disabled = !on; }
  R.appNeeded.textContent = on ? '' : (c ? 'Waiting for Sidebar.app’s status…' : 'Open Sidebar.app to change these settings.');
  R.appNeeded.hidden = on;
  const a = S.app || {};
  R.login.checked = !!a.launchAtLogin;
  R.lockstep.checked = a.lockstep !== false;
  R.menubar.checked = a.showMenuBarIcon !== false;
  const ax = on ? (typeof a.accessibility === 'boolean' ? a.accessibility : null) : null;
  R.axStatus.textContent = ax === true ? 'Granted' : ax === false ? 'Needed' : 'Unknown';
  R.axDot.className = 'status-dot' + (ax === true ? ' ok' : ax === false ? ' bad' : '');
  R.axStatus.title = ax === true ? 'Accessibility access granted' : ax === false ? 'Accessibility access needed' : 'Accessibility access unknown';
  R.axOpen.hidden = ax !== false;
  const sc = on && typeof a.screenCapture === 'boolean' ? a.screenCapture : null;
  R.scStatus.textContent = sc === true ? 'On' : '';
  R.scStatus.hidden = sc !== true;
  R.scOn.hidden = sc === true;
  R.scNote.hidden = sc === true;
  R.floatNote.hidden = !(on && a.railFound !== false && a.railControllable === false);
  R.version.textContent = a.appVersion ? `Sidebar ${a.appVersion}` : '';
  // Windows: green button
  if (R.greenSel) { R.greenSel.value = a.greenButtonAction === 'fill' ? 'fill' : 'full'; R.greenSel.disabled = !on; }
  // Appearance: pinned sidebar
  R.pinned.checked = a.state === 'pinned' || (a.state === undefined && a.pinned === true);
  R.pinned.disabled = !on;
  R.pinnedRowEl.classList.toggle('disabled', !on);
  R.pinnedHint.textContent = on ? '' : 'Needs Sidebar.app.';
  R.pinnedHint.hidden = on;
}

function drawGeneral() {
  const c = connected();
  const ps = profiles();
  const cur = currentProfile();
  R.rowProfile.hidden = !c || !ps.length;
  const dir = (S.helper && S.helper.currentProfileDir) || '';
  const opts = [];
  if (!dir || !ps.some((p) => p.dir === dir)) opts.push(['', 'Choose…']);
  for (const p of ps) opts.push([p.dir, p.name + (p.email ? ` (${p.email})` : '')]);
  fillOptions(R.pick, opts, ps.some((p) => p.dir === dir) ? dir : '');
  R.curProfile.replaceChildren(cur && !cur.own ? avatarEl('span', cur.p, cur.style, { 'aria-hidden': 'true' }) : '');
  R.kbd.hidden = appOn();
}

function drawTabs() {
  const c = connected();
  fillOptions(R.archProfile, [['', `Default for all profiles (${fmtMinutes(S.globalMinutes)})`], ...ARCHIVE_CHOICES.map((v) => [String(v), fmtMinutes(v)])].concat(
    S.archiveMinutes !== null && !ARCHIVE_CHOICES.includes(S.archiveMinutes) ? [[String(S.archiveMinutes), fmtMinutes(S.archiveMinutes)]] : []), S.archiveMinutes === null ? '' : S.archiveMinutes);
  fillOptions(R.archGlobal, ARCHIVE_CHOICES.map((v) => [String(v), fmtMinutes(v)]).concat(ARCHIVE_CHOICES.includes(S.globalMinutes) ? [] : [[String(S.globalMinutes), fmtMinutes(S.globalMinutes)]]), S.globalMinutes);
  R.archGlobal.disabled = !c;
  R.globalHint.textContent = c ? 'Shared by every Chrome profile that has Sidebar installed.' : 'Needs Sidebar.app. Until it is running the default stays at 12 hours.';
  R.archGrouped.checked = S.archiveGrouped;
  R.pinnedReset.checked = S.pinnedReset;
  R.mergeOnClose.checked = S.mergeOnClose;
}

function drawAll() {
  drawGeneral(); drawColour(); drawTabs(); drawLittle(); drawProfiles(); drawApp();
}

// ------------------------------------------------------------------ shell
let current = 'general';
function show(id, push = true) {
  if (!NAV.some((n) => n[0] === id)) id = 'general';
  current = id;
  for (const b of document.querySelectorAll('.nav-item')) { if (b.dataset.section === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  for (const [k, el] of Object.entries(secEls)) el.hidden = k !== id;
  $('pane-title').textContent = NAV.find((n) => n[0] === id)[1];
  $('pane-body').scrollTop = 0;
  if (push && location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
}
const secEls = {};
async function refresh() { await load(); drawAll(); }

async function init() {
  await load();
  const nav = $('nav');
  for (const [id, label, color, d] of NAV) {
    const tile = h('span', { class: 'tile', 'aria-hidden': 'true' }, svgOf(d));
    tile.style.setProperty('--tc', color);
    nav.append(h('button', { type: 'button', class: 'nav-item', 'data-testid': 'settings-nav-' + id, 'data-section': id, onclick: () => show(id) }, tile, h('span', { class: 'nm', text: label })));
    if (id === 'little' || id === 'boosts') nav.append(h('span', { class: 'nav-sp', 'aria-hidden': 'true' }));
  }
  for (const [id] of NAV) { const el = sections[id](); el.hidden = true; el.classList.add('sec-pane'); secEls[id] = el; $('pane-body').append(el); }
  const ctx = {
    cmd, toast, get windowId() { return null; },
    // the screenshots / boosts sections draw their own rows
    settingsUi: true
  };
  try { renderCaptureSettings(R.capHost, ctx); } catch (e) { console.warn('[sidebar] capture settings', e); }
  try { renderBoostSettings(R.boostHost, ctx); } catch (e) { console.warn('[sidebar] boost settings', e); }
  drawAll();
  const fromHash = () => { const hs = location.hash.replace('#', ''); const [sec, edit] = hs.split(':'); if (edit) S.styleEditing = decodeURIComponent(edit); show(sec || 'general', false); drawProfiles(); };
  window.addEventListener('hashchange', fromHash);
  fromHash();
  chrome.storage.onChanged.addListener((ch, area) => {
    const keys = Object.keys(ch);
    const rel = {
      session: ['helper', 'appState'],
      local: ['globalDefaultMinutes', 'overlayEnabled', 'defaultBrowser'],
      sync: ['archiveMinutes', 'archiveGrouped', 'ownStyle', 'mergeOnClose', 'littleStyle', 'littleMaxOpen', 'temporaryMinutes', 'pinnedResetOnRestart', 'sidebarColor']
    }[area];
    if (rel && keys.some((k) => rel.includes(k))) refresh();
  });
}
init();
