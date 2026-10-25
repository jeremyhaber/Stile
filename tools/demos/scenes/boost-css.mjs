// Boosts: custom CSS for a site.
import { BOOST_CSS } from '../fixtures.mjs';

export default {
  name: 'boost-css',
  output: 'boost-css.gif',
  width: 880, height: 640,
  tabs: ['recipes', 'encyclopedia'],
  panelH: 640,
  async setup(ctx) {
    await ctx.pages.recipes.setViewportSize({ width: 560, height: 640 });
    await ctx.activate('recipes');
    await ctx.pages.recipes.bringToFront(); await ctx.sleep(800);
  },
  shooters: (ctx) => [{ page: ctx.panel }, { page: ctx.pages.recipes }],
  async run(ctx) {
    const { panel, T } = ctx; const mp = ctx.mouse(panel);
    await mp.click(panel.locator(T('boost-button')), 600); await ctx.sleep(800);
    await mp.click(panel.locator(T('code-button')), 600); await ctx.sleep(700);
    const tab = panel.locator(T('code-tab-css')); if (await tab.count()) await mp.click(tab, 400);
    await mp.click(panel.locator(T('code-editor')), 500);
    await mp.type(BOOST_CSS, { delay: 16 }); await ctx.sleep(500);
    await mp.click(panel.locator(T('code-save')), 500); await ctx.sleep(1000);
  },
};
