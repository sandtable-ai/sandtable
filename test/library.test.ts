import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as lib from "../src/index.ts";
import { DomainError, parseDomain } from "../src/index.ts";
import YAML from "yaml";

// The library's exports are a contract from 1.0 (docs/reference/library.mdx): adding one is a minor release,
// removing or renaming one a major. This list changes only on purpose, with a changelog entry.
const EXPORTS = [
  "DOMAIN_FILE",
  "DomainError",
  "RegradeError",
  "World",
  "baselineSnapshot",
  "bedrockConverseAgent",
  "claudeAgent",
  "claudeUser",
  "coerceArgs",
  "compareRuns",
  "criticalFailures",
  "executeTool",
  "httpAgent",
  "lintDomain",
  "loadDomain",
  "noopAgent",
  "openaiCompatAgent",
  "openaiCompatUser",
  "parseDomain",
  "passAtK",
  "passHatK",
  "pendingReview",
  "regradeSuite",
  "renderHtml",
  "renderTerminal",
  "runSuite",
  "scriptedUser",
  "toolSchema",
  "trialStatus",
  "validateDomain",
  "wilsonInterval",
];

describe("the library API", () => {
  it("exports exactly the documented values", () => {
    expect(Object.keys(lib).sort()).toEqual(EXPORTS);
  });

  it("documents every export in docs/reference/library.mdx", () => {
    const page = readFileSync("docs/reference/library.mdx", "utf8");
    expect(EXPORTS.filter((name) => !page.includes(`\`${name}`))).toEqual([]);
  });

  it("documents every exported type in docs/reference/library.mdx", () => {
    // Types are erased at runtime, so read them from the export statements, and from sim/types.ts, which is re-exported whole.
    const index = readFileSync("src/index.ts", "utf8");
    const names = new Set<string>();
    for (const [, list] of index.matchAll(/export type \{([^}]*)\}/g)) for (const n of list!.split(",")) names.add(n.trim());
    for (const [, list] of index.matchAll(/export \{([^}]*)\}/g)) for (const n of list!.split(",")) if (n.trim().startsWith("type ")) names.add(n.trim().slice(5).trim());
    expect(index).toContain('export type * from "./sim/types.ts";');
    for (const [, n] of readFileSync("src/sim/types.ts", "utf8").matchAll(/^export (?:interface|type) (\w+)/gm)) names.add(n!);
    names.delete("");
    expect(names.size).toBeGreaterThan(50);
    const page = readFileSync("docs/reference/library.mdx", "utf8");
    expect([...names].filter((name) => !page.includes(`\`${name}\``)).sort()).toEqual([]);
  });
});

describe("parseDomain", () => {
  const freight = () => {
    const raw = YAML.parse(readFileSync("examples/freight/sandtable.yaml", "utf8")) as Record<string, unknown>;
    // sandtable.yaml names its policy and tasks files; a domain built in code holds the values.
    return { ...raw, policy: readFileSync("examples/freight/policy.md", "utf8"), tasks: YAML.parse(readFileSync("examples/freight/tasks.yaml", "utf8")) };
  };

  it("checks a domain built in code as loadDomain checks a file", () => {
    expect(parseDomain(freight()).tasks).toHaveLength(50);
  });

  it("throws a DomainError for a schema error or a cross-reference error", () => {
    expect(() => parseDomain({ ...freight(), nmae: "x" })).toThrow(DomainError);
    expect(() => parseDomain({ ...freight(), nmae: "x" })).toThrow('Unrecognized key: "nmae"');
    // The installed version, as loadDomain says it, but no validate command: a domain built in code has no path.
    expect(() => parseDomain({ ...freight(), nmae: "x" })).toThrow(/doesn't know this key: check its spelling, or whether a later release added it \(CHANGELOG\.md\)\.$/);
    const tasks = freight().tasks as { persona?: string }[];
    tasks[0]!.persona = "nobody-at-all";
    expect(() => parseDomain({ ...freight(), tasks })).toThrow('unknown persona "nobody-at-all"');
  });
});
