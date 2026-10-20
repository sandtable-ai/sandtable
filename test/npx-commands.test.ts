import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { draftFromOpenApi } from "../src/init/openapi.ts";
import { POLICY_PLACEHOLDER, renderDraft, TASKS_PLACEHOLDER } from "../src/init/render.ts";

// npm and PyPI each have an unrelated package named `sandtable`, and npm's ships a `sandtable` bin.
// Without a local sandtable-ai install, `npx sandtable …` fetches and runs that package (in CI,
// without asking), and `uvx sandtable …` does the same from PyPI. Every command shown to users names
// the package, `npx sandtable-ai …`, which runs the local install when there is one. A bare
// `sandtable <command>` runs only after `pip install sandtable-ai` or a global install: a project
// that pins sandtable-ai doesn't put it on PATH.

const root = process.cwd();
const sources = ["README.md", "docs", "plugin", "examples", "src", "python/README.md", "python/src"];
const text = /\.(md|mdx|json|ts|mjs|js|py|ya?ml)$/;
const skip = new Set(["node_modules", ".venv", "dist", ".sandtable", "__pycache__"]);

// A package runner, any of its flags, then `sandtable` not followed by `-ai`. `npx -p sandtable-ai
// sandtable …` stays allowed: `-p` names the package, and `sandtable` is then its bin.
const bare = /\b(?:npx|uvx)(?:\s+--?[\w-]+)*\s+sandtable(?![\w-])/;
const CMD = "(?:init|validate|lint|review|run|leaderboard|demo|report|regrade|--help|--version)(?![\\w-])";
// In code (a shell or YAML line, a source comment): a command starts the line, after any comment
// marker, `$ ` or VAR=value settings, or follows `&&`, `|` or `run:`.
const lineCommand = new RegExp(`(?:^\\s*(?:(?:\\*|//|#)\\s+)?(?:\\$\\s+)?|(?:&&|\\||\\brun:)\\s*)(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*sandtable ${CMD}`);
// In prose, an inline code span is a command when it has arguments (`sandtable validate <dir>`) or
// follows "run". A span with the command alone names it: "`sandtable lint` replays it".
const spanCommand = new RegExp(`(\\brun\\s+)?\`(?:\\$\\s+)?sandtable ${CMD}([^\`]*)\``, "gi");

/** Whether a line writes out a bare `sandtable <command>` for someone to run. */
function runsBareSandtable(line: string, kind: "code" | "prose"): boolean {
  if (line.includes("pip install")) return false;
  if (kind === "code") return lineCommand.test(line);
  return [...line.matchAll(spanCommand)].some((m) => m[1] !== undefined || m[2]!.trim() !== "");
}

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

  it("tell a command from a sentence that names one", () => {
    const commands = {
      code: ["sandtable run ./d --agent noop", "$ sandtable lint d", "- run: sandtable lint d", "npm ci && sandtable lint d", "KEY=x sandtable run d", " *   sandtable run d", "# sandtable demo"],
      prose: ["Run `sandtable validate <dir>` after every edit.", "or draft from one with `sandtable init --sop <file>`.", "then run `sandtable validate`."],
    };
    const names = {
      code: ["# the sandtable run writes results", "name: Run sandtable lint", "sandtable runs every call", "npx sandtable-ai run d", "npx -p sandtable-ai -p x sandtable demo", "pip install sandtable-ai && sandtable demo"],
      prose: ["`sandtable lint` replays it", "Drafted by `sandtable init` from api.yaml.", "use `npx sandtable-ai lint d`", "or `sandtable <command>` after `pip install`"],
    };
    for (const kind of ["code", "prose"] as const) {
      for (const line of commands[kind]) expect(runsBareSandtable(line, kind), line).toBe(true);
      for (const line of names[kind]) expect(runsBareSandtable(line, kind), line).toBe(false);
    }
  });

  it("write out every command as `npx sandtable-ai <command>`, and as `sandtable` only after a pip install", () => {
    const hits: string[] = [];
    for (const file of files) {
      const markdown = /\.mdx?$/.test(file);
      let fenced = false;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (markdown && /^\s*```/.test(line)) fenced = !fenced;
          else if (runsBareSandtable(line, (markdown && !fenced) || file.endsWith(".json") ? "prose" : "code")) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits, "write `npx sandtable-ai <command>`: installing sandtable-ai in a project doesn't put `sandtable` on PATH").toEqual([]);
  });

  it("in the files `init` drafts, say `npx sandtable-ai <command>` too", () => {
    const spec = YAML.parse(readFileSync(path.join(root, "examples/freight/source/openapi.yaml"), "utf8")) as Record<string, unknown>;
    const drafted = { "sandtable.yaml": renderDraft(draftFromOpenApi(spec), "openapi.yaml"), "policy.md": POLICY_PLACEHOLDER, "tasks.yaml": TASKS_PLACEHOLDER };
    const hits = Object.entries(drafted).flatMap(([file, body]) =>
      body
        .split("\n")
        .filter((line) => bare.test(line) || runsBareSandtable(line, "code") || runsBareSandtable(line, "prose"))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(hits, "write `npx sandtable-ai <command>` in src/init/render.ts").toEqual([]);
  });
});
