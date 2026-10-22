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
    expect(cases.sort()).toEqual(["attribute-stored-run", "check-cli-features", "confirm-grading-fix", "draft-from-sources", "install-advice", "review-drafted-domain"]);
    for (const c of cases) {
      const meta = front(path.join(evals, c, "prompt.md"));
      expect(meta.plugins, c).toEqual(["../../plugin"]);
      expect(meta.tags, c).toEqual(expect.arrayContaining([expect.stringMatching(/^skill-\d+$/)]));
      const graders = readdirSync(path.join(evals, c, "graders"));
      expect(graders.length, c).toBeGreaterThan(1);
      for (const g of graders) expect(front(path.join(evals, c, "graders", g)).type, `${c}/${g}`).toMatch(/^(regex|tool_used|tool_order|file_exists|llm)$/);
    }
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
