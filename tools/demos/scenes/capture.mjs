// Screenshot editor: capture a synthetic page (never the real screen), annotate it.
import { CAPTURE } from '../fixtures.mjs';

export default {
  name: 'capture',
  output: 'capture.gif',
  width: 820,
  tabs: ['weather', 'encyclopedia'],
  panelH: 640,
  async setup(ctx) {
    const { env } = ctx; const page = ctx.pages[CAPTURE.site];
    await page.setViewportSize({ width: 760, height: 560 });
    await ctx.activate(CAPTURE.site);
    await page.bringToFront(); await ctx.sleep(700);
    // With the app connected the editor opens in an app window; here the same page is opened as a tab.
    await ctx.cmd({ cmd: 'captureStart', mode: 'visible', windowId: env.mainWin });
    const cap = await ctx.until(async () => (await ctx.cmd({ cmd: 'captureList' }))?.captures?.[0], 8000, 200);
    if (!cap) throw new Error('no capture stored');
    const extId = new URL(env.sw.url()).host;
    const ed = await ctx.browser.newPage();
    await ed.goto(`chrome-extension://${extId}/capture/capture.html?id=${cap.id}`);
    await ed.setViewportSize({ width: 860, height: 600 });
    await ed.waitForSelector('[data-testid=annotate-stage]'); await ctx.sleep(900);
    await ed.locator('[data-testid=capture-zoom-in]').click(); await ctx.sleep(300);   // 150%: larger and readable, still fits the window
    ctx.editor = ed;
  },
  shooters: (ctx) => [{ page: ctx.editor }],
  async run(ctx) {
    const ed = ctx.editor; const mv = ctx.mouse(ed);
    const bb = await ed.locator('[data-testid=annotate-stage]').locator('svg').first().boundingBox();
    const at = (fx, fy) => [bb.x + bb.width * fx, bb.y + bb.height * fy];
    const tool = (n) => ed.locator(`[data-testid=annotate-tool-${n}]`);
    const dragDraw = async (name, a, b) => {
      await mv.click(tool(name), 500); await ctx.sleep(200);
      await mv.to(...at(...a), 500); await ctx.sleep(150); await mv.down(); await ctx.sleep(100);
      await mv.to(...at(...b), 650); await ctx.sleep(150); await mv.up(); await ctx.sleep(500);
    };
    await dragDraw('rect', [0.06, 0.42], [0.94, 0.68]);
    await dragDraw('arrow', [0.72, 0.9], [0.64, 0.7]);
    await mv.click(tool('text'), 500); await ctx.sleep(200);
    await mv.clickAt(...at(0.2, 0.88), 500); await ctx.sleep(300);
    await mv.type(CAPTURE.note, { delay: 90 }); await ctx.sleep(500);
    await mv.click(ed.getByRole('button', { name: /Done/ }), 500); await ctx.sleep(700);
    // click an empty spot on the picture (select tool is active) to deselect the text box: the GIF ends on the clean annotated image
    await mv.clickAt(...at(0.85, 0.2), 600); await ctx.sleep(900);
  },
};
