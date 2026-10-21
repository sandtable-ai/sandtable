# Assets

The logo, and the images for the README, the repository's social preview and the docs site's social card. This folder is not part of the npm package.

| File | What it shows | Source | Regenerate |
|---|---|---|---|
| `demo.gif` | `sandtable demo`: the naive agent's task table and pass^1 10.0%, its top failure modes, then the careful agent at 100% on the same 50 calls. 1600×960, about 13.5 s, about 1.5 MB | `demo.tape` | `npm run build && vhs assets/demo.tape` |
| `report.png`, `report-dark.png` | The HTML report of the offline naive run, on the `expired-insurance` trial: the failed checks, the record changes, and the `book_load` call that violates `verify-before-book` and `eligible-carrier`, up to the agent's "Booked L-1001" reply. 2× for high-DPI screens, 800 px wide at 1× | the report itself (`src/report/html.ts`) | `node assets/render.mjs report` |
| `og.png` | The GitHub social preview, 1280×640: one row of squares per agent, one square per call | `og.html` | `node assets/render.mjs og` |
| `../docs/images/og.png` | The same card laid out at 1200×630, the size the docs site declares in its `og:image` tags | `og.html` | (rendered with `og.png`) |
| `trial.png`, `trial-dark.png` | How one trial runs and is graded: caller, agent, mock tools, the invariant check on every tool call, and what the grade reads. 2×, 832 px wide at 1×, transparent background | `trial.html` | `node assets/render.mjs trial` |
| `brand/mark.svg`, `brand/mark-dark.svg` | The logo's mark: a 3×3 grid of squares, one of them terracotta, for one failed trial among passes. 48×48, transparent | the SVG itself | (none) |
| `brand/lockup.svg`, `brand/lockup-dark.svg` | The mark with the name, which is outlined from Fira Sans SemiBold so it needs no font. 123×32. Copied to `../docs/logo/light.svg` and `dark.svg` for the docs site | the SVG itself | (none) |
| `brand/favicon.svg` | The mark redrawn on a 16 px grid so its edges stay sharp at 16 and 32 px; it follows the browser's light or dark theme. Copied to `../docs/favicon.svg` | the SVG itself | (none) |
| `brand/avatar.png` | The GitHub organization avatar, 512×512: the mark on the light background | `brand/avatar.svg` | `node assets/render.mjs brand` |

`node assets/render.mjs all` renders every PNG. It drives headless Chrome over the DevTools protocol with no npm dependency, and needs Node 22.18+ and Chrome or Chromium (set `CHROME` to its path if it isn't found). `og.html` and `trial.html` load Fira Sans and Fira Code from Google Fonts, so they need the network. The GIF needs [vhs](https://github.com/charmbracelet/vhs) and the Menlo font, which ships with macOS; elsewhere, change `Set FontFamily` in `demo.tape` to a monospace font that has ✓ and ✗.

Every number in these images comes from an offline run of `examples/freight`, with rule-based agents and scripted callers and no model calls. `og.html` lists where each number comes from. If the example changes, regenerate everything and check the numbers in `og.html` and the `Down` counts in `demo.tape`.

The sample reports linked from the README are rebuilt from main by `.github/workflows/pages.yml` and published to GitHub Pages.

## In the README

Light and dark variants go in a `<picture>`; the `<img>` fallback is the light one, which is also what npm and PyPI show.

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/trial-dark.png">
  <img src="assets/trial.png" width="832" alt="One sandtable trial: a simulated caller talks to your agent, the agent's tool calls run against stateful mock tables and are checked against the invariants on every call, and the trial is graded on the agent's messages, the violations, the end state and the tool log, with no judge model. pass^k counts a task only if all k trials pass.">
</picture>
```

## Design rules

- One accent: the brand terracotta. It marks failures and the invariant check, nothing else. Passes use the text color.
  - On light backgrounds it's `#B4532A`, and `#9C3F20` for small text.
  - On dark backgrounds, text and lines use `#F0A374`. Solid fills next to the light text color (a failed square, the logo's cell) stay `#B4532A`, so they differ from it in lightness, not only in hue.
- The logo: a 3×3 grid of squares (three tasks, three trials each) with one terracotta cell, the failed trial, in the middle row on the right. Keep the cells square with small corner radii, the other eight in one ink color, and at least one cell's width of space around the mark. Don't recolor, rotate or animate it. Use the files in `brand/`; the name in the lockup is set in Fira Sans SemiBold.
- Warm neutrals: background `#F6F1E8` or `#171512`, text `#1E1A16` or `#E9E3D8`, secondary text `#6B6156` or `#A39886` (all at least 4.5:1).
- Fira Sans for text and Fira Code for code in the PNGs; Menlo in the GIF, which has both ✓ and ✗.
- An 8 px grid. Elements share left edges, right edges and text baselines.
- Sizes are set for where each image is seen. The social card stays readable at 600 px wide (headline 60 px at 1280, nothing under 24 px). The README images are drawn for a column of about 830 px.
- No gradients, glows, shadows, emoji or decorative icons.
