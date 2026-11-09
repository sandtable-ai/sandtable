import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { calibrate, renderCalibration } from "../src/judge/calibrate.ts";
import type { JudgedSummary } from "../src/judge/summary.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import { renderCompare, renderJudged, renderJudgedChanges, renderTerminal } from "../src/report/terminal.ts";
import { baselineSnapshot, comparisonOf } from "../src/run/compare.ts";
import { renderLeaderboardMarkdown, type LeaderboardRow } from "../src/run/leaderboard.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { shellWord } from "../src/shell.ts";
import { httpAgent } from "../src/sim/http.ts";
import { openaiCompatAgent } from "../src/sim/openai-compat.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";

// What an agent, a simulated caller, a platform or a results file holds reaches the terminal and Markdown as text:
// no escape sequence, bell or C1 control character in it gets through, and sandtable's own colours still do.

const example = path.resolve("examples/freight");
const cli = path.resolve("src/cli.ts");

/**
 * An OSC that sets the window title and ends with a bell, a CSI that clears the screen, a C1 CSI, a colour, a full reset,
 * a cursor save, a switch to line drawing, a C1 OSC ended by a C1 ST, a backspace, a carriage return, DEL and NUL, then
 * a right-to-left override and an isolate around text.
 */
const CONTROLS = "\x1b]0;a title\x07\x1b[2J\x9b31m\x1b[5m\x1bc\x1b7\x1b(0\x9d0;t\x9c\x08\r\x7f\x00\u202eevil\u2066x\u2069";
/** CONTROLS without NUL, which no file name can hold, and without the carriage return, backspace and DEL, so a test can name a file with it. */
const FILE_NAME_CONTROLS = "\x1b]0;a title\x07\x1b[2J\x9b31m\u202eevil\u2066x\u2069";
/** CONTROLS as a one-line value shows it, after a space. */
const SHOWN = "]0;a title [2J 31m [5m c 7 (0 0;t evil x";
/** Every control character but a newline, and the bidi embedding, override and isolate controls. */
const STRAY = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
/** Each control character left in `s` but a newline, with the text around it. */
const strays = (s: string) => [...s.matchAll(STRAY)].map((m) => JSON.stringify(s.slice(Math.max(0, m.index - 30), m.index + 10)));

afterEach(() => vi.unstubAllGlobals());

const domain = () => loadDomain(example);
const careful = async (): Promise<SuiteResult> => runSuite({ domain: await domain(), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });

/** A judged summary of one criterion, as `judge` writes it. */
const judgedSummary = (id: string, model: string): JudgedSummary => ({
  pass: 0,
  fail: 1,
  notApplicable: 0,
  score: 0,
  models: [model],
  notJudged: 0,
  criteria: [{ id, pass: 0, fail: 1, notApplicable: 0, score: 0, pending: true }],
  usage: { [model]: { calls: 1, input: 900, output: 90, cacheRead: 0, cacheWrite: 0 } },
  costUsd: null,
});

describe("terminal output strips control characters from run values", () => {
  it("shows a tool argument in a failure example as text, also where the line is cut to fit", async () => {
    // An OSC whose end a cut at 80 columns would leave out, so the rest of the terminal's output would be its title.
    const mc = `X\x1b]0;${"t".repeat(120)}\x07${CONTROLS}`;
    const agent: AgentAdapter = {
      name: "books",
      createSession: async () => ({
        reply: async (_message, callTool) => {
          await callTool("book_load", { load_id: "L-1001", mc_number: mc, rate: 2100 });
          return "Booked.";
        },
      }),
    };
    const r = await runSuite({ domain: await domain(), agent, user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    const out = renderTerminal(r);
    expect(out).toContain("e.g. book_load referenced carriers X ]0;tttt");
    expect(strays(out)).toEqual([]);
  });

  it("shows an HTTP agent's error body in skipped trials as text", async () => {
    vi.stubGlobal("fetch", async () => new Response(`boom ${CONTROLS}`, { status: 500 }));
    const r = await runSuite({ domain: await domain(), agent: httpAgent("http://agent.local/step"), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    const out = renderTerminal(r);
    expect(out).toContain("Skipped trials");
    expect(out).toContain("http://agent.local/step returned 500: boom ]0;a title [2J");
    expect(strays(out)).toEqual([]);
  });

  it("shows an OpenAI-compatible endpoint's error body in skipped trials as text", async () => {
    vi.stubGlobal("fetch", async () => new Response(`${CONTROLS} bad request`, { status: 400 }));
    const agent = openaiCompatAgent({ baseUrl: "http://llm.local/v1", model: "m" });
    const out = renderTerminal(await runSuite({ domain: await domain(), agent, user: scriptedUser(), taskIds: ["book-at-posted-rate"] }));
    expect(out).toContain("http://llm.local/v1/chat/completions returned 400: ]0;a title [2J");
    expect(strays(out)).toEqual([]);
  });

  it("shows the simulated user's sentence in caller notes as text", async () => {
    const r = await careful();
    r.tasks[0]!.trials[0]!.callerNotes = [{ turn: 1, why: "talks about its instructions", text: `My instructions say ${CONTROLS}book it.` }];
    const out = renderTerminal(r);
    expect(out).toContain(`"My instructions say ${SHOWN} book it."`);
    expect(strays(out)).toEqual([]);
  });

  it("shows a results file's agent, task ids, judge models and criteria as text in compare and the judged score", async () => {
    const now = await careful();
    now.agent = `agent ${CONTROLS}`;
    now.runId = `run ${CONTROLS}`;
    now.tasks[0]!.id = `book ${CONTROLS}`;
    now.tasks[0]!.passes = 0;
    now.tasks[0]!.trials[0]!.judged = { model: `judge ${CONTROLS}`, verdicts: [{ id: `tone ${CONTROLS}`, criterion: `Polite ${CONTROLS}`, verdict: "fail", reason: `Curt ${CONTROLS}`, quote: `No ${CONTROLS}` }] };
    now.judged = judgedSummary(`tone ${CONTROLS}`, `judge ${CONTROLS}`);
    const before = structuredClone(now);
    before.agent = `old ${CONTROLS}`;
    before.user = `caller ${CONTROLS}`;
    before.startedAt = `then ${CONTROLS}`;
    before.tasks[0]!.passes = 1;
    before.tasks[0]!.trials[0]!.judged = { model: `other ${CONTROLS}`, verdicts: [{ id: `tone ${CONTROLS}`, criterion: `Kind ${CONTROLS}`, verdict: "fail", reason: "Curt." }] };
    before.judged = judgedSummary(`tone ${CONTROLS}`, `other ${CONTROLS}`);
    const compared: SuiteResult = { ...now, baseline: baselineSnapshot(before) };

    const outputs = {
      compare: renderCompare(compared, { baseline: "baseline.json", results: "results.json" }),
      terminal: renderTerminal(compared),
      judged: renderJudged(now).join("\n"),
      judgedChanges: renderJudgedChanges(comparisonOf(compared)!).join("\n"),
    };
    expect(outputs.compare).toContain("broken");
    expect(outputs.compare).toContain(`agent old ${SHOWN} → agent ${SHOWN}`);
    expect(outputs.judged).toContain(`by judge ${SHOWN}`);
    expect(outputs.judgedChanges).toContain("text differs");
    for (const [name, out] of Object.entries(outputs)) expect(strays(out), name).toEqual([]);
  });

  it("shows a results file's task, criterion, model, quote and reason as text in a calibration", () => {
    const [task, criterion, model] = [`a ${CONTROLS}`, `tone ${CONTROLS}`, `judge ${CONTROLS}`];
    const run = {
      version: 1,
      domain: "freight",
      agent: "scripted:careful",
      passHat: {},
      tasks: [{ id: task, trials: [{ taskId: task, trial: 0, judged: { model, verdicts: [{ id: criterion, criterion: "Polite.", verdict: "fail", quote: `No ${CONTROLS}`, reason: `Curt ${CONTROLS}` }] } }] }],
      judged: judgedSummary(criterion, model),
    } as unknown as SuiteResult;
    const out = renderCalibration(calibrate(run, [{ task, trial: 1, criterion, label: "pass" }]));
    expect(out).toContain(`Judge judge ${SHOWN}`);
    expect(out).toContain(`quote: "No ${SHOWN}"`);
    expect(strays(out)).toEqual([]);
  });

  it("keeps sandtable's own colours on a terminal, and only those", async () => {
    const tty = process.stdout.isTTY;
    const noColor = process.env.NO_COLOR;
    vi.resetModules();
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;
    try {
      const terminal = await import("../src/report/terminal.ts");
      const r = await careful();
      r.agent = `agent ${CONTROLS}`;
      r.tasks[0]!.passes = 0;
      r.tasks[0]!.trials[0]!.callerNotes = [{ turn: 1, why: "talks about its instructions", text: `My instructions say ${CONTROLS}` }];
      const out = terminal.renderTerminal(r);
      // Red, green, yellow, bold and dim, each reset after.
      expect(out).toContain("\x1b[31m0/1\x1b[0m");
      expect(strays(out.replace(/\x1b\[(?:0|1|2|31|32|33)m/g, ""))).toEqual([]);
    } finally {
      process.stdout.isTTY = tty;
      if (noColor !== undefined) process.env.NO_COLOR = noColor;
      vi.resetModules();
    }
  });
});

describe("Markdown output strips control characters from run values", () => {
  it("report --markdown shows a failure example, the agent, ids and a verdict's reason as text", async () => {
    const r = await careful();
    r.agent = `agent ${CONTROLS}`;
    r.tasks[0]!.passes = 0;
    r.tasks[0]!.trials[0]!.judged = { model: "claude-sonnet-5-5", verdicts: [{ id: "tone", criterion: "Polite.", verdict: "fail", reason: `Curt ${CONTROLS}`, quote: `No ${CONTROLS}` }] };
    r.judged = judgedSummary("tone", "claude-sonnet-5-5");
    r.failureModes = [{ kind: "invariant", id: `rule ${CONTROLS}`, count: 1, tasks: [r.tasks[0]!.id], example: `book_load referenced carriers X${CONTROLS}` }];
    const md = renderMarkdown(r);
    expect(md).toContain("Top failure modes");
    expect(md).toContain("Curt \\]0;a title \\[2J 31m \\[5m c 7 \\(0 0;t evil x");
    expect(strays(md)).toEqual([]);
  });

  it("LEADERBOARD.md shows the domain, a model's label, its failure, rule and task ids and an error as text", () => {
    const row: LeaderboardRow = {
      label: `model ${CONTROLS}`,
      agent: "scripted:careful",
      baseline: false,
      passHat1: 0,
      passHatK: 0,
      tasks: 1,
      trials: 1,
      violations: { [`rule ${CONTROLS}`]: 1 },
      topFailure: `rule ${CONTROLS} (1×)`,
      soft: { [`soft ${CONTROLS}`]: { applied: 1, broken: 1, rate: 1 } },
      critical: { tasks: 1, failed: [`task ${CONTROLS}`] },
      costUsd: null,
      costPerTrialUsd: null,
      agentCostPerTrialUsd: null,
      agentTurnP95Ms: null,
      agentTokens: 0,
    };
    const md = renderLeaderboardMarkdown({
      version: 1,
      domain: `lanes ${CONTROLS}`,
      user: `caller ${CONTROLS}`,
      k: 1,
      generatedAt: `now ${CONTROLS}`,
      sandtable: { version: `1.5.0 ${CONTROLS}` },
      rows: [row, { ...row, label: "crashed", error: `boom ${CONTROLS}` }],
    });
    expect(md).toContain(`# Leaderboard: lanes ${SHOWN}`);
    expect(md).toContain(`boom ${SHOWN}`);
    expect(strays(md)).toEqual([]);
  });
});

describe.skipIf(!process.features.typescript)("CLI lines strip control characters from run values", () => {
  // No key or AWS setting: a model call, if one slipped through, fails instead of costing money.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AWS_") && !["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(k)));
  const sandtable = (cwd: string, ...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args], { env, cwd }).then(
      (r) => ({ code: 0, ...r }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );

  it("prints an agent's error as text: every trial ended in one, a skipped trial's gate, and a leaderboard model that failed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-controls-"));
    const error = JSON.stringify(`no credentials ${CONTROLS}`);
    await writeFile(path.join(dir, "crash.mjs"), `export default { name: "crash", createSession: async () => ({ reply: async () => { throw new Error(${error}); } }) };\n`);
    await writeFile(
      path.join(dir, "some.mjs"),
      `export default { name: "some", createSession: async (ctx) => ({ reply: async () => { if (ctx.sessionId.includes("walk-away")) throw new Error(${error}); return "Sorry, I can't help with that."; } }) };\n`,
    );
    await writeFile(path.join(dir, "models.yaml"), "models:\n  - { label: crash, agent: ./crash.mjs }\n");
    const run = (agent: string, tasks: string) => sandtable(dir, "run", example, "--agent", agent, "--user", "scripted", "-t", tasks, "--no-html", "-o", path.join(dir, `out-${path.basename(agent, ".mjs")}`));
    const all = await run("./crash.mjs", "book-at-posted-rate");
    expect(all.stderr).toContain("Every trial ended in an error");
    expect(all.stderr).toContain(`no credentials ${SHOWN}`);
    const some = await run("./some.mjs", "expired-insurance,walk-away-above-ceiling");
    expect(some.stderr).toContain("ended in an error before the agent broke any rule");
    const board = await sandtable(dir, "leaderboard", example, "-m", "models.yaml", "--user", "scripted", "-k", "1", "-t", "book-at-posted-rate", "-o", path.join(dir, "board"));
    expect(board.stdout).toContain("✗ failed");
    expect(board.stdout).toContain(`no credentials ${SHOWN}`);
    for (const r of [all, some, board]) expect(strays(r.stdout + r.stderr)).toEqual([]);
  });

  it("prints a results file's values as text: compare's summary and regression gate, calibrate's header, and errors that name the run's domain", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-controls-"));
    const now = await careful();
    now.domain = `freight ${CONTROLS}`;
    now.agent = `agent ${CONTROLS}`;
    now.tasks[0]!.trials[0]!.judged = { model: "claude-sonnet-5-5", verdicts: [{ id: "tone", criterion: "Polite.", verdict: "fail", reason: "Curt." }] };
    now.judged = judgedSummary("tone", "claude-sonnet-5-5");
    const failing = { ...now, tasks: [{ ...now.tasks[0]!, id: `book ${CONTROLS}`, passes: 0 }] };
    const passing = { ...failing, tasks: [{ ...failing.tasks[0]!, passes: 1 }] };
    const other = { ...now, domain: `clinic ${CONTROLS}` };
    for (const [file, r] of Object.entries({ "now.json": now, "failing.json": failing, "passing.json": passing, "other.json": other })) await writeFile(path.join(dir, file), JSON.stringify(r));
    await writeFile(path.join(dir, "labels.json"), JSON.stringify({ labels: [{ task: now.tasks[0]!.id, trial: 1, criterion: "tone", label: "pass" }] }));
    const compare = await sandtable(dir, "compare", "passing.json", "failing.json", "--fail-on-regression");
    expect(compare.code).toBe(1);
    expect(compare.stdout).toContain(`sandtable compare · freight ${SHOWN}`);
    expect(compare.stderr).toContain(`broke since the baseline (--fail-on-regression): book ${SHOWN} 1/1 → 0/1`);
    const header = await sandtable(dir, "calibrate", "now.json", "--labels", "labels.json");
    expect(header.stdout).toContain(`sandtable calibrate · freight ${SHOWN} · agent agent ${SHOWN}`);
    const errors = [
      await sandtable(dir, "compare", "now.json", "other.json"),
      await sandtable(dir, "regrade", "now.json", "-d", example, "-o", path.join(dir, "regraded")),
      await sandtable(dir, "judge", "now.json", "-d", example, "--dry-run"),
    ];
    expect(errors[0]!.stderr).toContain("now.json and other.json are runs of different domains, freight ");
    expect(errors[1]!.stderr).toContain("can't regrade now.json: it is a run of freight ");
    expect(errors[2]!.stderr).toContain("can't judge now.json: it is a run of freight ");
    for (const r of errors) expect(r.code).toBe(2);
    for (const r of [compare, header, ...errors]) expect(strays(r.stdout + r.stderr)).toEqual([]);
  });

  it("review prints a drafted item's quote as text, keeping its lines", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-controls-"));
    const copy = path.join(dir, "freight");
    await cp(example, copy, { recursive: true });
    const file = path.join(copy, "sandtable.yaml");
    const yaml = (await readFile(file, "utf8"))
      .replace('    source: { file: policy.md, quote: "Ask for', '    review: pending\n    source: { file: policy.md, quote: "\\e]0;a title\\a\\e[2J\\x9b31m\\ec\\e7\\e(0\\x9d0;t\\x9c\\b\\r\\x7f\\u202eevil\\u2066\\NAsk for')
      .replace('    source: { file: policy.md, quote: "Do **not** book', '    review: pending\n    source: { file: policy.md, quote: "Do **not** book');
    await writeFile(file, yaml);
    const r = await sandtable(dir, "review", copy);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('    " ]0;a title [2J 31m c 7 (0 0;t evil Ask for the carrier');
    expect(r.stdout).toContain('"Do **not** book a carrier if any of these is true:\n  - authority type is not `carrier`');
    expect(strays(r.stdout)).toEqual([]);
  });

  it("validate, lint and review print a drafted domain's name and task ids as text", async () => {
    // `init` copies a model's ids into tasks.yaml, where YAML keeps an escape as `\e`: it loads back as one.
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-controls-"));
    const copy = path.join(dir, "freight");
    await cp(example, copy, { recursive: true });
    const spec = path.join(copy, "sandtable.yaml");
    await writeFile(spec, (await readFile(spec, "utf8")).replace("name: freight-carrier-sales", 'name: "freight\\e]0;a title\\a\\x9b2J\\u202eevil"'));
    const tasks = path.join(copy, "tasks.yaml");
    await writeFile(tasks, (await readFile(tasks, "utf8")).replace("- id: book-at-posted-rate\n", '- id: "book\\e]0;a title\\a\\x9b2Jat-rate"\n  review: pending\n'));
    const validate = await sandtable(dir, "validate", copy);
    expect(validate.code, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("✓ freight ]0;a title 2J evil: ");
    const lint = await sandtable(dir, "lint", copy);
    expect(lint.stdout).toContain("book ]0;a title 2Jat-rate  (write");
    const review = await sandtable(dir, "review", copy);
    expect(review.code, review.stderr).toBe(0);
    expect(review.stdout).toContain("- task book ]0;a title 2Jat-rate");
    for (const r of [validate, lint, review]) expect(strays(r.stdout + r.stderr)).toEqual([]);
  });

  it("init --transcripts prints a transcript's file name as text", async () => {
    // A folder of chats from someone else's archive: its file names are as outside as the chats.
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-controls-"));
    const chats = path.join(dir, "chats");
    await mkdir(chats);
    await cp(example, path.join(dir, "draft"), { recursive: true });
    await writeFile(path.join(chats, `call${FILE_NAME_CONTROLS}.txt`), "Caller: I'd like to book load L-1008 for 2026-03-16.\nAgent: Let me check that load.\n");
    const r = await sandtable(dir, "init", "--transcripts", "chats", "--call-date", "2026-03-14", "-o", "draft", "--dry-run");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("  call ]0;a title [2J 31m evil x .txt: 2026-03-16, stated in the file");
    expect(strays(r.stdout + r.stderr)).toEqual([]);
  });

  it("a printed command quotes a word with control characters so the shell reads it back as it was", async () => {
    const word = `chats/call${FILE_NAME_CONTROLS}'s.txt`;
    const quoted = shellWord(word);
    expect(strays(quoted)).toEqual([]);
    const { stdout } = await promisify(execFile)("bash", ["-c", `printf %s ${quoted}`]);
    expect(stdout).toBe(word);
  });

  it("init --openapi prints a spec's refs as text in its warnings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-controls-"));
    const schema = { $ref: `./missing${CONTROLS}.yaml` };
    const spec = {
      openapi: "3.0.0",
      info: { title: "Controls", version: "1" },
      paths: { "/loads": { post: { operationId: "book_load", requestBody: { content: { "application/json": { schema } } }, responses: { "200": { description: "ok" } } } } },
    };
    await writeFile(path.join(dir, "api.json"), JSON.stringify(spec));
    const r = await sandtable(dir, "init", "--openapi", "api.json", "-o", "draft");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toContain("missing ]0;a title [2J 31m");
    expect(strays(r.stdout + r.stderr)).toEqual([]);
  });
});
