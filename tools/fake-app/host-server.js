'use strict';
// Reference implementation of the Stile app's `HostServer` (the helper merged into the Mac app).
// It speaks exactly the protocol the old Perl helper spoke, but over ONE Unix
// socket (`<appDir>/host.sock`) shared by every Chrome profile: each accepted connection is one
// profile's extension (Chrome starts the connector once per profile; the connector is a byte pipe).
//
// The Swift `HostServer` must behave like this file. Keep it small and readable.
//
// Wire format, both directions: native messaging framing = 4-byte native-endian (little-endian on
// every platform we run on) length + UTF-8 JSON.
//
// Bridge relay: `bridge` envelopes for a profile are written to that profile's connection
// (`host.sendBridge(profileDir, msg)`); `bridgeResult` / `bridgeEvent` coming back on it are emitted
// as `host.on('fromExt', ({ profileDir, msg }))`. Nothing else is forwarded.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { CaptureSettings } = require('./capture-settings');
const { spawn } = require('child_process');

const HOST_VERSION = '2.1.0';
const EXTENSION_ORIGIN = 'chrome-extension://ffblekellgdmlecjablfojaaadpkmdgg/';
const MAX_PICTURE = 150 * 1024;
const MAX_PREFS = 5 * 1024 * 1024;
const MAX_REPLY = 900 * 1000; // hello/profiles replies stay under 900 KB (Chrome's limit is 1 MB)
const MAX_FRAME = 64 * 1024 * 1024;
const HANDOFF_SECONDS = 60;
const DEFAULT_ARCHIVE_MINUTES = 720;
// v3.0: app-only settings the extension relays from the settings window ({type:"appSetting", name, value}).
const APP_SETTINGS = new Set(['setPinned','setLaunchAtLogin', 'requestScreenCapture', 'openAccessibilitySettings', 'rescanRail', 'quitApp', 'reviewPermissions', 'setShowMenuBarIcon', 'setGreenButtonAction', 'setCaptureSettings', 'chooseCaptureFolder', 'setUseChrome']);
const ICONS = new Set('picture initial home briefcase code star heart book music camera palette rocket leaf coffee game globe bolt moon'.split(' '));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPlainString = (v) => typeof v === 'string' && v !== '';
const safeDirName = (d) => typeof d === 'string' && d !== '' && d !== '.' && d !== '..' && !/[/\\]/.test(d);

// ---------------------------------------------------------------- Local State / Preferences parsing

/** Signed 32-bit ARGB int (number or numeric string) -> "#rrggbb", else null. */
function colorHex(n) {
  if (typeof n === 'string' && /^-?\d+$/.test(n)) n = Number(n);
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

function validMinutes(v) {
  return (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v));
}

function cleanStyle(s) {
  if (!isObject(s)) return null;
  if (typeof s.icon !== 'string' || !ICONS.has(s.icon)) return null;
  if (typeof s.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.color)) return null;
  return { icon: s.icon, color: s.color };
}

function readJsonFile(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || !st.size || (maxBytes && st.size > maxBytes)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

/** Profile picture as a data: URL (<= 150 KB), or null. */
function readPicture(dataDir, dir, entry) {
  if (!safeDirName(dir)) return null;
  let file = 'Google Profile Picture.png';
  const g = entry.gaia_picture_file_name;
  if (isPlainString(g) && !/[/\\]/.test(g) && g !== '.' && g !== '..') file = g;
  try {
    const p = path.join(dataDir, dir, file);
    const st = fs.statSync(p);
    if (!st.isFile() || !st.size || st.size > MAX_PICTURE) return null;
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch { return null; }
}

/** `chromeTheme` from <profile>/Preferences; nulls / "system" when missing or unreadable. */
function readChromeTheme(dataDir, dir) {
  const theme = { userColor: null, colorScheme: 'system', variant: null, themeId: null };
  if (!safeDirName(dir)) return theme;
  const prefs = readJsonFile(path.join(dataDir, dir, 'Preferences'), MAX_PREFS);
  if (!isObject(prefs)) return theme;
  const th = isObject(prefs.browser) && isObject(prefs.browser.theme) ? prefs.browser.theme : {};
  theme.userColor = colorHex(th.user_color);
  const cs = th.color_scheme2 !== undefined && th.color_scheme2 !== null ? th.color_scheme2 : th.color_scheme;
  if (typeof cs === 'number' || (typeof cs === 'string' && /^\d+$/.test(cs))) {
    const n = Number(cs);
    theme.colorScheme = n === 1 ? 'light' : n === 2 ? 'dark' : 'system';
  }
  const v = th.color_variant;
  if ((typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && /^-?\d+$/.test(v))) theme.variant = Number(v);
  const id = isObject(prefs.extensions) && isObject(prefs.extensions.theme) ? prefs.extensions.theme.id : null;
  if (isPlainString(id)) theme.themeId = id;
  return theme;
}

// ---------------------------------------------------------------- the server

class HostServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.appDir          holds host.sock and state.json (SIDEBAR_APP_DIR)
   * @param {string} o.localState      Chrome's `Local State` (SIDEBAR_LOCAL_STATE)
   * @param {string} o.chromeBin       Chrome executable used to open a profile (SIDEBAR_CHROME_BIN)
   * @param {string} [o.legacyStateFile] old SidebarHelper/state.json, imported once if state.json is missing
   * @param {boolean} [o.overlay=true] send overlayStatus{connected:true} after identify
   * @param {(msg:string)=>void} [o.log]
   */
  constructor(o = {}) {
    super();
    const home = os.homedir();
    this.appDir = o.appDir || process.env.SIDEBAR_APP_DIR || path.join(home, 'Library/Application Support/Stile');
    this.localState = o.localState || process.env.SIDEBAR_LOCAL_STATE || path.join(home, 'Library/Application Support/Google/Chrome/Local State');
    this.chromeBin = o.chromeBin || process.env.SIDEBAR_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    this.legacyStateFile = o.legacyStateFile || null;
    this.overlay = o.overlay !== false;
    this.log = o.log || (() => {});
    this.sockPath = path.join(this.appDir, 'host.sock');
    this.stateFile = path.join(this.appDir, 'state.json');
    /** every live connection (identified or not) */
    this.conns = new Set();
    /** profileDir -> connection (at most one live connection per profile) */
    this.byProfile = new Map();
    /** profileDir -> { bounds, ts (epoch seconds) }: handoffs waiting for that profile's identify */
    this.pending = new Map();
    /** profileDir -> timestamps (ms) of recent replacement attempts (duplicate-profile guard) */
    this.replacements = new Map();
    this.server = null;
    /** the app's latest host state (what the sidebar page receives as `hostState`), pushed to every extension as {type:"appState", state} */
    this.appState = null;
    /** v3.5c: the app-owned capture settings (state.json `capture`, the secret in a Keychain stand-in) and the mode */
    this.capture = new CaptureSettings(this);
    this.useChrome = o.useChrome !== false;
    this.microphones = [];
    /** v3.7: does the app have its own settings window? (`showSettings` replies ok only then) and the requests it got: [{ profileDir, section }] */
    this.settingsWindow = o.settingsWindow === true;
    this.showSettingsCalls = [];
  }

  // ---- lifecycle
  async listen() {
    fs.mkdirSync(this.appDir, { recursive: true });
    this.importLegacyState();
    try { fs.unlinkSync(this.sockPath); } catch { /* not there */ }
    this.server = net.createServer((sock) => this.accept(sock));
    await new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(this.sockPath, res); });
    fs.chmodSync(this.sockPath, 0o600);
    this.log(`listening on ${this.sockPath}`);
    return this.sockPath;
  }

  async close() {
    for (const c of [...this.conns]) c.sock.destroy();
    await new Promise((res) => (this.server ? this.server.close(res) : res()));
    try { fs.unlinkSync(this.sockPath); } catch { /* gone */ }
  }

  /** Is there a live connection for this profile? */
  isConnected(profileDir) { return this.byProfile.has(profileDir); }

  /** Write a `bridge` envelope to a profile's extension. Returns false if that profile isn't connected. */
  sendBridge(profileDir, msg) { return this.sendToProfile(profileDir, msg); }

  /**
   * v3.6: the app lists its recent recordings in the extension: metadata and a small JPEG thumbnail only (the video stays on
   * the Mac). Mirrors `RecentRecordings.send` in Swift: the message is dropped when it would exceed Chrome's 1 MB limit.
   * `rec` = { id, title, duration (s), time (ms), link, thumb (base64 JPEG) } or { id, removed: true }.
   */
  sendNativeRecording(profileDir, rec) {
    const m = rec.removed
      ? { type: 'nativeRecording', id: rec.id, removed: true }
      : { type: 'nativeRecording', id: rec.id, title: rec.title || '', duration: rec.duration || 0, time: rec.time || Date.now(), link: rec.link || '', ...(rec.thumb ? { thumb: rec.thumb } : {}) };
    if (Buffer.byteLength(JSON.stringify(m)) > 1024 * 1024 - 64) return false;
    return this.sendToProfile(profileDir, m);
  }

  sendToProfile(profileDir, msg) {
    const c = this.byProfile.get(profileDir);
    if (!c) return false;
    this.send(c, msg);
    return true;
  }

  // ---- connections
  accept(sock) {
    const conn = { sock, buf: Buffer.alloc(0), profileDir: null };
    this.conns.add(conn);
    sock.on('data', (d) => this.onData(conn, d));
    sock.on('error', () => {});
    sock.on('close', () => {
      this.conns.delete(conn);
      if (conn.profileDir && this.byProfile.get(conn.profileDir) === conn) this.byProfile.delete(conn.profileDir);
      this.emit('disconnect', { profileDir: conn.profileDir });
    });
  }

  onData(conn, chunk) {
    conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
    while (conn.buf.length >= 4) {
      const len = conn.buf.readUInt32LE(0);
      if (len > MAX_FRAME) { this.log(`absurd frame length ${len}, closing`); conn.sock.destroy(); return; }
      if (conn.buf.length < 4 + len) return;
      const payload = conn.buf.subarray(4, 4 + len);
      conn.buf = conn.buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { this.log(`malformed JSON from extension: ${e.message}`); continue; }
      this.dispatch(conn, msg);
    }
  }

  send(conn, msg) {
    if (conn.sock.destroyed) return;
    const payload = Buffer.from(JSON.stringify(msg), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(payload.length, 0);
    conn.sock.write(Buffer.concat([head, payload]));
  }

  reply(conn, req, msg) {
    if ('requestId' in req) msg.requestId = req.requestId;
    this.send(conn, msg);
  }

  dispatch(conn, m) {
    if (!isObject(m) || typeof m.type !== 'string') { this.log('ignoring message without type'); return; }
    if (m.type === 'bridgeResult' || m.type === 'bridgeEvent') {
      if (conn.profileDir) this.emit('fromExt', { profileDir: conn.profileDir, msg: m });
      return;
    }
    const handlers = {
      hello: this.doHello, identify: this.doIdentify, getProfiles: this.doGetProfiles,
      setProfileStyle: this.doSetStyle, switchProfile: this.doSwitch, setGlobalSettings: this.doSetSettings, setOverlayEnabled: this.doSetOverlayEnabled, setDefaultBrowser: this.doSetDefaultBrowser,
      showSettings: this.doShowSettings, clearArchiveOverrides: this.doClearArchiveOverrides,
      appSetting: this.doAppSetting, getAppState: this.doGetAppState, getCaptureSettings: this.doGetCaptureSettings,
      captureConfig: this.doCaptureConfig, openCaptureEditor: this.doOpenCaptureEditor,
      recordTab: this.doRecordMessage, recordTabState: this.doRecordMessage, recordTabClosed: this.doRecordMessage, recordTabMoved: this.doRecordMessage,
    };
    const h = Object.hasOwn(handlers, m.type) ? handlers[m.type] : null;
    if (!h) { this.log(`unknown message type '${m.type}'`); return this.reply(conn, m, { type: 'error', error: `unknown message type '${m.type}'` }); }
    try { h.call(this, conn, m); } catch (e) {
      this.log(`handler '${m.type}' failed: ${e.stack || e}`);
      this.reply(conn, m, { type: 'error', error: 'internal error' });
    }
  }

  broadcast(msg, except) {
    for (const c of this.conns) if (c !== except) this.send(c, msg);
  }

  /**
   * v3.0: the app reports its host state (pinned, launchAtLogin, accessibility, ...). Remembered, pushed to every identified
   * extension now, and replayed to each extension that identifies later.
   */
  setAppState(state) {
    this.appState = isObject(state) ? { ...state } : null;
    if (!this.appState) return;
    for (const c of this.conns) if (c.profileDir) this.send(c, { type: 'appState', state: this.appStateOut() });
  }

  /** v3.5c: the app state as the extension receives it: the reported state plus the mode and the capture settings (no secret) */
  appStateOut() {
    return this.appState ? { ...this.appState, useChrome: this.useChrome, capture: this.capture.publicDict(), microphones: this.microphones } : null;
  }

  /** capture settings or the mode changed: tell every identified extension (once the app has reported a state) and listeners */
  captureChanged() {
    if (this.appState) for (const c of this.conns) if (c.profileDir) this.send(c, { type: 'appState', state: this.appStateOut() });
    this.emit('captureSettings', this.capture.publicDict());
  }

  // ---- state.json
  readState() {
    const st = readJsonFile(this.stateFile);
    return isObject(st) ? st : {};
  }

  updateState(fn) {
    const st = this.readState();
    fn(st);
    fs.mkdirSync(this.appDir, { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(st) + '\n');
    return st;
  }

  settingsFrom(st) {
    return {
      archiveDefaultMinutes: validMinutes(st.archiveDefaultMinutes) ? Number(st.archiveDefaultMinutes) : DEFAULT_ARCHIVE_MINUTES,
      overlayEnabled: st.overlayEnabled !== false,
      // v2.8: the app's view of "little links on AND we are the default http handler" (the reference host has no OS to ask: just the stored flag)
      defaultBrowser: st.littleLinksEnabled === true,
    };
  }

  /** First launch: take over the Perl helper's state.json (settings and profile styles). */
  importLegacyState() {
    if (!this.legacyStateFile || fs.existsSync(this.stateFile)) return;
    try {
      fs.copyFileSync(this.legacyStateFile, this.stateFile);
      this.log(`imported ${this.legacyStateFile}`);
    } catch { /* nothing to import */ }
  }

  // ---- profiles
  readProfiles() {
    const ls = readJsonFile(this.localState);
    if (!isObject(ls)) { this.log(`cannot read Local State '${this.localState}'`); return []; }
    const prof = isObject(ls.profile) ? ls.profile : {};
    const cache = isObject(prof.info_cache) ? prof.info_cache : {};
    const dataDir = path.dirname(this.localState);
    const styles = isObject(this.readState().profileStyles) ? this.readState().profileStyles : {};
    const by = new Map();
    for (const [dir, e] of Object.entries(cache)) {
      if (/^(Guest|System)/.test(dir) || !isObject(e)) continue;
      by.set(dir, {
        dir,
        name: typeof e.name === 'string' || typeof e.name === 'number' ? String(e.name) : dir,
        email: typeof e.user_name === 'string' ? e.user_name : '',
        color: colorHex(e.profile_highlight_color) ?? colorHex(e.default_avatar_fill_color),
        picture: readPicture(dataDir, dir, e),
        style: cleanStyle(styles[dir]),
        chromeTheme: readChromeTheme(dataDir, dir),
      });
    }
    const out = [];
    const seen = new Set();
    if (Array.isArray(prof.profiles_order)) {
      for (const d of prof.profiles_order) {
        if (typeof d !== 'string' || seen.has(d) || !by.has(d)) continue;
        out.push(by.get(d)); seen.add(d);
      }
    }
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const rest = [...by.keys()].filter((d) => !seen.has(d)).sort((a, b) =>
      (a === 'Default' ? 0 : 1) - (b === 'Default' ? 0 : 1)
      || cmp(by.get(a).name.toLowerCase(), by.get(b).name.toLowerCase())
      || cmp(a, b));
    for (const d of rest) out.push(by.get(d));
    return out;
  }

  /** Profiles, with pictures dropped largest-first when the encoded list would exceed the reply cap. */
  profilesCapped() {
    const list = this.readProfiles();
    let size = Buffer.byteLength(JSON.stringify(list));
    if (size > MAX_REPLY - 4096) {
      const withPic = list.filter((p) => p.picture).sort((a, b) => b.picture.length - a.picture.length);
      for (const p of withPic) {
        size -= p.picture.length;
        p.picture = null;
        if (size <= MAX_REPLY - 4096) break;
      }
    }
    return list;
  }

  // ---- handlers
  doHello(conn, m) {
    this.reply(conn, m, { type: 'hello', hostVersion: HOST_VERSION, profiles: this.profilesCapped(), settings: this.settingsFrom(this.readState()) });
  }

  doGetProfiles(conn, m) {
    this.reply(conn, m, { type: 'profiles', profiles: this.profilesCapped() });
  }

  doIdentify(conn, m) {
    const dir = m.profileDir;
    if (typeof dir !== 'string' || dir === '') {
      return this.reply(conn, m, { type: 'identified', profileDir: dir, error: 'missing profileDir' });
    }
    const existing = this.byProfile.get(dir);
    if (existing && existing !== conn) {
      // Two different connections keep claiming the same profile: refuse the 4th replacement attempt within 60 s.
      const now = Date.now();
      const ts = (this.replacements.get(dir) || []).filter((t) => now - t < 60000);
      ts.push(now);
      this.replacements.set(dir, ts);
      if (ts.length >= 4) {
        this.log(`refusing duplicate claim on '${dir}'`);
        return this.reply(conn, m, { type: 'identified', profileDir: null, error: 'duplicate profile' });
      }
    }
    if (conn.profileDir && conn.profileDir !== dir && this.byProfile.get(conn.profileDir) === conn) this.byProfile.delete(conn.profileDir);
    const older = this.byProfile.get(dir);
    conn.profileDir = dir;
    this.byProfile.set(dir, conn);
    if (older && older !== conn) {
      // A newer connection for the same profile replaces the older one.
      this.log(`replacing older connection for '${dir}'`);
      older.profileDir = null;
      older.sock.end();
    }
    this.reply(conn, m, { type: 'identified', profileDir: dir });

    const p = this.pending.get(dir);
    if (p) {
      this.pending.delete(dir);
      if (Date.now() / 1000 - p.ts < HANDOFF_SECONDS) this.send(conn, { type: 'activate', bounds: p.bounds });
      else this.log(`ignoring stale pending handoff for '${dir}'`);
    }
    if (this.overlay) this.send(conn, { type: 'overlayStatus', connected: true });
    if (this.appState) this.send(conn, { type: 'appState', state: this.appStateOut() });
    this.emit('identify', { profileDir: dir });
  }

  doSwitch(conn, m) {
    const target = m.targetDir;
    if (typeof target !== 'string' || target === '') return this.reply(conn, m, { type: 'switchResult', ok: false, error: 'missing targetDir' });
    const bounds = isObject(m.bounds) ? m.bounds : null;
    const live = this.byProfile.get(target);
    if (live) {
      this.send(live, { type: 'activate', bounds });
      return this.reply(conn, m, { type: 'switchResult', ok: true, method: 'focused' });
    }
    this.pending.set(target, { bounds, ts: Math.floor(Date.now() / 1000) });
    const err = this.launchChrome(target);
    if (err) {
      this.pending.delete(target);
      this.log(`switch to '${target}': ${err}`);
      return this.reply(conn, m, { type: 'switchResult', ok: false, error: err });
    }
    this.reply(conn, m, { type: 'switchResult', ok: true, method: 'launched' });
  }

  /** Open a Chrome window in a profile (hands off to a running Chrome). Returns an error string or null. */
  launchChrome(dir) {
    try { fs.accessSync(this.chromeBin, fs.constants.X_OK); } catch { return `Chrome binary not found or not executable: ${this.chromeBin}`; }
    try {
      const child = spawn(this.chromeBin, [`--profile-directory=${dir}`], { detached: true, stdio: 'ignore' });
      child.on('error', (e) => this.log(`launching Chrome failed: ${e.message}`));
      child.unref();
    } catch (e) { return `launch failed: ${e.message}`; }
    return null;
  }

  doSetSettings(conn, m) {
    const s = isObject(m.settings) ? m.settings : {};
    if ('archiveDefaultMinutes' in s && !validMinutes(s.archiveDefaultMinutes)) {
      return this.reply(conn, m, { type: 'settings', settings: this.settingsFrom(this.readState()), error: 'invalid archiveDefaultMinutes' });
    }
    const st = this.updateState((state) => {
      if ('archiveDefaultMinutes' in s) state.archiveDefaultMinutes = Number(s.archiveDefaultMinutes);
    });
    const settings = this.settingsFrom(st);
    this.broadcast({ type: 'settings', settings }, conn);
    this.reply(conn, m, { type: 'settings', settings });
  }

  doSetOverlayEnabled(conn, m) {
    if (typeof m.enabled !== 'boolean') {
      return this.reply(conn, m, { type: 'overlayEnabled', enabled: this.readState().overlayEnabled !== false, error: 'invalid enabled' });
    }
    this.updateState((st) => { st.overlayEnabled = m.enabled; });
    this.broadcast({ type: 'overlayEnabled', enabled: m.enabled }, conn);
    this.reply(conn, m, { type: 'overlayEnabled', enabled: m.enabled });
    this.emit('overlayEnabled', { enabled: m.enabled });
  }

  // v2.8: Settings > Little windows > "Open links from other apps in little windows". Swift really changes the default browser; here we only store it.
  doSetDefaultBrowser(conn, m) {
    if (typeof m.enabled !== 'boolean') {
      return this.reply(conn, m, { type: 'defaultBrowser', enabled: this.readState().littleLinksEnabled === true, ok: false, error: 'invalid enabled' });
    }
    this.updateState((st) => { st.littleLinksEnabled = m.enabled; });
    this.broadcast({ type: 'defaultBrowser', enabled: m.enabled }, conn);
    this.reply(conn, m, { type: 'defaultBrowser', enabled: m.enabled, ok: true });
    this.emit('defaultBrowser', { enabled: m.enabled });
  }

  // v3.7: the extension asks the app to show ITS settings window, scoped to the sending profile. Only the app really has one;
  // here the reply says ok only when `settingsWindow` is on, so by default the extension falls back to its Chrome page.
  doShowSettings(conn, m) {
    const call = { profileDir: conn.profileDir, section: typeof m.section === 'string' ? m.section : null };
    this.showSettingsCalls.push(call);
    this.emit('showSettings', call);
    this.reply(conn, m, this.settingsWindow ? { type: 'showSettings', ok: true } : { type: 'showSettings', ok: false, error: 'no settings window' });
  }

  // v3.7: "Apply to all profiles": every identified extension (the sender included) drops its own archive time.
  doClearArchiveOverrides(conn, m) {
    let count = 0;
    for (const c of this.conns) if (c.profileDir) { this.send(c, { type: 'clearArchiveOverride' }); count++; }
    this.emit('clearArchiveOverrides', { profileDir: conn.profileDir, count });
    this.reply(conn, m, { type: 'clearArchiveOverrides', ok: true, count });
  }

  // v3.0: Settings window -> app. Unknown names are refused; the app applies the setting and then calls setAppState with the result.
  doAppSetting(conn, m) {
    if (typeof m.name !== 'string' || !APP_SETTINGS.has(m.name)) {
      // fire-and-forget senders (the extension) get no reply; callers that pass a requestId do
      if ('requestId' in m) this.reply(conn, m, { type: 'appSetting', name: m.name, ok: false, error: 'unknown setting' });
      return;
    }
    this.emit('appSetting', { profileDir: conn.profileDir, name: m.name, value: m.value });
    // v3.5c: the capture settings and the mode are owned by the app itself (the Swift OverlayManager does the same)
    if (m.name === 'setCaptureSettings') this.capture.apply(m.value);
    else if (m.name === 'setUseChrome') { this.useChrome = m.value === true; this.captureChanged(); }
    if ('requestId' in m) this.reply(conn, m, { type: 'appSetting', name: m.name, ok: true });
  }

  // v3.6: Record Chrome Tab messages from the extension (recordTab {windowId, tabId, title}, recordTabState {tabId, active},
  // recordTabClosed {tabId}, recordTabMoved {tabId, windowId}); no reply. The Swift app starts / pauses / stops the recording.
  doRecordMessage(conn, m) {
    this.emit('record', { profileDir: conn.profileDir, type: m.type, msg: m });
  }

  /** Menu bar "Record Chrome Tab": asks a profile's extension for its active tab ({type:'recordTabRequest'}). */
  requestRecordTab(profileDir) { return this.sendToProfile(profileDir, { type: 'recordTabRequest' }); }

  /** The app tells the extension which tab it records (null = none any more). */
  setRecordingTab(profileDir, tabId) { return this.sendToProfile(profileDir, { type: 'recordingTab', tabId: tabId ?? null }); }

  // v3.4: the profile's screenshot settings for the app's editor window (kept per connection, in memory only: it holds S3 keys)
  doCaptureConfig(conn, m) {
    if (!isObject(m.config)) return;
    conn.captureConfig = m.config;
    this.capture.adoptIfEmpty(m.config);
    this.emit('captureConfig', { profileDir: conn.profileDir, config: m.config });
  }

  // v3.4: a Chrome capture for the app's editor window, base64 in parts ({id, part, parts, data, meta, config}). The last
  // part carries a requestId; the reply {type:'openCaptureEditor', id, ok} tells the extension not to open its popup.
  doOpenCaptureEditor(conn, m) {
    const fail = (error) => this.reply(conn, m, { type: 'openCaptureEditor', id: m.id, ok: false, error });
    const parts = Number.isInteger(m.parts) ? m.parts : 0, part = Number.isInteger(m.part) ? m.part : -1;
    if (typeof m.id !== 'string' || !m.id || typeof m.data !== 'string' || parts < 1 || parts > 64 || part < 0 || part >= parts) return fail('invalid part');
    conn.captureParts ??= new Map();
    let e = conn.captureParts.get(m.id);
    if (!e) { e = { parts: new Array(parts).fill(null), got: 0 }; conn.captureParts.set(m.id, e); }
    if (e.parts[part] === null) { e.parts[part] = m.data; e.got++; }
    if (part !== parts - 1) return;
    conn.captureParts.delete(m.id);
    if (e.got < parts || !isObject(m.meta)) return fail('missing parts');
    const png = Buffer.from(e.parts.join(''), 'base64');
    if (isObject(m.config)) { conn.captureConfig = m.config; this.capture.adoptIfEmpty(m.config); }
    this.emit('openCaptureEditor', { profileDir: conn.profileDir, id: m.id, meta: m.meta, png, config: this.capture.editorConfig(conn.captureConfig && conn.captureConfig.sidebarColor) });
    this.reply(conn, m, { type: 'openCaptureEditor', id: m.id, ok: true });
  }

  doGetAppState(conn, m) {
    this.reply(conn, m, { type: 'appState', state: this.appStateOut() });
  }

  // v3.5c: the capture settings; `full: true` adds the S3 secret (the connection test and uploads from the extension)
  doGetCaptureSettings(conn, m) {
    this.reply(conn, m, { type: 'captureSettings', settings: this.capture.publicDict(m.full === true) });
  }

  doSetStyle(conn, m) {
    const { dir, style } = m;
    let err = null;
    if (typeof dir !== 'string' || dir === '') err = 'missing dir';
    else if (style !== undefined && style !== null) {
      if (!isObject(style)) err = 'invalid style';
      else if (typeof style.icon !== 'string' || !ICONS.has(style.icon)) err = 'invalid icon';
      else if (typeof style.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(style.color)) err = 'invalid color';
    }
    if (!err && !this.readProfiles().some((p) => p.dir === dir)) err = 'unknown profile';
    if (err) return this.reply(conn, m, { type: 'profiles', profiles: this.profilesCapped(), error: err });

    this.updateState((st) => {
      const ps = isObject(st.profileStyles) ? st.profileStyles : {};
      if (style) ps[dir] = { icon: style.icon, color: style.color.toLowerCase() };
      else delete ps[dir];
      st.profileStyles = ps;
    });
    const profiles = this.profilesCapped();
    this.broadcast({ type: 'profiles', profiles }, conn);
    this.reply(conn, m, { type: 'profiles', profiles });
  }
}

/** Write the Chrome native messaging host manifest (what the Mac app does on every launch). */
function writeHostManifest(nmhDir, executable) {
  fs.mkdirSync(nmhDir, { recursive: true });
  const file = path.join(nmhDir, 'com.stile.helper.json');
  fs.writeFileSync(file, JSON.stringify({
    name: 'com.stile.helper', description: 'Stile', path: executable, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN],
  }, null, 2));
  return file;
}

module.exports = { APP_SETTINGS, HostServer, writeHostManifest, colorHex, readChromeTheme, HOST_VERSION, EXTENSION_ORIGIN };

// `node host-server.js` runs a standalone host using the SIDEBAR_* environment variables.
if (require.main === module) {
  const host = new HostServer({ log: (m) => console.error(m) });
  host.listen().then((p) => console.error(`Stile reference host on ${p}`));
}
