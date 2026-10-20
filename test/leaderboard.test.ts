import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { bedrockRegion, bedrockUse, ModelsFile, pricesFile, runLeaderboard } from "../src/run/leaderboard.ts";
import { costOf, priceKey, registerPrices } from "../src/run/usage.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import YAML from "yaml";

const example = path.resolve("examples/freight");
const agents: Record<string, () => AgentAdapter> = {
  "scripted:careful": () => freightScriptedAgent("careful"),
  "scripted:naive": () => freightScriptedAgent("naive"),
};

describe("leaderboard", () => {
  it("ranks agents by pass^k, adds the do-nothing baseline, and writes json, markdown and html", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const lb = await runLeaderboard({
      domain,
      entries: [
        { label: "Naive rules", agent: "scripted:naive" },
        { label: "Careful rules", agent: "scripted:careful" },
        { label: "Broken", agent: "nope" },
      ],
      user: scriptedUser(),
      k: 2,
      outDir: dir,
      resolveAgent: async (spec) => {
        const make = agents[spec];
        if (!make) throw new Error(`unknown agent ${spec}`);
        return make();
      },
    });

    expect(lb.rows.map((r) => r.label)).toEqual(["Careful rules", "Do-nothing baseline", "Naive rules", "Broken"]);
    const careful = lb.rows[0]!;
    expect(careful).toMatchObject({ passHat1: 1, passHatK: 1, trials: domain.tasks.length * 2, costUsd: null });
    const naive = lb.rows.find((r) => r.label === "Naive rules")!;
    expect(naive.violations["verify-before-book"]).toBeGreaterThan(0);
    expect(lb.rows.find((r) => r.baseline)!.passHatK).toBeCloseTo(16 / 50);
    expect(lb.rows.at(-1)!.error).toMatch(/unknown agent nope/);

    const md = await readFile(path.join(dir, "LEADERBOARD.md"), "utf8");
    expect(md).toContain("| 1 | Careful rules | 100.0% | 100.0% |");
    expect(md).toContain("_Do-nothing baseline_");
    expect(await readFile(path.join(dir, "leaderboard.html"), "utf8")).toContain('href="./careful-rules/report.html"');
    expect(await readFile(path.join(dir, "careful-rules", "results.json"), "utf8")).toContain('"agent": "scripted:careful"');
  });

  it("resumes from existing results instead of rerunning a model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const base = { domain, user: scriptedUser(), k: 1, outDir: dir, entries: [{ label: "Careful rules", agent: "scripted:careful" }] };
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful") });
    const seen: string[] = [];
    const again = await runLeaderboard({
      ...base,
      resolveAgent: async () => {
        throw new Error("should not rerun");
      },
      onEntry: (label, status) => seen.push(`${label}:${status}`),
    });
    expect(seen).toEqual(["Careful rules:cached"]);
    expect(again.rows[0]!.passHat1).toBe(1);
  });

  it("reruns a model whose stored results are for another k, caller or task set, or have crashed trials", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const entries = [{ label: "Careful rules", agent: "scripted:careful" }];
    const careful = async () => freightScriptedAgent("careful");
    const run = async (opts: { k: number; taskIds?: string[] }) => {
      const seen: string[] = [];
      const lb = await runLeaderboard({ domain, entries, user: scriptedUser(), outDir: dir, resolveAgent: careful, onEntry: (_l, status, note) => seen.push(`${status}${note ? `: ${note}` : ""}`), ...opts });
      return { lb, seen };
    };
    await run({ k: 1 });
    expect((await run({ k: 2 })).seen).toEqual(["ran: stored results not reused: they are for k=1, not k=2"]);
    const subset = await run({ k: 2, taskIds: ["book-at-posted-rate", "no-mc-number"] });
    expect(subset.seen).toEqual(["ran: stored results not reused: they cover different tasks"]);
    expect(subset.lb.rows.map((r) => r.tasks)).toEqual([2, 2]);
    expect((await run({ k: 2, taskIds: ["no-mc-number", "book-at-posted-rate"] })).seen).toEqual(["cached"]);

    const file = path.join(dir, "careful-rules", "results.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.tasks[0].trials[0].endReason = "error";
    await writeFile(file, JSON.stringify(stored));
    expect((await run({ k: 2, taskIds: ["book-at-posted-rate", "no-mc-number"] })).seen).toEqual(["ran: stored results not reused: 1 trial(s) crashed"]);
  });

  it("reruns a model whose agent spec, or what the agent and the caller are given, changed under the same label", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const taskIds = ["book-at-posted-rate", "no-mc-number"];
    const run = async (agent: string, d = domain) => {
      const seen: string[] = [];
      const lb = await runLeaderboard({
        domain: d,
        entries: [{ label: "Candidate", agent }],
        user: scriptedUser(),
        k: 1,
        taskIds,
        outDir: dir,
        resolveAgent: async (spec) => agents[spec]!(),
        onEntry: (_l, status, note) => seen.push(`${status}${note ? `: ${note}` : ""}`),
      });
      return { row: lb.rows.find((r) => r.label === "Candidate")!, seen };
    };
    expect((await run("scripted:careful")).row.passHat1).toBe(1);
    expect((await run("scripted:careful")).seen).toEqual(["cached"]);

    const swapped = await run("scripted:naive");
    expect(swapped.seen).toEqual(["ran: stored results not reused: they are for agent scripted:careful, not scripted:naive"]);
    expect(swapped.row.passHat1).toBeLessThan(1);
    expect(JSON.parse(await readFile(path.join(dir, "candidate", "run.json"), "utf8"))).toMatchObject({ agent: "scripted:naive" });

    const edited = { ...domain, policy: `${domain.policy}\n\nA new rule.` };
    expect((await run("scripted:naive", edited)).seen).toEqual([
      "ran: stored results not reused: the agent or the caller would be given something else now: the policy, a tool's schema, or a task's caller prompt, opening, script or turn limit changed since it ran",
    ]);
    expect((await run("scripted:naive", edited)).seen).toEqual(["cached"]);
  });

  it("grades stored results again under the current rules instead of reusing their verdicts, without calling a model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const taskIds = ["book-at-posted-rate", "no-mc-number"];
    const run = async (d: typeof domain, resolveAgent = async () => freightScriptedAgent("careful")) => {
      const seen: string[] = [];
      const lb = await runLeaderboard({ domain: d, entries: [{ label: "Careful rules", agent: "scripted:careful" }], user: scriptedUser(), k: 1, taskIds, outDir: dir, resolveAgent, onEntry: (_l, status, note) => seen.push(`${status}${note ? `: ${note}` : ""}`) });
      return { row: lb.rows.find((r) => r.label === "Careful rules")!, seen };
    };
    const noModel = async (): Promise<never> => {
      throw new Error("should not call the agent");
    };
    expect((await run(domain)).row.passHat1).toBe(1);

    // A grading rule added after the run applies to the stored conversations.
    const stricter = { ...domain, invariants: [...domain.invariants, { id: "no-l1001", description: "Never book L-1001.", never: { tool: "book_load", when: { load_id: "L-1001" } } }] };
    const regraded = await run(stricter, noModel);
    expect(regraded.seen).toEqual(["regraded: 1 verdict(s) changed under the current rules"]);
    expect(regraded.row).toMatchObject({ passHat1: 0.5, violations: { "no-l1001": 1 } });
    const onDisk = JSON.parse(await readFile(path.join(dir, "careful-rules", "results.json"), "utf8"));
    expect(onDisk.failureModes[0]).toMatchObject({ id: "no-l1001", tasks: ["book-at-posted-rate"] });
    expect(await readFile(path.join(dir, "careful-rules", "report.html"), "utf8")).toContain("no-l1001");

    expect((await run(stricter, noModel)).seen).toEqual(["cached"]);
    const restored = await run(domain, noModel);
    expect(restored.seen).toEqual(["regraded: 1 verdict(s) changed under the current rules"]);
    expect(restored.row.passHat1).toBe(1);
  });

  it("reruns stored results that record no inputs fingerprint, since they can't be graded again", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const base = { domain, user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir, entries: [{ label: "Careful rules", agent: "scripted:careful" }] };
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful") });
    const file = path.join(dir, "careful-rules", "results.json");
    const { inputs: _, ...older } = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify(older));
    const seen: string[] = [];
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful"), onEntry: (_l, status, note) => seen.push(`${status}: ${note}`) });
    expect(seen).toEqual([expect.stringMatching(/^ran: stored results not reused: it was written by an older sandtable and records no inputs fingerprint/)]);
    expect(JSON.parse(await readFile(file, "utf8")).inputs).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reruns results stored without run.json, since nothing says which agent they ran", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const base = { domain, user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir, entries: [{ label: "Careful rules", agent: "scripted:careful" }] };
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful") });
    await rm(path.join(dir, "careful-rules", "run.json"));
    const seen: string[] = [];
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful"), onEntry: (_l, status, note) => seen.push(`${status}: ${note}`) });
    expect(seen).toEqual(["ran: stored results not reused: they have no run.json, so their agent spec can't be checked"]);
    expect(JSON.parse(await readFile(path.join(dir, "careful-rules", "run.json"), "utf8"))).toMatchObject({ agent: "scripted:careful" });
  });

  it("skips a noop entry, since the do-nothing baseline is always there, and shows one pass column at k=1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const seen: string[] = [];
    const lb = await runLeaderboard({
      domain,
      entries: [{ label: "Careful rules", agent: "scripted:careful" }, { label: "Do nothing", agent: "noop" }],
      user: scriptedUser(),
      k: 1,
      outDir: dir,
      resolveAgent: async () => freightScriptedAgent("careful"),
      onEntry: (label, status) => seen.push(`${label}:${status}`),
    });
    expect(seen).toEqual(["Careful rules:ran", "Do nothing:skipped"]);
    expect(lb.rows.map((r) => r.label)).toEqual(["Careful rules", "Do-nothing baseline"]);
    const md = await readFile(path.join(dir, "LEADERBOARD.md"), "utf8");
    expect(md).toContain("on every task once");
    expect(md).toContain("| # | Model | pass^1 | Rule violations |");
    expect(md).toContain("| 1 | Careful rules | 100.0% | 0 |");
    expect(await readFile(path.join(dir, "leaderboard.html"), "utf8")).toContain("<th>Model</th><th>pass^1</th><th>Rule violations</th>");
  });

  it("shows a model whose trials crashed as an error, not as a 0% score", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const broken: AgentAdapter = { name: "broken", createSession: async () => ({ reply: async () => { throw new Error("Failed to resolve AWS credentials"); } }) };
    const seen: string[] = [];
    const lb = await runLeaderboard({
      domain,
      entries: [{ label: "No credentials", agent: "broken" }],
      user: scriptedUser(),
      k: 1,
      taskIds: ["book-at-posted-rate", "no-mc-number"],
      outDir: dir,
      resolveAgent: async () => broken,
      onEntry: (label, status, note) => seen.push(`${label}:${status}: ${note}`),
    });
    const crashedDir = path.join(dir, "no-credentials", "crashed");
    expect(seen).toEqual([`No credentials:failed: 2 of 2 trial(s) crashed: Failed to resolve AWS credentials; the crashed run is in ${crashedDir}`]);
    // Nothing was stored before, so nothing is in the model's folder but the crashed run: the next run retries it.
    expect(JSON.parse(await readFile(path.join(crashedDir, "results.json"), "utf8")).tasks[0].trials[0].endReason).toBe("error");
    await expect(readFile(path.join(dir, "no-credentials", "results.json"))).rejects.toThrow();
    expect(lb.rows.map((r) => [r.label, r.error ?? ""])).toEqual([
      ["Do-nothing baseline", ""],
      ["No credentials", "2 of 2 trial(s) crashed: Failed to resolve AWS credentials"],
    ]);
    expect(await readFile(path.join(dir, "LEADERBOARD.md"), "utf8")).toContain("|  | No credentials | error |  | 2 of 2 trial(s) crashed: Failed to resolve AWS credentials |  |  |");
  });

  it("keeps a model's stored results when its rerun crashes, and writes the crashed run beside them", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const broken: AgentAdapter = { name: "broken", createSession: async () => ({ reply: async () => { throw new Error("Could not resolve authentication method"); } }) };
    const run = async (agent: AgentAdapter, resume: boolean) => {
      const seen: string[] = [];
      const entries = [{ label: "Careful rules", agent: "scripted:careful" }];
      const lb = await runLeaderboard({ domain, entries, user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir, resume, resolveAgent: async () => agent, onEntry: (_l, status, note) => seen.push(`${status}: ${note}`) });
      return { seen, row: lb.rows.find((r) => r.label === "Careful rules")! };
    };
    await run(freightScriptedAgent("careful"), true);
    const model = path.join(dir, "careful-rules");
    const stored = await Promise.all(["results.json", "run.json", "report.html"].map((f) => readFile(path.join(model, f), "utf8")));
    // --no-resume forces the rerun, as a stale key would; every trial of it crashes.
    const { seen, row } = await run(broken, false);
    expect(seen).toEqual([`failed: 1 of 1 trial(s) crashed: Could not resolve authentication method; the crashed run is in ${path.join(model, "crashed")}, and the stored results are kept`]);
    expect(row.error).toBe("1 of 1 trial(s) crashed: Could not resolve authentication method");
    expect(await Promise.all(["results.json", "run.json", "report.html"].map((f) => readFile(path.join(model, f), "utf8")))).toEqual(stored);
    expect(JSON.parse(await readFile(path.join(model, "crashed", "results.json"), "utf8")).tasks[0].trials[0]).toMatchObject({ endReason: "error" });
    // The stored results are still there to resume from.
    expect((await run(broken, true)).seen).toEqual(["cached: undefined"]);
  });

  it("rejects unknown task ids before running anything", async () => {
    const domain = await loadDomain(example);
    await expect(
      runLeaderboard({ domain, entries: [], user: scriptedUser(), k: 1, outDir: os.tmpdir(), taskIds: ["nope"], resolveAgent: async () => freightScriptedAgent("careful") }),
    ).rejects.toThrow(/unknown task id\(s\): nope/);
  });
});

describe("leaderboard/models.yaml", () => {
  it("parses, names each model once, and prices every model and the caller with the committed price file", async () => {
    const cfg = ModelsFile.parse(YAML.parse(await readFile("leaderboard/models.yaml", "utf8")));
    expect(cfg).toMatchObject({ user: "claude:global.anthropic.claude-sonnet-5-5", k: 4 });
    expect(new Set(cfg.models.map((m) => m.label)).size).toBe(cfg.models.length);
    // Every model at its provider's default effort: high for Sonnet 5.5 and Fable 5.1; Opus and Haiku 5.5 at sandtable's medium.
    const effort = (label: string) => cfg.models.find((m) => m.label === label)!.effort;
    expect([effort("Claude Fable 5.1"), effort("Claude Sonnet 5.5"), effort("Claude Opus 5.5"), effort("Claude Haiku 5.5")]).toEqual(["high", "high", undefined, undefined]);
    registerPrices(JSON.parse(await readFile("prices/bedrock.eu-west-1.json", "utf8")));
    // A claude: agent records usage under the model name Claude reports; a bedrock: agent under its model ID.
    const usageKey = (spec: string) => (spec.startsWith("claude:") ? priceKey(spec.slice("claude:".length)) : spec.slice("bedrock:".length));
    for (const spec of [cfg.user!, ...cfg.models.map((m) => m.agent)]) {
      expect(costOf({ [usageKey(spec)]: { calls: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }), spec).not.toBeNull();
    }
  });
});

describe("leaderboard provenance", () => {
  it("records what ran each model in run.json, and the sandtable that ranked them in leaderboard.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const runInfo = { sandtable: { version: "9.9.9", commit: "abc1234def", dirty: false }, provider: "bedrock" as const, region: "eu-west-1" };
    await runLeaderboard({ domain, entries: [{ label: "Careful rules", agent: "scripted:careful" }], user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir, runInfo, resolveAgent: async () => freightScriptedAgent("careful") });
    expect(JSON.parse(await readFile(path.join(dir, "careful-rules", "run.json"), "utf8"))).toMatchObject({ agent: "scripted:careful", ...runInfo });
    expect(JSON.parse(await readFile(path.join(dir, "leaderboard.json"), "utf8")).sandtable).toEqual(runInfo.sandtable);
    expect(await readFile(path.join(dir, "LEADERBOARD.md"), "utf8")).toContain("with [sandtable](https://github.com/sandtable-ai/sandtable) 9.9.9 (commit abc1234).");
    expect(await readFile(path.join(dir, "leaderboard.html"), "utf8")).toContain("sandtable</a> 9.9.9 (commit abc1234).");
  });

  it("records the prices file the costs use in leaderboard.json, by path and sha256, and nothing without one", async () => {
    const file = "prices/bedrock.eu-west-1.json";
    const bytes = await readFile(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const prices = pricesFile(file, bytes);
    expect(prices).toEqual({ file, sha256 });
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    // An absolute path is recorded relative to the working directory, or as the file's name outside it: never a home path.
    expect(pricesFile(path.resolve(file), bytes)).toEqual({ file, sha256 });
    expect(pricesFile("/home/dana/private/my-prices.json", bytes, "/srv/board")).toEqual({ file: "my-prices.json", sha256 });
    expect(pricesFile("../elsewhere/p.json", bytes, "/srv/board")).toEqual({ file: "p.json", sha256 });
    const domain = await loadDomain(example);
    const board = async (extra: object) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
      await runLeaderboard({ domain, entries: [{ label: "Careful rules", agent: "scripted:careful" }], user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir, resolveAgent: async () => freightScriptedAgent("careful"), ...extra });
      return JSON.parse(await readFile(path.join(dir, "leaderboard.json"), "utf8"));
    };
    expect((await board({ prices })).prices).toEqual(prices);
    expect(await board({})).not.toHaveProperty("prices");
  });

  it("prices a reused row with the prices the board records, not the ones it was stored with", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    // An agent that spends a million input tokens of a made-up model per turn, priced below.
    const spender: AgentAdapter = {
      name: "spender",
      async createSession(ctx) {
        return { async reply() { ctx.recordUsage?.("lb-test-model", { input: 1_000_000 }); return "Bye."; } };
      },
    };
    const price = (input: number) => registerPrices({ "lb-test-model": { input, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const run = async (resolveAgent: () => Promise<AgentAdapter>) =>
      (await runLeaderboard({ domain, entries: [{ label: "Spender", agent: "scripted:spender" }], user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir, resolveAgent })).rows.find((r) => r.label === "Spender")!;
    price(1);
    const first = await run(async () => spender);
    price(3);
    const reused = await run(async () => { throw new Error("should not call the agent"); });
    expect(reused.error).toBeUndefined();
    expect(reused.costUsd).toBeCloseTo(first.costUsd! * 3);
    expect(reused.costPerTrialUsd).toBeCloseTo(first.costPerTrialUsd! * 3);
    expect(reused.agentCostPerTrialUsd).toBeCloseTo(first.agentCostPerTrialUsd! * 3);
  });

  it("knows which specs run Claude and which calls go to Bedrock", () => {
    expect(bedrockUse(["claude:global.anthropic.claude-sonnet-5-5", "bedrock:global.openai.gpt-6-luna"], "bedrock")).toEqual({ claude: true, bedrock: true });
    expect(bedrockUse(["claude", "scripted:careful"], "anthropic")).toEqual({ claude: true, bedrock: false });
    expect(bedrockUse(["scripted", "bedrock:qwen.qwen3-next-80b-a3b"], "anthropic")).toEqual({ claude: false, bedrock: true });
    expect(bedrockUse(["scripted", "scripted:careful", "noop"], "bedrock")).toEqual({ claude: false, bedrock: false });
  });

  it("takes the Bedrock region from --region, then AWS_REGION, then the AWS profile's config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-aws-"));
    const config = path.join(dir, "config");
    await writeFile(config, "[profile board]\nregion = eu-north-1\n");
    const saved = { ...process.env };
    try {
      for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"]) delete process.env[k];
      process.env.AWS_CONFIG_FILE = config;
      process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, "none");
      expect(await bedrockRegion(undefined, "board")).toBe("eu-north-1");
      expect(await bedrockRegion(undefined, undefined)).toBeUndefined();
      process.env.AWS_REGION = "us-west-2";
      expect(await bedrockRegion(undefined, "board")).toBe("us-west-2");
      expect(await bedrockRegion("eu-west-1", "board")).toBe("eu-west-1");
    } finally {
      process.env = saved;
    }
  });

  it.skipIf(!process.features.typescript)("sandtable leaderboard records the commit of the sandtable clone it runs from, and its --prices file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const models = path.join(dir, "models.yaml");
    await writeFile(models, "models:\n  - { label: Careful rules, agent: scripted:careful }\n");
    const run = (...args: string[]) => promisify(execFile)(args[0]!, args.slice(1), { cwd: dir });
    // An absolute --prices path inside the working directory is recorded relative to it.
    const prices = path.join(dir, "prices", "board.json");
    await mkdir(path.dirname(prices));
    await writeFile(prices, await readFile("prices/bedrock.eu-west-1.json"));
    await run(process.execPath, path.resolve("src/cli.ts"), "leaderboard", example, "-m", models, "-u", "scripted", "-k", "1", "-t", "no-mc-number", "-o", dir, "--provider", "bedrock", "--region", "eu-west-1", "--prices", prices);
    const head = (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim();
    const info = JSON.parse(await readFile(path.join(dir, "careful-rules", "run.json"), "utf8"));
    expect(info).toMatchObject({ sandtable: { commit: head } });
    expect(typeof info.sandtable.dirty).toBe("boolean");
    // Nothing here ran Claude or called Bedrock, so neither the provider nor a region is recorded.
    expect(info).not.toHaveProperty("provider");
    expect(info).not.toHaveProperty("region");
    const sha256 = createHash("sha256").update(await readFile(prices)).digest("hex");
    expect(JSON.parse(await readFile(path.join(dir, "leaderboard.json"), "utf8")).prices).toEqual({ file: "prices/board.json", sha256 });
  });
});

describe("leaderboard effort", () => {
  const careful = async () => freightScriptedAgent("careful");
  const base = async (dir: string) => ({ domain: await loadDomain(example), user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir });

  it("passes a claude: entry's effort to its agent and records the effective effort in run.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const asked: Record<string, string | undefined> = {};
    const entries = [
      { label: "Sonnet", agent: "claude:claude-sonnet-5-5", effort: "high" as const },
      { label: "Opus", agent: "claude:claude-opus-5-5" },
      { label: "Luna", agent: "bedrock:global.openai.gpt-6-luna" },
    ];
    await runLeaderboard({ ...(await base(dir)), entries, resolveAgent: async (spec, effort) => ((asked[spec] = effort), careful()) });
    expect(asked).toEqual({ "claude:claude-sonnet-5-5": "high", "claude:claude-opus-5-5": undefined, "bedrock:global.openai.gpt-6-luna": undefined });
    const runJson = async (slug: string) => JSON.parse(await readFile(path.join(dir, slug, "run.json"), "utf8"));
    expect(await runJson("sonnet")).toMatchObject({ agent: "claude:claude-sonnet-5-5", effort: "high" });
    expect(await runJson("opus")).toMatchObject({ agent: "claude:claude-opus-5-5", effort: "medium" });
    expect(await runJson("luna")).not.toHaveProperty("effort");
  });

  it("shows the effort each Claude model ran at next to its name, also when its results are reused", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const entries = [
      { label: "Sonnet", agent: "claude:claude-sonnet-5-5", effort: "high" as const },
      { label: "Opus", agent: "claude:claude-opus-5-5" },
      { label: "Luna", agent: "bedrock:global.openai.gpt-6-luna" },
    ];
    const opts = { ...(await base(dir)), entries, resolveAgent: careful };
    await runLeaderboard(opts);
    const lb = await runLeaderboard({ ...opts, resolveAgent: async (): Promise<never> => { throw new Error("should not call the agent"); } });
    expect(lb.rows.filter((r) => r.error)).toEqual([]);
    const effort = (label: string) => lb.rows.find((r) => r.label === label)!.effort;
    expect([effort("Sonnet"), effort("Opus"), effort("Luna"), effort("Do-nothing baseline")]).toEqual(["high", "medium", undefined, undefined]);
    const md = await readFile(path.join(dir, "LEADERBOARD.md"), "utf8");
    expect(md).toContain("| Sonnet (effort high) |");
    expect(md).toContain("| Opus (effort medium) |");
    expect(md).toContain("| Luna |");
    const html = await readFile(path.join(dir, "leaderboard.html"), "utf8");
    expect(html).toContain('<a href="./sonnet/report.html">Sonnet</a> <span class="effort">effort high</span>');
    expect(html).toContain('<a href="./luna/report.html">Luna</a></td>');
    expect(JSON.parse(await readFile(path.join(dir, "leaderboard.json"), "utf8")).rows.find((r: { label: string }) => r.label === "Sonnet")).toMatchObject({ effort: "high" });
  });

  it("reuses a claude agent's results stored without an effort as medium, and reruns them at another effort", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const opts = await base(dir);
    await runLeaderboard({ ...opts, entries: [{ label: "Sonnet", agent: "claude:claude-sonnet-5-5" }], resolveAgent: careful });
    // A run.json written before effort was recorded, as by the paid run at 6ad55be.
    const keyFile = path.join(dir, "sonnet", "run.json");
    const { effort: _, ...older } = JSON.parse(await readFile(keyFile, "utf8"));
    await writeFile(keyFile, JSON.stringify(older));
    const run = async (entry: { label: string; agent: string; effort?: "high" }, resolveAgent = careful) => {
      const seen: string[] = [];
      await runLeaderboard({ ...opts, entries: [entry], resolveAgent, onEntry: (_l, status, note) => seen.push(`${status}${note ? `: ${note}` : ""}`) });
      return seen;
    };
    const noModel = async (): Promise<never> => {
      throw new Error("should not call the agent");
    };
    expect(await run({ label: "Sonnet", agent: "claude:claude-sonnet-5-5" }, noModel)).toEqual(["cached"]);
    expect(await run({ label: "Sonnet", agent: "claude:claude-sonnet-5-5", effort: "high" })).toEqual(["ran: stored results not reused: they ran at effort medium, not high"]);
    expect(JSON.parse(await readFile(keyFile, "utf8"))).toMatchObject({ effort: "high" });
    expect(await run({ label: "Sonnet", agent: "claude:claude-sonnet-5-5", effort: "high" }, noModel)).toEqual(["cached"]);
    expect(await run({ label: "Sonnet", agent: "claude:claude-sonnet-5-5" })).toEqual(["ran: stored results not reused: they ran at effort high, not medium"]);
  });

  it("rejects an effort on any agent but claude:, in the models file and in the library", async () => {
    const parsed = ModelsFile.safeParse({ models: [{ label: "Luna", agent: "bedrock:global.openai.gpt-6-luna", effort: "high" }] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ["models", 0, "effort"], message: "effort applies only to claude: agents, not bedrock:global.openai.gpt-6-luna" });
    expect(ModelsFile.safeParse({ models: [{ label: "Sonnet", agent: "claude:claude-sonnet-5-5", effort: "high" }] }).success).toBe(true);
    expect(ModelsFile.safeParse({ models: [{ label: "Sonnet", agent: "claude:claude-sonnet-5-5", effort: "adaptive" }] }).success).toBe(false);
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    await expect(
      runLeaderboard({ ...(await base(dir)), entries: [{ label: "Luna", agent: "bedrock:global.openai.gpt-6-luna", effort: "high" }], resolveAgent: careful }),
    ).rejects.toThrow("Luna: effort applies only to claude: agents, not bedrock:global.openai.gpt-6-luna");
  });
});

