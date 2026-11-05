import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { lintDomain } from "../src/grade/lint.ts";
import type { JudgedCriterion } from "../src/index.ts";
import { inputsFingerprint, taskFingerprints } from "../src/run/inputs.ts";
import { regradeSuite } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { serveConversations } from "../src/serve/driven.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { agentSystemPrompt, userSystemPrompt } from "../src/sim/prompts.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { UserSimulator } from "../src/sim/types.ts";
import { resolveDates, resolveTrial } from "../src/spec/clock.ts";
import { DomainError, domainWarnings, loadDomain, parseDomain, pendingReview, validateDomain } from "../src/spec/load.ts";
import { DomainSpec, JudgedCriterionSpec, TaskSpec, type Domain, type Task } from "../src/spec/schema.ts";

// Judged criteria (#504): rules that aren't state, such as tone, stated for an LLM judge to grade as a score apart from
// pass/fail. This is the spec's half of it: a suite can state them and `validate` checks them. Nothing here calls a model.

/** A fictional carrier desk with two tasks: a plain value, with criteria on it, on its tasks by id, and `patch` on top. */
function raw(judged: { domain?: unknown; tasks?: Record<string, unknown> } = {}, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    user: { instructions: `Ask about L-1 (${id}).`, script: ["What's on L-1?"] },
    expect: { called: ["get_load"] },
    ...(judged.tasks?.[id] !== undefined ? { judged: judged.tasks[id] } : {}),
    ...extra,
  });
  return {
    name: "carrier-desk",
    description: "Pinecrest Hauling, a (fictional) carrier desk.",
    policy: "Read the load back before you book it.",
    world: { tables: { loads: { key: "load_id", rows: [{ load_id: "L-1", status: "available" }] } } },
    tools: [{ name: "get_load", description: "Look up a load.", params: { load_id: { type: "string" } }, ops: [{ get: "loads", key: "$load_id" }] }],
    tasks: [task("book"), task("ask")],
    ...(judged.domain !== undefined ? { judged: judged.domain } : {}),
    ...patch,
  };
}

/** What validate says, past the schema: for a domain whose problems are the point. */
const problems = (value: unknown) => validateDomain(DomainSpec.parse(value));
const CLOCK = "2026-11-02T09:00";

describe("the judged key", () => {
  it("states criteria on a domain and on a task, trimmed, with an optional source and review", () => {
    const d = parseDomain(
      raw({
        domain: [{ id: "reads-back", criterion: "  The agent reads the load back before it books.\n" }],
        tasks: { book: [{ id: "names-the-date", criterion: "The agent names the pickup date.", source: { file: "tests/scenario-12.json", quote: "Confirms the pickup date" }, review: "accepted" }] },
      }),
    );
    expect(d.judged).toEqual([{ id: "reads-back", criterion: "The agent reads the load back before it books." }]);
    expect(d.tasks[0]!.judged).toEqual([{ id: "names-the-date", criterion: "The agent names the pickup date.", source: { file: "tests/scenario-12.json", quote: "Confirms the pickup date" }, review: "accepted" }]);
    const typed: JudgedCriterion = { id: "x", criterion: "y" };
    expect(JudgedCriterionSpec.parse(typed)).toEqual(typed);
  });

  it("adds no key when a domain or a task states none, so a parsed domain or a draft gains no `judged: []`", () => {
    const d = parseDomain(raw());
    expect(d).not.toHaveProperty("judged");
    expect(d.tasks[0]).not.toHaveProperty("judged");
    expect(TaskSpec.parse({ id: "drafted", user: { instructions: "Hi." }, expect: {} })).not.toHaveProperty("judged");
    const empty = parseDomain(raw({ domain: [], tasks: { book: [] } }));
    expect(empty.judged).toEqual([]);
    expect(empty.tasks[0]!.judged).toEqual([]);
  });

  it("isn't required of a typed literal, so a library user's code keeps compiling and running", () => {
    const task: Task = { id: "t", tags: [], user: { instructions: "Hi." }, expect: { state: [], called: [], not_called: [], reply_includes: [] } };
    const domain: Domain = { name: "d", policy: "p", world: { tables: {} }, tools: [], invariants: [], personas: [], tasks: [task], max_turns: 20 };
    expect(validateDomain(domain)).toEqual([]);
    expect(pendingReview(domain)).toEqual([]);
    const resolved = resolveDates(domain, task, CLOCK);
    expect(resolved.domain).not.toHaveProperty("judged");
    expect(resolved.task).not.toHaveProperty("judged");
  });

  const MALFORMED: [string, unknown, string][] = [
    ["no id", { criterion: "Reads back." }, "id"],
    ["an empty id", { id: "", criterion: "Reads back." }, "id"],
    ["an id that isn't text", { id: 7, criterion: "Reads back." }, "id"],
    ["no criterion", { id: "x" }, "criterion"],
    ["an empty criterion", { id: "x", criterion: "" }, "criterion"],
    ["a blank criterion", { id: "x", criterion: " \n " }, "criterion"],
    ["a source without a file", { id: "x", criterion: "Reads back.", source: { quote: "Reads back" } }, "source.file"],
    ["an unknown review", { id: "x", criterion: "Reads back.", review: "approved" }, "review"],
  ];

  it.each(MALFORMED)("rejects %s, with its path, on the domain and on a task", (_name, entry, at) => {
    const message = (value: unknown) => {
      try {
        parseDomain(value);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        return (err as Error).message;
      }
      return "accepted";
    };
    expect(message(raw({ domain: [entry] }))).toContain(`→ at judged[0].${at}`);
    expect(message(raw({ tasks: { ask: [entry] } }))).toContain(`→ at tasks[1].judged[0].${at}`);
  });

  it("is strict: rejects an unknown key, and a value that isn't a list", () => {
    expect(() => parseDomain(raw({ domain: [{ id: "x", criterion: "Reads back.", weight: 2 }] }))).toThrow(/"?weight"?[\s\S]*→ at judged\[0\]/);
    expect(() => parseDomain(raw({ domain: "Reads back." }))).toThrow(/→ at judged/);
    expect(() => parseDomain(raw({ tasks: { book: { id: "x", criterion: "Reads back." } } }))).toThrow(/→ at tasks\[0\]\.judged/);
  });

  it("doesn't belong inside expect, which is hashed as how a trial is graded", () => {
    const r = TaskSpec.safeParse({ id: "t", user: { instructions: "Hi." }, expect: { judged: [{ id: "x", criterion: "Reads back." }] } });
    expect(r.success).toBe(false);
  });
});

describe("validate", () => {
  const entry = (id: string) => ({ id, criterion: `Criterion ${id}.` });

  it("accepts ids that differ, and an id a task or a rule also has: only criteria share a namespace", () => {
    const rule = { id: "ask", description: "Never look up a load.", soft: true, never: { tool: "get_load" } };
    expect(problems(raw({ domain: [entry("a"), entry("ask")], tasks: { book: [entry("book"), entry("b")], ask: [entry("c")] } }, { invariants: [rule] }))).toEqual([]);
  });

  it("rejects a duplicate id, naming both places, wherever the two are", () => {
    expect(problems(raw({ domain: [entry("a"), entry("a")] }))).toEqual(['judged[1]: duplicate criterion id "a", also at judged[0]']);
    expect(problems(raw({ domain: [entry("a")], tasks: { ask: [entry("b"), entry("a")] } }))).toEqual(['tasks.ask.judged[1]: duplicate criterion id "a", also at judged[0]']);
    expect(problems(raw({ tasks: { book: [entry("a")], ask: [entry("a")] } }))).toEqual(['tasks.ask.judged[0]: duplicate criterion id "a", also at tasks.book.judged[0]']);
    expect(problems(raw({ tasks: { book: [entry("a"), entry("a")] } }))).toEqual(['tasks.book.judged[1]: duplicate criterion id "a", also at tasks.book.judged[0]']);
  });

  it("names the first place for each later duplicate", () => {
    expect(problems(raw({ domain: [entry("a")], tasks: { book: [entry("a")], ask: [entry("a")] } }))).toEqual([
      'tasks.book.judged[0]: duplicate criterion id "a", also at judged[0]',
      'tasks.ask.judged[0]: duplicate criterion id "a", also at judged[0]',
    ]);
  });

  it("makes parseDomain throw on a duplicate", () => {
    expect(() => parseDomain(raw({ domain: [entry("a"), entry("a")] }))).toThrow(DomainError);
  });

  it("reads the domain's criteria from their own file, and reports a problem in that file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-judged-"));
    const write = (file: string, value: unknown) => writeFileSync(path.join(dir, file), YAML.stringify(value));
    write("sandtable.yaml", raw({ domain: "./judged.yaml" }));
    write("judged.yaml", [entry("a")]);
    expect((await loadDomain(dir)).judged).toEqual([entry("a")]);

    write("judged.yaml", [entry("a"), entry("a")]);
    await expect(loadDomain(dir)).rejects.toThrow(new RegExp(`judged\\.yaml:\\n  - judged\\[1\\]: duplicate criterion id "a"`));
    write("judged.yaml", [{ id: "a" }]);
    await expect(loadDomain(dir)).rejects.toThrow(/judged\.yaml:[\s\S]*→ at judged\[0\]\.criterion/);
  });
});

describe("review", () => {
  const source = { file: "tests/scenario-12.json", quote: "Confirms the pickup date" };
  const pendingOnes = () =>
    raw({
      domain: [
        { id: "reads-back", criterion: "Reads the load back.", review: "pending" },
        { id: "accepted-one", criterion: "Stays polite.", review: "accepted" },
        { id: "no-review", criterion: "Says goodbye." },
      ],
      tasks: { book: [{ id: "names-the-date", criterion: "Names the pickup date.", source, review: "pending" }] },
    });

  it("lists a pending criterion with its id and source, after the other kinds, and no other", () => {
    const d = parseDomain({ ...pendingOnes(), tasks: [{ ...(pendingOnes().tasks as Record<string, unknown>[])[0], review: "pending" }] });
    expect(pendingReview(d)).toEqual([
      { kind: "task", id: "book", source: undefined },
      { kind: "criterion", id: "reads-back", source: undefined },
      { kind: "criterion", id: "names-the-date", source },
    ]);
  });

  it("is empty when every criterion is accepted or has no review", () => {
    expect(pendingReview(parseDomain(raw({ domain: [{ id: "a", criterion: "Stays polite.", review: "accepted" }], tasks: { book: [{ id: "b", criterion: "Says goodbye." }] } })))).toEqual([]);
  });

  const cli = path.resolve("src/cli.ts");
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args]).then(
      (r) => ({ code: 0, ...r }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );

  it.skipIf(!process.features.typescript)("shows in `sandtable review`, fails `validate --strict`, and passes both once accepted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-judged-"));
    const file = path.join(dir, "sandtable.yaml");
    writeFileSync(file, YAML.stringify(pendingOnes()));

    const review = await run("review", dir);
    expect(review.code).toBe(0);
    expect(review.stdout).toContain(`- criterion reads-back\n- criterion names-the-date  (tests/scenario-12.json)\n    "Confirms the pickup date"\n`);
    expect(review.stdout).not.toContain("accepted-one");
    expect(review.stdout).not.toContain("no-review");

    expect((await run("validate", dir)).code).toBe(0);
    const strict = await run("validate", dir, "--strict");
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("⚠ 2 drafted item(s) pending review");

    writeFileSync(file, readFileSync(file, "utf8").replaceAll("review: pending", "review: accepted"));
    expect((await run("review", dir)).stdout).toContain("Nothing pending review.");
    expect((await run("validate", dir, "--strict")).code).toBe(0);
  });
});

describe("dates in a criterion", () => {
  const dated = (patch: Record<string, unknown> = { clock: CLOCK }) =>
    parseDomain(
      raw(
        {
          domain: [{ id: "says-the-date", criterion: "Says the pickup is ${today+2d}, as of ${now}." }],
          tasks: { book: [{ id: "says-the-time", criterion: "Says the driver arrives by ${now+90m}." }] },
        },
        patch,
      ),
    );

  it("resolve at the trial's clock, on the domain and on the task, and stay as written in the spec", () => {
    const d = dated();
    const r = resolveDates(d, d.tasks[0]!, CLOCK);
    expect(r.domain.judged![0]!.criterion).toBe("Says the pickup is 2026-11-04, as of 2026-11-02T09:00.");
    expect(r.task.judged![0]!.criterion).toBe("Says the driver arrives by 2026-11-02T10:30.");
    expect(d.judged![0]!.criterion).toBe("Says the pickup is ${today+2d}, as of ${now}.");
    expect(d.tasks[0]!.judged![0]!.criterion).toBe("Says the driver arrives by ${now+90m}.");
  });

  it("read each trial's clock under `clock: now`, and a task's own clock over the domain's", () => {
    const d = dated({ clock: "now" });
    const trial = resolveTrial(d, d.tasks[0]!, new Date(2026, 10, 2, 9, 0, 41));
    expect(trial.domain.judged![0]!.criterion).toBe("Says the pickup is 2026-11-04, as of 2026-11-02T09:00.");
    expect(trial.task.judged![0]!.criterion).toBe("Says the driver arrives by 2026-11-02T10:30.");

    const [book] = raw().tasks as Record<string, unknown>[];
    const own = parseDomain({ ...raw({ domain: [{ id: "a", criterion: "By ${today}." }] }, { clock: CLOCK }), tasks: [{ ...book, clock: "2026-12-31T23:30", judged: [{ id: "b", criterion: "On ${today+1d}." }] }] });
    const late = resolveTrial(own, own.tasks[0]!);
    expect(late.domain.judged![0]!.criterion).toBe("By 2026-12-31.");
    expect(late.task.judged![0]!.criterion).toBe("On 2027-01-01.");
  });

  it("are read in text only: a whole $today and a literal date stay as written", () => {
    const d = parseDomain(raw({ domain: [{ id: "a", criterion: "$today" }, { id: "b", criterion: "Says 2026-11-04." }] }, { clock: CLOCK }));
    expect(validateDomain(d)).toEqual([]);
    const r = resolveDates(d, d.tasks[0]!, CLOCK);
    expect(r.domain.judged!.map((c) => c.criterion)).toEqual(["$today", "Says 2026-11-04."]);
  });

  it("leave a task without criteria without the key", () => {
    const d = dated();
    expect(resolveDates(d, d.tasks[1]!, CLOCK).task).not.toHaveProperty("judged");
  });

  it("are a problem when malformed in a domain with a clock, with each place's path, and never lenient", () => {
    const value = raw({ domain: [{ id: "a", criterion: "By ${today+2h}." }], tasks: { book: [{ id: "b", criterion: "At ${now+5x}." }] } }, { clock: CLOCK });
    expect(problems(value)).toEqual([
      'judged[0].criterion: "${today+2h}" is not a date: $today takes an offset in days, such as $today+2d',
      'tasks.book.judged[0].criterion: "${now+5x}" is not a date: an offset is a whole number of d, h or m, such as $now+90m or $now-3h',
    ]);
    expect(domainWarnings(DomainSpec.parse(value))).toEqual([]);
    expect(() => parseDomain(value)).toThrow(DomainError);
  });

  const onlyAskHasAClock = () => {
    const [book, ask] = raw().tasks as Record<string, unknown>[];
    return { book, ask: { ...ask, clock: CLOCK } };
  };
  const SET_CLOCK = "`clock:` to now or a date and time, such as `clock: 2026-11-02T09:00`";

  it("are a problem where a task's trials have no clock, in a domain that uses one", () => {
    const { book, ask } = onlyAskHasAClock();
    const fine = { id: "ok", criterion: "On ${today}." };
    const value = {
      ...raw({ domain: [{ id: "a", criterion: "On ${today}." }] }),
      tasks: [{ ...book, judged: [{ id: "b", criterion: "On ${today}." }] }, { ...ask, judged: [fine] }],
    };
    expect(problems(value)).toEqual([
      `judged[0].criterion: "\${today}" needs a clock, and task book has none: set ${SET_CLOCK}`,
      `tasks.book.judged[0].criterion: "\${today}" needs a clock: set ${SET_CLOCK}`,
    ]);
  });

  it("need no domain clock when every task has its own", () => {
    const { book, ask } = onlyAskHasAClock();
    expect(problems({ ...raw({ domain: [{ id: "a", criterion: "On ${today}." }] }), tasks: [{ ...book, clock: "now" }, ask] })).toEqual([]);
  });

  it("warn as text in a domain with no clock, and stay text", () => {
    const value = raw({ domain: [{ id: "a", criterion: "On ${today+2d}." }], tasks: { book: [{ id: "b", criterion: "By ${now}." }] } });
    const d = parseDomain(value);
    const warnings = domainWarnings(d);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('judged[0].criterion: "${today+2d}" is text, not a date, since the domain sets no clock');
    expect(warnings[1]).toContain('tasks.book.judged[0].criterion: "${now}" is text, not a date, since the domain sets no clock');
    const trial = resolveTrial(d, d.tasks[0]!);
    expect(trial.domain.judged![0]!.criterion).toBe("On ${today+2d}.");
    expect(trial.task.judged![0]!.criterion).toBe("By ${now}.");
  });
});

describe("nothing else changes", () => {
  const example = path.resolve("examples/freight");
  const MARK = "reads the rate back in a warm tone";
  const first = { id: "warm-read-back", criterion: `The agent ${MARK}.` };
  const second = { id: "warm-on-the-task", criterion: `On this task, the agent ${MARK}, by \${today+2d}.` };
  /** The domain with a criterion on it and on every task, one of them pending. */
  const withCriteria = (d: Domain, opts: { review?: "pending" } = {}): Domain =>
    parseDomain({
      ...d,
      judged: [{ ...first, ...opts }],
      tasks: d.tasks.map((t, i) => ({ ...t, judged: [{ ...second, id: `${second.id}-${i}` }] })),
    });

  it("reaches neither the agent's prompt nor the caller's", async () => {
    const plain = { ...(await loadDomain(example)), clock: CLOCK };
    const judged = withCriteria(plain);
    expect(judged.tasks.length).toBeGreaterThan(0);
    for (const [i, task] of judged.tasks.entries()) {
      const persona = judged.personas.find((p) => p.id === task.persona);
      const agent = agentSystemPrompt(judged, task);
      const caller = userSystemPrompt(judged, task, persona);
      expect(agent).not.toContain(MARK);
      expect(caller).not.toContain(MARK);
      expect(agent).toBe(agentSystemPrompt(plain, plain.tasks[i]!));
      expect(caller).toBe(userSystemPrompt(plain, plain.tasks[i]!, persona));
    }
  });

  it("reaches neither one in a trial, once its dates are resolved", async () => {
    const said: string[] = [];
    const plain = { ...(await loadDomain(example)), clock: CLOCK };
    const scripted = scriptedUser();
    const user: UserSimulator = {
      name: scripted.name,
      createSession(ctx) {
        said.push(userSystemPrompt(ctx.domain, ctx.task, ctx.persona));
        return scripted.createSession(ctx);
      },
    };
    const noop = noopAgent();
    await runSuite({
      domain: withCriteria(plain),
      user,
      agent: {
        name: noop.name,
        createSession(ctx) {
          said.push(ctx.system, JSON.stringify(ctx.tools));
          return noop.createSession(ctx);
        },
      },
      taskIds: [plain.tasks[0]!.id],
    });
    expect(said).toHaveLength(3);
    for (const text of said) expect(text).not.toContain(MARK);
  });

  it("keeps every fingerprint when a criterion is added, edited or removed", async () => {
    const plain = await loadDomain(example);
    const added = withCriteria(plain);
    const edited: Domain = {
      ...added,
      judged: [{ ...first, criterion: "Something else entirely." }],
      tasks: added.tasks.map((t) => ({ ...t, judged: [{ id: t.id, criterion: "Something else again.", review: "pending" as const }] })),
    };
    const ids = plain.tasks.map((t) => t.id);
    for (const user of ["scripted", "claude:claude-sonnet-5-5"]) {
      for (const other of [added, edited]) {
        expect(inputsFingerprint(other, ids, user)).toBe(inputsFingerprint(plain, ids, user));
        for (const [i, task] of other.tasks.entries()) expect(taskFingerprints(other, task, user)).toEqual(taskFingerprints(plain, plain.tasks[i]!, user));
      }
    }
  });

  /** A run, without what differs from one run to the next. */
  const stable = (r: SuiteResult): unknown =>
    JSON.parse(JSON.stringify(r, (key, value: unknown) => (["runId", "startedAt", "durationMs", "latency", "latencyMs", "sessionId", "at", "ms"].includes(key) ? undefined : value)));

  it.each(["careful", "naive"] as const)("gives the %s agent the same run, to the last field", async (kind) => {
    const plain = await loadDomain(example);
    const run = (domain: Domain) => runSuite({ domain, agent: freightScriptedAgent(kind), user: scriptedUser(), k: 2 });
    const [without, withThem] = [await run(plain), await run(withCriteria(plain))];
    expect(withThem.passHat).toEqual(without.passHat);
    expect(stable(withThem)).toEqual(stable(without));
    expect(JSON.stringify(withThem)).not.toContain(MARK);
    expect(JSON.stringify(withThem)).not.toContain("judged");
  });

  it("leaves a pending criterion out of a run's pendingReview, which regrade agrees with, since it can't change the score", async () => {
    const plain = await loadDomain(example);
    const pending = withCriteria(plain, { review: "pending" });
    expect(pendingReview(pending)).toEqual([{ kind: "criterion", id: first.id }]);
    const run = (domain: Domain) => runSuite({ domain, agent: freightScriptedAgent("careful"), user: scriptedUser() });
    const [without, withPending] = [await run(plain), await run(pending)];
    expect(withPending.pendingReview).toEqual([]);
    expect(stable(withPending)).toEqual(stable(without));
    expect(renderTerminal(withPending)).not.toContain("provisional");
    expect(renderHtml(withPending)).not.toContain(first.id);
    expect(regradeSuite(pending, withPending).pendingReview).toEqual([]);
    expect(regradeSuite(pending, without).pendingReview).toEqual([]);
  });

  it("sandtable serve: leaves a pending criterion out of a served run's pendingReview too", async () => {
    const domain = parseDomain(raw({ domain: [{ id: "a", criterion: "Reads the load back.", review: "pending" }], tasks: { book: [{ id: "b", criterion: "Says goodbye.", review: "pending" }] } }));
    expect(pendingReview(domain)).toHaveLength(2);
    const post = async (url: string, body: unknown) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ id: string; url: string }>;
    const served = await serveConversations(domain, { port: 0, label: "platform" });
    try {
      const session = await post(`${served.server.url}/sessions`, { task: "book" });
      await post(`${session.url}/tools/get_load`, { load_id: "L-1" });
      await post(`${served.server.url}/sessions/${session.id}/end`, { transcript: [{ role: "agent", text: "Thanks for calling." }] });
      expect(served.result()!.pendingReview).toEqual([]);
    } finally {
      await served.server.stop();
    }
  });

  it("keeps a run provisional for the items that can change its score, without listing a criterion beside them", async () => {
    const plain = await loadDomain(example);
    const drafted = withCriteria({ ...plain, tasks: plain.tasks.map((t, i) => (i === 0 ? { ...t, review: "pending" as const } : t)) }, { review: "pending" });
    const taskId = plain.tasks[0]!.id;
    expect(pendingReview(drafted).map((p) => `${p.kind} ${p.id}`)).toEqual([`task ${taskId}`, `criterion ${first.id}`]);
    const r = await runSuite({ domain: drafted, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: [taskId] });
    expect(r.pendingReview.map((p) => `${p.kind} ${p.id}`)).toEqual([`task ${taskId}`]);
    expect(regradeSuite(drafted, r).pendingReview.map((p) => `${p.kind} ${p.id}`)).toEqual([`task ${taskId}`]);
  });

  it("gives lint the same report", async () => {
    const plain = await loadDomain(example);
    expect(lintDomain(withCriteria(plain))).toEqual(lintDomain(plain));
  });

  const cli = path.resolve("src/cli.ts");
  const runCli = (dir: string, agent: string) => {
    const out = mkdtempSync(path.join(tmpdir(), "sandtable-judged-out-"));
    return promisify(execFile)(process.execPath, [cli, "run", dir, "--agent", agent, "--user", "scripted", "--fail-under", "100", "--no-html", "-o", out]).then(
      (r) => ({ code: 0, out, stdout: r.stdout }),
      (e: { code: number; stdout: string }) => ({ code: e.code, out, stdout: e.stdout }),
    );
  };

  it.skipIf(!process.features.typescript)("keeps `run`'s exit code, and leaves results.json without them, a pending one too", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-judged-"));
    cpSync(example, dir, { recursive: true });
    const tasksFile = path.join(dir, "tasks.yaml");
    const tasks = YAML.parse(readFileSync(tasksFile, "utf8")) as Record<string, unknown>[];
    writeFileSync(tasksFile, YAML.stringify(tasks.map((t, i) => ({ ...t, judged: [{ ...second, id: `${second.id}-${i}` }] }))));
    const main = path.join(dir, "sandtable.yaml");
    const pendingFirst = { ...first, review: "pending" };
    writeFileSync(main, `${readFileSync(main, "utf8").replace(/^judged:\n(?: .*\n|\n)*/m, "")}\n${YAML.stringify({ judged: [pendingFirst] })}`);
    expect((await loadDomain(dir)).judged).toEqual([pendingFirst]);

    for (const [agent, code] of [["scripted:careful", 0], ["scripted:naive", 1]] as const) {
      const [plain, judged] = [await runCli(example, agent), await runCli(dir, agent)];
      expect(plain.code, agent).toBe(code);
      expect(judged.code, agent).toBe(code);
      const results = readFileSync(path.join(judged.out, "results.json"), "utf8");
      expect(results).not.toContain(MARK);
      expect(results).not.toContain("judged");
      expect(results).not.toContain("criterion");
      expect(judged.stdout).not.toContain("provisional");
      const parsed = JSON.parse(results) as SuiteResult;
      expect(parsed.pendingReview).toEqual([]);
      expect(parsed.passHat).toEqual((JSON.parse(readFileSync(path.join(plain.out, "results.json"), "utf8")) as SuiteResult).passHat);
    }
  }, 60_000);
});
