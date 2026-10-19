import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

// What `npm publish` would ship, from `npm pack --dry-run` (offline). The CLI needs dist/, package.json
// and the bundled examples with every file they include; nothing else belongs in the package.
// CI runs the tests before the build, so the dist/ checks run only when dist/ exists:
// `npm run check` runs this file again after `npm run build`.

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  files: string[];
  bin: Record<string, string>;
  main: string;
  types: string;
  exports: Record<string, Record<string, string>>;
};
const built = existsSync(path.join(root, "dist", "cli.js"));

let files: string[] = [];
let unpackedSize = 0;

beforeAll(async () => {
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root });
  const [report] = JSON.parse(stdout) as { files: { path: string }[]; unpackedSize: number }[];
  files = report!.files.map((f) => f.path);
  unpackedSize = report!.unpackedSize;
}, 60_000);

const normalize = (p: string) => p.replace(/^\.\//, "");

describe("npm package", () => {
  it("ships the license, the README and package.json", () => {
    for (const f of ["package.json", "README.md", "LICENSE"]) expect(files).toContain(f);
  });

  it("ships no sources, tests, source maps or repo-only folders", () => {
    const unwanted = files.filter(
      (f) =>
        /^(src|test|notes|docs|scripts|plugin|leaderboard|prices|assets|python|\.github|\.claude|\.claude-plugin|examples\/frameworks)\//.test(f) ||
        f === "examples/custom-agent.ts" ||
        /\.map$|(^|\/)\.DS_Store$|(^|\/)\.env/.test(f),
    );
    expect(unwanted, "dist/ may be stale: `npm run build` rebuilds it from scratch").toEqual([]);
  });

  it("ships each bundled example with every file its sandtable.yaml includes", () => {
    const examples = pkg.files.filter((f) => f.startsWith("examples/"));
    expect(examples).toEqual(expect.arrayContaining(["examples/freight", "examples/clinic"]));
    for (const dir of examples) {
      const domainFile = `${dir}/sandtable.yaml`;
      expect(files).toContain(domainFile);
      // Same rule as loadDomain: a top-level value naming an existing .md/.yaml/.yml file is inlined.
      const raw = YAML.parse(readFileSync(path.join(root, domainFile), "utf8")) as Record<string, unknown>;
      const includes = Object.values(raw).filter((v): v is string => typeof v === "string" && /\.(md|ya?ml)$/i.test(v));
      expect(includes.length, `${domainFile} includes`).toBeGreaterThan(0);
      for (const inc of includes) expect(files, `${domainFile} includes ${inc}`).toContain(path.posix.join(dir, inc));
    }
  });

  it("points bin, main, types and exports into dist/", () => {
    const targets = [...Object.values(pkg.bin), pkg.main, pkg.types, ...Object.values(pkg.exports).flatMap((e) => Object.values(e))].map(normalize);
    expect(targets.length).toBeGreaterThan(3);
    for (const t of targets) expect(t, t).toMatch(/^dist\//);
    expect(pkg.files).toContain("dist");
  });

  it.skipIf(!built)("ships the built CLI and library that package.json points at", () => {
    const targets = [...Object.values(pkg.bin), pkg.main, pkg.types, ...Object.values(pkg.exports).flatMap((e) => Object.values(e))].map(normalize);
    for (const t of new Set(targets)) expect(files, t).toContain(t);
    for (const bin of Object.values(pkg.bin)) {
      expect(readFileSync(path.join(root, bin), "utf8").startsWith("#!/usr/bin/env node\n"), `${bin} shebang`).toBe(true);
    }
  });

  it.skipIf(!built)("stays small", () => {
    expect(unpackedSize).toBeLessThan(1_000_000);
  });
});
