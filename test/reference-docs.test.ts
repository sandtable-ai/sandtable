import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DomainSpec } from "../src/spec/schema.ts";
import { loadDomain } from "../src/spec/load.ts";

// The reference pages document contracts users build on (docs/reference/stability.mdx). These checks fail when
// the code has an item its page doesn't mention, so a new flag, key or field can't ship undocumented.

const root = process.cwd();
const page = (name: string) => readFileSync(path.join(root, "docs", "reference", `${name}.mdx`), "utf8");
const run = promisify(execFile);
const cli = (...args: string[]) => run(process.execPath, [path.join(root, "src", "cli.ts"), ...args]);
const mentions = (text: string, name: string) => new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(text);

describe("docs/reference/cli.mdx", () => {
  // Runs the CLI from src/, which needs a Node that strips types (22.18 and later).
  it.skipIf(!process.features.typescript)("documents every option of every command, in that command's section", async () => {
    const doc = page("cli");
    const commands = [...(await cli("--help")).stdout.split("Commands:")[1]!.matchAll(/^ {2}(\w+)/gm)].map((m) => m[1]!).filter((c) => c !== "help");
    expect(commands.length).toBeGreaterThan(5);
    const missing: string[] = [];
    for (const command of commands) {
      const section = doc.split(new RegExp(`^## ${command}\\b`, "m"))[1]?.split(/^## /m)[0] ?? "";
      expect(section, `cli.mdx has no "## ${command}" section`).not.toBe("");
      const options = (await cli(command, "--help")).stdout.split("Options:")[1] ?? "";
      for (const [flag] of options.matchAll(/--[a-z][a-z-]*/g)) {
        if (flag !== "--help" && !mentions(section, flag)) missing.push(`${command} ${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("documents every environment variable sandtable reads", () => {
    const doc = page("cli");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : f.endsWith(".ts") ? [path.join(dir, f)] : []));
    const read = new Set(walk(path.join(root, "src")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!)));
    expect(read.size).toBeGreaterThan(3);
    expect([...read].filter((v) => !mentions(doc, v))).toEqual([]);
  });
});

describe("docs/reference/spec.mdx", () => {
  it("documents every key of the domain spec", () => {
    const keys = new Set<string>();
    const seen = new Set<unknown>();
    // Walk zod's schema definitions: objects, and everything that wraps or combines them.
    const walk = (schema: unknown): void => {
      if (!schema || seen.has(schema)) return;
      seen.add(schema);
      const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
      if (!def) return;
      if (def.type === "object") {
        for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
          keys.add(key);
          walk(value);
        }
      }
      for (const f of ["innerType", "element", "valueType", "in", "out", "left", "right"]) walk(def[f]);
      for (const option of (def.options as unknown[] | undefined) ?? []) walk(option);
      if (typeof def.getter === "function") walk((def.getter as () => unknown)());
    };
    walk(DomainSpec);
    expect(keys.size).toBeGreaterThan(50);
    const doc = page("spec");
    expect([...keys].filter((k) => !mentions(doc, k))).toEqual([]);
  });
});

describe("docs/reference/results-schema.mdx", () => {
  // Only the fields an offline freight run writes are seen here: per-model `usage`, `emptyAfterStrip`, caller notes
  // and other fields that only live runs or other commands write are checked by reading the page, not by this test.
  it.skipIf(!process.features.typescript)("documents every field an offline run writes to results.json, with a baseline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-reference-"));
    const base = ["run", "examples/freight", "--agent", "scripted:naive", "--user", "scripted", "-k", "2", "--no-html"];
    // The naive agent fails gates, so `run` exits 1; the results are written either way.
    await cli(...base, "-o", path.join(dir, "a")).catch(() => undefined);
    await cli(...base, "-o", path.join(dir, "b"), "--baseline", path.join(dir, "a", "results.json")).catch(() => undefined);
    const results = JSON.parse(readFileSync(path.join(dir, "b", "results.json"), "utf8")) as unknown;

    // The domain's own names (tables, fields, tools, params, tasks, tags) and model names are data, not fields.
    const domain = await loadDomain(path.join(root, "examples", "freight"));
    const data = new Set<string>([
      ...Object.entries(domain.world.tables).flatMap(([name, t]) => [name, ...t.rows.flatMap((r) => Object.keys(r))]),
      ...domain.tools.flatMap((t) => [t.name, ...Object.keys(t.params)]),
      ...domain.tasks.flatMap((t) => [t.id, ...t.tags]),
      ...domain.invariants.map((i) => i.id),
    ]);
    const fields = new Set<string>();
    const walk = (value: unknown, inData: boolean): void => {
      if (Array.isArray(value)) return value.forEach((v) => walk(v, inData));
      if (!value || typeof value !== "object") return;
      for (const [key, v] of Object.entries(value)) {
        // Keys that are numbers (pass^1, pass^2), data names, or model ids hold values, not field names.
        const isData = inData || data.has(key) || /^\d+$/.test(key) || key.includes(":") || key === "agent" && typeof v === "object";
        if (!isData) fields.add(key);
        // Tool arguments and results, and world rows, are the domain's data.
        walk(v, isData || ["args", "result", "before", "after", "values", "row"].includes(key));
      }
    };
    walk(results, false);
    expect(fields.size).toBeGreaterThan(40);
    const doc = page("results-schema");
    expect([...fields].filter((f) => !mentions(doc, f)).sort()).toEqual([]);
  });
});
