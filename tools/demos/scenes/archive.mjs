// Archive view: search, restore a tab.
import { ARCHIVE, ARCHIVE_SEARCH } from '../fixtures.mjs';
import { icon } from '../lib/sites.mjs';

export default {
  name: 'archive',
  output: 'archive.gif',
  width: 480, panelH: 580,   // full panel, top to bottom (nothing cropped)
  tabs: ['encyclopedia', 'docs', 'code', 'weather', 'maps'],
  async setup(ctx) {
    const now = Date.now();
    const items = ARCHIVE.map(([k, title, hoursAgo, sub]) => ({ id: 'a-' + k + hoursAgo, url: ctx.U(k, sub), title, favIconUrl: icon(ctx.SITES[k]), archivedAt: now - hoursAgo * 3600e3 }));
    await ctx.swEval(async (list) => chrome.storage.local.set({ archive: list }), items);
    await ctx.sleep(600);
  },
  async run(ctx) {
    const { panel, T } = ctx; const mv = ctx.mouse(panel);
    await mv.click(panel.locator(T('archive-button')), 700); await ctx.pause();
    await mv.click(panel.locator(T('archive-search')), 500);
    await mv.type(ARCHIVE_SEARCH, { delay: 160 }); await ctx.sleep(1000);
    await mv.click(panel.locator(T('archive-row')).first(), 500); await ctx.sleep(700);
    await mv.click(panel.locator(T('back-button')).first(), 500); await ctx.sleep(1600);
  },
};
