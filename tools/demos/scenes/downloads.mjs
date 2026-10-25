// Downloads popover from the Archive button.
import http from 'http';
import { DOWNLOADS, DOWNLOAD_DIR } from '../fixtures.mjs';

export default {
  name: 'downloads',
  output: 'downloads.gif',
  lead: 300,
  width: 480, panelH: 580,   // full panel, top to bottom (nothing cropped)
  tabs: ['encyclopedia', 'docs', 'code', 'weather', 'maps'],
  async setup(ctx) {
    // A tiny local file server: zero-filled bodies, the "slow" one streams so a progress bar shows.
    const srv = http.createServer((req, res) => {
      const [, kind, enc] = req.url.split('/'); const name = decodeURIComponent(enc || 'file.bin');
      const slow = kind === 'slow'; const size = slow ? DOWNLOADS.slow.size : (DOWNLOADS.done.find((d) => d.name === name)?.size || 2000);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'content-disposition': `attachment; filename="${name}"` });
      if (!slow) { res.end(Buffer.alloc(size)); return; }
      let sent = 0; const t = setInterval(() => { res.write(Buffer.alloc(30000)); sent += 30000; if (sent >= size) { clearInterval(t); res.end(); } }, 220);
      res.on('close', () => clearInterval(t));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    ctx.base = `http://127.0.0.1:${srv.address().port}`;
    ctx.onCleanup(() => srv.close());
    ctx.onCleanup(() => ctx.swEval(async () => { for (const d of await chrome.downloads.search({})) { try { await chrome.downloads.removeFile(d.id); } catch {} try { await chrome.downloads.erase({ id: d.id }); } catch {} } }));
    // Headless Chromium saves under random names in a temp folder: show the fixture names under a user-free folder.
    await ctx.panel.evaluate((dir) => {
      const o = chrome.downloads.search.bind(chrome.downloads);
      chrome.downloads.search = (...a) => Promise.resolve(o(...a)).then((l) => Array.isArray(l) ? l.map((d) => ({ ...d, filename: dir + decodeURIComponent(d.url.split('/').pop()) })) : l);
    }, DOWNLOAD_DIR);
    ctx.start = (kind, name) => ctx.swEval(async (u) => chrome.downloads.download({ url: u, conflictAction: 'uniquify' }), `${ctx.base}/${kind}/${encodeURIComponent(name)}`);
    for (const d of DOWNLOADS.done) { await ctx.start('fast', d.name); await ctx.sleep(300); }
    await ctx.sleep(1200);
  },
  async run(ctx) {
    const { panel, T } = ctx; const mv = ctx.mouse(panel);
    await ctx.start('slow', DOWNLOADS.slow.name); await ctx.sleep(300);
    await mv.to(250, 330, 400);
    await mv.center(panel.locator(T('archive-button')), 700);
    await panel.locator(T('downloads-popover')).waitFor({ timeout: 6000 }).catch(() => {});
    // let the progress bar run to the end (about 4 s in total), then hold briefly on the finished list
    await ctx.until(() => ctx.swEval(async () => (await chrome.downloads.search({ urlRegex: '/slow/' })).every((d) => d.state === 'complete')), 10000, 150);
    await ctx.sleep(500);
  },
};
