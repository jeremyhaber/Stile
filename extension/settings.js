// Settings window (v3.0). An extension page opened by the sidebar's gear in its own popup window.
// Left navigation + one pane per section. App-only settings go through the service worker (`appSetting`),
// which relays them to Stile.app; the app's latest state comes back as `appState`.
import { ARCHIVE_CHOICES, DEFAULT_ARCHIVE_MINUTES, STILE_APP_URL, fmtMinutes, resolveStyle, onColor, PROFILE_COLORS, PROFILE_GLYPHS } from './shared.js';
import { icon } from './icons.js';
import { renderBoostSettings } from './boost-view.js';
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
  helper: null, app: null, appEverConnected: false,
  archiveMinutes: null, globalMinutes: DEFAULT_ARCHIVE_MINUTES, archiveGrouped: false, mergeOnClose: true, pinnedReset: true,
  sidebarColor: { mode: 'auto' }, ownStyle: null, overlayEnabled: true, defaultBrowser: false,
  littleStyle: 'minimal', littleMaxOpen: 3, temporaryMinutes: 360, styleEditing: null,
  overrides: {}, migrated: false,   // per-profile tab overrides (all profiles) from the app; whether this profile moved to the global settings
  connectedProfiles: null, scopeProfile: null   // app-hosted only: which profiles have a live extension, and the one this page is scoped to
};
// Stile.app's own window loads this page with a bridge to one profile's extension (`host=app&profile=<dir>`).
const QS = new URLSearchParams(location.search);
const APP_HOST = QS.get('host') === 'app' && !!QS.get('profile');
const native = (msg) => window.webkit.messageHandlers.stileSettings.postMessage(msg);
const HEX6 = /^#[0-9a-f]{6}$/i;
const normSidebarColor = (v) => (v && v.mode === 'custom' && typeof v.color === 'string' && HEX6.test(v.color) ? { mode: 'custom', color: v.color.toLowerCase() } : { mode: 'auto' });

async function load() {
  const [ses, loc, syn] = await Promise.all([
    chrome.storage.session.get(['helper', 'appState']).catch(() => ({})),
    chrome.storage.local.get(['globalDefaultMinutes', 'overlayEnabled', 'defaultBrowser', 'appEverConnected', 'sharedSettings', 'profileOverrides', 'sharedMigrated']).catch(() => ({})),
    chrome.storage.sync.get(['archiveMinutes', 'archiveGrouped', 'ownStyle', 'mergeOnClose', 'sidebarColor', 'littleStyle', 'littleMaxOpen', 'temporaryMinutes', 'pinnedResetOnRestart']).catch(() => ({}))
  ]);
  S.helper = ses.helper || null;
  S.app = ses.appState && typeof ses.appState === 'object' ? ses.appState : null;
  S.globalMinutes = typeof loc.globalDefaultMinutes === 'number' ? loc.globalDefaultMinutes : DEFAULT_ARCHIVE_MINUTES;
  S.appEverConnected = !!loc.appEverConnected;
  S.overlayEnabled = loc.overlayEnabled !== false;
  S.defaultBrowser = !!loc.defaultBrowser;
  // Every value here is the GLOBAL one: the app's cached copy (storage.local sharedSettings), else this profile's synced value.
  const sh = loc.sharedSettings && typeof loc.sharedSettings === 'object' ? loc.sharedSettings : {};
  const g = (k) => (sh[k] !== undefined ? sh[k] : syn[k]);
  S.overrides = loc.profileOverrides && typeof loc.profileOverrides === 'object' ? loc.profileOverrides : {};
  S.migrated = !!loc.sharedMigrated;
  S.archiveGrouped = !!g('archiveGrouped');
  S.mergeOnClose = g('mergeOnClose') !== false;
  S.pinnedReset = g('pinnedResetOnRestart') !== false;
  S.sidebarColor = normSidebarColor(g('sidebarColor'));
  S.ownStyle = syn.ownStyle || null;
  S.littleStyle = g('littleStyle') === 'regular' ? 'regular' : 'minimal';
  S.littleMaxOpen = Number.isFinite(Number(g('littleMaxOpen'))) && g('littleMaxOpen') !== undefined ? Math.min(5, Math.max(1, Math.round(Number(g('littleMaxOpen'))))) : 3;
  S.temporaryMinutes = typeof g('temporaryMinutes') === 'number' && g('temporaryMinutes') >= 0 ? g('temporaryMinutes') : 360;
}
// Every settings write is global: through the service worker to Stile.app (or straight to storage while it is away).
async function setShared(values) {
  const r = await cmd('setShared', { values });
  if (!r || !r.ok) { toast((r && r.error) || 'Could not save the setting'); refresh(); }
  return r;
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
  ['appearance', 'Appearance', '#bf5af2', 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z'],
  ['tabs', 'Tabs & Archive', '#ff9f0a', 'M3 5h18v4H3zM5 9v10h14V9M10 13h4'],
  ['windows', 'Windows', '#0a84ff', 'M3 5h18v14H3zM3 9h18'],
  ['little', 'Little windows', '#30b0c7', 'M5 6h14v10H5zM9 20h6M12 16v4'],
  ['screenshots', 'Screenshots', '#ff375f', 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'],
  ['boosts', 'Boosts', '#ffb000', 'M13 2 4 14h7l-1 8 9-12h-7z'],
  ['profiles', 'Profiles', '#5e5ce6', 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c0-4 3.6-6 8-6s8 2 8 6'],
  ['app', 'App', '#32d74b', 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 9h16M8 6.5h.01']
];
// Every setting is global (one value for all profiles; Stile.app keeps it). The only per-profile values are the three tab
// overrides, edited per profile on the Profiles page. So every pane shows the "All profiles" chip.
const SCOPE = { appearance: 'global', tabs: 'global', windows: 'global', little: 'global', screenshots: 'global', boosts: 'global', profiles: 'global', app: 'global' };
const scopeOf = (id) => SCOPE[id] || 'global';
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
function fillOptions(s, opts, cur) {
  const sig = JSON.stringify(opts);
  if (s.dataset.sig !== sig) { s.replaceChildren(...opts.map(([v, l]) => h('option', { value: v, text: l }))); s.dataset.sig = sig; }
  s.value = String(cur);
}
const appSetting = async (name, value) => {
  const r = await cmd('appSetting', { name, value });
  if (!r || !r.ok) toast((r && r.error) || 'Stile.app didn’t respond');
  return r;
};

// ------------------------------------------------------------------ sections
const sections = {};

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
  root.append(groupHead('Colour'), h('div', { class: 'group' }, colourRow, R.sbcCustom));
  return root;
};

sections.tabs = () => {
  const root = h('section', { 'data-testid': 'settings-section-tabs' });
  const [gw, gs] = sel('settings-archive-global', async (v) => { const r = await cmd('setGlobalArchive', { minutes: Number(v) }); if (!r || !r.ok) refresh(); });
  R.archGlobal = gs;
  R.archGrouped = sw('settings-archive-grouped', (v) => { S.archiveGrouped = v; setShared({ archiveGrouped: v }); });
  R.pinnedReset = sw('pinned-reset-on-restart', (v) => { S.pinnedReset = v; setShared({ pinnedResetOnRestart: v }); });
  root.append(
    group(
      setRow('Archive tabs after', 'Unused tabs move to the archive. Tabs in Favourites and Pinned are never archived. A profile can use its own time: Profiles > pick a profile.', gw, { key: 'globalRow' }),
      setRow('Also archive tabs in groups', 'Tabs inside tab groups are kept by default, including when you press Clear.', R.archGrouped)
    ),
    groupHead('Pinned tabs'),
    group(setRow('Reset pinned tabs when Chrome restarts', 'Favourites and Pinned tabs that wandered off go back to their original page. The back button still resets one by hand.', R.pinnedReset))
  );
  return root;
};

sections.windows = () => {
  const root = h('section', { 'data-testid': 'settings-section-windows' });
  R.mergeOnClose = sw('settings-merge-on-close', (v) => { S.mergeOnClose = v; setShared({ mergeOnClose: v }); });
  const [gbWrap, gbSel] = sel('green-button-action', (v) => appSetting('setGreenButtonAction', v));
  fillOptions(gbSel, [['full', 'Full screen'], ['fill', 'Fill screen']], 'full');
  R.greenSel = gbSel;
  R.greenRow = setRow('Green button', 'What the green window button does in Chrome. Fill screen enlarges the window to the screen without entering full screen.', gbWrap);
  // The green button always fills the screen now (Stile doesn't run in full screen), so the choice is gone.
  root.append(group(setRow('Move tabs back when a pop-out closes', 'Closing a pop-out with a single tab archives that tab instead. The main window is the first window of the session; right-click a window in Today to change it.', R.mergeOnClose)));
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
  R.littleStyle = seg('little-style', [['minimal', 'Minimal'], ['regular', 'Regular']], 'style', (v) => { S.littleStyle = v; setShared({ littleStyle: v }); drawLittle(); });
  const [mw, ms] = sel('little-max-open', (v) => { S.littleMaxOpen = Number(v); setShared({ littleMaxOpen: S.littleMaxOpen }); });
  const [ew, es] = sel('temporary-expiry', (v) => { S.temporaryMinutes = Number(v); setShared({ temporaryMinutes: S.temporaryMinutes }); });
  R.littleMax = ms; R.littleExpiry = es;
  root.append(
    group(setRow('Open links from other apps in little windows', '', R.littleDefault, { descKey: 'littleDefaultHint', descTestid: 'little-default-hint', key: 'littleDefaultRow' })),
    group(
      setRow('Window style', '', R.littleStyle, { descKey: 'littleStyleHint' }),
      setRow('Keep open at most', 'Older little windows close, and their links stay in Temporary.', mw),
      setRow('Move temporary links to Archive after', '', ew)
    ),
    R.littleHotkey = h('p', { class: 'note', 'data-testid': 'little-hotkey-note', text: 'Control+Option+N opens a little window from anywhere.' })
  );
  R.littleStyleHint.id = 'little-style-hint';
  return root;
};

sections.screenshots = () => {
  const root = h('section', { 'data-testid': 'settings-section-screenshots' });
  R.capHost = h('div');
  R.recHost = h('div');   // recording defaults: shown while Stile.app owns the capture settings
  root.append(R.capHost, R.recHost);
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
  root.append(h('p', { class: 'note', style: 'margin:6px 4px 10px', text: 'Pick an icon and colour for each Chrome profile. They show in the sidebar’s profile switcher. A profile can also use its own archive time and tab settings; everything else is shared.' }), R.pstyles);
  return root;
};

sections.app = () => {
  const root = h('section', { 'data-testid': 'settings-app' });
  R.helperDot = h('span', { class: 'status-dot' });
  R.helperStatus = h('span', { 'data-testid': 'helper-status' });
  R.helperRetry = h('button', { type: 'button', class: 'btn', 'data-testid': 'helper-retry', text: 'Retry', onclick: () => cmd('retryHelper') });
  R.overlayEnabled = sw('overlay-enabled', async (v) => { const r = await cmd('setOverlayEnabled', { enabled: v }); if (!r || !r.ok) refresh(); });
  R.login = sw('app-launch-login', (v) => appSetting('setLaunchAtLogin', v));
  R.menubar = sw('app-menubar-icon', (v) => appSetting('setShowMenuBarIcon', v));
  R.useChrome = sw('app-use-chrome', (v) => appSetting('setUseChrome', v));
  R.axDot = h('span', { class: 'status-dot' });
  R.axStatus = h('span', { 'data-testid': 'app-accessibility' });
  R.axOpen = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-accessibility-open', text: 'Open settings', onclick: () => appSetting('openAccessibilitySettings', true) });
  R.scStatus = h('span', { 'data-testid': 'app-screen-capture' });
  R.scOn = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-screen-capture-on', text: 'Turn on', onclick: () => appSetting('requestScreenCapture', true) });
  R.floatNote = h('p', { class: 'note', 'data-testid': 'app-float-note', text: 'Couldn’t control Chrome’s tab rail; a pinned sidebar will float over the page.' });
  R.rescan = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-rescan', text: 'Find again', onclick: () => appSetting('rescanRail', true) });
  R.review = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-review-permissions', text: 'Review permissions…', onclick: () => appSetting('reviewPermissions', true) });
  R.version = h('span', { class: 'status', 'data-testid': 'app-version' });
  R.quit = h('button', { type: 'button', class: 'btn danger', 'data-testid': 'app-quit', text: 'Quit Stile', onclick: async () => {
    if (R.quit.dataset.armed !== '1') { R.quit.dataset.armed = '1'; R.quit.textContent = 'Click again to quit'; setTimeout(() => { R.quit.dataset.armed = ''; R.quit.textContent = 'Quit Stile'; }, 3500); return; }
    R.quit.dataset.armed = ''; R.quit.textContent = 'Quit Stile';
    appSetting('quitApp', true);
  } });
  const [pickWrap, pick] = sel('settings-profile-picker', (v) => { if (v) cmd('setProfileDir', { dir: v }); });
  R.pick = pick;
  R.curProfile = h('span', { class: 'status', 'data-testid': 'settings-current-profile' });
  const shortcutBtn = h('button', { type: 'button', class: 'btn', 'data-testid': 'shortcut-button', text: 'Change…', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {}) });
  const leftBtn = h('button', { type: 'button', class: 'btn', 'data-testid': 'left-button', text: 'Show panel on the left', onclick: () => chrome.tabs.create({ url: 'chrome://settings/appearance' }).catch(() => {}) });
  R.appNeeded = h('p', { class: 'note', 'data-testid': 'app-needed' });
  R.appRows = [];
  const arow = (label, desc, ctl, o) => { const r = setRow(label, desc, ctl, o); R.appRows.push(r); return r; };
  root.append(
    group(
      setRow('Stile app', '', [h('span', { class: 'status' }, R.helperDot, R.helperStatus), R.helperRetry]),
      setRow('Show sidebar over Chrome’s tabs', 'Covers Chrome’s own tab rail with this sidebar.', R.overlayEnabled, { key: 'overlayRow' })
    ),
    R.appNeeded,
    groupHead('Behaviour'),
    group(
      arow('Launch at login', 'Starts Stile.app when you sign in.', R.login),
      arow('Use Stile with Chrome', 'On: the sidebar over Chrome’s tabs, plus screenshots. Off: capture only; Chrome keeps its own tabs and Stile.app just takes screenshots from the menu bar.', R.useChrome),
      arow('Show menu bar icon', 'Puts Stile in the menu bar, with shortcuts for the sidebar, settings and quitting.', R.menubar)
    ),
    groupHead('Permissions'),
    group(
      arow('Accessibility', 'Lets Stile follow and move Chrome’s windows.', [h('span', { class: 'status' }, R.axDot, R.axStatus), R.axOpen]),
      arow('Match Chrome’s colour exactly', 'Needs Screen Recording permission, which also lets Stile take screenshots of other apps.', [R.scStatus, R.scOn], { descKey: 'scNote', descTestid: 'app-screen-capture-note' }),
      arow('Permissions overview', 'Accessibility, Screen Recording, launch at login and the Chrome extension in one place.', R.review)
    ),
    R.floatNote,
    groupHead('Chrome’s tab rail'),
    group(arow('Find Chrome’s tab rail again', 'Use this if Chrome’s vertical tabs moved and the sidebar no longer lines up.', R.rescan)),
    groupHead('About'),
    group(arow('Version', '', R.version), arow('Quit Stile', 'The sidebar disappears until you open Stile.app again.', R.quit)),
    // side-panel mode only (the overlay replaces the side panel)
    R.kbdHead = groupHead('Chrome’s side panel'),
    group(
      R.kbdRow = setRow('Keyboard shortcut', 'Opens and closes the sidebar.', shortcutBtn),
      R.leftRow = setRow('Panel position', 'Set Side panel to Left in Chrome’s appearance settings.', leftBtn)
    ),
    R.tsHead = groupHead('Troubleshooting'),
    group(R.rowProfile = setRow('Chrome profile', 'Stile matches this extension to a Chrome profile by its signed-in account. Change this only if the names look wrong.', [R.curProfile, pickWrap]))
  );
  return root;
};

// ------------------------------------------------------------------ behaviours
let sbSaveTimer = 0;
function setSidebarColor(v, save = true) {
  S.sidebarColor = normSidebarColor(v);
  drawColour();
  clearTimeout(sbSaveTimer);
  const persist = () => setShared({ sidebarColor: S.sidebarColor });
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
  R.littleDefaultRow.hidden = !c;   // app-only: hidden until Stile.app is connected
  R.littleHotkey.hidden = !c;
  R.littleDefaultHint.textContent = 'Stile.app asks macOS to make it your default browser; links it can’t show go to Chrome as usual.';
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
    h('div', {}, h('p', { class: 'cap', text: 'Colour' }), h('div', { class: 'color-grid' }, ...colorBtns)),
    overrideBlock(en));
}
// The only per-profile settings: the three tab settings. Each is "Use global (<value>)" or an explicit value for this profile.
const onOff = (v) => (v ? 'On' : 'Off');
function overrideBlock(en) {
  if (en.own || !connected() || !S.migrated) return null;
  const ov = S.overrides[en.dir] || {};
  const set = async (key, val) => {
    const r = await cmd('setProfileOverride', { dir: en.dir, overrides: { [key]: val } });
    if (!r || !r.ok) toast((r && r.error) || 'Could not save the override');
    refresh();
  };
  const rowFor = (key, label, desc, testid, opts, globalLabel, parse) => {
    const [w, s] = sel(testid, (v) => set(key, v === '' ? null : parse(v)));
    s.dataset.dir = en.dir;
    const cur = ov[key];
    const all = [['', `Use global (${globalLabel})`], ...opts];
    if (cur !== undefined && !all.some((o) => o[0] === String(cur))) all.push([String(cur), key === 'archiveMinutes' ? fmtMinutes(cur) : onOff(cur)]);
    fillOptions(s, all, cur === undefined ? '' : String(cur));
    return setRow(label, desc, w);
  };
  const bool = [['true', 'On'], ['false', 'Off']];
  return h('div', { 'data-testid': 'profile-overrides', 'data-dir': en.dir },
    h('p', { class: 'cap', text: 'Tabs & Archive for this profile' }),
    group(
      rowFor('archiveMinutes', 'Archive tabs after', '', 'profile-override-archive', ARCHIVE_CHOICES.map((v) => [String(v), fmtMinutes(v)]), fmtMinutes(S.globalMinutes), Number),
      rowFor('archiveGrouped', 'Also archive tabs in groups', '', 'profile-override-grouped', bool, onOff(S.archiveGrouped), (v) => v === 'true'),
      rowFor('pinnedResetOnRestart', 'Reset pinned tabs when Chrome restarts', '', 'profile-override-pinned', bool, onOff(S.pinnedReset), (v) => v === 'true')
    ));
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
    const sub = en.own ? 'Without Stile.app, only this profile can be styled' : (en.p.email || (en.current ? 'This profile' : ''));
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
  else if (hs.status === 'not_installed') st.textContent = S.appEverConnected ? 'Not running. Open Stile.app, then Retry' : 'Not installed';
  else st.textContent = `Error: ${hs.error || 'unknown'}`;
  st.dataset.status = (hs && hs.status) || 'checking';
  R.helperRetry.hidden = c;
  R.overlayRow.hidden = !c;
  R.overlayEnabled.checked = S.overlayEnabled;
  const on = appOn();
  for (const r of R.appRows) { r.hidden = !c; r.classList.toggle('disabled', !on); for (const b of r.querySelectorAll('button, input')) b.disabled = !on; }
  R.appNeeded.textContent = on || !c ? '' : 'Waiting for Stile.app’s status…';
  R.appNeeded.hidden = on || !c;
  const a = S.app || {};
  R.login.checked = !!a.launchAtLogin;
  R.menubar.checked = a.showMenuBarIcon !== false;
  R.useChrome.checked = a.useChrome !== false;
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
  R.version.textContent = a.appVersion ? `Stile ${a.appVersion}` : '';
  // Windows: green button
  if (R.greenSel) { R.greenSel.value = a.greenButtonAction === 'fill' ? 'fill' : 'full'; R.greenSel.disabled = !on; }
}

function drawTroubleshoot() {
  const c = connected();
  const ps = profiles();
  const cur = currentProfile();
  R.rowProfile.hidden = !c || !ps.length;
  R.kbdRow.hidden = R.leftRow.hidden = !c || S.overlayEnabled;   // useful in side-panel mode only
  const dir = (S.helper && S.helper.currentProfileDir) || '';
  const opts = [];
  if (!dir || !ps.some((p) => p.dir === dir)) opts.push(['', 'Choose…']);
  for (const p of ps) opts.push([p.dir, p.name + (p.email ? ` (${p.email})` : '')]);
  fillOptions(R.pick, opts, ps.some((p) => p.dir === dir) ? dir : '');
  R.curProfile.replaceChildren(cur && !cur.own ? avatarEl('span', cur.p, cur.style, { 'aria-hidden': 'true' }) : '');
}

// Pane header: the "All profiles" chip (every section is global).
function drawScope() {
  const box = $('pane-scope');
  const kind = scopeOf(current);
  box.dataset.kind = kind;
  box.replaceChildren(h('span', { class: 'scope-chip', 'data-testid': 'settings-scope-global', text: 'All profiles' }));
}

function drawTabs() {
  const c = connected();
  fillOptions(R.archGlobal, ARCHIVE_CHOICES.map((v) => [String(v), fmtMinutes(v)]).concat(ARCHIVE_CHOICES.includes(S.globalMinutes) ? [] : [[String(S.globalMinutes), fmtMinutes(S.globalMinutes)]]), S.globalMinutes);
  R.globalRow.hidden = !c;   // app-only: the archive default lives in Stile.app
  R.archGrouped.checked = S.archiveGrouped;
  R.pinnedReset.checked = S.pinnedReset;
  R.mergeOnClose.checked = S.mergeOnClose;
}

// A group card whose rows are all hidden is hidden too, together with its heading.
function syncGroups() {
  for (const g of document.querySelectorAll('.group')) {
    const kids = [...g.children];
    const empty = kids.length > 0 && kids.every((k) => k.hidden);
    g.hidden = empty;
    const head = g.previousElementSibling;
    if (head && head.classList.contains('group-h')) head.hidden = empty;
  }
}

// Stile.app is required: a gate over the whole window until the helper connects (never for 'checking'/unknown).
function drawGate() {
  const st = S.helper && S.helper.status;
  const down = st === 'not_installed' || st === 'error';
  if (!R.gate) {
    const dl = () => chrome.tabs.create({ url: STILE_APP_URL }).catch(() => {});
    R.gTitle = h('h2', { 'data-testid': 'app-required-title' });
    R.gMsg = h('p', { 'data-testid': 'app-offline-message' });
    R.gSteps = h('ol', { class: 'ag-steps', 'data-testid': 'app-required-steps' }, ['Download Stile.app and move it to Applications.', 'Open it and allow Accessibility.', 'Come back here.'].map((t) => h('li', { text: t })));
    R.gOpen = h('button', { type: 'button', class: 'btn primary', 'data-testid': 'app-offline-open', text: 'Open Stile.app', onclick: () => cmd('retryHelper') });
    R.gDl = h('button', { type: 'button', class: 'btn primary', 'data-testid': 'app-required-download', text: 'Download Stile.app', onclick: dl });
    R.gRetry = h('button', { type: 'button', class: 'btn', 'data-testid': 'app-offline-retry', onclick: () => cmd('retryHelper') });
    R.gGet = h('button', { type: 'button', class: 'ag-link', 'data-testid': 'app-required-get', text: 'Don’t have it? Download Stile.app', onclick: dl });
    R.gate = h('section', { class: 'app-gate', 'data-testid': 'app-required', hidden: true }, h('div', { class: 'ag-body' }, R.gTitle, R.gMsg, R.gSteps, h('div', { class: 'ag-actions' }, R.gOpen, R.gDl, R.gRetry), R.gGet));
    document.body.append(R.gate);
  }
  const fresh = !S.appEverConnected;
  R.gate.hidden = !down;
  document.querySelector('.win').inert = down;
  R.gTitle.textContent = fresh ? 'Stile needs the Stile app' : 'Stile.app isn’t running';
  R.gMsg.textContent = fresh ? 'Stile works together with Stile.app on your Mac. Install it and this window turns on by itself.' : 'Open it to cover Chrome’s tabs with this sidebar.';
  R.gSteps.hidden = !fresh; R.gDl.hidden = !fresh; R.gOpen.hidden = fresh; R.gGet.hidden = fresh;
  R.gRetry.textContent = fresh ? 'Check again' : 'Retry';
}

function drawAll() {
  drawTroubleshoot(); drawColour(); drawTabs(); drawLittle(); drawProfiles(); drawApp(); drawScope();
  syncGroups();
  drawGate();
}

// ------------------------------------------------------------------ shell
let current = 'tabs';
function show(id, push = true) {
  if (!NAV.some((n) => n[0] === id)) id = 'tabs';
  current = id;
  if (secEls.tabs) drawScope();
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
  try { renderRecordingSettings(R.recHost, ctx); } catch (e) { console.warn('[sidebar] recording settings', e); }
  try { renderBoostSettings(R.boostHost, ctx); } catch (e) { console.warn('[sidebar] boost settings', e); }
  drawAll();
  const fromHash = () => { const hs = location.hash.replace('#', ''); const [sec, edit] = hs.split(':'); if (edit) S.styleEditing = decodeURIComponent(edit); show(sec || 'tabs', false); drawProfiles(); };
  window.addEventListener('hashchange', fromHash);
  fromHash();
  chrome.storage.onChanged.addListener((ch, area) => {
    const keys = Object.keys(ch);
    const rel = {
      session: ['helper', 'appState'],
      local: ['globalDefaultMinutes', 'overlayEnabled', 'defaultBrowser', 'appEverConnected', 'sharedSettings', 'profileOverrides', 'sharedMigrated'],
      sync: ['archiveMinutes', 'archiveGrouped', 'ownStyle', 'mergeOnClose', 'littleStyle', 'littleMaxOpen', 'temporaryMinutes', 'pinnedResetOnRestart', 'sidebarColor']
    }[area];
    if (rel && keys.some((k) => rel.includes(k))) refresh();
  });
}
// `settings.html?host=app&profile=<dir>` is Stile.app's own window, bridged to that profile's extension (bridge-shim.js
// supplies `chrome`): the normal page, plus the app's profile scope. Without `profile` (capture-only mode, or no extension
// connected) there is no chrome.* at all: see settings-app.js.
async function boot() {
  if (!APP_HOST) return init();
  document.documentElement.dataset.host = 'app';
  try { await window.__sidebarReady; } catch (e) {
    $('pane-body').replaceChildren(h('p', { class: 'note', 'data-testid': 'settings-bridge-error', text: `Couldn’t reach this profile’s Stile extension (${(e && e.message) || e}). Close this window and open settings again.` }));
    return;
  }
  try { const st = await native({ op: 'state' }); S.connectedProfiles = st.connectedProfiles || null; S.scopeProfile = st.scopeProfile || null; } catch { /* no state: every profile stays selectable */ }
  window.__stileSettingsPush = (st) => {
    if (!st || typeof st !== 'object') return;
    S.connectedProfiles = st.connectedProfiles || null; S.scopeProfile = st.scopeProfile || null;
    if (R.scopeSel) drawScope();
  };
  await init();
}
if (QS.get('host') === 'app' && !QS.get('profile')) import('./settings-app.js').then((m) => m.initAppSettings());
else boot();
