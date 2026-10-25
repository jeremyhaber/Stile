// Protocol tests for the reference host (host-server.js + connector.js). Port of the Perl helper's
// test-helper.pl; the Swift HostServer is checked against the same scenarios.
//   node tools/fake-app/test-host.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { HostServer, writeHostManifest } = require('./host-server.js');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONNECTOR = path.join(HERE, 'connector.js');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  (' + extra + ')'}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (cond, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(25); } return !!(await cond()); };
const j = (v) => JSON.stringify(v);
const slurp = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f) => { try { return JSON.parse(slurp(f)); } catch { return {}; } };

// ------------------------------------------------------------ environment
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbhost-'));
const appDir = path.join(tmp, 'app');
const localState = path.join(tmp, 'Local State');
const chromeArgs = path.join(tmp, 'chrome-args.txt');
const fakeChrome = path.join(tmp, 'fake-chrome.sh');
fs.writeFileSync(fakeChrome, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${chromeArgs}'\n`, { mode: 0o755 });

function writeLocalState(order) {
  fs.writeFileSync(localState, j({ profile: {
    info_cache: {
      'Default': { name: 'Personal', user_name: 'me@example.com', profile_highlight_color: -16776961 }, // 0xFF0000FF
      'Profile 1': { name: 'Work', user_name: 'me@work.example', profile_highlight_color: -2383999, default_avatar_fill_color: -1 }, // 0xFFDB9F81
      'Profile 2': { name: 'Hobby', user_name: '', default_avatar_fill_color: -16711936 }, // 0xFF00FF00
      'Guest Profile': { name: 'Guest' },
      'System Profile': { name: 'System' },
    },
    ...(order ? { profiles_order: order } : {}),
  } }));
}
writeLocalState(['Profile 1', 'Default', 'Profile 2']);

const host = new HostServer({ appDir, localState, chromeBin: fakeChrome });
const fromExt = [];
host.on('fromExt', (x) => fromExt.push(x));
await host.listen();
const ENV = { ...process.env, SIDEBAR_APP_DIR: appDir };

// ------------------------------------------------------------ a "Chrome profile": one connector process
class Client {
  constructor(env = {}) {
    this.proc = spawn('node', [CONNECTOR, 'chrome-extension://ffblekellgdmlecjablfojaaadpkmdgg/'], { env: { ...ENV, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = Buffer.alloc(0); this.msgs = []; this.exited = false; this.stdoutEnded = false; this.stray = false;
    this.proc.stdout.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 4) {
        const len = this.buf.readUInt32LE(0);
        if (this.buf.length < 4 + len) break;
        try { this.msgs.push(JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8'))); } catch { this.stray = true; }
        this.buf = this.buf.subarray(4 + len);
      }
    });
    this.proc.stdout.on('end', () => { this.stdoutEnded = true; });
    this.proc.stdin.on('error', () => {});
    this.proc.on('exit', (code) => { this.exited = true; this.code = code; });
  }
  sendRaw(bytes) { this.proc.stdin.write(bytes); }
  send(m) { const p = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(p.length); this.sendRaw(Buffer.concat([h, p])); }
  async recv(type, ms = 5000) {
    let found;
    await wait(() => { const i = this.msgs.findIndex((m) => !type || m.type === type); if (i >= 0) { found = this.msgs.splice(i, 1)[0]; return true; } return false; }, ms);
    return found;
  }
  async request(m, type) {
    const rt = { getProfiles: 'profiles', identify: 'identified', switchProfile: 'switchResult', setGlobalSettings: 'settings', setProfileStyle: 'profiles', setOverlayEnabled: 'overlayEnabled', setDefaultBrowser: 'defaultBrowser', getAppState: 'appState', appSetting: 'appSetting', getCaptureSettings: 'captureSettings' };
    this.send(m);
    return this.recv(type ?? rt[m.type] ?? m.type);
  }
  async quiet(ms) { await sleep(ms); return this.msgs.length === 0; }
  closeStdin() { this.proc.stdin.end(); }
  kill() { this.proc.kill('SIGTERM'); }
}
const all = [];
const spawnClient = (env) => { const c = new Client(env); all.push(c); return c; };

// ------------------------------------------------------------ 1. hello / profiles
const A = spawnClient();
let r = await A.request({ type: 'hello', extVersion: '0.1', requestId: 7 });
check('hello: reply received', r?.type === 'hello', j(r));
check('hello: requestId echoed', r?.requestId === 7);
check('hello: hostVersion present', typeof r?.hostVersion === 'string' && r.hostVersion.length > 0);
let p = r?.profiles ?? [];
check('hello: 3 profiles (Guest/System skipped)', p.length === 3, String(p.length));
check('hello: profiles_order respected', p.map((x) => x.dir).join() === 'Profile 1,Default,Profile 2', p.map((x) => x.dir).join());
const by = Object.fromEntries(p.map((x) => [x.dir, x]));
check('colour: negative ARGB profile_highlight_color -> #0000ff', by.Default?.color === '#0000ff', by.Default?.color);
check('colour: highlight preferred over avatar fill', by['Profile 1']?.color === '#db9f81', by['Profile 1']?.color);
check('colour: falls back to default_avatar_fill_color', by['Profile 2']?.color === '#00ff00', by['Profile 2']?.color);
check('profile name and email parsed', by.Default?.email === 'me@example.com' && by.Default?.name === 'Personal');
check('empty email is ""', by['Profile 2']?.email === '');
check('hello: default archiveDefaultMinutes 720', r?.settings?.archiveDefaultMinutes === 720);
check('hello: overlayEnabled defaults to true', r?.settings?.overlayEnabled === true, j(r?.settings));
check('hello: defaultBrowser defaults to false', r?.settings?.defaultBrowser === false, j(r?.settings));

// chromeTheme from Preferences
const ct = by.Default?.chromeTheme;
check('chromeTheme: missing Preferences -> nulls/system', ct && ct.userColor === null && ct.colorScheme === 'system' && ct.variant === null && ct.themeId === null, j(ct));
for (const d of ['Default', 'Profile 1', 'Profile 2']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
fs.writeFileSync(path.join(tmp, 'Default/Preferences'), j({ browser: { theme: { user_color: -16776961, color_scheme2: 2, color_variant: 3 } }, extensions: { theme: { id: 'abcdefabcdefabcdefabcdefabcdefab' } } }));
fs.writeFileSync(path.join(tmp, 'Profile 1/Preferences'), j({ browser: { theme: { user_color: -2383999, color_scheme: 1 } } }));
fs.writeFileSync(path.join(tmp, 'Profile 2/Preferences'), '{not json');
r = await A.request({ type: 'getProfiles', requestId: 'th1' });
const tb = Object.fromEntries((r?.profiles ?? []).map((x) => [x.dir, x.chromeTheme]));
check('chromeTheme: colour, color_scheme2, variant, theme id', tb.Default?.userColor === '#0000ff' && tb.Default.colorScheme === 'dark' && tb.Default.variant === 3 && tb.Default.themeId === 'abcdefabcdefabcdefabcdefabcdefab', j(tb.Default));
check('chromeTheme: negative ARGB colour, legacy color_scheme', tb['Profile 1']?.userColor === '#db9f81' && tb['Profile 1'].colorScheme === 'light' && tb['Profile 1'].variant === null, j(tb['Profile 1']));
check('chromeTheme: unparsable Preferences -> nulls', tb['Profile 2']?.userColor === null && tb['Profile 2'].colorScheme === 'system', j(tb['Profile 2']));
fs.writeFileSync(path.join(tmp, 'Profile 2/Preferences'), j({ browser: { theme: { color_scheme2: 0 } } }));
r = await A.request({ type: 'getProfiles' });
check('chromeTheme: color_scheme2 0 -> system, no colour', r?.profiles?.find((x) => x.dir === 'Profile 2')?.chromeTheme?.colorScheme === 'system');
for (const d of ['Default', 'Profile 1', 'Profile 2']) fs.rmSync(path.join(tmp, d, 'Preferences'), { force: true });

// getProfiles with no profiles_order -> Default first, then by name
writeLocalState(null);
r = await A.request({ type: 'getProfiles', requestId: 'g1' });
check('getProfiles: requestId echoed', r?.requestId === 'g1');
check('getProfiles: no order -> Default first then by name', (r?.profiles ?? []).map((x) => x.dir).join() === 'Default,Profile 2,Profile 1', (r?.profiles ?? []).map((x) => x.dir).join());
writeLocalState(['Profile 1', 'Default', 'Profile 2']);

// ------------------------------------------------------------ 2. identify
const B = spawnClient();
r = await A.request({ type: 'identify', profileDir: 'Default', requestId: 1 });
check('identify A as Default', r?.profileDir === 'Default' && r.requestId === 1, j(r));
r = await B.request({ type: 'identify', profileDir: 'Profile 1' });
check('identify B as Profile 1', r?.profileDir === 'Profile 1', j(r));
check('host tracks both connections', host.isConnected('Default') && host.isConnected('Profile 1'));
let os_ = await A.recv('overlayStatus');
check('identify: overlayStatus connected:true follows', os_?.connected === true, j(os_));
await B.recv('overlayStatus');
r = await A.request({ type: 'identify', requestId: 'x' });
check('identify without profileDir -> error', r?.error && r.requestId === 'x', j(r));

// ------------------------------------------------------------ 3. switch to identified profile
const bounds = { left: 10, top: 20, width: 1200, height: 800, state: 'normal' };
r = await A.request({ type: 'switchProfile', targetDir: 'Profile 1', bounds, requestId: 2 });
check('switch -> identified: focused', r?.ok && r.method === 'focused' && r.requestId === 2, j(r));
let act = await B.recv('activate');
check('switch -> identified: target gets activate with same bounds', act && j(act.bounds) === j(bounds), j(act));
check('switch -> identified: Chrome not launched', !fs.existsSync(chromeArgs));
r = await A.request({ type: 'switchProfile', bounds });
check('switch without targetDir -> ok:false', r?.ok === false && r.error);

// ------------------------------------------------------------ 4. switch to unidentified profile
const b2 = { left: 0, top: 0, width: 1440, height: 900, state: 'maximized' };
r = await A.request({ type: 'switchProfile', targetDir: 'Profile 2', bounds: b2 });
check('switch -> unidentified: launched', r?.ok && r.method === 'launched', j(r));
check('fake chrome ran', await wait(() => slurp(chromeArgs).length > 0));
check('fake chrome got --profile-directory=Profile 2', /^--profile-directory=Profile 2$/m.test(slurp(chromeArgs)), slurp(chromeArgs));
const pend = host.pending.get('Profile 2');
check('pending handoff remembered with bounds and ts', pend && j(pend.bounds) === j(b2) && Math.abs(Date.now() / 1000 - pend.ts) < 10, j(pend));

// ------------------------------------------------------------ 5. identify consumes pending
const C = spawnClient();
r = await C.request({ type: 'identify', profileDir: 'Profile 2' });
check('identify C as Profile 2', r?.profileDir === 'Profile 2');
act = await C.recv('activate');
check('identify with pending: activate with stored bounds', act && j(act.bounds) === j(b2), j(act));
check('pending handoff consumed', !host.pending.has('Profile 2'));
host.pending.set('Stale X', { bounds, ts: Date.now() / 1000 - 120 });
const S = spawnClient();
await S.request({ type: 'identify', profileDir: 'Stale X' });
await S.recv('overlayStatus');
check('stale (>60s) pending handoff does not activate', await S.quiet(400));
check('stale pending handoff removed', !host.pending.has('Stale X'));
S.closeStdin();

// ------------------------------------------------------------ 6. setGlobalSettings
r = await A.request({ type: 'setGlobalSettings', settings: { archiveDefaultMinutes: 1440 }, requestId: 3 });
check('setGlobalSettings: reply', r?.type === 'settings' && r.settings.archiveDefaultMinutes === 1440 && r.requestId === 3, j(r));
check('setGlobalSettings: persisted to state.json', readJson(path.join(appDir, 'state.json')).archiveDefaultMinutes === 1440, slurp(path.join(appDir, 'state.json')));
for (const [n, c] of [['B', B], ['C', C]]) {
  const m = await c.recv('settings');
  check(`setGlobalSettings: broadcast to connection ${n}`, m?.settings?.archiveDefaultMinutes === 1440, j(m));
}
check('setGlobalSettings: sender gets no unsolicited settings', await A.quiet(300));
const D0 = spawnClient();
r = await D0.request({ type: 'hello' });
check('hello after set: reads persisted settings', r?.settings?.archiveDefaultMinutes === 1440);
r = await A.request({ type: 'setGlobalSettings', settings: { archiveDefaultMinutes: 0 } });
check('0 (never) is accepted', r?.settings?.archiveDefaultMinutes === 0);
r = await A.request({ type: 'setGlobalSettings', settings: { archiveDefaultMinutes: 'abc' } });
check('invalid archiveDefaultMinutes rejected', !!r?.error, j(r));
check('invalid value leaves state unchanged', readJson(path.join(appDir, 'state.json')).archiveDefaultMinutes === 0);
await A.request({ type: 'setGlobalSettings', settings: { archiveDefaultMinutes: 720 } });
for (const c of [B, C, D0]) c.msgs.length = 0;
A.msgs.length = 0;
// showSettings / clearArchiveOverrides (v3.7)
{
  const calls = [];
  host.on('showSettings', (c) => calls.push(c));
  r = await A.request({ type: 'showSettings', section: 'tabs', requestId: 21 });
  check('showSettings: no settings window -> ok:false + error', r?.type === 'showSettings' && r.ok === false && !!r.error && r.requestId === 21, j(r));
  check('showSettings: the request is recorded with profile and section', host.showSettingsCalls.length === 1 && host.showSettingsCalls[0].profileDir === 'Default' && host.showSettingsCalls[0].section === 'tabs' && calls.length === 1, j(host.showSettingsCalls));
  host.settingsWindow = true;
  r = await B.request({ type: 'showSettings' });
  check('showSettings: settingsWindow on -> ok:true', r?.type === 'showSettings' && r.ok === true, j(r));
  check('showSettings: section defaults to null, profile is the sender\'s', host.showSettingsCalls[1]?.profileDir === 'Profile 1' && host.showSettingsCalls[1].section === null, j(host.showSettingsCalls));
  host.settingsWindow = false;
  const nIdent = host.byProfile.size;
  r = await A.request({ type: 'clearArchiveOverrides', requestId: 22 });
  check('clearArchiveOverrides: reply ok with the count of identified connections', r?.type === 'clearArchiveOverrides' && r.ok === true && r.count === nIdent && nIdent >= 3 && r.requestId === 22, j(r));
  for (const [n, c] of [['A (the sender)', A], ['B', B], ['C', C]]) check(`clearArchiveOverrides: broadcast reaches ${n}`, !!(await c.recv('clearArchiveOverride', 2000)));
  check('clearArchiveOverrides: an unidentified connection is not told', await D0.quiet(300));
  for (const c of [A, B, C, D0]) c.msgs.length = 0;
}
// setOverlayEnabled (v2.7)
r = await A.request({ type: 'setOverlayEnabled', enabled: false, requestId: 11 });
check('setOverlayEnabled: reply', r?.type === 'overlayEnabled' && r.enabled === false && r.requestId === 11, j(r));
check('setOverlayEnabled: persisted to state.json', readJson(path.join(appDir, 'state.json')).overlayEnabled === false, slurp(path.join(appDir, 'state.json')));
for (const [n, c] of [['B', B], ['C', C], ['D0', D0]]) {
  const m = await c.recv('overlayEnabled');
  check(`setOverlayEnabled: broadcast to connection ${n}`, m?.enabled === false && !('requestId' in m), j(m));
}
check('setOverlayEnabled: sender gets no unsolicited broadcast', await A.quiet(300));
check('setOverlayEnabled: other state keys preserved', readJson(path.join(appDir, 'state.json')).archiveDefaultMinutes === 720);
const D1 = spawnClient();
r = await D1.request({ type: 'hello' });
check('hello after set: includes overlayEnabled false', r?.settings?.overlayEnabled === false, j(r?.settings));
r = await A.request({ type: 'setOverlayEnabled', enabled: 'yes' });
check('setOverlayEnabled: non-boolean rejected, unchanged', !!r?.error && r.enabled === false && readJson(path.join(appDir, 'state.json')).overlayEnabled === false, j(r));
r = await A.request({ type: 'setOverlayEnabled', enabled: true });
check('setOverlayEnabled: re-enable', r?.enabled === true && readJson(path.join(appDir, 'state.json')).overlayEnabled === true);
// setDefaultBrowser (v2.8)
r = await A.request({ type: 'setDefaultBrowser', enabled: true, requestId: 12 });
check('setDefaultBrowser: reply {type, enabled, ok, requestId}', r?.type === 'defaultBrowser' && r.enabled === true && r.ok === true && r.requestId === 12, j(r));
check('setDefaultBrowser: persisted (littleLinksEnabled)', readJson(path.join(appDir, 'state.json')).littleLinksEnabled === true);
for (const [n, c] of [['B', B], ['C', C], ['D0', D0]]) {
  const m = await c.recv('defaultBrowser');
  check(`setDefaultBrowser: broadcast to connection ${n}`, m?.enabled === true && !('requestId' in m), j(m));
}
check('setDefaultBrowser: sender gets no unsolicited broadcast', await A.quiet(300));
const D2 = spawnClient();
r = await D2.request({ type: 'hello' });
check('hello after set: settings.defaultBrowser true', r?.settings?.defaultBrowser === true, j(r?.settings));
check('setDefaultBrowser: other state keys preserved', readJson(path.join(appDir, 'state.json')).overlayEnabled === true);
r = await A.request({ type: 'setDefaultBrowser', enabled: 'yes' });
check('setDefaultBrowser: non-boolean rejected, unchanged', r?.ok === false && !!r.error && r.enabled === true && readJson(path.join(appDir, 'state.json')).littleLinksEnabled === true, j(r));
r = await A.request({ type: 'setDefaultBrowser', enabled: false });
check('setDefaultBrowser: disable', r?.enabled === false && r.ok === true && readJson(path.join(appDir, 'state.json')).littleLinksEnabled === false);
D2.closeStdin();
D1.closeStdin();
D0.closeStdin();
B.msgs.length = 0; C.msgs.length = 0; A.msgs.length = 0;

// ------------------------------------------------------------ 7. robustness: malformed, split, coalesced, unicode
{
  const bad = Buffer.concat([Buffer.from([8, 0, 0, 0]), Buffer.from('not json')]);
  A.sendRaw(bad);
  r = await A.request({ type: 'getProfiles', requestId: 'after-bad' });
  check('malformed JSON frame: host survives and continues', r?.requestId === 'after-bad');
  A.send({ type: 'bogus', requestId: 'u1' });
  r = await A.recv('error');
  check('unknown type: error reply with requestId', r?.requestId === 'u1' && /bogus/.test(r.error), j(r));
  A.send({ requestId: 'notype' });
  r = await A.request({ type: 'getProfiles', requestId: 'after-notype' });
  check('message without type is ignored', r?.requestId === 'after-notype');

  const pl = Buffer.from(j({ type: 'getProfiles', requestId: 's1' }));
  const head = Buffer.alloc(4); head.writeUInt32LE(pl.length);
  const frame = Buffer.concat([head, pl]);
  A.sendRaw(frame.subarray(0, 2)); await sleep(100);
  A.sendRaw(frame.subarray(2, 7)); await sleep(100);
  A.sendRaw(frame.subarray(7));
  r = await A.recv('profiles');
  check('frame split across writes (header split too) is reassembled', r?.requestId === 's1');

  const enc = (id) => { const b = Buffer.from(j({ type: 'getProfiles', requestId: id })); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
  A.sendRaw(Buffer.concat([enc('c1'), enc('c2')]));
  const m1 = await A.recv('profiles'), m2 = await A.recv('profiles');
  check('two frames in one write both handled in order', m1?.requestId === 'c1' && m2?.requestId === 'c2');

  const ls = readJson(localState);
  ls.profile.info_cache.Default.name = 'Café \u{1f600}';
  fs.writeFileSync(localState, j(ls));
  r = await A.request({ type: 'getProfiles' });
  check('UTF-8 profile names round-trip', r?.profiles?.find((x) => x.dir === 'Default')?.name === 'Café \u{1f600}');
  writeLocalState(['Profile 1', 'Default', 'Profile 2']);
}

// ------------------------------------------------------------ 8. a newer connection replaces the older one
const B2 = spawnClient();
r = await B2.request({ type: 'identify', profileDir: 'Profile 1' });
check('new connection identifies as Profile 1', r?.profileDir === 'Profile 1');
check('older connection for the same profile is closed (its connector exits)', await wait(() => B.exited, 5000));
check('profile still connected (owned by the new connection)', host.isConnected('Profile 1'));
r = await A.request({ type: 'switchProfile', targetDir: 'Profile 1', bounds: null });
check('switch reaches the new connection', r?.ok && r.method === 'focused');
act = await B2.recv('activate');
check('null bounds passed through as null', act && act.bounds === null, j(act));

// ------------------------------------------------------------ 9. EOF / closing
A.closeStdin();
check('stdin EOF: connector exits', await wait(() => A.exited, 3000));
check('stdin EOF: connection removed from host', await wait(() => !host.isConnected('Default')));
C.kill();
check('SIGTERM: connection removed from host', await wait(() => !host.isConnected('Profile 2')));
{
  // connector wrote only framed protocol bytes to stdout
  check('connector stdout carried only framed messages', !A.stray && !B2.stray && A.buf.length === 0);
}

// launching with a missing binary reports an error
{
  const bad = new HostServer({ appDir: path.join(tmp, 'app-nochrome'), localState, chromeBin: path.join(tmp, 'nope') });
  await bad.listen();
  const E = spawnClient({ SIDEBAR_APP_DIR: bad.appDir });
  r = await E.request({ type: 'switchProfile', targetDir: 'Default', bounds: null });
  check('missing chrome binary: ok=false with error', r?.ok === false && r.error, j(r));
  check('missing chrome binary: pending handoff cleaned up', !bad.pending.has('Default'));
  E.closeStdin();
  await bad.close();
}

// ------------------------------------------------------------ 10. pictures and styles
{
  const A2 = spawnClient();
  await A2.request({ type: 'identify', profileDir: 'Default' });
  await A2.recv('overlayStatus');
  const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(100, 'x')]);
  fs.writeFileSync(path.join(tmp, 'Default/Google Profile Picture.png'), png);
  fs.writeFileSync(path.join(tmp, 'Profile 1/Google Profile Picture.png'), Buffer.alloc(151 * 1024, 'y'));
  r = await A2.request({ type: 'getProfiles' });
  const q = Object.fromEntries((r?.profiles ?? []).map((x) => [x.dir, x]));
  const want = 'data:image/png;base64,' + png.toString('base64');
  check('picture: data URL for profile with picture file', q.Default?.picture === want, String(q.Default?.picture).slice(0, 40));
  check('picture: null for profile without file', 'picture' in q['Profile 2'] && q['Profile 2'].picture === null);
  check('picture: oversized (>150 KB) file skipped', q['Profile 1']?.picture === null);
  check('style: null by default', 'style' in q.Default && q.Default.style === null);

  const ls = readJson(localState);
  ls.profile.info_cache['Profile 2'].gaia_picture_file_name = 'custom.png';
  fs.writeFileSync(localState, j(ls));
  fs.writeFileSync(path.join(tmp, 'Profile 2/custom.png'), png);
  r = await A2.request({ type: 'getProfiles' });
  check('picture: gaia_picture_file_name honoured', r?.profiles?.find((x) => x.dir === 'Profile 2')?.picture === want);
  ls.profile.info_cache['Profile 2'].gaia_picture_file_name = '../Default/Google Profile Picture.png';
  fs.writeFileSync(localState, j(ls));
  r = await A2.request({ type: 'getProfiles' });
  check('picture: path traversal in gaia_picture_file_name ignored', r?.profiles?.find((x) => x.dir === 'Profile 2')?.picture === null);
  writeLocalState(['Profile 1', 'Default', 'Profile 2']);

  const B3 = spawnClient();
  await B3.request({ type: 'identify', profileDir: 'Profile 1' });
  await B3.recv('overlayStatus');
  const stateFile = path.join(appDir, 'state.json');
  r = await A2.request({ type: 'setProfileStyle', dir: 'Profile 2', style: { icon: 'rocket', color: '#FF5f57' }, requestId: 'st1' });
  const p2 = r?.profiles?.find((x) => x.dir === 'Profile 2');
  check('setProfileStyle: reply has fresh profiles with style', r?.requestId === 'st1' && !r.error && p2?.style?.icon === 'rocket' && /^#ff5f57$/i.test(p2.style.color), j(p2));
  const stj = readJson(stateFile);
  check('setProfileStyle: persisted under profileStyles', stj.profileStyles?.['Profile 2']?.icon === 'rocket', slurp(stateFile));
  check('setProfileStyle: colour stored lower-case', stj.profileStyles['Profile 2'].color === '#ff5f57');
  check('setProfileStyle: other state keys preserved', stj.archiveDefaultMinutes === 720);
  let bm = await B3.recv('profiles');
  check('setProfileStyle: other connection gets {type:profiles}', bm?.profiles?.find((x) => x.dir === 'Profile 2')?.style?.icon === 'rocket', j(bm)?.slice(0, 200));
  check('setProfileStyle: sender gets no unsolicited profiles', await A2.quiet(300));

  const before = slurp(stateFile);
  for (const [name, style] of [['bad icon', { icon: 'skull', color: '#ff5f57' }], ['bad colour', { icon: 'star', color: 'red' }], ['short hex', { icon: 'star', color: '#fff' }], ['no colour', { icon: 'star' }], ['non-object', 'star']]) {
    r = await A2.request({ type: 'setProfileStyle', dir: 'Default', style });
    check(`setProfileStyle: rejects ${name}`, r?.type === 'profiles' && !!r.error, j(r?.error));
  }
  r = await A2.request({ type: 'setProfileStyle', dir: 'Nope', style: { icon: 'star', color: '#000000' } });
  check('setProfileStyle: rejects unknown profile', !!r?.error);
  r = await A2.request({ type: 'setProfileStyle', style: { icon: 'star', color: '#000000' } });
  check('setProfileStyle: rejects missing dir', !!r?.error);
  check('setProfileStyle: rejected requests do not change state', slurp(stateFile) === before);
  check('setProfileStyle: rejected requests are not broadcast', await B3.quiet(300));

  r = await A2.request({ type: 'setProfileStyle', dir: 'Profile 2', style: null });
  check('setProfileStyle null: clears style', !r?.error && r.profiles.find((x) => x.dir === 'Profile 2').style === null);
  check('setProfileStyle null: removed from state.json', !('Profile 2' in (readJson(stateFile).profileStyles ?? {})));
  check('setProfileStyle null: broadcast', !!(await B3.recv('profiles')));

  // 900 KB cap
  const big = path.join(tmp, 'big');
  const ic = {};
  for (let i = 1; i <= 6; i++) {
    fs.mkdirSync(path.join(big, `P${i}`), { recursive: true });
    fs.writeFileSync(path.join(big, `P${i}/Google Profile Picture.png`), Buffer.alloc((120 + i * 3) * 1024, 'z'));
    ic[`P${i}`] = { name: `P${i}` };
  }
  fs.writeFileSync(path.join(big, 'Local State'), j({ profile: { info_cache: ic } }));
  const bigHost = new HostServer({ appDir: path.join(tmp, 'app-big'), localState: path.join(big, 'Local State'), chromeBin: fakeChrome });
  await bigHost.listen();
  const G = spawnClient({ SIDEBAR_APP_DIR: bigHost.appDir });
  const h = await G.request({ type: 'hello' });
  const pics = (h?.profiles ?? []).filter((x) => x.picture);
  const size = Buffer.byteLength(j(h));
  check('cap: all 6 profiles still listed', h?.profiles?.length === 6);
  check(`cap: hello reply under 900 KB (${size} bytes)`, size < 900 * 1000);
  check('cap: some pictures dropped, not all', pics.length > 0 && pics.length < 6, String(pics.length));
  const kept = new Set(pics.map((x) => x.dir));
  check('cap: largest pictures dropped first', !kept.has('P6') && kept.has('P1'), [...kept].join());
  G.closeStdin(); A2.closeStdin(); B3.closeStdin();
  await bigHost.close();
}

// ------------------------------------------------------------ 11. bridge relay (bridge envelopes go straight over the profile's connection)
{
  fromExt.length = 0;
  const H = spawnClient();
  H.send({ type: 'bridgeEvent', name: 'early', args: [] });
  await sleep(150);
  check('relay: bridge messages from an unidentified connection are dropped', fromExt.length === 0);
  r = await H.request({ type: 'identify', profileDir: 'Default' });
  check('relay: identify ok', r?.profileDir === 'Default');
  os_ = await H.recv('overlayStatus');
  check('relay: extension told overlayStatus connected:true right after identify', os_?.connected === true, j(os_));

  // app -> extension
  const bm = { type: 'bridge', id: 'b1', call: 'tabs.query', args: [{ active: true }], note: 'café \u{1f600}' };
  check('relay: sendBridge returns true for a connected profile', host.sendBridge('Default', bm) === true);
  const got = await H.recv('bridge');
  check('relay: bridge msg delivered to the extension unchanged', got && j(got) === j(bm), j(got));
  check('relay: sendBridge to an unknown profile returns false', host.sendBridge('Nope', bm) === false);

  // extension -> app
  const res = { type: 'bridgeResult', id: 'b1', ok: true, result: [{ id: 5, title: 'té' }] };
  H.send(res);
  await wait(() => fromExt.length >= 1);
  check('relay: bridgeResult -> fromExt{profileDir,msg}', fromExt[0]?.profileDir === 'Default' && j(fromExt[0].msg) === j(res), j(fromExt[0]));
  const ev = { type: 'bridgeEvent', name: 'tabs.onCreated', args: [{ id: 9 }] };
  H.send(ev);
  await wait(() => fromExt.length >= 2);
  check('relay: bridgeEvent -> fromExt{profileDir,msg}', fromExt[1]?.profileDir === 'Default' && j(fromExt[1].msg) === j(ev));

  // unrelated messages are not forwarded
  fromExt.length = 0;
  H.send({ type: 'getProfiles', requestId: 'u1' }); H.send({ type: 'bogus' }); H.send({ type: 'hello' });
  H.send({ type: 'bridge', id: 'nope', call: 'x', args: [] }); H.send({ type: 'overlayStatus', connected: true });
  await H.recv('profiles'); await H.recv('hello');
  await sleep(300);
  check('relay: unrelated extension messages are NOT forwarded', fromExt.length === 0, j(fromExt));
  H.msgs.length = 0;

  // ~1 MB both ways
  const blob = 'q'.repeat(1000 * 1000);
  host.sendBridge('Default', { type: 'bridge', id: 'big', call: 'x', args: [blob] });
  const bg = await H.recv('bridge', 10000);
  check('relay: 1 MB bridge message delivered to the extension', bg?.args?.[0]?.length === blob.length);
  H.send({ type: 'bridgeResult', id: 'bigr', ok: true, result: blob });
  await wait(() => fromExt.length >= 1, 10000);
  check('relay: 1 MB bridgeResult delivered to the app', fromExt[0]?.msg?.result?.length === blob.length && fromExt[0].msg.id === 'bigr');
  fromExt.length = 0;

  // many large events arrive in order while the app is busy
  const chunk = 'e'.repeat(100 * 1024);
  for (let i = 1; i <= 20; i++) H.send({ type: 'bridgeEvent', name: 'e', args: [i, chunk] });
  r = await H.request({ type: 'getProfiles', requestId: 'alive2' });
  check('relay: host responsive between large events', r?.requestId === 'alive2');
  await wait(() => fromExt.length >= 20, 10000);
  check('relay: events delivered in order', fromExt.map((x) => x.msg.args[0]).join() === Array.from({ length: 20 }, (_, i) => i + 1).join());
  fromExt.length = 0;

  // identify again as another profile -> fromExt uses the new profileDir
  r = await H.request({ type: 'identify', profileDir: 'Profile 1' });
  check('relay: re-identify as another profile is accepted', r?.profileDir === 'Profile 1' && !host.isConnected('Default') && host.isConnected('Profile 1'));
  await H.recv('overlayStatus');
  H.send(ev);
  await wait(() => fromExt.length >= 1);
  check('relay: fromExt uses the new profileDir', fromExt[0]?.profileDir === 'Profile 1', j(fromExt[0]));

  // two profiles at once: bridge goes to the right connection
  const H2 = spawnClient();
  await H2.request({ type: 'identify', profileDir: 'Default' });
  await H2.recv('overlayStatus'); await H.recv('overlayStatus', 100);
  H.msgs.length = 0;
  host.sendBridge('Default', { type: 'bridge', id: 'to-default', call: 'x', args: [] });
  host.sendBridge('Profile 1', { type: 'bridge', id: 'to-p1', call: 'x', args: [] });
  const g2 = await H2.recv('bridge'), g1 = await H.recv('bridge');
  check('relay: bridge envelopes are routed per profile', g2?.id === 'to-default' && g1?.id === 'to-p1');
  check('relay: nothing leaks to the other profile', await H.quiet(200) && await H2.quiet(10));

  // overlay feature off: no overlayStatus
  const quiet = new HostServer({ appDir: path.join(tmp, 'app-quiet'), localState, chromeBin: fakeChrome, overlay: false });
  await quiet.listen();
  const Q = spawnClient({ SIDEBAR_APP_DIR: quiet.appDir });
  await Q.request({ type: 'identify', profileDir: 'Default' });
  check('relay: overlay feature off -> no overlayStatus', await Q.quiet(300));
  Q.closeStdin(); await quiet.close();
  H.closeStdin(); H2.closeStdin();
}

// ------------------------------------------------------------ 11b. duplicate profile guard
{
  const dupHost = new HostServer({ appDir: path.join(tmp, 'app-dup'), localState, chromeBin: fakeChrome, overlay: false });
  await dupHost.listen();
  const cs = [];
  const res = [];
  for (let i = 0; i < 6; i++) {
    const c = spawnClient({ SIDEBAR_APP_DIR: dupHost.appDir });
    cs.push(c);
    res.push(await c.request({ type: 'identify', profileDir: 'Default' }));
  }
  check('duplicate: first claim and 3 replacements accepted', res.slice(0, 4).every((x) => x?.profileDir === 'Default' && !x.error), j(res.slice(0, 4)));
  check('duplicate: 4th replacement attempt within 60 s refused', res[4]?.error === 'duplicate profile' && res[4].profileDir === null, j(res[4]));
  check('duplicate: later attempts still refused, third connection keeps the profile', res[5]?.error === 'duplicate profile' && dupHost.isConnected('Default'));
  for (const c of cs) c.closeStdin();
  await dupHost.close();
}

// ------------------------------------------------------------ 12. connector behaviour
{
  // starts before the host exists: waits, then connects
  const late = new HostServer({ appDir: path.join(tmp, 'app-late'), localState, chromeBin: fakeChrome });
  const L = spawnClient({ SIDEBAR_APP_DIR: late.appDir });
  await sleep(500);
  check('connector: waits for the app socket (still running)', !L.exited);
  L.send({ type: 'getProfiles', requestId: 'q1' }); // buffered until connected
  await late.listen();
  r = await L.recv('profiles', 8000);
  check('connector: connects once the app appears and delivers buffered input', r?.requestId === 'q1');
  // host drops the connection -> connector exits
  for (const c of late.conns) c.sock.destroy();
  check('connector: exits when the app closes the connection', await wait(() => L.exited, 3000));
  await late.close();

  // gives up when the app never appears
  const t0 = Date.now();
  const N = spawnClient({ SIDEBAR_APP_DIR: path.join(tmp, 'app-never'), SIDEBAR_CONNECT_TIMEOUT_MS: '800' });
  check('connector: gives up with exit code 1 after the timeout', await wait(() => N.exited, 4000) && N.code === 1 && Date.now() - t0 >= 700, `code ${N.code}`);
  check('connector: nothing on stdout when it fails', N.buf.length === 0 && N.msgs.length === 0 && N.stdoutEnded);

  // launches the app when the socket is missing
  const launchDir = path.join(tmp, 'app-launch');
  const marker = path.join(tmp, 'launched.txt');
  const M = spawnClient({ SIDEBAR_APP_DIR: launchDir, SIDEBAR_APP_LAUNCH: `echo started > '${marker}'`, SIDEBAR_CONNECT_TIMEOUT_MS: '800' });
  check('connector: runs SIDEBAR_APP_LAUNCH when the socket is missing', await wait(() => fs.existsSync(marker), 3000));
  await wait(() => M.exited, 3000);
}

// ------------------------------------------------------------ 12b. v3.0: appSetting relay and appState push
{
  const T = spawnClient();
  await T.request({ type: 'hello' });
  await T.request({ type: 'identify', profileDir: 'Default', requestId: 31 });
  await T.recv('overlayStatus');
  const seen = [];
  host.on('appSetting', (x) => seen.push(x));
  r = await T.request({ type: 'appSetting', name: 'setLaunchAtLogin', value: false, requestId: 32 });
  check('appSetting: reply {type, name, ok, requestId}', r?.type === 'appSetting' && r.name === 'setLaunchAtLogin' && r.ok === true && r.requestId === 32, j(r));
  check('appSetting: emitted to the app with profile, name and value', seen.length === 1 && seen[0].profileDir === 'Default' && seen[0].name === 'setLaunchAtLogin' && seen[0].value === false, j(seen));
  for (const name of ['setLaunchAtLogin', 'requestScreenCapture', 'openAccessibilitySettings', 'rescanRail', 'quitApp', 'setPinned', 'reviewPermissions', 'setShowMenuBarIcon', 'setGreenButtonAction']) {
    r = await T.request({ type: 'appSetting', name, value: true, requestId: 'n-' + name });
    check(`appSetting: ${name} accepted`, r?.ok === true && seen.at(-1)?.name === name, j(r));
  }
  const n = seen.length;
  r = await T.request({ type: 'appSetting', name: 'formatDisk', value: 1, requestId: 33 });
  check('appSetting: unknown name refused and not emitted', r?.ok === false && !!r.error && seen.length === n, j(r));
  T.send({ type: 'appSetting', name: 'setLaunchAtLogin', value: true });
  await wait(() => seen.length === n + 1);
  check('appSetting: works without a requestId (fire and forget), no reply', seen.length === n + 1 && await T.quiet(200));
  r = await T.request({ type: 'getAppState', requestId: 34 });
  check('getAppState: null before the app reported anything', r?.type === 'appState' && r.state === null && r.requestId === 34, j(r));
  host.setAppState({ state: 'pinned', showMenuBarIcon: false, launchAtLogin: true, accessibility: true });
  r = await T.recv('appState');
  check('setAppState: pushed to identified extensions as {type:"appState", state} without requestId', r?.state?.showMenuBarIcon === false && r.state.state === 'pinned' && !('requestId' in r), j(r));
  r = await T.request({ type: 'getAppState', requestId: 35 });
  check('getAppState: returns the latest state', r?.state?.launchAtLogin === true && r.requestId === 35, j(r));
  const T2 = spawnClient();
  await T2.request({ type: 'hello' });
  const unidentified = await T2.quiet(200);
  await T2.request({ type: 'identify', profileDir: 'Profile 1', requestId: 36 });
  const replay = await T2.recv('appState');
  check('appState: replayed to an extension that identifies later (not before)', unidentified && replay?.state?.accessibility === true, j(replay));
  host.appState = null;
  T2.closeStdin();
  await wait(() => T2.exited, 3000);
  T.closeStdin();
  await wait(() => T.exited, 3000);
  host.removeAllListeners('appSetting');
}

// ------------------------------------------------------------ 13. state import
{
  const legacy = path.join(tmp, 'legacy-state.json');
  fs.writeFileSync(legacy, j({ archiveDefaultMinutes: 60, profileStyles: { Default: { icon: 'star', color: '#123456' } } }));
  const imp = new HostServer({ appDir: path.join(tmp, 'app-import'), localState, chromeBin: fakeChrome, legacyStateFile: legacy });
  await imp.listen();
  const I = spawnClient({ SIDEBAR_APP_DIR: imp.appDir });
  r = await I.request({ type: 'hello' });
  check('legacy SidebarHelper state.json imported on first launch', r?.settings?.archiveDefaultMinutes === 60 && r.profiles.find((x) => x.dir === 'Default')?.style?.icon === 'star', j(r?.settings));
  I.closeStdin(); await imp.close();
}

// ------------------------------------------------------------ 13b. v3.4: screenshot editor in the app
{
  const T = spawnClient();
  await T.request({ type: 'hello' });
  await T.request({ type: 'identify', profileDir: 'Default', requestId: 61 });
  await T.recv('overlayStatus');
  const cfgs = [], opened = [];
  host.on('captureConfig', (x) => cfgs.push(x));
  host.on('openCaptureEditor', (x) => opened.push(x));
  T.send({ type: 'captureConfig', config: { annotate: true, askWhere: false, s3: { bucket: 'b' } } });
  await wait(() => cfgs.length === 1);
  check('captureConfig: kept for the connection, no reply', cfgs[0]?.profileDir === 'Default' && cfgs[0].config.s3.bucket === 'b' && await T.quiet(200), j(cfgs));
  const png = Buffer.from('not really a png but bytes \x00\x01\x02 all the same');
  const b64 = png.toString('base64'), cut = 8;
  const head = { type: 'openCaptureEditor', id: 'cap1', parts: 2, meta: { id: 'cap1', mode: 'full', width: 10, height: 20, dpr: 2 }, config: {} };
  T.send({ ...head, part: 0, data: b64.slice(0, cut) });
  check('openCaptureEditor: no reply before the last part', await T.quiet(200));
  r = await T.request({ ...head, part: 1, data: b64.slice(cut), requestId: 62 });
  check('openCaptureEditor: last part answered {type, id, ok, requestId}', r?.ok === true && r.id === 'cap1' && r.requestId === 62, j(r));
  check('openCaptureEditor: the picture is reassembled byte for byte, with its meta', opened.length === 1 && opened[0].png.equals(png) && opened[0].meta.mode === 'full', j(opened.map((o) => o.png.length)));
  r = await T.request({ ...head, id: 'cap2', part: 1, data: b64.slice(cut), requestId: 63 });
  check('openCaptureEditor: a missing part is refused (the extension falls back to its popup)', r?.ok === false && !!r.error && opened.length === 1, j(r));
  r = await T.request({ ...head, part: 5, data: 'x', requestId: 64 });
  check('openCaptureEditor: an out-of-range part is refused', r?.ok === false, j(r));
  T.closeStdin();
  await wait(() => T.exited, 3000);
}

// ------------------------------------------------------------ 13b2. v3.6: Record Chrome Tab messages
{
  const T = spawnClient();
  await T.request({ type: 'hello' });
  await T.request({ type: 'identify', profileDir: 'Default', requestId: 65 });
  await T.recv('overlayStatus');
  const rec = [];
  host.on('record', (x) => rec.push(x));
  T.send({ type: 'recordTab', windowId: 7, tabId: 42, title: 'Docs' });
  T.send({ type: 'recordTabState', tabId: 42, active: false });
  T.send({ type: 'recordTabState', tabId: 42, active: true });
  T.send({ type: 'recordTabMoved', tabId: 42, windowId: 9 });
  T.send({ type: 'recordTabClosed', tabId: 42 });
  await wait(() => rec.length === 5);
  check('recordTab: reaches the app with window, tab and title, no reply', rec[0]?.profileDir === 'Default' && rec[0].type === 'recordTab'
    && rec[0].msg.windowId === 7 && rec[0].msg.tabId === 42 && rec[0].msg.title === 'Docs' && await T.quiet(200), j(rec[0]));
  check('recordTabState: inactive then active (auto-pause / resume)', rec[1]?.msg.active === false && rec[2]?.msg.active === true && rec[1].msg.tabId === 42, j(rec.slice(1, 3)));
  check('recordTabMoved / recordTabClosed: delivered in order', rec[3]?.type === 'recordTabMoved' && rec[3].msg.windowId === 9 && rec[4]?.type === 'recordTabClosed' && rec[4].msg.tabId === 42, j(rec.slice(3)));
  check('recordTabRequest: the app asks the extension for its active tab', host.requestRecordTab('Default') && (await T.recv('recordTabRequest'))?.type === 'recordTabRequest');
  host.setRecordingTab('Default', 42);
  check('recordingTab: the app names the tab it records', (await T.recv('recordingTab'))?.tabId === 42);
  host.setRecordingTab('Default', null);
  check('recordingTab: null when the recording ends', (await T.recv('recordingTab'))?.tabId === null);
  check('recordingTab / recordTabRequest: refused for a profile that is not connected', host.setRecordingTab('Nope', 1) === false && host.requestRecordTab('Nope') === false);
  T.closeStdin();
  await wait(() => T.exited, 3000);
}

// ------------------------------------------------------------ 13c. v3.5c: app-owned capture settings, mode, migration
{
  const T = spawnClient();
  await T.request({ type: 'hello' });
  await T.request({ type: 'identify', profileDir: 'Default', requestId: 71 });
  await T.recv('overlayStatus');
  r = await T.request({ type: 'getCaptureSettings', requestId: 72 });
  const d = r?.settings;
  check('getCaptureSettings: defaults (folders, pattern, shadow, annotate, recording keys)', r?.type === 'captureSettings' && r.requestId === 72
    && d.screenshotFolder.endsWith(path.join('Downloads', 'Screenshots')) && d.recordingFolder === d.screenshotFolder && d.recordingFolderFollowsScreenshots === true
    && d.filenamePattern === 'Screenshot {yyyy}-{mm}-{dd} at {hh}.{min}.{ss}' && d.windowShadow === true && d.annotate === true && d.askWhere === false
    && d.recording.fps === 30 && d.recording.codec === 'h264' && d.recording.countdown === true && d.recording.showCursor === true
    && d.recording.systemAudio === false && d.recording.micDeviceId === '' && d.recording.maxResolution === '1080p' && d.s3.secretSet === false && d.s3.recordingShare === 'page', j(r));
  const seen = [];
  host.on('appSetting', (x) => seen.push(x));
  const secret = 'SECRET-never-in-state-json-0123456789';
  r = await T.request({ type: 'appSetting', name: 'setCaptureSettings', requestId: 73, value: {
    screenshotFolder: '/tmp/shots', filenamePattern: '{app} {yyyy}{mm}{dd}', windowShadow: false, annotate: false, askWhere: true,
    s3: { endpoint: ' https://s3.example.com ', bucket: 'b', accessKeyId: 'AKID', secretAccessKey: secret, prefix: 'x/{yyyy}/', linkType: 'public', publicBase: 'https://cdn.example.com/', expiry: 3600, naming: 'timestamp', recordingShare: 'file' },
    recording: { fps: 60, codec: 'hevc', countdown: false, showCursor: false, systemAudio: true, micDeviceId: 'mic-1', maxResolution: '1440p' } } });
  check('setCaptureSettings: accepted through the appSetting relay', r?.type === 'appSetting' && r.name === 'setCaptureSettings' && r.ok === true && seen.at(-1)?.name === 'setCaptureSettings', j(r));
  r = await T.request({ type: 'getCaptureSettings', requestId: 74 });
  const c = r?.settings;
  check('setCaptureSettings: values stored and read back', c.screenshotFolder === '/tmp/shots' && c.filenamePattern === '{app} {yyyy}{mm}{dd}' && c.windowShadow === false && c.annotate === false && c.askWhere === true
    && c.s3.endpoint === 'https://s3.example.com' && c.s3.bucket === 'b' && c.s3.accessKeyId === 'AKID' && c.s3.linkType === 'public' && c.s3.expiry === 3600 && c.s3.naming === 'timestamp' && c.s3.recordingShare === 'file'
    && c.recording.fps === 60 && c.recording.codec === 'hevc' && c.recording.countdown === false && c.recording.showCursor === false && c.recording.systemAudio === true && c.recording.micDeviceId === 'mic-1' && c.recording.maxResolution === '1440p', j(c));
  check('capture settings: the secret is never in the normal reply, only a secretSet flag', c.s3.secretSet === true && !('secretAccessKey' in c.s3) && !j(r).includes(secret), j(c.s3));
  r = await T.request({ type: 'getCaptureSettings', full: true, requestId: 75 });
  check('getCaptureSettings full:true adds the secret (for the connection test / uploads)', r?.settings?.s3?.secretAccessKey === secret, j(r?.settings?.s3));
  check('capture settings: the secret is not written to state.json', !slurp(host.stateFile).includes(secret) && readJson(host.stateFile).capture?.s3?.bucket === 'b');
  r = await T.request({ type: 'appSetting', name: 'setCaptureSettings', requestId: 76, value: { recording: { fps: 45, codec: 'vp9', maxResolution: '8k' }, screenshotFolder: 'relative/path', windowShadow: 'yes', s3: { expiry: 99999999, style: 'nonsense', recordingShare: 'bogus' } } });
  r = await T.request({ type: 'getCaptureSettings', requestId: 77 });
  check('setCaptureSettings: invalid values are ignored (fps, codec, resolution, relative folder, non-boolean, style) and expiry is capped',
    r.settings.recording.fps === 60 && r.settings.recording.codec === 'hevc' && r.settings.recording.maxResolution === '1440p' && r.settings.screenshotFolder === '/tmp/shots'
    && r.settings.windowShadow === false && r.settings.s3.style === 'auto' && r.settings.s3.recordingShare === 'file' && r.settings.s3.expiry === 604800, j(r.settings));
  T.send({ type: 'appSetting', name: 'setCaptureSettings', value: { screenshotFolder: '' } });
  r = await T.request({ type: 'getCaptureSettings', requestId: 78 });
  check('setCaptureSettings: an empty folder goes back to the default', r.settings.screenshotFolder.endsWith(path.join('Downloads', 'Screenshots')), j(r.settings.screenshotFolder));
  r = await T.request({ type: 'appSetting', name: 'chooseCaptureFolder', value: 'recordings', requestId: 79 });
  check('chooseCaptureFolder is a known app setting (the Swift app shows the panel)', r?.ok === true && seen.at(-1)?.name === 'chooseCaptureFolder' && seen.at(-1).value === 'recordings', j(r));
  check('fileName: pattern tokens, "/" and ":" made safe', host.capture.fileName('Fin/der', new Date(2026, 9, 24, 14, 3, 22)) === '{app} {yyyy}{mm}{dd}'.replace('{app}', 'Fin-der').replace('{yyyy}', '2026').replace('{mm}', '10').replace('{dd}', '24') + '.png', host.capture.fileName('Fin/der', new Date(2026, 9, 24, 14, 3, 22)));
  host.capture.apply({ filenamePattern: '' });
  check('fileName: empty pattern means the macOS-style default', host.capture.fileName('X', new Date(2026, 9, 24, 14, 3, 22)) === 'Screenshot 2026-10-24 at 14.03.22.png', host.capture.fileName('X', new Date(2026, 9, 24, 14, 3, 22)));

  // appState carries the mode and the (secret-free) capture settings, and follows changes
  T.msgs.length = 0;
  host.setAppState({ state: 'pinned', accessibility: true });
  r = await T.recv('appState');
  check('appState: carries useChrome, capture (no secret) and microphones', r?.state?.useChrome === true && r.state.capture?.s3?.bucket === 'b' && r.state.capture.s3.secretSet === true && !j(r).includes(secret) && Array.isArray(r.state.microphones), j(r?.state?.capture?.s3));
  T.send({ type: 'appSetting', name: 'setCaptureSettings', value: { filenamePattern: 'Shot {hh}' } });
  r = await T.recv('appState');
  check('appState: re-pushed when a capture setting changes', r?.state?.capture?.filenamePattern === 'Shot {hh}', j(r?.state?.capture?.filenamePattern));
  T.send({ type: 'appSetting', name: 'setUseChrome', value: false });
  r = await T.recv('appState');
  check('setUseChrome: the mode is pushed in appState', r?.state?.useChrome === false && host.useChrome === false, j(r?.state?.useChrome));
  T.send({ type: 'appSetting', name: 'setUseChrome', value: true });
  r = await T.recv('appState');
  check('setUseChrome: back on', r?.state?.useChrome === true);

  // the editor's config comes from the app (with the profile's colour from its captureConfig)
  const opened = [];
  host.on('openCaptureEditor', (x) => opened.push(x));
  const png = Buffer.from('png-bytes');
  r = await T.request({ type: 'openCaptureEditor', id: 'cfg1', parts: 1, part: 0, data: png.toString('base64'), meta: { id: 'cfg1', mode: 'area' },
    config: { annotate: true, askWhere: false, sidebarColor: { mode: 'custom', color: '#112233' }, s3: { bucket: 'EXT' } }, requestId: 80 });
  const cfg = opened[0]?.config;
  check('openCaptureEditor: the editor config is the app\'s (annotate/askWhere/S3 incl. secret) plus the profile colour, not the extension\'s',
    r?.ok === true && cfg?.annotate === false && cfg.askWhere === true && cfg.s3.bucket === 'b' && cfg.s3.secretAccessKey === secret && cfg.sidebarColor?.color === '#112233', j(cfg));
  // v3.6: recent recordings are pushed to the extension as small messages (metadata + thumbnail, never the video)
  const thumb = Buffer.alloc(6000, 7).toString('base64');
  const sent = host.sendNativeRecording('Default', { id: 'rec1', title: 'Recording — Slack — Oct 24', duration: 42.4, time: 1_792_000_000_000, link: 'https://cdn.example.com/r.mp4', thumb });
  r = await T.recv('nativeRecording');
  check('nativeRecording: id, title, duration, time, link and the thumbnail arrive intact', sent === true && r?.id === 'rec1' && r.title === 'Recording — Slack — Oct 24' && r.duration === 42.4
    && r.time === 1_792_000_000_000 && r.link === 'https://cdn.example.com/r.mp4' && r.thumb === thumb && !('removed' in r), j({ ...r, thumb: r?.thumb?.length }));
  host.sendNativeRecording('Default', { id: 'rec1', removed: true });
  r = await T.recv('nativeRecording');
  check('nativeRecording: a removal carries just the id', r?.id === 'rec1' && r.removed === true && !('thumb' in r), j(r));
  check('nativeRecording: over Chrome\'s 1 MB message limit it is dropped, not sent', host.sendNativeRecording('Default', { id: 'big', title: 'x', thumb: 'A'.repeat(1_100_000) }) === false && await T.quiet(300));
  check('nativeRecording: a profile that is not connected gets nothing', host.sendNativeRecording('Nobody', { id: 'rec2', title: 'x' }) === false);
  T.closeStdin();
  await wait(() => T.exited, 3000);
  host.removeAllListeners('appSetting'); host.removeAllListeners('openCaptureEditor');
  host.appState = null; host.useChrome = true;

  // migration: a fresh app adopts the extension's S3 setup once
  const mdir = path.join(tmp, 'app-migrate');
  const mh = new HostServer({ appDir: mdir, localState, chromeBin: fakeChrome });
  await mh.listen();
  const M = spawnClient({ SIDEBAR_APP_DIR: mdir });
  await M.request({ type: 'hello' });
  await M.request({ type: 'identify', profileDir: 'Default', requestId: 81 });
  await M.recv('overlayStatus');
  M.send({ type: 'captureConfig', config: { annotate: false, askWhere: true, s3: { endpoint: 'https://r2.example.com', bucket: 'ext-bucket', accessKeyId: 'EXTKEY', secretAccessKey: 'EXTSECRET', prefix: 'p/', region: 'auto' } } });
  await wait(() => mh.capture.s3Public.bucket === 'ext-bucket');
  r = await M.request({ type: 'getCaptureSettings', full: true, requestId: 82 });
  check('migration: the extension\'s S3 setup is adopted when the app has none (secret into the keychain stand-in)', r?.settings?.s3?.bucket === 'ext-bucket' && r.settings.s3.accessKeyId === 'EXTKEY' && r.settings.s3.secretAccessKey === 'EXTSECRET' && r.settings.s3.prefix === 'p/' && r.settings.annotate === false && r.settings.askWhere === true, j(r?.settings?.s3));
  check('migration: the secret is not in state.json', !slurp(mh.stateFile).includes('EXTSECRET'));
  M.send({ type: 'captureConfig', config: { s3: { endpoint: 'https://other', bucket: 'other', accessKeyId: 'O', secretAccessKey: 'OS' } } });
  await M.quiet(300);
  check('migration: adopted once, a later push does not overwrite the app\'s settings', mh.capture.s3Public.bucket === 'ext-bucket');
  mh.capture.apply({ s3: { bucket: '', accessKeyId: '', secretAccessKey: '' } });
  M.send({ type: 'captureConfig', config: { s3: { endpoint: 'https://other', bucket: 'other', accessKeyId: 'O', secretAccessKey: 'OS' } } });
  await M.quiet(300);
  check('migration: not adopted again after it happened once, even when the app was cleared', mh.capture.s3Public.bucket === '');
  M.closeStdin();
  await wait(() => M.exited, 3000);
  await mh.close();
  // an app that is already set up keeps its own
  const kdir = path.join(tmp, 'app-keep');
  const kh = new HostServer({ appDir: kdir, localState, chromeBin: fakeChrome });
  await kh.listen();
  kh.capture.apply({ s3: { endpoint: 'https://mine', bucket: 'mine', accessKeyId: 'MINE', secretAccessKey: 'MS' } });
  const K = spawnClient({ SIDEBAR_APP_DIR: kdir });
  await K.request({ type: 'hello' });
  await K.request({ type: 'identify', profileDir: 'Default', requestId: 83 });
  K.send({ type: 'captureConfig', config: { s3: { endpoint: 'https://ext', bucket: 'ext', accessKeyId: 'E', secretAccessKey: 'ES' } } });
  await K.quiet(300);
  check('migration: an app that already has an S3 setup is left alone', kh.capture.s3Public.bucket === 'mine' && kh.capture.keychainSecret === 'MS');
  K.closeStdin();
  await wait(() => K.exited, 3000);
  await kh.close();
}

// ------------------------------------------------------------ 14. manifest
{
  const f = writeHostManifest(path.join(tmp, 'nmh'), CONNECTOR);
  const m = readJson(f);
  check('host manifest: name, stdio, path and allowed origin', m.name === 'com.stile.helper' && m.type === 'stdio' && m.path === CONNECTOR
    && m.allowed_origins?.[0] === 'chrome-extension://ffblekellgdmlecjablfojaaadpkmdgg/' && path.basename(f) === 'com.stile.helper.json');
  check('connector.js is executable with a node shebang', (fs.statSync(CONNECTOR).mode & 0o111) !== 0 && slurp(CONNECTOR).startsWith('#!/usr/bin/env node\n'));
}

// ------------------------------------------------------------ cleanup
for (const c of all) if (!c.exited) c.kill();
await host.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
