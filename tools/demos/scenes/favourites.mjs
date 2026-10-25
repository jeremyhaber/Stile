// Drag a Today tab onto Favourites, then another into a pinned folder.
import { FAVOURITES, PINNED_FOLDERS } from '../fixtures.mjs';

export default {
  name: 'favourites',
  output: 'favourites.gif',
  width: 480, panelH: 580,   // full panel, top to bottom (nothing cropped)
  async setup(ctx) {
    for (const k of FAVOURITES) await ctx.pin(k, 'favourites');
    for (const [folder, sites] of Object.entries(PINNED_FOLDERS)) {
      const id = await ctx.swEval(async ([p, t]) => (await chrome.bookmarks.create({ parentId: p, title: t })).id, [ctx.env.roots.pinned, folder]);
      for (const k of sites) await ctx.pin(k, 'pinned', { parentId: id });
    }
    await ctx.activate('docs');
    await ctx.sleep(900);
  },
  async run(ctx) {
    const { panel, T } = ctx; const mv = ctx.mouse(panel);
    await mv.drag(ctx.row('Daily News'), panel.locator(T('favourites-grid')), { ms: 800 });
    await ctx.pause();
    await mv.drag(ctx.row('Encyclopedia'), panel.locator(`${T('pinned-folder')}:has-text("Reading")`).first(), { ms: 800 });
    await ctx.sleep(1000);
  },
};
