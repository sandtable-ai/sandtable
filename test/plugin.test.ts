import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { InvariantSpec, PersonaSpec, TableSpec, TaskSpec, ToolSpec } from "../src/spec/schema.ts";

// The Claude Code plugin's skills teach coding agents exact commands and spec snippets.
// These tests keep them true as the CLI and the spec change.

const root = path.resolve(".");
const pluginDir = path.join(root, "plugin");
const read = (file: string) => readFileSync(file, "utf8");
const json = (file: string) => JSON.parse(read(file)) as Record<string, unknown>;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const docs = walk(pluginDir).filter((f) => f.endsWith(".md"));
const rel = (file: string) => path.relative(root, file);
// Pages outside the plugin that teach its install and its skills.
const guide = path.join(root, "docs", "guides", "claude-code-plugin.mdx");
const readme = path.join(root, "README.md");

/** Skill names in the first column of the tables under `heading`, e.g. "| `drafting-a-domain` | ... |". */
function skillTable(file: string, heading: string): string[] {
  const text = read(file);
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`${rel(file)} has no "${heading}" section`);
  const end = text.indexOf("\n## ", start + heading.length + 2);
  const section = text.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^\| `([a-z][\w-]*)` \|/gm)].map((m) => m[1]!);
}

function frontmatter(file: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(file));
  if (!m) throw new Error(`${rel(file)} has no frontmatter`);
  return { meta: YAML.parse(m[1]!) as Record<string, unknown>, body: m[2]! };
}

function fences(text: string): { lang: string; code: string }[] {
  // Docs pages indent fences inside <Steps> and <Tabs>; the closing fence has the same indent.
  return [...text.matchAll(/^([ \t]*)```(\w*)\n([\s\S]*?)^\1```/gm)].map((m) => ({ lang: m[2]!, code: m[3]! }));
}

const schemas = { tools: ToolSpec, invariants: InvariantSpec, tasks: TaskSpec, personas: PersonaSpec } as const;

/** Problems with one YAML snippet: a domain fragment (a mapping of top-level keys) or a list of tools, invariants or tasks. */
function snippetProblems(value: unknown): string[] {
  const check = (schema: { safeParse(v: unknown): { success: boolean; error?: { message: string } } }, item: unknown, where: string) => {
    const r = schema.safeParse(item);
    return r.success ? [] : [`${where}: ${r.error?.message}`];
  };
  const listItem = (item: unknown, i: number): string[] => {
    const o = (item ?? {}) as Record<string, unknown>;
    if ("ops" in o) return check(ToolSpec, item, `[${i}] tool`);
    if ("user" in o || "expect" in o) return check(TaskSpec, item, `[${i}] task`);
    if ("id" in o) return check(InvariantSpec, item, `[${i}] invariant`);
    return [`[${i}]: not a tool, task or invariant`];
  };
  if (Array.isArray(value)) return value.flatMap(listItem);
  if (!value || typeof value !== "object") return ["not a mapping or a list"];
  const problems: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") continue; // e.g. tasks: ./tasks.yaml
    if (key in schemas && Array.isArray(v)) {
      v.forEach((item, i) => problems.push(...check(schemas[key as keyof typeof schemas], item, `${key}[${i}]`)));
    } else if (key === "world") {
      const tables = (v as { tables?: Record<string, unknown> }).tables ?? {};
      for (const [name, t] of Object.entries(tables)) problems.push(...check(TableSpec, t, `world.tables.${name}`));
    } else if (!["name", "description", "policy", "max_turns"].includes(key)) {
      problems.push(`${key}: not a domain key`);
    }
  }
  return problems;
}

describe("Claude Code plugin", () => {
  it("is listed in the repository's marketplace, versioned with the CLI", () => {
    const market = json(path.join(root, ".claude-plugin", "marketplace.json"));
    const manifest = json(path.join(pluginDir, ".claude-plugin", "plugin.json"));
    expect(market.name).toBe("sandtable");
    expect(market.plugins).toEqual([expect.objectContaining({ name: "sandtable", source: "./plugin" })]);
    expect(manifest.name).toBe("sandtable");
    expect(manifest.version).toBe(json(path.join(root, "package.json")).version);
  });

  it("is not shipped in the npm package", () => {
    const pkgFiles = json(path.join(root, "package.json")).files as string[];
    expect(pkgFiles.filter((f) => /^\.?\/?(plugin|\.claude-plugin)\b/.test(f))).toEqual([]);
  });

  it("gives every skill a name matching its folder, a description that says when to use it, and a short body", () => {
    const skills = readdirSync(path.join(pluginDir, "skills"));
    expect(skills.sort()).toEqual(["drafting-a-domain", "running-and-reading-results", "writing-good-tasks"]);
    for (const skill of skills) {
      const file = path.join(pluginDir, "skills", skill, "SKILL.md");
      const { meta } = frontmatter(file);
      expect(Object.keys(meta).sort(), rel(file)).toEqual(["description", "name"]);
      expect(meta.name, rel(file)).toBe(skill);
      expect(String(meta.description).length, rel(file)).toBeLessThanOrEqual(1024);
      expect(String(meta.description), rel(file)).toMatch(/\bUse when\b/);
      expect(read(file).split("\n").length, rel(file)).toBeLessThan(250);
    }
    for (const file of walk(path.join(pluginDir, "agents"))) {
      const { meta } = frontmatter(file);
      expect(meta.name, rel(file)).toBe(path.basename(file, ".md"));
      expect(String(meta.description), rel(file)).toMatch(/\bUse after\b|\bUse when\b/);
    }
  });

  it("is described skill by skill in the README and the docs guide", () => {
    const skills = readdirSync(path.join(pluginDir, "skills")).sort();
    expect(skillTable(readme, "## Use it from your coding agent").sort(), "README skill table").toEqual(skills);
    expect(skillTable(guide, "## What's inside").sort(), rel(guide)).toEqual(skills);
    for (const file of walk(path.join(pluginDir, "agents"))) {
      const agent = path.basename(file, ".md");
      expect(read(readme), `README names ${agent}`).toContain(`\`${agent}\``);
      expect(read(guide), `${rel(guide)} names ${agent}`).toContain(`\`${agent}\``);
    }
  });

  it("links only to files that exist", () => {
    for (const file of docs) {
      const text = read(file);
      const targets = [
        ...[...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!).filter((t) => !/^https?:/.test(t)).map((t) => path.resolve(path.dirname(file), t)),
        ...[...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`]+)/g)].map((m) => path.join(pluginDir, m[1]!)),
      ];
      for (const target of targets) expect(existsSync(target), `${rel(file)} -> ${path.relative(root, target)}`).toBe(true);
    }
  });

  it("shows YAML snippets that the domain schema accepts", () => {
    let count = 0;
    for (const file of docs) {
      for (const { lang, code } of fences(read(file))) {
        if (lang !== "yaml") continue;
        count++;
        expect(snippetProblems(YAML.parse(code)), `${rel(file)}:\n${code}`).toEqual([]);
      }
    }
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it("quotes bundled freight tasks exactly where it says it does", () => {
    const tasks = YAML.parse(read(path.join(root, "examples", "freight", "tasks.yaml"))) as { id: string }[];
    let count = 0;
    for (const file of docs) {
      for (const m of read(file).matchAll(/^```yaml\n([\s\S]*?)^```\n\nThis is from the bundled, fictional freight domain/gm)) {
        const [snippet] = YAML.parse(m[1]!) as { id: string }[];
        expect(snippet, `${rel(file)}: ${snippet?.id}`).toEqual(tasks.find((t) => t.id === snippet?.id));
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it.skipIf(!process.features.typescript)("uses only commands and flags the CLI has", { timeout: 30_000 }, async () => {
    const run = promisify(execFile);
    const help = async (...args: string[]) => (await run(process.execPath, [path.join(root, "src", "cli.ts"), ...args, "--help"])).stdout;
    const commands = [...(await help()).split("Commands:")[1]!.matchAll(/^ {2}(\w+)/gm)].map((m) => m[1]!).filter((c) => c !== "help");
    const flags = Object.fromEntries(
      await Promise.all(
        commands.map(async (c) => {
          const options = (await help(c)).split("Options:")[1] ?? "";
          return [c, new Set([...options.matchAll(/(?<![\w-])(--?[a-zA-Z][\w-]*)/g)].map((m) => m[1]!))] as const;
        }),
      ),
    );
    let count = 0;
    for (const file of [...docs, guide]) {
      const text = read(file);
      const code = [...fences(text).map((f) => f.code), ...[...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)];
      for (const snippet of code) {
        for (const m of snippet.matchAll(/(?:npx sandtable-ai|node src\/cli\.ts) +([a-z][\w-]*)([^\n;&|`]*)/g)) {
          count++;
          const [, command, rest] = m as unknown as [string, string, string];
          expect(commands, `${rel(file)}: ${m[0]}`).toContain(command);
          for (const f of rest.matchAll(/(?<![\w-])(--?[a-zA-Z][\w-]*)/g)) {
            expect(flags[command]?.has(f[1]!), `${rel(file)}: ${f[1]} in ${m[0].trim()}`).toBe(true);
          }
        }
      }
    }
    expect(count).toBeGreaterThan(20);
  });
});
