import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { draftFromOpenApi } from "../src/init/openapi.ts";
import { POLICY_PLACEHOLDER, renderDraft, TASKS_PLACEHOLDER } from "../src/init/render.ts";

// npm and PyPI each have an unrelated package named `sandtable`, and npm's ships a `sandtable` bin.
// Without a local sandtable-ai install, `npx sandtable …` fetches and runs that package (in CI,
// without asking), and `uvx sandtable …` does the same from PyPI. Every command shown to users names
// the package, `npx sandtable-ai …`, which runs the local install when there is one.

const root = process.cwd();
const sources = ["README.md", "docs", "plugin", "examples", "src", "python/README.md", "python/src"];
const text = /\.(md|mdx|json|ts|mjs|js|py|ya?ml)$/;
const skip = new Set(["node_modules", ".venv", "dist", ".sandtable", "__pycache__"]);
// A package runner, any of its flags, then `sandtable` not followed by `-ai`. `npx -p sandtable-ai
// sandtable …` stays allowed: `-p` names the package, and `sandtable` is then its bin.
const bare = /\b(?:npx|uvx)(?:\s+--?[\w-]+)*\s+sandtable(?![\w-])/;
// A bare `sandtable <command>` runs only after `pip install sandtable-ai` or a global install: a
// project that pins sandtable-ai doesn't put it on PATH. Backticked names in comments are not commands.
const bareCommand = /(?<![\w./@`-])(?<!npx |-p \S+ )sandtable (?:init|validate|lint|review|run|leaderboard|demo|report|regrade|--help|--version)\b/;

function walk(file: string): string[] {
  if (!statSync(file).isDirectory()) return text.test(file) ? [file] : [];
  return readdirSync(file)
    .filter((name) => !skip.has(name))
    .flatMap((name) => walk(path.join(file, name)));
}

const files = sources.flatMap((s) => walk(path.join(root, s)));

describe("commands shown to users", () => {
  it("run the CLI as `npx sandtable-ai`, never as a bare `npx sandtable`", () => {
    const hits: string[] = [];
    let named = 0;
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        named += line.match(/\bnpx sandtable-ai\b/g)?.length ?? 0;
        if (bare.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(named, "the scan found the files that show commands").toBeGreaterThan(50);
    expect(hits, "write `npx sandtable-ai`: npm's `sandtable` is an unrelated package").toEqual([]);
  });

  it("show the CLI in code blocks as `npx sandtable-ai`, and as `sandtable` only after a pip install", () => {
    const hits: string[] = [];
    for (const file of files.filter((f) => /\.mdx?$/.test(f))) {
      let fenced = false;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*```/.test(line)) fenced = !fenced;
          else if (fenced && bareCommand.test(line) && !line.includes("pip install")) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits, "write `npx sandtable-ai <command>`: installing sandtable-ai in a project doesn't put `sandtable` on PATH").toEqual([]);
  });

  it("in the files `init` drafts, say `npx sandtable-ai <command>` too", () => {
    const spec = YAML.parse(readFileSync(path.join(root, "examples/freight/source/openapi.yaml"), "utf8")) as Record<string, unknown>;
    const drafted = { "sandtable.yaml": renderDraft(draftFromOpenApi(spec), "openapi.yaml"), "policy.md": POLICY_PLACEHOLDER, "tasks.yaml": TASKS_PLACEHOLDER };
    // Here a backticked command is one to run: the files have no code blocks.
    const command = new RegExp(bareCommand.source.replace("`", ""));
    const hits = Object.entries(drafted).flatMap(([file, body]) =>
      body
        .split("\n")
        .filter((line) => bare.test(line) || command.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(hits, "write `npx sandtable-ai <command>` in src/init/render.ts").toEqual([]);
  });
});
