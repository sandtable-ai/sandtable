/**
 * The brand shared by the HTML report and the leaderboard page: warm neutrals, ink for passes and one
 * terracotta accent for failures. `--bad` fills shapes, #B4532A in both themes; `--bad-text` colors text,
 * at 4.5:1 or more on every surface. Fira Sans and Fira Code are used when installed; no font is
 * downloaded, so each page stays one self-contained file.
 */
export const BRAND_CSS = `:root{color-scheme:light dark;--bg:#F6F1E8;--fg:#1E1A16;--muted:#6B6156;--card:#FBF8F2;--line:#DDD3C4;--chip:#EEE7DB;--bad:#B4532A;--bad-text:#9C3F20;--ok:var(--fg);
--sans:"Fira Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Fira Code",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#171512;--fg:#E9E3D8;--muted:#A39886;--card:#1F1C18;--line:#3A342D;--chip:#2A2621;--bad-text:#F0A374}}
.head{display:flex;align-items:flex-start;gap:8px}.head svg{flex:none;margin-top:4px}`;

/**
 * The logo, drawn at 24px left of each page's title and taken from here by both pages. Its ink is
 * `currentColor`, so it follows the page's text color in light and dark, and its accent square is the
 * terracotta fill `--bad`.
 */
export const MARK_SVG = `<svg viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><g fill="currentColor"><rect x="2" y="2" width="12" height="12" rx="2"/><rect x="18" y="2" width="12" height="12" rx="2"/><rect x="34" y="2" width="12" height="12" rx="2"/><rect x="2" y="18" width="12" height="12" rx="2"/><rect x="18" y="18" width="12" height="12" rx="2"/><rect x="2" y="34" width="12" height="12" rx="2"/><rect x="18" y="34" width="12" height="12" rx="2"/><rect x="34" y="34" width="12" height="12" rx="2"/></g><rect x="34" y="18" width="12" height="12" rx="2" style="fill:var(--bad)"/></svg>`;
