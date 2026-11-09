import { CONTROL_CHAR } from "./report/printable.ts";

/**
 * A path as one shell word, so a printed command runs as it is when the path has spaces, quotes or `$`, or starts
 * with `-`, which the CLI would read as an option.
 */
export function shellWord(s: string): string {
  const p = s.startsWith("-") ? `./${s}` : s;
  if (CONTROL_CHAR.test(p)) return ansiQuoted(p);
  return /^[\w./@:+=,-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;
}

/**
 * A word with a control character in it, such as a file name from someone else's archive, as `$'…'`: bash and zsh read
 * it back as the same text, and the terminal that shows the command sees each control character as an escape, not as one.
 */
function ansiQuoted(s: string): string {
  // Each UTF-8 byte as \xHH, which bash 3.2 (macOS's) reads too, where \u needs bash 4.2.
  const escape = (c: string) => [...Buffer.from(c, "utf8")].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
  return `$'${[...s].map((c) => (c === "\\" || c === "'" ? `\\${c}` : CONTROL_CHAR.test(c) ? escape(c) : c)).join("")}'`;
}
