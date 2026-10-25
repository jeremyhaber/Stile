# Demo GIFs

Builds the animated GIFs in `docs/demos/` (embedded in the main README). Each scene drives the extension in headless
Chromium with a throwaway profile, a fake host (`tools/fake-app/`) and fake `*.test` sites, draws a cursor and click
pulse, records frames, and encodes them with ffmpeg. Nothing appears on screen.

## Prerequisites

- `ffmpeg` on PATH (or set `FFMPEG=/path/to/ffmpeg`)
- Playwright: `cd tools && npm install`

## Commands

```
node tools/demos/build.mjs                  # rebuild every scene
node tools/demos/build.mjs favourites zap   # rebuild just these
node tools/demos/build.mjs recording        # a native scene: naming it builds it (see below)
node tools/demos/build.mjs --native         # every scene, native ones included (same as DEMO_NATIVE=1)
node tools/demos/build.mjs --list           # list scenes and which a plain run skips; builds nothing
```

Runs from any directory. Prints each output path, size, duration and dimensions.

## Native scenes

A scene with `native: true` needs macOS and a built debug app (`cd mac && swift build`, giving `mac/.build/debug/StileApp`), so a plain
`node tools/demos/build.mjs` **skips** it with a printed note. It runs when you name it (`build.mjs recording`), or with `--native` /
`DEMO_NATIVE=1` for a full run. `scenes/recording.mjs` is the example: a headless part (right-click a tab, "Record this tab", the red dot)
followed by the real recording editor.

How the native part works (`lib/native.mjs`): it renders a synthetic, silent 10 s clip of a fictional page and names it `Recording.mp4` in a
fresh `/tmp/stile-demo-native-*` dir; starts the debug app with `STILE_PREVIEW_RECORDING=<clip>` (opens only the editor: no server, menu
bar item or recent-recordings list, so it does not touch an installed Stile.app); finds that process's window ID; and grabs frames with
`screencapture -l <windowID> -o -x` (that window only, no shadow; never the screen or a region). The app is then stopped by its own PID.
The frames are replayed in real time as a stage layer. It opens a window for about 15 seconds while it runs; do not use the Mac meanwhile
(and silence/close it if it is in your way). The terminal needs the Screen Recording permission; if `screencapture` fails the scene stops
with a message, it never asks for the permission. Keep any other window out of the way: only the editor window is captured, but check the
frames before committing. The editor is autoplaying, so nothing is clicked in it.

## Layout

- `build.mjs` runner: discovers `scenes/*.mjs`, starts the fake sites and host, records and encodes.
- `fixtures.mjs` all fake seed data (sites, favourites, folders, groups, archive, downloads, Zap targets, CSS, capture note).
- `lib/` harness (browser + fake app, cursor, recorder, encoder) and the fake page template.
- `scenes/` one file per demo, holding only that feature's steps.

## Adding a scene

Drop a file in `scenes/`; it is picked up by name. Put any new fake data in `fixtures.mjs`.

```js
// scenes/example.mjs
export default {
  name: 'example',            // what you pass on the command line
  output: 'example.gif',      // written to docs/demos/
  width: 520,                 // GIF width in px
  clip: { x: 0, y: 0, width: 320, height: 520 },  // part of the panel to record (omit for all of it)
  // tabs: ['news', 'docs'], panelW, panelH, fps, hold, lead: optional
  // shooters: (ctx) => [{ page: ctx.panel }, { page: ctx.pages.news }]  // record several pages side by side
  async setup(ctx) { await ctx.pin('weather', 'favourites'); },   // not recorded
  async run(ctx) {                                                // recorded
    const mv = ctx.mouse(ctx.panel);
    await mv.click(ctx.panel.locator(ctx.T('archive-button')), 600);
    await ctx.pause();
  },
};
```

**Captions and stages.** `captions: true` in a scene adds a caption bar under the picture (the canvas grows by 56 px at final size, so
it never covers UI and the GIF size is constant). Call `await ctx.caption('a few plain words')` to switch the text (short crossfade) and
`await ctx.caption(null)` to clear it; the bar stays. Calling it in a scene without `captions: true` throws. Other scenes are unchanged.
Captioned scenes are composited by `lib/stage.mjs`: a second headless page that takes fresh screenshots of the real pages each frame and
lays them out. A scene that wants several windows or a zoom sets `stage: { width, height }` (the area above the caption bar) and calls
`ctx.stage.build({ layers, decor, css })` in `setup`; see `scenes/little.mjs` (real panel and page in a plain browser frame, a mock other app,
little windows in plain frames). Layers are `{ id, page, x, y, w, h, scale, z, frame: { title }, hidden }`; then `stage.show(id)`,
`stage.hide(id)`, `stage.ring(id, box)` (highlight ring), `stage.zoom({ x, y, scale })` / `stage.zoom(null)` and `stage.layer(id).page = p`
to swap the page a layer shows. Panel and page pixels always come from real screenshots; the stage adds only frames, ring and caption.

**Clip guard.** Everything a scene clicks, hovers, drags to or types into must be inside the frame the GIF records. `ctx.mouse(page)`
(`click`, `dblclick`, `rightClick`, `hover`, `drag`, `to`, `clickAt`, `down`/`up`, `type`, `press`) checks the target point or the
element's bounding box against the clip of every shooter recording that page (no clip = the whole viewport; both are CSS pixels) and
throws `[demo guard] scene "...": click ... target {...} is outside the recorded clip {...}` if not. Act only through these helpers,
never `page.mouse` / `page.keyboard` directly, so the check cannot be bypassed. For a stage scene the guard asks the stage where the page really appears: the target must map inside the visible frame (after any zoom),
its window must be shown, and nothing else may cover it (`elementFromPoint`); otherwise it throws `... is not visible in the composited
frame: <reason>`. Only one fake cursor is visible at a time: the page being driven owns it. Prefer recording the whole panel (shrink `panelH`
or the fixture tabs) over cropping off controls.

`ctx` gives you `caption()` (captioned scenes), `stage`, `panel`, `pages` (by site key), `browser`, `mouse(page)` (guarded: `to`, `click`, `drag`, `type`, ...), `row(title)`, `pin()`,
`activate()`, `cmd()`, `swEval()`, `U(site, path)`, `T(testid)`, `sleep()`, `pause()` and `onCleanup(fn)`.

## Tuning knobs (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_FPS` | 12 | GIF frame rate |
| `DEMO_WIDTH` | scene's own | force every GIF to this width in px |
| `DEMO_PAUSE` | 900 | default pause in ms (`ctx.pause()` and the lead-in) |
| `DEMO_HOLD` | 1100 | how long the last frame stays, in ms |
| `DEMO_COLORS` | 128 | GIF palette size |
| `DEMO_SCRATCH` | a fresh temp dir | where temporary frames go |
| `DEMO_NATIVE` | off | `1` includes native scenes in a full run |
| `DEMO_KEEP_FRAMES` | off | `1` keeps the frames after encoding |
| `DEMO_OUT` | `docs/demos` | output folder |
| `FFMPEG` | `ffmpeg` | ffmpeg binary |

## Privacy

- Fake data from `fixtures.mjs` only. Keep names generic and fictional (no brands, no real people, emails or paths).
- Never use a real Chrome profile, never touch Stile.app or its folders (`~/Library/Application Support/Stile`,
  `~/Library/Caches/Stile`), and never record the real screen. The capture scene screenshots a fake page.
- Before committing a GIF, grep `tools/demos` and `docs/demos` (and `strings` on each GIF) for your own name, email and home
  folder path; nothing should match.
