import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { renderHtml } from "../src/report/html.ts";
import { runSuite } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";

/** Run the report's script against a stand-in for the page, open one trial, and return what it shows. */
function openTrial(html: string, task: number, trial: number): string {
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  const elements = new Map<string, { innerHTML: string; textContent: string; scrollIntoView(): void }>();
  const document = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", scrollIntoView() {} });
      return elements.get(id)!;
    },
  };
  const page = vm.createContext({ document });
  vm.runInContext(`${script}\nshow(${task}, ${trial});`, page);
  return elements.get("detail")!.innerHTML;
}

describe("HTML report world changes", () => {
  it("shows an update as the fields it changed, with the whole row behind a toggle, and an insert as its row", async () => {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.changes.map((c) => c.kind).sort()).toEqual(["insert", "update"]);
    const lines = openTrial(renderHtml(r), 0, 0).split('<div class="change">').slice(1);
    const update = lines.find((l) => l.startsWith("update loads L-1001"))!;
    // Only the field that changed is shown before the toggle; the rest of the row is behind it.
    const [shown, hidden] = update.split("<details>");
    expect(shown).toBe("update loads L-1001 <b>status</b> &quot;available&quot; → &quot;booked&quot;");
    expect(hidden).toContain("<summary>whole row</summary>");
    expect(hidden).toContain("&quot;origin&quot;: &quot;Dallas, TX&quot;");
    const insert = lines.find((l) => l.startsWith("insert bookings"))!;
    expect(insert).not.toContain("<details>");
    expect(insert).toContain("&quot;load_id&quot;: &quot;L-1001&quot;");
  });

  it("marks a field an update added or removed as unset on the other side", () => {
    const r = {
      domain: "d", agent: "a", user: "u", k: 1, startedAt: "", durationMs: 0, passHat: { "1": 1 }, failureModes: [], byTag: [], soft: [], pendingReview: [],
      usage: { agent: {}, user: {}, costUsd: null }, latency: { agentTurnP50Ms: null, agentTurnP95Ms: null }, inputs: "x", runId: "r", version: 1,
      tasks: [{ id: "t", description: "", tags: [], passes: 1, trials: [{ taskId: "t", trial: 0, passed: true, endReason: "user_stop", turns: 1, durationMs: 0, checks: [], violations: [], events: [],
        changes: [{ table: "loads", key: "L-1", kind: "update", before: { status: "open", note: "x" }, after: { status: "open", hold: true } }] }] }],
    };
    const html = openTrial(renderHtml(r as never), 0, 0);
    expect(html).toContain("<b>note</b> &quot;x&quot; → (unset), <b>hold</b> (unset) → true<details>");
  });
});
