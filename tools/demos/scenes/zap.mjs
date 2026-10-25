// Boosts: Zap hides two elements on a site, then Done ends Zap mode from the page's own toolbar.
import { ZAP_TARGETS } from '../fixtures.mjs';

export default {
  name: 'zap',
  output: 'zap.gif',
  width: 880, height: 640,
  tabs: ['news', 'encyclopedia'],
  panelH: 640,
  async setup(ctx) {
    await ctx.pages.news.setViewportSize({ width: 560, height: 640 });
    await ctx.activate('news');
    await ctx.pages.news.bringToFront(); await ctx.sleep(800);
  },
  shooters: (ctx) => [{ page: ctx.panel }, { page: ctx.pages.news }],
  async run(ctx) {
    const { panel, T } = ctx; const page = ctx.pages.news;
    const mp = ctx.mouse(panel), mg = ctx.mouse(page);
    await mp.click(panel.locator(T('boost-button')), 600); await ctx.pause();
    await mp.click(panel.locator(T('zap-button')), 600); await ctx.pause();
    await mg.to(300, 190, 700); await ctx.sleep(700);
    for (const sel of ZAP_TARGETS) { await mg.click(page.locator(sel), 600); await ctx.sleep(1000); }
    // Done sits in the zap toolbar the page draws at the bottom (a closed shadow root, so click by position)
    await mg.clickAt(472, 600, 700); await ctx.sleep(800);
    // Back to the panel. Headless Chromium does not fire the window focus the panel listens for when a user returns to it,
    // so send that one event ourselves; the panel then leaves Zapping mode and lists what is hidden.
    await mp.to(160, 580, 700); await ctx.sleep(200);
    await panel.evaluate(() => window.dispatchEvent(new Event('focus')));
    await ctx.sleep(1800);
  },
};
