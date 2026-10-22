import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { draftPlan, planLine } from "../src/init/plan.ts";

// `init --dry-run` prints what the model steps will spend, and the files --openapi would write, then stops: no
// model call, nothing written, and no credentials, client or Bedrock package needed. A real run prints the plan first.

const cli = path.resolve("src/cli.ts");
const discovery = path.resolve("plugin-evals/fixtures/discovery");
const domain = path.resolve("plugin-evals/fixtures/wrenfield");
const sop = path.join(domain, "policy.md");

/** The CLI with nothing but PATH, and HOME an empty folder: no API key, no AWS profile or config. */
async function scrubbed(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(path.join(tmpdir(), "sandtable-home-"));
  const env = { PATH: process.env.PATH ?? "", HOME: home };
  return promisify(execFile)(process.execPath, [cli, ...args], { env, cwd: home }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );
}

describe("the drafting plan", () => {
  it("counts the calls, resolves the model as a run does, and bounds the cost at list prices", () => {
    const p = draftPlan({ domainChars: 4000, sopChars: 8000, transcriptChars: [2000, 2000], claude: { model: "claude-sonnet-5-5", provider: "bedrock", region: "eu-west-1" } });
    expect(p).toMatchObject({ sopCalls: 1, transcriptCalls: 2, model: "claude-sonnet-5-5", resolved: "eu.anthropic.claude-sonnet-5-5", region: "eu-west-1", outputTokens: 3 * 16000 });
    // Input at the cache-write rate and output at the output rate, both with Bedrock's 1.1× geo-profile premium.
    expect(p.costUsd).toBeCloseTo(((p.inputTokens * 2.5 + p.outputTokens * 10) * 1.1) / 1e6, 6);
    expect(planLine(p)).toBe(`Plan: 3 model calls (1 for the SOP, 2 for transcripts) to claude-sonnet-5-5 on Bedrock (eu-west-1, eu.anthropic.claude-sonnet-5-5); at most about $${p.costUsd!.toFixed(2)} at list prices`);
  });

  it("names the default model and provider, plans without a region, and says when it knows no price", () => {
    const saved = { region: process.env.AWS_REGION, def: process.env.AWS_DEFAULT_REGION, provider: process.env.SANDTABLE_PROVIDER };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.SANDTABLE_PROVIDER;
    try {
      expect(planLine(draftPlan({ domainChars: 100, sopChars: 100, transcriptChars: [], claude: {} }))).toMatch(/^Plan: 1 model call \(1 for the SOP\) to claude-opus-5-5 on the Anthropic API; at most about \$\d+\.\d\d at list prices$/);
      expect(planLine(draftPlan({ domainChars: 100, transcriptChars: [100], claude: { provider: "bedrock" } }))).toContain("on Bedrock (region from your AWS config, global.anthropic.claude-opus-5-5)");
      expect(planLine(draftPlan({ domainChars: 100, transcriptChars: [100], claude: { model: "claude-made-up-9" } }))).toContain("cost unknown (no price for claude-made-up-9)");
    } finally {
      for (const [k, v] of [["AWS_REGION", saved.region], ["AWS_DEFAULT_REGION", saved.def], ["SANDTABLE_PROVIDER", saved.provider]] as const) if (v !== undefined) process.env[k] = v;
    }
  });
});

describe.skipIf(!process.features.typescript)("`sandtable init --dry-run`, with no credentials at all", () => {
  it("prints the plan and the files --openapi would write, and writes nothing", async () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "sandtable-dry-")), "domain");
    const r = await scrubbed("init", "--openapi", path.join(discovery, "openapi.yaml"), "--sop", sop, "--transcripts", path.join(discovery, "transcripts"), "-o", out, "-m", "claude-sonnet-5-5", "--provider", "bedrock", "--region", "eu-west-1", "--dry-run");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`would write ${path.join(out, "sandtable.yaml")}`);
    expect(r.stdout).toMatch(/Plan: 5 model calls \(1 for the SOP, 4 for transcripts\) to claude-sonnet-5-5 on Bedrock \(eu-west-1, eu\.anthropic\.claude-sonnet-5-5\); at most about \$\d+\.\d\d at list prices/);
    expect(r.stdout).toContain("no model was called and nothing was written");
    expect(existsSync(out)).toBe(false);
  });

  it("with only --openapi, says what it would write and that it calls no model", async () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "sandtable-dry-")), "domain");
    const r = await scrubbed("init", "--openapi", path.join(discovery, "openapi.yaml"), "-o", out, "--dry-run");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Dry run: only --openapi, which calls no model. Nothing was written.");
    expect(existsSync(out)).toBe(false);
  });

  it("plans against an existing domain, and exits 2 on a missing input or no domain at -o", async () => {
    const ok = await scrubbed("init", "--sop", sop, "-o", domain, "--dry-run");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^Plan: 1 model call \(1 for the SOP\) to claude-opus-5-5 on the Anthropic API/m);
    const missing = await scrubbed("init", "--sop", "nope.md", "-o", domain, "--dry-run");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--sop: no file at nope.md");
    const empty = mkdtempSync(path.join(tmpdir(), "sandtable-dry-"));
    mkdirSync(path.join(empty, "nothing"));
    const noDomain = await scrubbed("init", "--sop", sop, "-o", path.join(empty, "nothing"), "--dry-run");
    expect(noDomain.code).toBe(2);
    expect(noDomain.stderr).toContain("no sandtable.yaml found");
  });
});
