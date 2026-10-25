// Tidy groups tabs by website; Clear archives the list; both undo.
import { TIDY_EXTRA } from '../fixtures.mjs';

export default {
  name: 'tidy',
  output: 'tidy.gif',
  width: 480, panelH: 660,   // full panel, top to bottom (nothing cropped)
  tabs: ['encyclopedia', 'docs', 'code', 'weather', 'recipes'],
  async setup(ctx) {
    for (const [k, sub] of TIDY_EXTRA) { const p = await ctx.browser.newPage(); await p.goto(ctx.U(k, sub)); }
    await ctx.activate('weather');
    await ctx.sleep(1200);
  },
  async run(ctx) {
    const { panel, T } = ctx; const mv = ctx.mouse(panel);
    await mv.click(panel.locator(T('tidy-button')), 600); await ctx.sleep(1600);
    await mv.click(panel.locator(T('toast-undo')), 600); await ctx.sleep(1300);
    await mv.click(panel.locator(T('clear-button')), 600); await ctx.sleep(1600);
    await mv.click(panel.locator(T('toast-undo')), 600); await ctx.sleep(1500);
  },
};
