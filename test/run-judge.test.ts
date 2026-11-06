import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { DEFAULT_JUDGE_MODEL } from "../src/judge/judge.ts";
import type { JudgedVerdict } from "../src/judge/summary.ts";
import type { SuiteResult } from "../src/run/suite.ts";

// `run --judge` (#506): the run first, then the judge, and the gates alone decide the exit code. Nothing here calls a
// model or needs a key: a stub server on 127.0.0.1 stands in for the API, so the real action, the SDK and the files are
// all exercised.

const example = path.resolve("examples/freight");
const cli = path.resolve("src/cli.ts");
const TASKS = ["book-at-posted-rate", "no-mc-number"];
const scripted = (agent = "careful", tasks = TASKS) => ["--agent", `scripted:${agent}`, "--user", "scripted", "-t", tasks.join(",")];

type Request = { model: string; messages: { content: string }[] };
type Verdict = JudgedVerdict["verdict"];
type Answer = { status: number; body: unknown };

const criteriaIn = (req: Request) => [...req.messages[0]!.content.split("<transcript>")[0]!.matchAll(/^- ([\w-]+):/gm)].map((m) => m[1]!);
const reply = (req: Request, verdict: (id: string) => Verdict = () => "pass"): Answer => ({
  status: 200,
  body: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: req.model,
    content: [{ type: "text", text: JSON.stringify({ verdicts: criteriaIn(req).map((id) => ({ id, verdict: verdict(id), quote: null, reason: "Because." })) }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 500, output_tokens: 50 },
  },
});
const unauthorized: Answer = { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
const tooLong: Answer = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } } };

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A stand-in for the API that answers each call with `answer(request, n)`, n counting from 1. */
async function stub(answer: (req: Request, n: number) => Answer = (req) => reply(req)) {
  const seen: Request[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Request;
      seen.push(body);
      const out = answer(body, seen.length);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const sandtable = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
const through = (base: string, ...args: string[]) => sandtable({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base }, ...args);

/** A copy of the freight example with these criteria in place of its own, and these on its tasks. */
async function fixture(judged: string[] = ["reads-back", "polite"], onTask: Record<string, string[]> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-run-judge-"));
  const domain = path.join(dir, "domain");
  await cp(example, domain, { recursive: true });
  const criteria = (ids: string[]) => ids.map((id) => ({ id, criterion: `The agent does ${id}.` }));
  const spec = path.join(domain, "sandtable.yaml");
  const text = (await readFile(spec, "utf8")).replace(/^judged:\n(?: .*\n|\n)*/m, "");
  await writeFile(spec, judged.length ? `${text}\n${YAML.stringify({ judged: criteria(judged) })}` : text);
  const tasksFile = path.join(domain, "tasks.yaml");
  const tasks = YAML.parse(await readFile(tasksFile, "utf8")) as { id: string; judged?: unknown }[];
  for (const t of tasks) if (onTask[t.id]) t.judged = criteria(onTask[t.id]!);
  await writeFile(tasksFile, YAML.stringify(tasks));
  const out = path.join(dir, "out");
  return { dir, domain, out, results: path.join(out, "results.json"), report: path.join(out, "report.html") };
}

const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as SuiteResult;

/** The run with every field the judge adds taken out. */
function withoutJudged(r: SuiteResult): unknown {
  const { judged: _, tasks, ...rest } = r;
  return { ...rest, tasks: tasks.map(({ judged: __, trials, ...t }) => ({ ...t, trials: trials.map(({ judged: ___, ...tr }) => tr) })) };
}

/** What grading decided, which no two runs may differ in: everything but the ids and timings of the run. */
const graded = (r: SuiteResult) => ({
  inputs: r.inputs,
  passHat: r.passHat,
  failureModes: r.failureModes,
  byTag: r.byTag,
  soft: r.soft,
  coverage: r.coverage,
  pendingReview: r.pendingReview,
  tasks: r.tasks.map((t) => ({ id: t.id, passes: t.passes, verdict: t.verdict, inputs: t.inputs, grading: t.grading, trials: t.trials.map((tr) => ({ passed: tr.passed, checks: tr.checks, violations: tr.violations, changes: tr.changes })) })),
});

describe.skipIf(!process.features.typescript)("run without --judge", () => {
  it("makes no judge call, and says in one line how many criteria weren't judged and the two ways to judge them", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const { seen, base } = await stub();
    const r = await through(base, "run", f.domain, ...scripted(), "-o", f.out);
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toEqual([]);
    expect(r.stdout.split("\n").filter((l) => l.includes("judged"))).toEqual([
      `2 judged criteria weren't judged. To judge them, add --judge to the run, or judge this one: npx sandtable-ai judge ${f.results} -d ${f.domain}`,
    ]);
    expect(r.stdout.indexOf("results:")).toBeLessThan(r.stdout.indexOf("weren't judged"));
    expect(read(f.results).judged).toBeUndefined();
  });

  it("counts only the criteria for the run's tasks, and says nothing when none apply", { timeout: 30_000 }, async () => {
    const f = await fixture([], { "book-at-posted-rate": ["on-booking"], "no-mc-number": ["on-refusal", "on-refusal-too"] });
    const { base } = await stub();
    const one = await through(base, "run", f.domain, ...scripted("careful", ["book-at-posted-rate"]), "-o", f.out);
    expect(one.stdout).toContain("1 judged criterion wasn't judged. To judge it, add --judge");
    const other = await through(base, "run", f.domain, ...scripted("careful", ["expired-insurance"]), "-o", path.join(f.dir, "other"));
    expect(other.code, other.stderr).toBe(0);
    expect(other.stdout).not.toMatch(/judged/i);
  });

  it("says nothing on a domain with no criteria, or a run whose every trial ended in an error", { timeout: 30_000 }, async () => {
    const none = await fixture([]);
    const { seen, base } = await stub();
    const r = await through(base, "run", none.domain, ...scripted(), "-o", none.out);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/judged/i);

    const f = await fixture();
    const crash = path.join(f.dir, "crash.mjs");
    await writeFile(crash, 'export default { name: "crash", createSession: async () => ({ reply: async () => { throw new Error("no credentials"); } }) };\n');
    const crashed = await through(base, "run", f.domain, "--agent", crash, "--user", "scripted", "-t", TASKS.join(","), "-o", f.out);
    expect(crashed.code).toBe(2);
    expect(crashed.stdout).not.toMatch(/judged/i);
    expect(seen).toEqual([]);
  });

  it("refuses --judge-model without --judge, before anything runs", async () => {
    const f = await fixture();
    const r = await sandtable({}, "run", f.domain, ...scripted(), "-o", f.out, "--judge-model", "claude-haiku-5-5");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--judge-model needs --judge");
    expect(existsSync(f.out)).toBe(false);
  });
});

describe.skipIf(!process.features.typescript)("run --judge", () => {
  it("writes the run first, prints the plan, then judges, writing after each trial: the same results, plus the verdicts", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const onDisk: string[] = [];
    const { seen, base } = await stub((req) => {
      onDisk.push(readFileSync(f.results, "utf8"));
      return reply(req);
    });
    const r = await through(base, "run", f.domain, ...scripted(), "-o", f.out, "--judge", "-c", "1");
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.model).toBe(DEFAULT_JUDGE_MODEL);

    // The first call finds the whole run on disk, unjudged; the second, the first trial's verdicts too.
    const before = JSON.parse(onDisk[0]!) as SuiteResult;
    expect(before.judged).toBeUndefined();
    expect(before.tasks.flatMap((t) => t.trials)).toHaveLength(2);
    expect((JSON.parse(onDisk[1]!) as SuiteResult).tasks[0]!.trials[0]!.judged?.verdicts).toHaveLength(2);

    const saved = read(f.results);
    expect(JSON.stringify(withoutJudged(saved))).toBe(JSON.stringify(withoutJudged(before)));
    expect(saved.judged).toMatchObject({ pass: 4, fail: 0, score: 1, notJudged: 0, models: [DEFAULT_JUDGE_MODEL] });
    expect(readFileSync(f.report, "utf8")).toContain('"verdict":"pass"');

    // In order: the summary and the files, the plan, each trial, the score.
    const at = (s: string) => r.stdout.indexOf(s);
    expect(at("pass^1 100.0%")).toBeGreaterThan(-1);
    expect(at("pass^1 100.0%")).toBeLessThan(at("results:"));
    expect(at("results:")).toBeLessThan(at("Plan: 2 model calls, one per trial, to claude-sonnet-5-5 on the Anthropic API;"));
    expect(at("Plan:")).toBeLessThan(at("book-at-posted-rate trial 1: 2 pass"));
    expect(at("book-at-posted-rate trial 1: 2 pass")).toBeLessThan(at("Judged score"));
    expect(r.stdout).toContain("judged 100.0%");
    expect(r.stderr).toBe("");

    // A run without --judge of the same tasks is graded the same.
    const plain = await through(base, "run", f.domain, ...scripted(), "-o", path.join(f.dir, "plain"));
    expect(graded(saved)).toEqual(graded(read(path.join(f.dir, "plain", "results.json"))));
    expect(seen).toHaveLength(2);
    expect(plain.code).toBe(0);
  });

  it("--judge-model picks the model, and --no-html still writes no report", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const { seen, base } = await stub();
    const r = await through(base, "run", f.domain, ...scripted(), "-o", f.out, "--judge", "--judge-model", "claude-haiku-5-5", "--no-html");
    expect(r.code, r.stderr).toBe(0);
    expect(seen.map((s) => s.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5"]);
    expect(r.stdout).toContain("to claude-haiku-5-5 on the Anthropic API");
    expect(read(f.results).judged!.models).toEqual(["claude-haiku-5-5"]);
    expect(existsSync(f.report)).toBe(false);
  });

  it("on a domain with no criteria for the run's tasks, says so in one line and makes no call", { timeout: 30_000 }, async () => {
    const f = await fixture([], { "expired-insurance": ["on-refusal"] });
    const { seen, base } = await stub();
    const r = await through(base, "run", f.domain, ...scripted(), "-o", f.out, "--judge");
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toEqual([]);
    expect(r.stdout).toContain("freight-carrier-sales states no judged criteria for the tasks of this run, so there is nothing to judge.");
    expect(r.stdout).not.toContain("Plan:");
    expect(read(f.results).judged).toBeUndefined();
  });

  it("makes no call for a run whose every trial ended in an error, and exits as that run does", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const crash = path.join(f.dir, "crash.mjs");
    await writeFile(crash, 'export default { name: "crash", createSession: async () => ({ reply: async () => { throw new Error("no credentials"); } }) };\n');
    const { seen, base } = await stub();
    const r = await through(base, "run", f.domain, "--agent", crash, "--user", "scripted", "-t", TASKS.join(","), "-o", f.out, "--judge");
    expect(r.code).toBe(2);
    expect(seen).toEqual([]);
    expect(r.stdout).toContain("No trial to judge, since each one was skipped");
    expect(r.stderr).toContain("Every trial ended in an error");
  });

  it("leaves the exit code to the gates, whatever the judge says", { timeout: 60_000 }, async () => {
    const f = await fixture();
    const { base: failing } = await stub((req) => reply(req, () => "fail"));
    const low = await through(failing, "run", f.domain, ...scripted(), "-o", f.out, "--judge", "--fail-under", "100");
    expect(low.code, low.stderr).toBe(0);
    expect(low.stdout).toContain("judged 0.0%");
    expect(read(f.results).passHat["1"]).toBe(1);

    const { base: passing } = await stub();
    const gate = await through(passing, "run", f.domain, ...scripted("naive"), "-o", path.join(f.dir, "naive"), "--judge", "--fail-under", "100");
    expect(gate.code).toBe(1);
    expect(gate.stdout).toContain("judged 100.0%");
    expect(gate.stderr).toContain("is below --fail-under");
  });

  it("when the judge stops, says so loudly with the command that retries, and keeps the run and the gates' exit code", { timeout: 60_000 }, async () => {
    const f = await fixture();
    const { seen, base } = await stub(() => unauthorized);
    const r = await through(base, "run", f.domain, ...scripted(), "-o", f.out, "--judge", "--judge-model", "claude-haiku-5-5", "--provider", "anthropic", "-c", "1");
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(r.stderr).toMatch(/✗ The judge stopped: .*invalid x-api-key/);
    expect(r.stderr).toContain("2 trial(s) were not judged");
    expect(r.stderr).toContain(`npx sandtable-ai judge ${f.results} -d ${f.domain} -m claude-haiku-5-5 --provider anthropic`);
    // No verdict came back, so the file is the run as written, and the report is there.
    const saved = read(f.results);
    expect(saved.judged).toBeUndefined();
    expect(saved.tasks.flatMap((t) => t.trials).every((tr) => tr.judged === undefined)).toBe(true);
    expect(existsSync(f.report)).toBe(true);

    const naive = await through(base, "run", f.domain, ...scripted("naive"), "-o", path.join(f.dir, "naive"), "--judge", "--fail-under", "100", "-c", "1");
    expect(naive.code).toBe(1);
    expect(naive.stderr).toContain("The judge stopped");
    expect(naive.stderr).toContain("is below --fail-under");
  });

  it("keeps what was judged when it stops partway, in the report too", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const { base } = await stub((req, n) => (n === 1 ? reply(req) : unauthorized));
    const r = await through(base, "run", f.domain, ...scripted(), "-o", f.out, "--judge", "-c", "1");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("1 trial(s) were not judged");
    expect(r.stdout).toContain("Judged score");
    expect(read(f.results).judged).toMatchObject({ pass: 2, notJudged: 2 });
    expect(readFileSync(f.report, "utf8")).toContain('"verdict":"pass"');
  });

  it("says loudly when one trial's call fails, with the command that sends it again, and exits as the gates say", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const { base } = await stub((req, n) => (n === 2 ? tooLong : reply(req)));
    const r = await through(base, "run", f.domain, ...scripted(), "-o", f.out, "--judge", "-c", "1");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/! no-mc-number trial 1: the judge call failed: .*prompt is too long/);
    expect(r.stderr).toContain("✗ 1 of 2 judge call(s) failed");
    expect(r.stderr).toContain(`npx sandtable-ai judge ${f.results} -d ${f.domain}`);
    expect(read(f.results).tasks[1]!.trials[0]!.judged!.error).toMatch(/prompt is too long/);
  });

  it("with no credentials, runs and saves all the same, and says what to do", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const r = await sandtable({ ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, "run", f.domain, ...scripted(), "-o", f.out, "--judge", "-c", "1");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("✗ The judge stopped");
    expect(r.stderr).toContain(`npx sandtable-ai judge ${f.results} -d ${f.domain}`);
    expect(read(f.results).passHat["1"]).toBe(1);
  });

  it("keeps the exit code when writing the verdicts fails: the run was already on disk", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const { base } = await stub((req) => {
      // Where the run's folder was, a file: the write after this trial can't succeed.
      rmSync(f.out, { recursive: true, force: true });
      writeFileSync(f.out, "");
      return reply(req);
    });
    const r = await through(base, "run", f.domain, ...scripted(), "-o", f.out, "--judge", "-c", "1");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("✗ The judge failed:");
    expect(r.stderr).toContain(`npx sandtable-ai judge ${f.results} -d ${f.domain}`);
  });

  it("with --baseline, shows how the judged score changed once it is known, and a judged drop fails no gate", { timeout: 60_000 }, async () => {
    const f = await fixture();
    const first = await stub();
    const baseline = await through(first.base, "run", f.domain, ...scripted(), "-o", f.out, "--judge");
    expect(baseline.code, baseline.stderr).toBe(0);

    const second = await stub((req) => reply(req, (id) => (id === "polite" ? "fail" : "pass")));
    const out = path.join(f.dir, "second");
    const r = await through(second.base, "run", f.domain, ...scripted(), "-o", out, "--baseline", f.results, "--fail-on-regression", "--judge");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("Judged score since the baseline")).toHaveLength(2);
    expect(r.stdout.indexOf("Plan:")).toBeLessThan(r.stdout.indexOf("Judged score since the baseline"));
    expect(r.stdout).toContain("judged 100.0% → 50.0%  (−50.0 pts)");
    const saved = read(path.join(out, "results.json"));
    expect(saved.baseline!.judged).toMatchObject({ pass: 4, score: 1 });
    expect(readFileSync(path.join(out, "report.html"), "utf8")).toContain("Judged score since the baseline");
  });
});
