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
    const rt = { getProfiles: 'profiles', identify: 'identified', switchProfile: 'switchResult', setGlobalSettings: 'settings', setProfileStyle: 'profiles', setOverlayEnabled: 'overlayEnabled', setDefaultBrowser: 'defaultBrowser', getAppState: 'appState', appSetting: 'appSetting' };
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
  r = await T.request({ type: 'appSetting', name: 'setLockstep', value: false, requestId: 32 });
  check('appSetting: reply {type, name, ok, requestId}', r?.type === 'appSetting' && r.name === 'setLockstep' && r.ok === true && r.requestId === 32, j(r));
  check('appSetting: emitted to the app with profile, name and value', seen.length === 1 && seen[0].profileDir === 'Default' && seen[0].name === 'setLockstep' && seen[0].value === false, j(seen));
  for (const name of ['setLaunchAtLogin', 'requestScreenCapture', 'openAccessibilitySettings', 'rescanRail', 'quitApp', 'setPinned', 'reviewPermissions', 'setShowMenuBarIcon', 'setGreenButtonAction']) {
    r = await T.request({ type: 'appSetting', name, value: true, requestId: 'n-' + name });
    check(`appSetting: ${name} accepted`, r?.ok === true && seen.at(-1)?.name === name, j(r));
  }
  const n = seen.length;
  r = await T.request({ type: 'appSetting', name: 'formatDisk', value: 1, requestId: 33 });
  check('appSetting: unknown name refused and not emitted', r?.ok === false && !!r.error && seen.length === n, j(r));
  T.send({ type: 'appSetting', name: 'setLockstep', value: true });
  await wait(() => seen.length === n + 1);
  check('appSetting: works without a requestId (fire and forget), no reply', seen.length === n + 1 && await T.quiet(200));
  r = await T.request({ type: 'getAppState', requestId: 34 });
  check('getAppState: null before the app reported anything', r?.type === 'appState' && r.state === null && r.requestId === 34, j(r));
  host.setAppState({ state: 'pinned', lockstep: false, launchAtLogin: true, accessibility: true });
  r = await T.recv('appState');
  check('setAppState: pushed to identified extensions as {type:"appState", state} without requestId', r?.state?.lockstep === false && r.state.state === 'pinned' && !('requestId' in r), j(r));
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

// ------------------------------------------------------------ 14. manifest
{
  const f = writeHostManifest(path.join(tmp, 'nmh'), CONNECTOR);
  const m = readJson(f);
  check('host manifest: name, stdio, path and allowed origin', m.name === 'com.sidebar.helper' && m.type === 'stdio' && m.path === CONNECTOR
    && m.allowed_origins?.[0] === 'chrome-extension://ffblekellgdmlecjablfojaaadpkmdgg/' && path.basename(f) === 'com.sidebar.helper.json');
  check('connector.js is executable with a node shebang', (fs.statSync(CONNECTOR).mode & 0o111) !== 0 && slurp(CONNECTOR).startsWith('#!/usr/bin/env node\n'));
}

// ------------------------------------------------------------ cleanup
for (const c of all) if (!c.exited) c.kill();
await host.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
