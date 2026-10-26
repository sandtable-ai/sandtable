import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildRun, USER_LABEL } from "../plugin-evals/fixtures/build-run.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { draftFromOpenApi } from "../src/init/openapi.ts";
import { regradeSuite } from "../src/run/regrade.ts";
import type { SuiteResult } from "../src/run/suite.ts";
import { loadDomain, pendingReview } from "../src/spec/load.ts";

// The plugin's eval suite (plugin-evals/, run with `npm run evals:plugin`) calls a model, so CI never runs it.
// These tests keep its fixtures true to the code, so a paid run grades the plugin and not a stale fixture.

const evals = path.resolve("plugin-evals");
const fixtures = path.join(evals, "fixtures");
const stored = JSON.parse(readFileSync(path.join(fixtures, "wrenfield-run", "results.json"), "utf8")) as SuiteResult;
const verdicts = (r: SuiteResult) => Object.fromEntries(r.tasks.map((t) => [t.id, t.trials.every((tr) => tr.passed)]));

describe("the plugin eval suite's fixtures", () => {
  it("start the eval without npm's global config path, which makes Claude Code's sandbox block Homebrew's OpenSSL config", () => {
    const script = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts["evals:plugin"]!;
    expect(script).toMatch(/env -u npm_config_globalconfig claude plugin eval /);
  });

  it("rebuild the stored run exactly from the current code: run `node plugin-evals/fixtures/build-run.ts` when this fails", async () => {
    expect(JSON.parse(JSON.stringify(await buildRun()))).toEqual(stored);
  });

  it("store a run with one pass and three failures, each with a different owner", () => {
    expect(stored.user).toBe(USER_LABEL);
    expect(verdicts(stored)).toEqual({ "return-boots-silver": true, "jacket-not-on-order": false, "guest-receipt": false, "return-jacket-gold": false });
    const failed = (id: string) => stored.tasks.find((t) => t.id === id)!.trials[0]!.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed("jacket-not-on-order")).toEqual(["state:returns#1"]); // the item isn't on the order: the task's fault
    expect(failed("guest-receipt")).toEqual(["state:returns#1"]); // the caller invented a receipt
    expect(failed("return-jacket-gold")).toEqual(["account-before-order"]); // a rule stricter than the SOP
  });

  it("regrade unchanged under the accepted domain, and flip only return-jacket-gold once its rule is soft", async () => {
    const domain = await loadDomain(path.join(fixtures, "wrenfield"));
    expect(verdicts(regradeSuite(domain, stored))).toEqual(verdicts(stored));
    // What confirm-grading-fix's scaffold does to the domain before the run.
    const soft = { ...domain, invariants: domain.invariants.map((i) => (i.id === "account-before-order" ? { ...i, soft: true } : i)) };
    const regraded = regradeSuite(soft, stored);
    expect(verdicts(regraded)).toEqual({ ...verdicts(stored), "return-jacket-gold": true });
    expect([stored.passHat["1"], regraded.passHat["1"]]).toEqual([0.25, 0.5]);
  });

  it("give the review case a drafted domain whose planted problems lint can't see", async () => {
    const drafted = await loadDomain(path.join(fixtures, "drafted"));
    expect(pendingReview(drafted).map((p) => p.id).sort()).toEqual(
      ["account-before-order", "claimed-gold-but-guest-denied", "jacket-wrong-size-silver", "poles-silver-changed-mind", "return-boots-silver", "verify-before-return"].sort(),
    );
    const lint = lintDomain(drafted);
    expect([lint.errors, lint.warnings]).toEqual([0, 0]);
    // The chats the drafted tasks cite exist, and the facts the review must catch are where the graders expect them.
    for (const t of drafted.tasks) expect(existsSync(path.join(fixtures, "discovery", "transcripts", t.source!.file)), t.id).toBe(true);
    const order = (id: string) => drafted.world.tables.orders!.rows.find((r) => r.order_id === id)!;
    expect(order("O-2004").item).toBe("down vest");
    expect(order("O-2005")).toMatchObject({ item: "hiking poles", original_packaging: true });
    expect(drafted.tasks.find((t) => t.id === "poles-silver-changed-mind")!.user.instructions).not.toMatch(/packag|box/i);
  });

  it("give the drafting case an OpenAPI spec that init --openapi drafts", () => {
    const draft = draftFromOpenApi(YAML.parse(readFileSync(path.join(fixtures, "discovery", "openapi.yaml"), "utf8")) as Record<string, unknown>);
    expect(draft.tools.map((t) => t.name).sort()).toEqual(["get_account", "get_order", "start_return", "transfer_to_human"]);
  });
});

describe("the plugin eval suite's cases", () => {
  const cases = readdirSync(evals).filter((d) => existsSync(path.join(evals, d, "prompt.md")));
  const front = (file: string) => YAML.parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))![1]!) as Record<string, unknown>;

  it("each load the plugin under test, grade with at least one check, and tag the skill issue they cover", () => {
    expect(cases.sort()).toEqual(["attribute-stored-run", "check-cli-features", "confirm-grading-fix", "draft-from-sources", "draft-preauthorized", "install-advice", "install-new-folder", "review-drafted-domain"]);
    for (const c of cases) {
      const meta = front(path.join(evals, c, "prompt.md"));
      expect(meta.plugins, c).toEqual(["../../plugin"]);
      expect(meta.tags, c).toEqual(expect.arrayContaining([expect.stringMatching(/^skill-\d+$/)]));
      const graders = readdirSync(path.join(evals, c, "graders"));
      expect(graders.length, c).toBeGreaterThan(1);
      for (const g of graders) expect(front(path.join(evals, c, "graders", g)).type, `${c}/${g}`).toMatch(/^(regex|tool_used|tool_order|file_exists|llm)$/);
    }
  });

  it("fail a case that reads sandtable's own code to learn what the CLI supports, and not one that runs or asks the CLI", () => {
    for (const c of ["check-cli-features", "draft-from-sources", "draft-preauthorized"]) {
      const reads = new RegExp(front(path.join(evals, c, "graders", "no-reading-sandtable-code.md")).pattern as string);
      const bash = (command: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
      const grep = (p: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "bedrock", path: p } }] } });
      // The replay at b0143b8: cd into the package, then grep its dist.
      expect(reads.test(bash("cd /work/node_modules/sandtable-ai && ls dist | head -50")), c).toBe(true);
      expect(reads.test(bash('grep -rn -i "bedrock" node_modules/sandtable-ai/dist')), c).toBe(true);
      expect(reads.test(grep("node_modules/sandtable-ai/src")), c).toBe(true);
      expect(reads.test(bash("ls ~/.npm/_npx/1a2b/node_modules/sandtable-ai")), c).toBe(true);
      expect(reads.test(bash("npx sandtable-ai init --help")), c).toBe(false);
      expect(reads.test(bash("cat node_modules/sandtable-ai/package.json")), c).toBe(false);
      expect(reads.test(bash("npm install --save-dev sandtable-ai @anthropic-ai/bedrock-sdk")), c).toBe(false);
    }
  });

  it("tell, in draft-preauthorized, a dry run before the model-backed init from a run without one", () => {
    const grader = (name: string) => new RegExp(front(path.join(evals, "draft-preauthorized", "graders", `${name}.md`)).pattern as string);
    const dryRunFirst = grader("dry-run-before-paid-init");
    const dryRunThenInit = grader("estimate-then-init");
    const initBeforeEstimate = grader("no-paid-init-before-estimate");
    // Trace lines as the eval writes them: one JSON event per line.
    const event = (type: "assistant" | "user", ...content: object[]) => JSON.stringify({ type, message: { role: type, content } });
    const say = (text: string) => event("assistant", { type: "text", text });
    const bash = (command: string) => event("assistant", { type: "tool_use", id: "t", name: "Bash", input: { command } });
    const result = (text: string) => event("user", { type: "tool_result", tool_use_id: "t", content: text });
    const skill = event("user", { type: "text", text: "Base directory for this skill: … `init … --dry-run` prints a plan line …" });
    const paid = 'npx sandtable-ai init --sop "discovery/sop.md" --transcripts discovery/transcripts -o sandtable --provider bedrock -m claude-sonnet-5-5';
    const dry = `${paid} --dry-run`;
    const plan = "Plan: 5 model calls (1 for the SOP, 4 for transcripts) to claude-sonnet-5-5 on Bedrock (eu-west-1); at most about $0.94 at list prices";
    const openapiDry = "npx sandtable-ai init --openapi discovery/openapi.yaml -o sandtable --dry-run";
    const trace = (...lines: string[]) => `${lines.join("\n")}\n`;
    // [name, trace, dry run first, dry run then the paid init, paid init with no estimate said before it]
    const cases: [string, string, boolean, boolean, boolean][] = [
      ["dry run, the plan said, then the run", trace(skill, bash(dry), result(plan), say(`${plan}. Authorized, so I'm running it.`), bash(paid)), true, true, false],
      ["dry run, then the run, nothing said", trace(skill, bash(dry), result(plan), bash(paid)), true, true, true],
      ["dry run and a question, no run", trace(skill, bash(dry), result(plan), say(`${plan}. Go ahead?`)), true, false, false],
      ["the run with no dry run", trace(skill, bash(paid), say("Done: 5 calls cost $0.46.")), false, false, true],
      ["an estimate said, then the run, no dry run", trace(skill, say("5 model calls, at most about $0.94."), bash(paid)), false, false, false],
      ["the run, then a dry run", trace(skill, bash(paid), bash(dry)), false, false, true],
      ["only --openapi dry-run, then the run", trace(skill, bash(openapiDry), bash(paid)), false, false, true],
    ];
    for (const [name, t, first, then, unannounced] of cases) {
      expect(dryRunFirst.test(t), name).toBe(first);
      expect(dryRunThenInit.test(t), name).toBe(then);
      expect(initBeforeEstimate.test(t), name).toBe(unannounced);
    }
  });

  it("count, in draft-from-sources, a model-backed init as a paid step and its dry run as not one", () => {
    // tool_used matches input_match against the tool call's input as JSON, so quotes in a command arrive escaped.
    const paidStep = new RegExp(front(path.join(evals, "draft-from-sources", "graders", "no-paid-step-without-go-ahead.md")).input_match as string);
    const bash = (command: string) => JSON.stringify({ command, description: "Draft from the SOP and chats" });
    const paid = 'npx sandtable-ai init --sop "./discovery/sop.md" --transcripts ./discovery/transcripts -o ./sandtable -m claude-sonnet-5-5 --provider bedrock';
    // The runs at d02ff40 (#342): the dry run, with --dry-run last, after the quoted SOP path.
    expect(paidStep.test(bash(`${paid} --dry-run`))).toBe(false);
    expect(paidStep.test(bash("npx sandtable-ai init --dry-run --transcripts ./discovery/transcripts -o ./sandtable"))).toBe(false);
    expect(paidStep.test(bash("npx sandtable-ai init --openapi ./discovery/openapi.yaml -o ./sandtable"))).toBe(false);
    expect(paidStep.test(bash(paid))).toBe(true);
    expect(paidStep.test(bash("npx sandtable-ai init --transcripts ./discovery/transcripts -o ./sandtable"))).toBe(true);
    expect(paidStep.test(bash(`npx sandtable-ai init --openapi ./discovery/openapi.yaml -o ./sandtable && ${paid}`))).toBe(true);
    // A dry run chained before the paid init doesn't excuse it, on one line or two.
    expect(paidStep.test(bash(`${paid} --dry-run && ${paid}`))).toBe(true);
    expect(paidStep.test(bash(`${paid} --dry-run\n${paid}`))).toBe(true);
    expect(paidStep.test(bash(`${paid} --dry-run; ls sandtable`))).toBe(false);
  });

  it("count, in attribute-stored-run, handing the run to failure-triager as plugin use, as loading the skill is", () => {
    const meta = front(path.join(evals, "attribute-stored-run", "graders", "skill-fired.md"));
    // Under --ablation with-without it stays the plugin-fired indicator, as a `tool_used: Skill` grader is by default.
    expect([meta.target, meta.arm]).toEqual(["trace", "with-only"]);
    const fired = new RegExp(meta.pattern as string);
    const event = (type: "assistant" | "user", ...content: object[]) => JSON.stringify({ type, message: { role: type, content } });
    const call = (name: string, input: object) => event("assistant", { type: "tool_use", id: "t", name, input });
    const skillText = event("user", { type: "text", text: "Base directory for this skill: … delegate the reading to the `failure-triager` agent …" });
    const trace = (...lines: string[]) => `${lines.join("\n")}\n`;
    const triager = (subagent_type: string) => call("Agent", { description: "Attribute the failures", prompt: "Read results.json …", subagent_type });
    expect(fired.test(trace(call("Skill", { skill: "sandtable:running-and-reading-results" })))).toBe(true);
    // The runs at d02ff40 and f720166 (#344) that delegated without loading the skill.
    expect(fired.test(trace(triager("sandtable:failure-triager")))).toBe(true);
    expect(fired.test(trace(skillText, triager("sandtable:failure-triager")))).toBe(true);
    expect(fired.test(trace(skillText, triager("general-purpose")))).toBe(false);
    expect(fired.test(trace(call("Skill", { skill: "sandtable:writing-good-tasks" }), call("Read", { file_path: "results.json" })))).toBe(false);
  });

  it("accept, in install-advice, either skill that says what to install", () => {
    const fired = new RegExp(front(path.join(evals, "install-advice", "graders", "skill-fired.md")).input_match as string);
    // tool_used matches input_match against the Skill call's input as JSON.
    const skill = (name: string) => JSON.stringify({ skill: name });
    expect(fired.test(skill("sandtable:drafting-a-domain"))).toBe(true);
    expect(fired.test(skill("sandtable:running-and-reading-results"))).toBe(true);
    expect(fired.test(skill("running-and-reading-results"))).toBe(true);
    expect(fired.test(skill("sandtable:writing-good-tasks"))).toBe(false);
  });

  it("ask, in install-new-folder, for npm init before the install, so npm doesn't install into a parent project", () => {
    const first = new RegExp(front(path.join(evals, "install-new-folder", "graders", "init-before-install.md")).pattern as string, "i");
    const install = "npm install --save-dev sandtable-ai @anthropic-ai/bedrock-sdk";
    expect(first.test(`\`\`\`bash\nnpm init -y\n${install}\nnpx sandtable-ai --version\n\`\`\``)).toBe(true);
    expect(first.test(`npm init -y && ${install}`)).toBe(true);
    // The 1.0.0 session in #401: the install alone, in a folder with no package.json.
    expect(first.test(`\`\`\`bash\n${install}\n\`\`\``)).toBe(false);
    expect(first.test(`${install}\n(If npm complains about a missing package.json, run npm init first.)`)).toBe(false);
  });

  it("set up their workspace with a scaffold script that bash can parse", () => {
    for (const c of cases.filter((c) => existsSync(path.join(evals, c, "case.yaml")))) {
      const meta = YAML.parse(readFileSync(path.join(evals, c, "case.yaml"), "utf8")) as { name: string; context: { scaffold_script: string } };
      expect(meta.name, c).toBe(c);
      const script = path.join(evals, c, meta.context.scaffold_script);
      expect(statSync(script).mode & 0o111, `${c}: executable`).not.toBe(0);
      execFileSync("bash", ["-n", script]);
    }
    execFileSync("bash", ["-n", path.join(evals, "lib", "setup.sh")]);
  });
});
