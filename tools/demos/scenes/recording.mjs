// NATIVE scene: needs macOS + a built mac/.build/debug/StileApp; briefly opens the recording editor window and captures only that window.
// Part 1 (headless, like the other scenes): right-click a tab, "Record this tab", the red recording dot on its row. The real app answers
// a recordTab message with recordingTab {tabId}; the fake host does the same here, nothing more.
// Part 2 (native): the real recording editor (STILE_PREVIEW_RECORDING with a synthetic silent clip), captured with
// `screencapture -l <windowID>` only (see lib/native.mjs), replayed in real time on the stage.
import fs from 'fs';
import { makeClip, captureEditorWindow, replay, workDir, nativeProblem } from '../lib/native.mjs';

const PANEL = { w: 320, h: 504 }, MAIN = { w: 600, h: 504 };
const BX = 11, BY = 43;
const NATIVE = { w: 1212, h: 644, scale: 0.78 };   // the editor window in points, drawn at 78%
const REC_SITE = 'docs';

export default {
  name: 'recording',
  output: 'recording.gif',
  native: true,
  captions: true,
  stage: { width: 960, height: 560 },
  width: 960, fps: 8, colors: 96, lead: 150, hold: 1500,
  tabs: ['encyclopedia', REC_SITE, 'news', 'code'],
  panelH: PANEL.h,
  async setup(ctx) {
    const why = nativeProblem(); if (why) throw new Error(why);
    const main = ctx.pages[REC_SITE];
    await main.setViewportSize({ width: MAIN.w, height: MAIN.h });
    await ctx.activate(REC_SITE);
    await main.bringToFront(); await ctx.sleep(800);
    // In the app's overlay the tab menu is a native macOS menu (not drawable here); the side panel shows the same items as a web menu.
    // Drop the overlay's native-menu bridge so the panel draws that web menu.
    await ctx.panel.evaluate(() => { window.__sidebarHost = null; });
    // the app's side of a recording: it answers recordTab with recordingTab {tabId} once recording starts
    const { refApp } = ctx.env;
    refApp.on('record', ({ type, msg }) => { if (type === 'recordTab') refApp.setRecordingTab('Default', msg.tabId); });
    // native part, captured now (not recorded) and replayed later
    const dir = workDir(); ctx.onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
    const clipPage = await ctx.stage.newPage({ width: 1280, height: 800 });
    const clip = await makeClip(clipPage, dir); await clipPage.close();
    const cap = await captureEditorWindow({ clip, dir, seconds: 9.5, fps: 8 });
    if (Math.abs(cap.width - NATIVE.w) > 40 || Math.abs(cap.height - NATIVE.h) > 40) throw new Error(`editor window is ${cap.width}x${cap.height}, expected about ${NATIVE.w}x${NATIVE.h}`);
    ctx.native = replay(cap.frames);
    const nx = Math.round((960 - NATIVE.w * NATIVE.scale) / 2), ny = Math.round((560 - NATIVE.h * NATIVE.scale) / 2);
    await ctx.stage.build({
      decor: `<div class="win" id="browser-decor" style="left:10px;top:14px;width:${PANEL.w + MAIN.w + 2}px;height:${PANEL.h + 28 + 2}px;z-index:0"><div class="bar" style="height:28px"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div></div>`,
      layers: [
        { id: 'panel', page: ctx.panel, x: BX, y: BY, w: PANEL.w, h: PANEL.h, z: 2 },
        { id: 'main', page: main, x: BX + PANEL.w, y: BY, w: MAIN.w, h: MAIN.h, z: 2 },
        { id: 'editor', page: ctx.native, x: nx, y: ny, w: NATIVE.w, h: NATIVE.h, scale: NATIVE.scale, z: 20, hidden: true },
      ],
    });
  },
  async run(ctx) {
    const { panel, T, stage } = ctx;
    const mp = ctx.mouse(panel);
    const row = ctx.row('Dev Docs');
    await ctx.caption('Right-click a tab, then Record this tab');
    await ctx.sleep(600);
    await mp.rightClick(row, 700);
    const item = panel.locator(`${T('context-menu-item')}[data-action="record-tab"]`);
    await item.waitFor({ timeout: 5000 });
    await ctx.sleep(1300);
    await mp.click(item, 600);
    await ctx.caption('A red dot marks the tab being recorded');
    await row.locator(T('recording-dot')).waitFor({ timeout: 6000 });
    await mp.to(150, 440, 500);
    await ctx.sleep(1800);
    // native part: the real editor window, replayed from the captured frames
    await ctx.caption('When you stop, the recording opens in an editor');
    ctx.native.start();
    await stage.hide('panel'); await stage.hide('main');
    await stage.page.evaluate(() => { document.getElementById('browser-decor').style.display = 'none'; });
    await stage.show('editor');
    await ctx.sleep(3000);
    await ctx.caption('Trim it, then save, copy or upload');
    await ctx.sleep(4600);
  },
};
