import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// package.json promises a minimum Node version (README, the quickstart and the Python launcher repeat it).
// A runtime dependency that requires a newer Node makes `npx sandtable-ai` print an EBADENGINE warning on
// the oldest supported version, and fail to install under engine-strict. The lockfile records each
// installed package's `engines`, so this check needs no network and no node_modules.

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { engines: { node: string } };
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string; dev?: boolean; devOptional?: boolean; engines?: { node?: string } | string[] }>;
};

type Version = [number, number, number];

const cmp = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether `v` satisfies an npm `engines.node` range. Throws on syntax it doesn't know, so the test never passes by accident. */
function satisfies(v: Version, range: string): boolean {
  const r = range.trim();
  if (r === "" || r === "*" || r === "x") return true;
  return r.split("||").some((alt) => {
    const comparators = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    return comparators.every((c) => {
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(c);
      if (!m) throw new Error(`can't parse engines range "${range}"`);
      const op = m[1] ?? "";
      const parts = [m[2], m[3], m[4]].map((p) => (p === undefined || p === "x" || p === "*" ? undefined : Number(p)));
      const given = parts.findIndex((p) => p === undefined);
      const exact = given === -1;
      const lo = parts.map((p) => p ?? 0) as Version;
      // Upper bound (exclusive) for ^, ~ and partial versions such as "20" or "20.x".
      const bump = (i: number): Version => (i === 0 ? [lo[0] + 1, 0, 0] : i === 1 ? [lo[0], lo[1] + 1, 0] : [lo[0], lo[1], lo[2] + 1]);
      const firstNonZero = lo[0] !== 0 ? 0 : lo[1] !== 0 ? 1 : 2;
      switch (op) {
        case ">=":
          return cmp(v, lo) >= 0;
        case ">":
          return exact ? cmp(v, lo) > 0 : cmp(v, bump(given - 1)) >= 0;
        case "<":
          return cmp(v, lo) < 0;
        case "<=":
          return exact ? cmp(v, lo) <= 0 : cmp(v, bump(given - 1)) < 0;
        case "^":
          return cmp(v, lo) >= 0 && cmp(v, bump(exact ? firstNonZero : Math.min(firstNonZero, given - 1))) < 0;
        case "~":
          return cmp(v, lo) >= 0 && cmp(v, bump(exact || given > 1 ? 1 : 0)) < 0;
        default:
          return exact ? cmp(v, lo) === 0 : cmp(v, lo) >= 0 && cmp(v, bump(given - 1)) < 0;
      }
    });
  });
}

describe("engines", () => {
  const declared = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(pkg.engines.node);

  it("declares a minimum Node version", () => {
    expect(declared, `package.json engines.node is "${pkg.engines.node}"`).not.toBeNull();
  });

  it("reads ranges the way npm does", () => {
    expect(satisfies([20, 0, 0], ">=20")).toBe(true);
    expect(satisfies([20, 0, 0], ">= 14.6")).toBe(true);
    expect(satisfies([20, 0, 0], ">=22.12.0")).toBe(false);
    expect(satisfies([20, 0, 0], "^20.17.0 || >=22.9.0")).toBe(false);
    expect(satisfies([20, 18, 0], "^20.17.0 || >=22.9.0")).toBe(true);
    expect(satisfies([20, 0, 0], "^18 || ^20")).toBe(true);
    expect(satisfies([20, 0, 0], "18.x || 20.x")).toBe(true);
    expect(satisfies([20, 0, 0], ">=14 <20")).toBe(false);
    expect(satisfies([20, 0, 0], "~20.0.0")).toBe(true);
    expect(() => satisfies([20, 0, 0], "lts")).toThrow(/can't parse/);
  });

  it("every runtime dependency installs on the oldest Node that package.json allows", () => {
    const min = [1, 2, 3].map((i) => Number(declared?.[i] ?? 0)) as Version;
    const runtime = Object.entries(lock.packages).filter(([key, p]) => key.startsWith("node_modules/") && !p.dev && !p.devOptional);
    expect(runtime.map(([key]) => key)).toContain("node_modules/commander");
    for (const [key, p] of runtime) {
      const range = Array.isArray(p.engines) ? undefined : p.engines?.node;
      if (!range) continue;
      expect(satisfies(min, range), `${key.slice("node_modules/".length)}@${p.version} needs node ${range}, but package.json allows ${pkg.engines.node}`).toBe(true);
    }
  });
});
