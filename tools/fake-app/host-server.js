'use strict';
// Reference implementation of the Sidebar app's `HostServer` (SPEC-v2.1-overlay.md, "Merge the helper
// into the Mac app"). It speaks exactly the protocol the old Perl helper spoke, but over ONE Unix
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
const { spawn } = require('child_process');

const HOST_VERSION = '2.1.0';
const EXTENSION_ORIGIN = 'chrome-extension://ffblekellgdmlecjablfojaaadpkmdgg/';
const MAX_PICTURE = 150 * 1024;
const MAX_PREFS = 5 * 1024 * 1024;
const MAX_REPLY = 900 * 1000; // hello/profiles replies stay under 900 KB (Chrome's limit is 1 MB)
const MAX_FRAME = 64 * 1024 * 1024;
const HANDOFF_SECONDS = 60;
const DEFAULT_ARCHIVE_MINUTES = 720;
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
    this.appDir = o.appDir || process.env.SIDEBAR_APP_DIR || path.join(home, 'Library/Application Support/Sidebar');
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
    this.server = null;
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
      setProfileStyle: this.doSetStyle, switchProfile: this.doSwitch, setGlobalSettings: this.doSetSettings, setOverlayEnabled: this.doSetOverlayEnabled,
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
  const file = path.join(nmhDir, 'com.sidebar.helper.json');
  fs.writeFileSync(file, JSON.stringify({
    name: 'com.sidebar.helper', description: 'Sidebar', path: executable, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN],
  }, null, 2));
  return file;
}

module.exports = { HostServer, writeHostManifest, colorHex, readChromeTheme, HOST_VERSION, EXTENSION_ORIGIN };

// `node host-server.js` runs a standalone host using the SIDEBAR_* environment variables.
if (require.main === module) {
  const host = new HostServer({ log: (m) => console.error(m) });
  host.listen().then((p) => console.error(`Sidebar reference host on ${p}`));
}
