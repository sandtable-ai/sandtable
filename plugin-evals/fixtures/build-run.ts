// Rebuilds fixtures/wrenfield-run/results.json, the stored run the attribution and regrade cases read, without
// calling a model: the careful rule-based agent answers a scripted caller. The result is then labelled as a live
// run (an HTTP agent and a Claude caller) and its inputs hash recomputed for that caller, so the cases read it
// like a real rehearsal and `sandtable regrade` accepts it. Run it whenever the agent's or the caller's prompts
// change: test/plugin-evals.test.ts fails until the stored hash matches the current code.
//
//   node plugin-evals/fixtures/build-run.ts

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDomain } from "../../src/spec/load.ts";
import { runSuite, type SuiteResult } from "../../src/run/suite.ts";
import { inputsFingerprint, taskFingerprints } from "../../src/run/inputs.ts";
import { scriptedUser } from "../../src/sim/scripted.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** What the caller says in each task. The guest's receipt is the caller's own invention: its instructions never mention one. */
export const SCRIPTS: Record<string, string[]> = {
  "return-boots-silver": ["Hi, I'm Orrin Petch, account A-502. I want to return the rain boots from order O-2002, they're the wrong size.", "Great, thanks!"],
  "jacket-not-on-order": ["Hi, this is Bram Holloway, account A-504. I want to return the trail jacket from order O-2004, it's the wrong size.", "Oh, okay. Thanks anyway."],
  "guest-receipt": ["Hi, I'm Linnea Quarry, account A-503. I want to return the camp stove from order O-2003, I changed my mind.", "Yes, I have the receipt right here.", "Thanks!"],
  "return-jacket-gold": ["Hi, I want to return order O-2001, the trail jacket arrived damaged.", "Sure, it's A-501, Tamsin Vale.", "Thank you!"],
};

/** The labels the stored run carries: the team's own agent behind the HTTP step protocol, and a Claude caller. */
export const AGENT_LABEL = "http://localhost:8787/step";
export const USER_LABEL = "claude:claude-haiku-5-5";

export async function buildRun(): Promise<SuiteResult> {
  const domain = await loadDomain(path.join(here, "wrenfield"));
  const scripted = { ...domain, tasks: domain.tasks.map((t) => ({ ...t, user: { ...t.user, script: SCRIPTS[t.id] } })) };
  const agent = (await import("./careful-agent.ts")).default;
  const run = await runSuite({ domain: scripted, agent, user: scriptedUser(), k: 1, concurrency: 1 });
  // Fixed ids, times and durations, so a rebuild only changes what the code changed.
  const trials = run.tasks.flatMap((t) => t.trials);
  for (const tr of trials) {
    tr.durationMs = 2400;
    for (const e of tr.events) if (e.type === "agent") e.latencyMs = 800;
  }
  // The task hashes `run --baseline` compares, recomputed for the caller the run is labelled with (a scripted
  // caller's script is part of them).
  const tasks = run.tasks.map((t) => ({ ...t, ...taskFingerprints(domain, domain.tasks.find((d) => d.id === t.id)!, USER_LABEL) }));
  return {
    ...run,
    tasks,
    // A fixed version, so a release doesn't change the stored run.
    sandtable: { version: "0.3.0" },
    runId: "20261102T090000-wrfd",
    agent: AGENT_LABEL,
    user: USER_LABEL,
    inputs: inputsFingerprint(domain, domain.tasks.map((t) => t.id), USER_LABEL),
    startedAt: "2026-11-02T09:00:00.000Z",
    durationMs: 9600,
    latency: { agentTurnP50Ms: 800, agentTurnP95Ms: 800 },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = await buildRun();
  const out = path.join(here, "wrenfield-run");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "results.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`${path.relative(process.cwd(), out)}/results.json: ${run.tasks.map((t) => `${t.id} ${t.passes}/${t.trials.length}`).join(", ")}`);
}
