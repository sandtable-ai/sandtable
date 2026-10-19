# Assets

Images for the README, the repository's social preview and the docs site's social card. This folder is not part of the npm package.

| File | What it shows | Source | Regenerate |
|---|---|---|---|
| `demo.gif` | `sandtable demo`: the naive agent's task table and pass^1 15.6%, its top failure modes, then the careful agent at 100% on the same 32 calls. 1600×960, about 14 s, under 2 MB | `demo.tape` | `npm run build && vhs assets/demo.tape` |
| `report.png`, `report-dark.png` | The HTML report of the offline naive run, on the `expired-insurance` trial: the failed checks, the record changes, and the `book_load` call that violates `verify-before-book` and `eligible-carrier`, up to the agent's "Booked L-1001" reply. 2× for high-DPI screens, 800 px wide at 1× | the report itself (`src/report/html.ts`) | `node assets/render.mjs report` |
| `og.png` | The GitHub social preview, 1280×640: one row of squares per agent, one square per call | `og.html` | `node assets/render.mjs og` |
| `../docs/images/og.png` | The same card laid out at 1200×630, the size the docs site declares in its `og:image` tags | `og.html` | (rendered with `og.png`) |
| `trial.png`, `trial-dark.png` | How one trial runs and is graded: caller, agent, mock tools, the invariant check on every tool call, and what the grade reads. 2×, 832 px wide at 1×, transparent background | `trial.html` | `node assets/render.mjs trial` |

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

- One accent: the brand terracotta, `#B4532A` on light backgrounds (`#9C3F20` for small text) and `#F0A374` on dark ones. It marks failures and the invariant check, nothing else. Passes use the text color.
- Warm neutrals: background `#F6F1E8` or `#171512`, text `#1E1A16` or `#E9E3D8`, secondary text `#6B6156` or `#A39886` (all at least 4.5:1).
- Fira Sans for text and Fira Code for code in the PNGs; Menlo in the GIF, which has both ✓ and ✗.
- An 8 px grid. Elements share left edges, right edges and text baselines.
- Sizes are set for where each image is seen. The social card stays readable at 600 px wide (headline 60 px at 1280, nothing under 24 px). The README images are drawn for a column of about 830 px.
- No gradients, glows, shadows, emoji or decorative icons.
