import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `sandtable leaderboard ... | head` or `less` quit early: the reader goes away while the CLI still has output.
// Like other CLIs, it stops quietly instead of crashing with an EPIPE stack trace.

describe("output piped into a reader that stops early", () => {
  it.skipIf(!process.features.typescript)("ends the CLI quietly with exit 0", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-pipe-"));
    // The board prints its header before any model runs; a slow agent puts the next line well after it.
    const agent = path.join(dir, "agent.mjs");
    writeFileSync(agent, 'export default { name: "slow", async createSession() { await new Promise((r) => setTimeout(r, 300)); return { async reply() { return "Goodbye."; } }; } };\n');
    writeFileSync(path.join(dir, "models.yaml"), `models:\n  - { label: Slow, agent: ${JSON.stringify(agent)} }\n`);
    const args = [path.resolve("src/cli.ts"), "leaderboard", "examples/freight", "-m", path.join(dir, "models.yaml"), "--user", "scripted", "-k", "1", "-t", "book-at-posted-rate", "-o", path.join(dir, "board")];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    // Close the pipe after the header, as `head -1` does.
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stderr).not.toMatch(/EPIPE|\n\s+at /);
    expect(code).toBe(0);
  });
});
