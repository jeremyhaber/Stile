// Helpers for NATIVE demo scenes (macOS only): briefly run the debug Stile.app with its recording editor and capture ONLY that
// window, frame by frame, with `screencapture -l <windowID> -o -x` (window capture: no desktop, no other windows, no shadow).
// Safe by construction:
//   - the app is started with STILE_PREVIEW_RECORDING, which opens just the editor (no server, no menu bar item, no recent list),
//     so it never conflicts with an installed Stile.app; it is only ever stopped by its own PID;
//   - the clip it opens is a synthetic, silent video made here from a fictional page, kept in a fresh dir under /tmp;
//   - needs the Screen Recording permission for the terminal; if screencapture fails we stop and say so (we never request it).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { ROOT, FFMPEG, sleep, until } from './harness.mjs';

export const DEBUG_BIN = path.join(ROOT, 'mac', '.build', 'debug', 'StileApp');

export function nativeProblem() {
  if (process.platform !== 'darwin') return 'needs macOS';
  if (!fs.existsSync(DEBUG_BIN)) return `needs a built ${path.relative(ROOT, DEBUG_BIN)} (run: cd mac && swift build)`;
  return null;
}

// A neutral working dir: /tmp/stile-demo-native-XXXX (no user name in the path or in the clip's file name).
export const workDir = () => fs.mkdtempSync(path.join('/tmp', 'stile-demo-native-'));

// Fictional "Weekly report" page, scrolled by ffmpeg into a 10 s, 1280x800, SILENT clip (audio is anullsrc: pure silence).
const CLIP_HTML = `<!doctype html><meta charset=utf-8><style>
body{margin:0;width:1280px;font:20px/1.5 -apple-system,Helvetica,Arial,sans-serif;background:#f6f7fb;color:#1f2328}
header{background:#1b6ac9;color:#fff;padding:22px 60px;font-size:26px;font-weight:700}
main{padding:40px 60px}h1{font-size:54px;margin:0 0 6px}p.s{color:#5b6472;margin:0 0 30px}
.row{display:flex;gap:24px;margin-bottom:28px}.k{flex:1;background:#fff;border-radius:16px;padding:26px;box-shadow:0 1px 4px #0002}
.k b{font-size:44px;display:block}.bar{height:26px;border-radius:6px;background:#1b6ac9;margin:12px 0}
.c{background:#fff;border-radius:16px;padding:30px;margin-bottom:28px;box-shadow:0 1px 4px #0002}.c h2{margin:0 0 10px;font-size:32px}
.g{height:220px;border-radius:12px;background:linear-gradient(90deg,#c7dcf7,#1b6ac9);margin-top:14px}
</style><header>Northwind Studio</header><main><h1>Weekly report</h1><p class=s>Sample figures for a demo page</p>
<div class=row><div class=k><b>128</b>New sign-ups</div><div class=k><b>94%</b>On-time delivery</div><div class=k><b>31</b>Open tasks</div></div>
<div class=c><h2>Progress</h2>Design<div class=bar style="width:90%"></div>Build<div class=bar style="width:70%"></div>Review<div class=bar style="width:45%"></div></div>
<div class=c><h2>Highlights</h2>Launched the new onboarding flow and shortened setup from ten steps to four. Support replies are now twice as fast.<div class=g></div></div>
<div class=c><h2>Next week</h2>Finish the pricing page, run a round of user interviews, and tidy the backlog.<div class=g style="background:linear-gradient(90deg,#fde7c7,#e08a1b)"></div></div>
<div class=c><h2>Notes</h2>Thanks to everyone who helped this week. Numbers above are placeholders.</div></main>`;

// page: any Playwright page (its viewport is set here). Returns the path of <dir>/Recording.mp4
export async function makeClip(page, dir) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(CLIP_HTML);
  const tall = path.join(dir, 'page.png');
  await page.screenshot({ path: tall, fullPage: true });
  const out = path.join(dir, 'Recording.mp4');
  const vf = "scale=1280:-2,crop=1280:800:0:'min(ih-800,max(0,(t-1)*(ih-800)/7.5))',format=yuv420p";
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-t', '10', '-i', tall,
    '-f', 'lavfi', '-t', '10', '-i', 'anullsrc=r=44100:cl=stereo', '-vf', vf, '-c:v', 'libx264', '-c:a', 'aac', '-shortest', out]);
  fs.rmSync(tall, { force: true });
  return out;
}

const WIN_SWIFT = `import Cocoa
let pid = Int32(CommandLine.arguments[1])!
let l = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String:Any]]
for w in l where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
  let b = w[kCGWindowBounds as String] as! [String:Any]
  print(w[kCGWindowNumber as String]!, b["Width"]!, b["Height"]!)
}`;

// Starts the debug app on `clip`, captures its (only) window for `seconds`, stops it. Returns { frames:[{t,file}], width, height }
// (width/height in points). Frames are PNGs in `dir`.
export async function captureEditorWindow({ clip, dir, seconds = 10, fps = 8 }) {
  const src = path.join(dir, 'win.swift'), tool = path.join(dir, 'win');
  fs.writeFileSync(src, WIN_SWIFT);
  execFileSync('swiftc', ['-O', src, '-o', tool], { stdio: 'ignore' });
  const child = spawn(DEBUG_BIN, [], { env: { ...process.env, STILE_PREVIEW_RECORDING: clip }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    let win = null;
    await until(() => {
      const lines = execFileSync(tool, [String(child.pid)]).toString().trim().split('\n').filter(Boolean);
      if (lines.length > 1) throw new Error('expected exactly one window from the debug app, got ' + lines.length);
      if (lines.length === 1) { const [id, w, h] = lines[0].split(' '); win = { id, width: +w, height: +h }; }
      return win;
    }, 20000, 250);
    if (!win) throw new Error('the debug Stile.app did not open its editor window');
    await sleep(1200);   // let the video load and start playing
    const frames = [], t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      const t = Date.now() - t0, f = path.join(dir, `win-${String(frames.length).padStart(4, '0')}.png`);
      try { execFileSync('screencapture', ['-l', win.id, '-o', '-x', f], { stdio: 'pipe' }); }
      catch (e) { throw new Error('screencapture -l failed (does the terminal have the Screen Recording permission?): ' + String(e.stderr || e.message).trim()); }
      frames.push({ t, file: f });
      await sleep(Math.max(0, 1000 / fps - (Date.now() - t0 - t)));
    }
    return { frames, width: win.width, height: win.height };
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(4000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}

// A page-like object for a stage layer that replays captured frames in real time (the stage only needs screenshot()).
export function replay(frames) {
  let t0 = null;
  return {
    start() { t0 = Date.now(); },
    isClosed: () => false,
    async screenshot({ path: out }) {
      const t = t0 == null ? 0 : Date.now() - t0;
      let f = frames[0];
      for (const x of frames) { if (x.t <= t) f = x; else break; }
      fs.copyFileSync(f.file, out);
    },
  };
}
