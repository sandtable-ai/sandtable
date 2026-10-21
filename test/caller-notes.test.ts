import path from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { callerNotes } from "../src/run/caller-notes.ts";
import { regradeTrial } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { userSystemPrompt } from "../src/sim/prompts.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { UserSimulator } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";

// Caller notes flag turns where the simulated user steps out of its role. They never change a verdict.

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const turns = (...texts: string[]) => texts.flatMap((text) => [{ type: "user", text }, { type: "agent", text: "ok" }]);

describe("callerNotes", () => {
  it("flags a caller that talks about its instructions or about the agent instead of to it", () => {
    const cases: [string, string][] = [
      ["The agent asked for two things at once, and my instructions say to give one at a time. My MC is 100101.", "talks about its instructions; talks about the agent in the third person"],
      ["Agent says they can't go higher, so I pass.", "talks about the agent in the third person"],
      ["$1,900 is the agent's first counter, so I decline. Make it $2,000.", "talks about the agent in the third person"],
      ["The assistant offered a gift card, which my goal doesn't mention.", "talks about the agent in the third person"],
      ["Per my script, I'll hang up now.", "talks about its instructions"],
      ["As the caller, I accept that rate.", "talks about its instructions"],
      ["Great, my goal is complete. Thanks!", "says its goal is met"],
    ];
    for (const [text, why] of cases) expect(callerNotes(turns(text)), text).toEqual([{ turn: 1, text: expect.any(String), why }]);
    // The note quotes the sentence that matched, not the whole turn.
    expect(callerNotes(turns(cases[0]![0]))[0]!.text).toBe("The agent asked for two things at once, and my instructions say to give one at a time.");
    expect(callerNotes(turns("Make it $2,000.\nAgent said that's the best they can do"))[0]!.text).toBe("Agent said that's the best they can do");
  });

  it("leaves what a real caller says alone", () => {
    const lines = [
      "My goal is to get this load at $2,000.",
      "The agent I spoke to yesterday said quick pay was available.",
      "Can I talk to an agent, please?",
      "My instructions from dispatch are to deliver by Friday.",
      "You asked for three things, so here is my MC number: 100101.",
      "I'm not sure about the packaging, sorry.",
      "I've been a customer since 2019, and as a customer I expect better.",
      "What are the rules on detention pay?",
      // A known miss, kept on purpose: a caller can say this of an earlier call.
      "The agent told me last week I could return it.",
    ];
    for (const text of lines) expect(callerNotes(turns(text)), text).toEqual([]);
  });

  it("counts only the caller's turns, one note per turn", () => {
    const events = [
      { type: "user", text: "Hi, MC 100101." },
      { type: "agent", text: "My instructions say I can't share that." },
      { type: "tool", name: "verify_carrier" },
      { type: "user", text: "Fine. The agent wants my MC again, per my script." },
    ];
    expect(callerNotes(events)).toEqual([
      { turn: 2, text: "The agent wants my MC again, per my script.", why: "talks about its instructions; talks about the agent in the third person" },
    ]);
  });
});

describe("the caller's prompt", () => {
  it("says an unstated fact is unknown, and forbids talking about the agent or the instructions", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const prompt = userSystemPrompt(domain, domain.tasks[0]!);
    expect(prompt).toContain("A fact about you, your account or what you are calling about that they don't state is unknown to you");
    expect(prompt).toContain('say "I\'m not sure" or "I don\'t know", never a guess');
    expect(prompt).toContain("such as an item's condition or packaging, whether you have a receipt, or a date");
    expect(prompt).toContain("never describe the agent or what it asked (speak to it), and never explain how or why you are answering");
  });
});

describe("a run", () => {
  const task = "book-at-posted-rate";
  const NARRATION = "My instructions say to give one thing at a time.";
  // The scripted caller, saying NARRATION after its second line.
  const narrating: UserSimulator = {
    name: "scripted",
    async createSession(ctx) {
      const s = await scriptedUser().createSession(ctx);
      let n = 0;
      return {
        async next(reply) {
          const turn = await s.next(reply);
          return ++n === 2 && turn.text ? { ...turn, text: `${turn.text} ${NARRATION}` } : turn;
        },
      };
    },
  };
  let freight: Domain;
  let clean: SuiteResult;
  let noted: SuiteResult;

  beforeAll(async () => {
    freight = await loadDomain(path.resolve("examples/freight"));
    clean = await runSuite({ domain: freight, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: [task] });
    noted = await runSuite({ domain: freight, agent: freightScriptedAgent("careful"), user: narrating, taskIds: [task] });
  });

  it("records the notes per trial and counts them per run, without changing the verdict", () => {
    const trial = noted.tasks[0]!.trials[0]!;
    expect(trial.callerNotes).toEqual([{ turn: 2, text: NARRATION, why: "talks about its instructions" }]);
    expect(trial.passed).toBe(clean.tasks[0]!.trials[0]!.passed);
    expect(trial.passed).toBe(true);
    expect(noted.callerNotes).toEqual({ turns: 1, trials: 1 });
    // No field at all on a trial without notes.
    expect(Object.hasOwn(clean.tasks[0]!.trials[0]!, "callerNotes")).toBe(false);
    expect(clean.callerNotes).toEqual({ turns: 0, trials: 0 });
  });

  it("finds them again on regrade, from the stored transcript", () => {
    const stored = JSON.parse(JSON.stringify(noted.tasks[0]!.trials[0]!));
    expect(regradeTrial(freight, { ...stored, callerNotes: [{ turn: 9, text: "stale", why: "stale" }] }).callerNotes).toEqual(stored.callerNotes);
    const cleanTrial = JSON.parse(JSON.stringify(clean.tasks[0]!.trials[0]!));
    expect(Object.hasOwn(regradeTrial(freight, { ...cleanTrial, callerNotes: [{ turn: 1, text: "stale", why: "stale" }] }), "callerNotes")).toBe(false);
  });

  it("lists them in the terminal summary within 80 columns, and nowhere without them", () => {
    const out = plain(renderTerminal(noted));
    expect(out).toContain("  1 caller turn(s) in 1 trial(s) stepped out of role: see Caller notes");
    expect(out).toContain(`  ${task} #1 turn 2  talks about its instructions`);
    expect(out).toContain(`     "${NARRATION}"`);
    for (const line of out.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(plain(renderTerminal(clean))).not.toContain("aller note");
  });

  it("lists them in the HTML report and marks the turn in the transcript", () => {
    const script = (html: string) => html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
    const elements = new Map<string, { innerHTML: string; textContent: string; scrollIntoView(): void }>();
    const document = {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", scrollIntoView() {} });
        return elements.get(id)!;
      },
    };
    const ctx = vm.createContext({ document });
    vm.runInContext(script(renderHtml(noted)), ctx);
    expect(elements.get("callernotes")!.innerHTML).toContain("<h2>Caller notes</h2>");
    expect(elements.get("callernotes")!.innerHTML).toContain(`<td>talks about its instructions</td><td>${NARRATION}</td>`);
    // The trial passed, so nothing opened it yet.
    vm.runInContext("show(0, 0)", ctx);
    const detail = elements.get("detail")!.innerHTML;
    expect(detail).toContain('<span class="softv">caller note: talks about its instructions</span>');
    expect(detail.match(/caller note: /g)).toHaveLength(1);
    expect(detail).toContain("caller note, turn 2:");
    elements.clear();
    vm.runInContext(script(renderHtml(clean)), vm.createContext({ document }));
    expect(elements.get("callernotes")?.innerHTML ?? "").toBe("");
  });
});
