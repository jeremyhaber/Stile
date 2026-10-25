// Little windows: a link clicked in another app opens in a small window and waits in the Temporary list; Make full tab keeps it.
// The picture is composited on a stage (lib/stage.mjs) from screenshots of real pages: the real panel and main tab page in
// a plain browser frame, a mock chat app (a local page, not Stile UI), and the real little-window pages in plain frames.
// The real trigger is a click in the other app (Stile.app then sends openLittle); here we click the link and send the same command.
import { LITTLE, LITTLE_APP } from '../fixtures.mjs';
import { appHtml } from '../lib/sites.mjs';

const PANEL = { w: 320, h: 504 }, MAIN = { w: 340, h: 504 };   // viewports, drawn 1:1
const BX = 11, BY = 43;                                         // where the browser window's content starts on the stage
const APP = { w: 256, h: 200, x: 696, y: 44 };
const LW = 320, LH = 240;                                       // little windows are clearly smaller than the main one
const LITTLE_POS = [{ x: 634, y: 296 }, { x: 604, y: 314 }];

export default {
  name: 'little',
  output: 'little.gif',
  captions: true,
  stage: { width: 960, height: 560 },
  width: 960, fps: 9, colors: 128, lead: 150, hold: 1300,
  tabs: ['encyclopedia', 'docs', LITTLE.behind, 'code'],
  panelH: PANEL.h,
  async setup(ctx) {
    const main = ctx.pages[LITTLE.behind];
    await main.setViewportSize({ width: MAIN.w, height: MAIN.h });
    await ctx.activate(LITTLE.behind);
    await main.bringToFront(); await ctx.sleep(800);
    // the "other app": a local page in the stage's own browser (never a tab of the demo browser)
    const app = await ctx.stage.newPage({ width: APP.w, height: APP.h });
    await app.setContent(appHtml(LITTLE_APP));
    ctx.little = { app, main, pages: [null, null] };
    await ctx.stage.build({
      decor: `<div class="win" style="left:10px;top:14px;width:${PANEL.w + MAIN.w + 2}px;height:${PANEL.h + 28 + 2}px;z-index:0"><div class="bar" style="height:28px"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div></div>`,
      layers: [
        { id: 'panel', page: ctx.panel, x: BX, y: BY, w: PANEL.w, h: PANEL.h, z: 2 },
        { id: 'main', page: main, x: BX + PANEL.w, y: BY, w: MAIN.w, h: MAIN.h, z: 2 },
        { id: 'app', page: app, x: APP.x, y: APP.y, w: APP.w, h: APP.h, z: 2, frame: { title: LITTLE_APP.title } },
        ...LITTLE_POS.map((p, i) => ({ id: 'little' + i, page: null, x: p.x, y: p.y, w: LW, h: LH, z: 10 + i, hidden: true, frame: { title: '' } })),
      ],
    });
  },
  async run(ctx) {
    const { panel, T, stage, little } = ctx;
    const mp = ctx.mouse(panel), ma = ctx.mouse(little.app);
    const hostPath = (t) => `${ctx.SITES[t.site].host}/${t.path}`;
    const targets = [LITTLE, LITTLE.second];

    // Link i in the other app is clicked, then the little window opens (the same openLittle Stile.app sends)
    const openFromApp = async (i) => {
      await ma.click(little.app.locator('a').nth(i), 750);
      const t = targets[i];
      const r = await ctx.cmd({ cmd: 'openLittle', url: ctx.U(t.site, t.path), bounds: { left: 100, top: 80, width: LW, height: LH } });
      if (!r?.ok) throw new Error('openLittle failed: ' + JSON.stringify(r));
      const page = await ctx.until(() => ctx.browser.pages().find((p) => p.url().includes(hostPath(t))), 8000);
      await page.setViewportSize({ width: LW, height: LH });
      await ctx.sleep(300);
      little.pages[i] = page;
      stage.layer('little' + i).page = page;
      await stage.show('little' + i, { title: (await page.title()) || t.site });
    };
    const ringTemp = async () => stage.ring('panel', await panel.locator('#sec-temp').boundingBox(), 3);

    await ctx.caption('Links from other apps open in a little window');
    await ctx.sleep(800);
    await openFromApp(0);
    await ctx.sleep(500);

    // it waits in the Temporary list, with its "open" dot
    await ctx.caption('It waits in the Temporary list, not in your tabs');
    await panel.locator(T('temp-row')).first().waitFor({ timeout: 6000 });
    await ctx.sleep(300);
    await ringTemp();
    await ctx.sleep(1800);
    await stage.ring('panel', null);

    // a second link piles up next to it instead of becoming another tab
    await ctx.caption('More links wait there too');
    await openFromApp(1);
    await panel.locator(T('temp-row')).nth(1).waitFor({ timeout: 6000 });
    await ctx.sleep(300);
    await ringTemp();
    await ctx.sleep(1400);
    await stage.ring('panel', null);

    // Make full tab, with the panel zoomed so the small button is easy to see
    await ctx.caption('Make a full tab to keep it');
    const row = panel.locator(`${T('temp-row')}[data-url*="${hostPath(LITTLE)}"]`);
    await row.waitFor({ timeout: 6000 });
    const sec = await panel.locator('#sec-temp').boundingBox();
    const Z = 1.55;
    await stage.zoom({ x: 0, y: Math.max(0, BY + sec.y - 30), scale: Z }, 650);
    await mp.hover(row, 550); await ctx.sleep(450);
    await mp.click(row.locator(T('temp-promote')), 650);
    const tab = await ctx.until(() => ctx.browser.pages().find((p) => !p.isClosed() && p !== little.pages[0] && p !== little.main && p.url().includes(hostPath(LITTLE))), 8000);
    if (tab) { await tab.setViewportSize({ width: MAIN.w, height: MAIN.h }); await ctx.sleep(300); stage.layer('main').page = tab; }
    await ctx.sleep(400);
    await stage.hide('little0');
    await ctx.sleep(700);
    // the page now fills the main window and sits as a normal row in Today
    await stage.zoom(null, 650);
    await mp.to(150, 470, 450);
    await ctx.sleep(300);
  },
};
