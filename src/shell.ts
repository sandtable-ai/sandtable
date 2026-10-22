/**
 * A path as one shell word, so a printed command runs as it is when the path has spaces, quotes or `$`, or starts
 * with `-`, which the CLI would read as an option.
 */
export function shellWord(s: string): string {
  const p = s.startsWith("-") ? `./${s}` : s;
  return /^[\w./@:+=,-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;
}
