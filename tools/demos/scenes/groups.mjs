// Tab groups: collapse / expand, drag a tab in.
import { GROUP } from '../fixtures.mjs';

export default {
  name: 'groups',
  output: 'groups.gif',
  width: 480, panelH: 580,   // full panel, top to bottom (nothing cropped)
  async setup(ctx) {
    const ids = await Promise.all(GROUP.sites.map((k) => ctx.tid(k)));
    await ctx.swEval(async ([ids, w, g]) => {
      const id = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: w } });
      await chrome.tabGroups.update(id, { title: g.title, color: g.color });
    }, [ids, ctx.env.mainWin, GROUP]);
    await ctx.activate('encyclopedia');
    await ctx.sleep(1000);
  },
  async run(ctx) {
    const { panel, T } = ctx; const mv = ctx.mouse(panel);
    const grp = () => panel.locator(T('group-row')).first();
    await mv.click(grp(), 600); await ctx.sleep(1100);
    await mv.click(grp(), 400); await ctx.sleep(1000);
    await mv.drag(ctx.row('Recipes'), grp(), { ms: 800 }); await ctx.sleep(1400);
  },
};
