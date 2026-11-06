import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { runSuite } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { DomainError, domainWarnings, loadDomain, parseDomain, validateDomain } from "../src/spec/load.ts";
import { InvariantSpec, type Domain, type StateAssert } from "../src/spec/schema.ts";
import { version } from "../src/version.ts";

// A domain's own files: sandtable.yaml and the policy, world or tasks files it includes.

function copyOfClinic(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sandtable-load-"));
  cpSync(path.resolve("examples/clinic"), dir, { recursive: true });
  return dir;
}

function edit(file: string, from: string | RegExp, to: string): void {
  const before = readFileSync(file, "utf8");
  const after = before.replace(from, to);
  expect(after).not.toBe(before);
  writeFileSync(file, after);
}

describe("loadDomain includes", () => {
  it("inlines policy and tasks from their own files", async () => {
    const d = await loadDomain(path.resolve("examples/clinic"));
    expect(d.policy).toBe(readFileSync(path.resolve("examples/clinic/policy.md"), "utf8"));
    expect(d.tasks.length).toBeGreaterThan(0);
  });

  it("rejects a misspelled policy path instead of using the path as the policy", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^policy: \.\/policy\.md$/m, "policy: ./polcy.md");
    const err = await loadDomain(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as Error).message).toContain("policy: ./polcy.md not found (looked for ");
  });

  it("rejects a missing tasks file by name", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^tasks: \.\/tasks\.yaml$/m, "tasks: ./task.yaml");
    await expect(loadDomain(dir)).rejects.toThrow(/tasks: \.\/task\.yaml not found/);
  });

  it("keeps inline text that merely mentions a file", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^policy: \.\/policy\.md$/m, "policy: Follow the steps in policy.md");
    expect((await loadDomain(dir)).policy).toBe("Follow the steps in policy.md");
  });

  it("inlines a file whose name has spaces", async () => {
    const dir = copyOfClinic();
    renameSync(path.join(dir, "policy.md"), path.join(dir, "Front Desk SOP.md"));
    edit(path.join(dir, "sandtable.yaml"), /^policy: \.\/policy\.md$/m, "policy: ./Front Desk SOP.md");
    expect((await loadDomain(dir)).policy).toBe(readFileSync(path.resolve("examples/clinic/policy.md"), "utf8"));
  });
});

describe("loadDomain YAML errors", () => {
  it("name sandtable.yaml", async () => {
    const dir = copyOfClinic();
    writeFileSync(path.join(dir, "sandtable.yaml"), "name: x\nworld:\n  tables: {\n  bad: [\n");
    const err = await loadDomain(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as Error).message).toMatch(new RegExp(`^${path.join(dir, "sandtable.yaml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
  });

  it("name the included file they come from", async () => {
    const dir = copyOfClinic();
    writeFileSync(path.join(dir, "tasks.yaml"), "- id: a\n  bad: : :\n");
    await expect(loadDomain(dir)).rejects.toThrow(`${path.join(dir, "tasks.yaml")}: Nested mappings are not allowed`);
  });
});

describe("loadDomain schema and cross-reference errors", () => {
  it("name the included file an item comes from, and sandtable.yaml for its own keys", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "tasks.yaml"), /^- id: /m, "- critcal: true\n  id: ");
    edit(path.join(dir, "sandtable.yaml"), /^name: /m, "nmae: x\nname: ");
    const message = ((await loadDomain(dir).catch((e: unknown) => e)) as Error).message;
    expect(message).toContain(`${path.join(dir, "tasks.yaml")}:\n✖ Unrecognized key: "critcal"`);
    expect(message).toContain(`${path.join(dir, "sandtable.yaml")}:\n✖ Unrecognized key: "nmae"`);
    // Last, the installed version, so a key from a later release reads differently from a typo.
    expect(message.split("\n").at(-1)).toBe(
      `sandtable-ai ${version} doesn't know these keys: check their spelling, or whether a later release added them (CHANGELOG.md, or \`npx sandtable-ai@latest validate ${dir}\`).`,
    );
  });

  it("say once which version doesn't know a single unknown key", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^name: /m, "nmae: x\nname: ");
    const message = ((await loadDomain(dir).catch((e: unknown) => e)) as Error).message;
    expect(message).toContain(`\nsandtable-ai ${version} doesn't know this key: check its spelling, or whether a later release added it`);
  });

  it("print the validate command with the path as given, quoted when it needs to be, so it runs as printed", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^name: /m, "nmae: x\nname: ");
    const spaced = `${dir} copy`;
    renameSync(dir, spaced);
    const message = ((await loadDomain(spaced).catch((e: unknown) => e)) as Error).message;
    expect(message).toContain(`\`npx sandtable-ai@latest validate '${spaced}'\``);
  });

  it("print a relative path that starts with - as ./, so the CLI doesn't read it as an option", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^name: /m, "nmae: x\nname: ");
    const parent = mkdtempSync(path.join(tmpdir(), "sandtable-dash-"));
    renameSync(dir, path.join(parent, "-weird"));
    const cwd = process.cwd();
    process.chdir(parent);
    try {
      const message = ((await loadDomain("-weird").catch((e: unknown) => e)) as Error).message;
      expect(message).toContain("`npx sandtable-ai@latest validate ./-weird`");
    } finally {
      process.chdir(cwd);
    }
  });

  it("leave other schema errors without the version line", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^name: .*$/m, "name: 42");
    const message = ((await loadDomain(dir).catch((e: unknown) => e)) as Error).message;
    expect(message).not.toContain("doesn't know");
  });

  it("name the included tasks file for a task's cross-reference problem", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "tasks.yaml"), /^ {2}persona: \S+$/m, "  persona: nobody-at-all");
    await expect(loadDomain(dir)).rejects.toThrow(new RegExp(`^${path.join(dir, "tasks.yaml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\n {2}- tasks\\.[\\w-]+: unknown persona "nobody-at-all"$`));
  });
});

describe("max_count and monotonic cross-references", () => {
  const freight = () => loadDomain(path.resolve("examples/freight"));
  const problems = async (...invariants: unknown[]) => validateDomain({ ...(await freight()), invariants: invariants.map((i) => InvariantSpec.parse(i)) });

  it("name a tool the domain doesn't have, and a per_arg, arg or when argument its tool doesn't have", async () => {
    expect(
      await problems(
        { id: "a", description: "x", max_count: { tool: "log_offers", max: 3 } },
        { id: "b", description: "x", max_count: { tool: "log_offer", per_arg: "load", max: 3, when: { rnd: 1, round: { $gte: 2, $like: 1 } } } },
        { id: "c", description: "x", monotonic: { tool: "log_offer", arg: "counter", per_arg: "lod_id", direction: "up" } },
        { id: "d", description: "x", monotonic: { tool: "log_ofer", arg: "counter_offer", direction: "down" } },
      ),
    ).toEqual([
      'invariants.a: unknown tool "log_offers"',
      'invariants.b: tool "log_offer" has no param "load"',
      'invariants.b.max_count.when: tool "log_offer" has no param "rnd"',
      expect.stringMatching(/^invariants\.b\.max_count\.when\.round: unknown operator "\$like" \(use /),
      'invariants.c: tool "log_offer" has no param "counter"',
      'invariants.c: tool "log_offer" has no param "lod_id"',
      'invariants.d: unknown tool "log_ofer"',
    ]);
  });

  it("accept the freight example's", async () => {
    expect(
      await problems(
        { id: "a", description: "x", max_count: { tool: "log_offer", per_arg: "load_id", max: 3 } },
        { id: "b", description: "x", monotonic: { tool: "log_offer", arg: "counter_offer", per_arg: "load_id", direction: "up", strict: true } },
      ),
    ).toEqual([]);
  });

  it("point max: 0 to never, and take only a whole max", async () => {
    const d = await freight();
    const parse = (max: unknown) => () => parseDomain({ ...d, invariants: [{ id: "no-offers", description: "x", max_count: { tool: "log_offer", max } }] });
    expect(parse(0)).toThrow("max is 1 or more: for a tool that may not be called at all, use never: { tool: log_offer }");
    expect(parse(0)).toThrow("at invariants[0].max_count.max");
    expect(parse(1.5)).toThrow(DomainError);
    expect(parse(1)).not.toThrow();
  });

  it("take direction up or down", () => {
    const ok = (monotonic: unknown) => InvariantSpec.safeParse({ id: "x", description: "x", monotonic }).success;
    expect(ok({ tool: "log_offer", arg: "counter_offer", direction: "up" })).toBe(true);
    expect(ok({ tool: "log_offer", arg: "counter_offer", direction: "down", strict: false })).toBe(true);
    expect(ok({ tool: "log_offer", arg: "counter_offer", direction: "higher" })).toBe(false);
    expect(ok({ tool: "log_offer", arg: "counter_offer" })).toBe(false);
  });
});

describe("domainWarnings on an expect.state entry it only partly reads", () => {
  const TASK = "book-at-posted-rate";
  const AT = `tasks.${TASK}.expect.state`;
  const ROW = { table: "loads", key: "L-1001" };
  const MATCH = { status: "available" };

  /** The freight example with this task's expect.state in place of its own. */
  async function withState(state: StateAssert[]): Promise<Domain> {
    const d = await loadDomain(path.resolve("examples/freight"));
    return { ...d, tasks: d.tasks.map((t) => (t.id === TASK ? { ...t, expect: { ...t.expect, state } } : t)) };
  }

  it.each<[string, StateAssert, string]>([
    ["fields without key", { table: "bookings", fields: { rate: 9999 } }, "fields is read only with key, so this entry checks only that a bookings row exists. Use where to match rows, or add key; 2.0 will reject this."],
    ["where with key", { ...ROW, where: MATCH }, "where is read only without key, so this entry checks only that loads L-1001 exists. Use fields to match the row, or drop key; 2.0 will reject this."],
    ["key with a count above 0", { ...ROW, count: 5 }, "count is read with key only as count: 0, so this entry checks only that loads L-1001 exists. Drop count, or drop key and use where to count rows; 2.0 will reject this."],
    ["fields with key and count: 0", { ...ROW, count: 0, fields: MATCH }, "fields isn't read with key and count: 0, so this entry checks only that loads L-1001 doesn't exist. Drop fields, or drop count to match the row; 2.0 will reject this."],
  ])("warns on %s, naming the task, the entry and the ignored key", async (_, entry, message) => {
    expect(domainWarnings(await withState([entry]))).toEqual([`${AT}[0]: ${message}`]);
  });

  it("says what the entry checks given what is left of it", async () => {
    const checks = async (entry: StateAssert) => (domainWarnings(await withState([entry]))[0] ?? "").match(/checks only that (.*?)\. /)?.[1];
    expect(await checks({ table: "bookings", where: MATCH, fields: MATCH })).toBe("a bookings row matches its where");
    expect(await checks({ table: "bookings", count: 2, fields: MATCH })).toBe("exactly 2 bookings row(s) exist");
    expect(await checks({ table: "bookings", where: MATCH, count: 1, fields: MATCH })).toBe("exactly 1 bookings row(s) match its where");
    expect(await checks({ ...ROW, where: MATCH, fields: MATCH })).toBe("loads L-1001 exists and matches its fields");
    expect(await checks({ ...ROW, where: MATCH, count: 0 })).toBe("loads L-1001 doesn't exist");
    expect(await checks({ ...ROW, count: 5, fields: MATCH })).toBe("loads L-1001 exists and matches its fields");
  });

  it("warns once per ignored key, and on an empty clause, which is still not read", async () => {
    const warned = domainWarnings(await withState([{ ...ROW, where: MATCH, count: 5 }, { table: "bookings", fields: {} }, { ...ROW, where: {} }]));
    expect(warned.map((w) => w.split(":")[0])).toEqual([`${AT}[0]`, `${AT}[0]`, `${AT}[1]`, `${AT}[2]`]);
    expect(warned[0]).toContain("where is read only without key");
    expect(warned[1]).toContain("count is read with key only as count: 0");
  });

  it("names the entry by its index, counted from 0", async () => {
    const good: StateAssert = { table: "bookings", count: 0 };
    expect(domainWarnings(await withState([good, good, { table: "bookings", fields: MATCH }]))).toEqual([expect.stringMatching(/^tasks\.book-at-posted-rate\.expect\.state\[2\]: fields/)]);
  });

  it("gives no warning for an entry whose every key is read", async () => {
    const documented: StateAssert[] = [{ table: "bookings", count: 0 }, { table: "bookings", where: MATCH, count: 2 }, { table: "bookings", where: MATCH }, { ...ROW, fields: MATCH }, { ...ROW, count: 0 }];
    expect(domainWarnings(await withState(documented))).toEqual([]);
    // Outside the documented shapes, but nothing in them is ignored: any row in the table, and this row exists.
    expect(domainWarnings(await withState([{ table: "bookings" }, ROW]))).toEqual([]);
  });

  it("gives no warning for either bundled example", async () => {
    for (const example of ["examples/freight", "examples/clinic"]) expect(domainWarnings(await loadDomain(path.resolve(example))), example).toEqual([]);
  });

  it("leaves grading as it was: each entry still passes on the part that is read", async () => {
    const d = await loadDomain(path.resolve("examples/freight"));
    const task = d.tasks.find((t) => t.id === TASK)!;
    const extra: StateAssert[] = [{ table: "bookings", fields: { rate: 9999 } }, { ...ROW, where: MATCH }, { ...ROW, count: 5 }];
    const domain = await withState([...task.expect.state, ...extra]);
    const result = await runSuite({ domain, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: [TASK] });
    const [trial] = result.tasks[0]!.trials;
    expect(trial!.passed).toBe(true);
    const at = task.expect.state.length;
    expect(trial!.checks.filter((c) => c.kind === "state").slice(at).map((c) => [c.id, c.passed, c.detail])).toEqual([
      [`state:bookings#${at + 1}`, true, "1 bookings row(s) match {} (expected at least 1)"],
      [`state:loads[L-1001]#${at + 2}`, true, "loads L-1001 as expected"],
      [`state:loads[L-1001]#${at + 3}`, true, "loads L-1001 as expected"],
    ]);
  });

  it.skipIf(!process.features.typescript)("validate prints them as warning lines and exits 0, with or without --strict", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-load-"));
    cpSync(path.resolve("examples/freight"), dir, { recursive: true });
    edit(path.join(dir, "tasks.yaml"), /(- id: book-at-posted-rate\n[^]*?\n( +)state:\n)/, `$1$2  - { table: bookings, fields: { rate: 9999 } }\n`);
    const validate = (...flags: string[]) => promisify(execFile)(process.execPath, [path.resolve("src/cli.ts"), "validate", dir, ...flags]);
    // Either exit other than 0 would reject here.
    for (const flags of [[], ["--strict"]]) {
      const { stdout } = await validate(...flags);
      expect(stdout).toContain(`⚠ ${AT}[0]: fields is read only with key, so this entry checks only that a bookings row exists.`);
    }
  });
});
