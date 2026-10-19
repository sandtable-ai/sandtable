import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// README.md is also the package page on npmjs.com and ships in the tarball. npmjs.com rewrites
// relative links only partly (never `<source srcset>`), and other renderers not at all, so every
// link and image in it is absolute. Links into this repository must still name files that exist.

const root = process.cwd();
const text = readFileSync(path.join(root, "README.md"), "utf8");
const REPO = "https://github.com/sandtable-ai/sandtable/";

const targets = [
  ...[...text.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]!),
  ...[...text.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim().split(/\s+/)[0]!)),
];

describe("README.md", () => {
  it("uses only absolute links and images", () => {
    expect(targets.length).toBeGreaterThan(20);
    const relative = targets.filter((t) => !/^(https?:\/\/|mailto:|#)/.test(t));
    expect(relative, "use https://github.com/sandtable-ai/sandtable/(blob|tree|raw)/main/<path>").toEqual([]);
  });

  it("links only to files in this repository that exist", () => {
    const local = targets
      .filter((t) => t.startsWith(REPO))
      .map((t) => /^(?:blob|tree|raw)\/main\/([^#?]+)/.exec(t.slice(REPO.length))?.[1])
      .filter((p): p is string => p !== undefined);
    expect(local.length).toBeGreaterThan(15);
    for (const p of local) expect(existsSync(path.join(root, decodeURIComponent(p))), p).toBe(true);
  });
});
