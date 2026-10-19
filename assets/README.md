# Assets

Images for the README and the repository's social preview. This folder is not part of the npm package.

| File | What it shows | How to regenerate |
|---|---|---|
| `demo.gif` | `sandtable demo`: the naive agent's task table and top failure modes, then the careful agent on the same 32 calls | `npm run build && vhs assets/demo.tape` |
| `report.png` | The HTML report of the offline naive run, on the `expired-insurance` trial: the failed checks, the world changes, and the `book_load` call that violates `verify-before-book` and `eligible-carrier` | Run `sandtable demo`, open the naive report, click the `expired-insurance` trial, and screenshot the trial card at 2× |
| `og.png` | The GitHub social preview (1280×640) | Screenshot `og.html` at 1280×640, e.g. `chrome --headless=new --window-size=1280,640 --screenshot=assets/og.png assets/og.html` |
| `../docs/images/og.png` | The same card at 1200×630, the size the docs site declares in its `og:image` tags | Scale `og.png` to 1200×600 and pad it to 1200×630 with the background color, e.g. on macOS `sips -z 600 1200 assets/og.png --out docs/images/og.png && sips -p 630 1200 --padColor 141413 docs/images/og.png` |

Every number in these images comes from the offline demo: rule-based agents and scripted callers, no model calls. If the bundled examples change, regenerate them.

The sample reports linked from the README are rebuilt from main by `.github/workflows/pages.yml` and published to GitHub Pages.
