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

/**
 * The lowest Node version that a `>=` range accepts. Every runtime dependency uses that form today.
 * Any other syntax throws, so a new dependency can't pass by accident.
 */
function lowest(range: string): Version {
  const m = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!m) throw new Error(`engines.node "${range}" is not a plain ">=" range: teach lowest() in test/engines.test.ts to read it`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

const atMost = (a: Version, b: Version) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) <= 0;

describe("engines", () => {
  it("every runtime dependency installs on the oldest Node that package.json allows", () => {
    const min = lowest(pkg.engines.node);
    const runtime = Object.entries(lock.packages).filter(([key, p]) => key.startsWith("node_modules/") && !p.dev && !p.devOptional);
    expect(runtime.map(([key]) => key)).toContain("node_modules/commander");
    for (const [key, p] of runtime) {
      const range = Array.isArray(p.engines) ? undefined : p.engines?.node;
      if (!range) continue;
      expect(atMost(lowest(range), min), `${key.slice("node_modules/".length)}@${p.version} needs node ${range}, but package.json allows ${pkg.engines.node}`).toBe(true);
    }
  });
});
