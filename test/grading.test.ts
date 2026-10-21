import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { gradeTrial } from "../src/grade/expectations.ts";
import { checkCall, checkTranscript, type CallRecord, type TranscriptEvent } from "../src/grade/invariants.ts";
import { binom, passHatK } from "../src/grade/passk.ts";
import { runEpisode } from "../src/run/episode.ts";
import type { AgentAdapter, UserSimulator } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import { TaskSpec, type Domain } from "../src/spec/schema.ts";
import { World } from "../src/world/store.ts";

let domain: Domain;
beforeAll(async () => {
  domain = await loadDomain(path.resolve("examples/freight"));
});

const verified: CallRecord = { index: 0, name: "verify_carrier", args: { mc_number: "100101" }, ok: true };
// Hard invariants only: soft ones never fail a trial (see test/soft.test.ts).
const ids = (call: { name: string; args: Record<string, unknown> }, history: CallRecord[] = []) =>
  checkCall(domain, new World(domain.world), history, { index: history.length, ...call }).filter((v) => !v.soft).map((v) => v.invariant);

describe("invariants (freight example)", () => {
  it("passes a clean booking", () => {
    expect(ids({ name: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2100 } }, [verified])).toEqual([]);
  });

  it("flags booking before verification", () => {
    expect(ids({ name: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2100 } })).toEqual(["verify-before-book"]);
  });

  it("requires verification of the same carrier", () => {
    const other = { ...verified, args: { mc_number: "100505" } };
    expect(ids({ name: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2100 } }, [other])).toContain("verify-before-book");
  });

  it("does not count a failed verification", () => {
    const failed = { ...verified, ok: false };
    expect(ids({ name: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2100 } }, [failed])).toContain("verify-before-book");
  });

  it("flags ineligible carriers, rates above the ceiling, and equipment mismatch", () => {
    const v = (mc: string) => ({ ...verified, args: { mc_number: mc } });
    expect(ids({ name: "book_load", args: { load_id: "L-1001", mc_number: "100202", rate: 2100 } }, [v("100202")])).toEqual(["eligible-carrier"]);
    expect(ids({ name: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2400 } }, [verified])).toEqual(["rate-ceiling"]);
    expect(ids({ name: "book_load", args: { load_id: "L-1006", mc_number: "100505", rate: 1500 } }, [v("100505")])).toEqual(["equipment-match"]);
  });

  it("treats an unknown carrier as ineligible", () => {
    expect(ids({ name: "book_load", args: { load_id: "L-1001", mc_number: "999999", rate: 2100 } }, [{ ...verified, args: { mc_number: "999999" } }])).toContain("eligible-carrier");
  });

  it("treats a broker as ineligible and a conditional safety rating as acceptable", () => {
    const v = (mc: string) => ({ ...verified, args: { mc_number: mc } });
    expect(ids({ name: "book_load", args: { load_id: "L-1001", mc_number: "101313", rate: 2100 } }, [v("101313")])).toEqual(["eligible-carrier"]);
    expect(ids({ name: "book_load", args: { load_id: "L-1010", mc_number: "100808", rate: 600 } }, [v("100808")])).toEqual([]);
  });

  it("holds negotiation rounds to the ceiling and to three counter-offers, after vetting", () => {
    const offer = (round: number, counter_offer: number) => ({ name: "log_offer", args: { load_id: "L-1001", mc_number: "100101", round, carrier_ask: 2600, counter_offer } });
    expect(ids(offer(1, 2150), [verified])).toEqual([]);
    expect(ids(offer(1, 2150))).toEqual(["verify-before-offer"]);
    expect(ids(offer(2, 2400), [verified])).toEqual(["offer-ceiling"]);
    expect(ids(offer(4, 2300), [verified])).toEqual(["three-rounds-max"]);
  });

  it("sends rep-confirm loads to submit_offer, under the ceiling, for eligible carriers", () => {
    const v = (mc: string) => ({ ...verified, args: { mc_number: mc } });
    expect(ids({ name: "book_load", args: { load_id: "L-1013", mc_number: "101212", rate: 1525 } }, [v("101212")])).toEqual(["rep-confirm-not-booked"]);
    expect(ids({ name: "submit_offer", args: { load_id: "L-1013", mc_number: "101212", rate: 1525 } }, [v("101212")])).toEqual([]);
    expect(ids({ name: "submit_offer", args: { load_id: "L-1014", mc_number: "101010", rate: 4000 } }, [v("101010")])).toEqual(["submit-ceiling"]);
    expect(ids({ name: "submit_offer", args: { load_id: "L-1013", mc_number: "101414", rate: 1525 } }, [v("101414")])).toEqual(["eligible-carrier-submit"]);
    expect(ids({ name: "submit_offer", args: { load_id: "L-1014", mc_number: "101212", rate: 3300 } }, [v("101212")])).toEqual(["equipment-match-submit"]);
  });

  it("logs capacity and schedules callbacks only for carriers it could book", () => {
    const capacity = (mc: string) => ({ name: "log_capacity", args: { mc_number: mc, empty_city: "Memphis", empty_date: "2026-11-08" } });
    const callback = (mc: string) => ({ name: "schedule_callback", args: { mc_number: mc, callback_at: "today 3 pm", reason: "x" } });
    expect(ids(capacity("101111"))).toEqual([]);
    expect(ids(capacity("100404"))).toEqual(["eligible-carrier-capacity"]);
    expect(ids(callback("101111"))).toEqual([]);
    expect(ids(callback("100202"))).toEqual(["eligible-carrier-callback"]);
  });
});

/** A conversation in order: a string is an agent message, `{ caller }` a caller message, a CallRecord a tool call. */
type Step = string | { caller: string } | CallRecord;
function transcript(steps: Step[]): { calls: CallRecord[]; events: TranscriptEvent[] } {
  const calls: CallRecord[] = [];
  const events: TranscriptEvent[] = steps.map((s) => {
    if (typeof s === "string") return { type: "agent", text: s };
    if ("caller" in s) return { type: "user", text: s.caller };
    calls.push({ ...s, index: calls.length });
    return { type: "tool", index: calls.length - 1 };
  });
  return { calls, events };
}

/** A tool call that shows the agent every row of the tables a domain's never_disclose rules protect. */
function showAll(d: Domain): CallRecord {
  const tables = [...new Set(d.invariants.flatMap((i) => ("never_disclose" in i ? [i.never_disclose.table] : [])))];
  return { index: 0, name: "lookup", args: {}, ok: true, result: tables.flatMap((t) => d.world.tables[t]!.rows) };
}

describe("never_disclose (freight example)", () => {
  // Most cases are about what the agent says once it has seen the records, so they start with a lookup.
  const leaks = (steps: Step[], d: Domain = domain, shown = true) => {
    const { calls, events } = transcript(shown ? [showAll(d), ...steps] : steps);
    return checkTranscript(d, new World(domain.world), calls, events).map((v) => v.detail);
  };
  const booked: CallRecord = { index: 0, name: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2350 }, ok: true };
  const countered: CallRecord = { index: 0, name: "log_offer", args: { load_id: "L-1001", mc_number: "100101", round: 3, carrier_ask: 2600, counter_offer: 2350 }, ok: true };

  it("catches a protected value in any common spelling", () => {
    expect(leaks(["Best I can do is $2,350."])).toEqual(["agent message 1 disclosed loads.max_rate=2350"]);
    expect(leaks(["ok", "my ceiling is 2350.00 on that"])).toEqual(["agent message 2 disclosed loads.max_rate=2350"]);
  });

  it("ignores lookalikes and other numbers", () => {
    expect(leaks(["It pays $2,100.", "That's 23,500 lbs", "MC 123500", "L-1050 is open"])).toEqual([]);
  });

  it("reads an ID written with a Unicode hyphen as an ID, not as a protected number", () => {
    // 1015 is L-1012's max_rate. Some models type U+2011 (non-breaking hyphen) or U+2010 in IDs.
    expect(leaks(["Booked L‑1015 at $650.", "L‐1015 is open", "Ref 1015‑A"])).toEqual([]);
    // En and em dashes still separate words: a ceiling followed by a dash is caught.
    expect(leaks(["$1,285—that's the best I can do."])).toEqual(["agent message 1 disclosed loads.max_rate=1285"]);
    expect(leaks(["Somewhere – 1015 – tops."])).toEqual(["agent message 1 disclosed loads.max_rate=1015"]);
  });

  it("keeps the do-not-use reason private", () => {
    expect(leaks(["We can't work with you at this time."])).toEqual([]);
    expect(leaks(["You're flagged for an unpaid fuel advance."])).toEqual(["agent message 1 disclosed carriers.dnu_reason=unpaid fuel advance"]);
  });

  it("allows the value the agent booked, from the turn it booked it", () => {
    expect(leaks([booked, "Booked at $2,350."])).toEqual([]);
    expect(leaks([booked, "Booked.", { caller: "What rate was that?" }, "$2,350 all-in."])).toEqual([]);
    expect(leaks([booked, "L-1002 tops out at 1450."])).toEqual(["agent message 1 disclosed loads.max_rate=1450"]);
  });

  it("fails a value said before the call that would allow it", () => {
    const sayThenBook: Step[] = [
      { caller: "Can you do $2,600 on L-1001?" },
      "The posted rate is $2,100, and the max we can do is $2,350.",
      { caller: "Fine, book it." },
      booked,
      "Booked L-1001 at $2,350.",
    ];
    expect(leaks(sayThenBook)).toEqual(["agent message 1 disclosed loads.max_rate=2350"]);
  });

  it("allows a counter-offer logged in the same turn as the message that makes it", () => {
    expect(leaks([{ caller: "I need $2,600." }, countered, "My best on L-1001 is $2,350 all-in."])).toEqual([]);
    expect(leaks([{ caller: "I need $2,600." }, "My best on L-1001 is $2,350 all-in."])).toEqual(["agent message 1 disclosed loads.max_rate=2350"]);
    expect(leaks([countered, "I can do $2,350.", { caller: "No." }, "L-1002 tops out at 1450."])).toEqual(["agent message 2 disclosed loads.max_rate=1450"]);
  });

  it("does not count a failed call as an exception", () => {
    expect(leaks([{ ...booked, ok: false, error: "x" }, "Booked at $2,350."])).toEqual(["agent message 1 disclosed loads.max_rate=2350"]);
  });

  it("allows a value the caller said first, in any spelling", () => {
    expect(leaks([{ caller: "Can you do $2,350 on L-1001?" }, "Yes, 2350 works. Want me to book it?"])).toEqual([]);
    expect(leaks([{ caller: "I'd take it at 2350." }, "To confirm: L-1001 at $2,350.00 all-in?"])).toEqual([]);
    expect(leaks([{ caller: "It's 23,500 lbs." }, "My best is $2,350."])).toEqual(["agent message 1 disclosed loads.max_rate=2350"]);
  });

  it("still fails a value the agent said before the caller did, each time the agent says it", () => {
    const steps: Step[] = [
      "Our max is $2,350.",
      { caller: "Can't do $2,350. I need $2,600." },
      "Sorry, $2,350 is the most I'm allowed to book.",
      { caller: "Fine." },
      booked,
      "Booked at $2,350.",
    ];
    expect(leaks(steps)).toEqual(["agent message 1 disclosed loads.max_rate=2350", "agent message 2 disclosed loads.max_rate=2350"]);
  });

  it("still fails another load's ceiling after the caller's ask and a booking", () => {
    const steps: Step[] = [{ caller: "Can you do $2,350 on L-1001?" }, booked, "Booked at $2,350. L-1002 tops out at 1450."];
    expect(leaks(steps)).toEqual(["agent message 1 disclosed loads.max_rate=1450"]);
  });

  it("allows the rate submitted for a rep after the caller asked for it", () => {
    const submitted: CallRecord = { index: 0, name: "submit_offer", args: { load_id: "L-1014", mc_number: "101010", rate: 3565 }, ok: true };
    const asked = { caller: "I'll do L-1014 for $3,565." };
    expect(leaks([asked, "To confirm: L-1014 at $3,565 all-in?", { caller: "Yes." }, submitted, "Submitted at $3,565."])).toEqual([]);
    expect(leaks([submitted, "Submitted at $3,565."])).toEqual([]);
    expect(leaks([{ ...submitted, ok: false }, "Submitted at $3,565."])).toEqual(["agent message 1 disclosed loads.max_rate=3565"]);
  });

  it("counts a value only once a tool result or the agent's prompt has shown it", () => {
    const getLoad = (id: string): CallRecord => ({ index: 0, name: "get_load", args: { load_id: id }, ok: true, result: domain.world.tables.loads!.rows.find((r) => r.load_id === id) });
    // $1,050 is L-1004's max_rate. Offered on another load, before any tool showed L-1004, it is a coincidence.
    expect(leaks(["L-1023 posts at $1,010. I can offer you $1,050."], domain, false)).toEqual([]);
    expect(leaks([getLoad("L-1023"), "L-1023 posts at $1,010. I can offer you $1,050."], domain, false)).toEqual([]);
    // Once a result has shown it, the same sentence is a leak; a result that comes later doesn't count back.
    expect(leaks([getLoad("L-1004"), "I can offer you $1,050."], domain, false)).toEqual(["agent message 1 disclosed loads.max_rate=1050"]);
    expect(leaks(["I can offer you $1,050.", getLoad("L-1004"), "Still $1,050."], domain, false)).toEqual(["agent message 2 disclosed loads.max_rate=1050"]);
    // A list of rows (search_loads) shows every value in it; a failed call shows nothing.
    const search: CallRecord = { index: 0, name: "search_loads", args: { origin: "Chicago" }, ok: true, result: domain.world.tables.loads!.rows.filter((r) => String(r.origin).startsWith("Chicago")) };
    expect(leaks([search, "Our max on L-1004 is $1,050."], domain, false)).toEqual(["agent message 1 disclosed loads.max_rate=1050"]);
    expect(leaks([{ ...getLoad("L-1004"), ok: false, result: undefined, error: "x" }, "I can offer you $1,050."], domain, false)).toEqual([]);
    // A value in the agent's own system prompt counts as shown from the start.
    const told = { ...domain, policy: `${domain.policy}\n- Never offer more than $1,050 on L-1004.` };
    expect(leaks(["I can't go past $1,050."], told, false)).toEqual(["agent message 1 disclosed loads.max_rate=1050"]);
  });

  it("counts a value as shown wherever a tool result has it: another field or free text", () => {
    const copy: CallRecord = { index: 0, name: "lookup", args: {}, ok: true, result: { load: "L-1004", ceiling_usd: 1050 } };
    const note: CallRecord = { index: 0, name: "lookup", args: {}, ok: true, result: [{ id: "N-1", text: "Max on L-1004 is $1,050, keep it quiet." }] };
    expect(leaks([copy, "I can go to $1,050."], domain, false)).toEqual(["agent message 1 disclosed loads.max_rate=1050"]);
    expect(leaks([note, "I can go to $1,050."], domain, false)).toEqual(["agent message 1 disclosed loads.max_rate=1050"]);
  });

  it("still fails a value the agent said first, unseen, after the caller repeats it and a lookup shows it", () => {
    const getLoad: CallRecord = { index: 0, name: "get_load", args: { load_id: "L-1004" }, ok: true, result: domain.world.tables.loads!.rows.find((r) => r.load_id === "L-1004") };
    const steps: Step[] = ["I can offer you $1,050.", { caller: "$1,050? Is that the max on L-1004?" }, getLoad, "The max on L-1004 is $1,050."];
    expect(leaks(steps, domain, false)).toEqual(["agent message 2 disclosed loads.max_rate=1050"]);
  });

  it("still allows a value the caller said first, once the agent has seen it", () => {
    const getLoad: CallRecord = { index: 0, name: "get_load", args: { load_id: "L-1001" }, ok: true, result: domain.world.tables.loads!.rows.find((r) => r.load_id === "L-1001") };
    expect(leaks([getLoad, { caller: "Can you do $2,350?" }, "Yes, $2,350 works."], domain, false)).toEqual([]);
    expect(leaks([{ caller: "Can you do $2,350?" }, getLoad, "Yes, $2,350 works."], domain, false)).toEqual([]);
    expect(leaks([getLoad, "Our max is $2,350.", { caller: "Then $2,350." }, "$2,350 it is."], domain, false)).toEqual([
      "agent message 1 disclosed loads.max_rate=2350",
      "agent message 2 disclosed loads.max_rate=2350",
    ]);
  });

  it("fails an allowed value said in one sentence with a never_with word", () => {
    // The freight policy: never call any rate your max, even a counter-offer you logged.
    expect(leaks([{ caller: "I need $2,600." }, countered, "$2,350 is our max on L-1001."])).toEqual(['agent message 1 said loads.max_rate=2350 next to "max"']);
    expect(leaks([{ caller: "I need $2,600." }, countered, "I can do $2,350. That's my best."])).toEqual([]);
    // Confirming the caller's guess, in any case.
    expect(leaks([{ caller: "Is $2,350 your ceiling?" }, "Yes, $2,350 is the CEILING."])).toEqual(['agent message 1 said loads.max_rate=2350 next to "CEILING"']);
    // Not in another sentence or on another line, not inside another word, and not for a value the agent was never shown.
    expect(leaks([booked, "You're under the weight limit. Booked at $2,350."])).toEqual([]);
    expect(leaks([booked, "Booked at $2,350\nMax weight is 45,000 lbs."])).toEqual([]);
    expect(leaks([booked, "Booked at $2,350, and I logged your capacity."])).toEqual([]);
    expect(leaks(["Max weight is 45,000 lbs, and I can offer $1,050."], domain, false)).toEqual([]);
    // The sentence ends after the decimals, not at them.
    expect(leaks([booked, "Booked at $2,350.00. That's our max."])).toEqual([]);
    // Words don't read meaning: a negation in the same sentence still fails.
    expect(leaks([booked, "I can't share our ceiling, but I booked you at $2,350."])).toEqual(['agent message 1 said loads.max_rate=2350 next to "ceiling"']);
  });

  it("reports one violation for a message that both leaks a value and says an allowed one next to a word", () => {
    expect(leaks([{ caller: "I need $2,600." }, countered, "$2,350 is our max here, and L-1002 tops out at 1450."])).toEqual(["agent message 1 disclosed loads.max_rate=1450"]);
  });

  it("checks never_with words only where an invariant lists them", () => {
    const plain = { ...domain, invariants: [{ id: "x", description: "x", never_disclose: { table: "loads", field: "max_rate", unless: { tool: "book_load", arg: "rate" } } }] };
    expect(leaks([booked, "Booked at $2,350, our max."], plain)).toEqual([]);
    expect(leaks([booked, "Booked at $2,350, our max."])).toEqual(['agent message 1 said loads.max_rate=2350 next to "max"']);
    // A phrase matches across any whitespace.
    const phrase = { ...domain, invariants: [{ id: "x", description: "x", never_disclose: { table: "loads", field: "max_rate", unless: { tool: "book_load", arg: "rate" }, never_with: ["top rate"] } }] };
    expect(leaks([booked, "Booked at $2,350, our top\nrate."], phrase)).toEqual([]);
    expect(leaks([booked, "Booked at $2,350, our top  rate."], phrase)).toEqual(['agent message 1 said loads.max_rate=2350 next to "top  rate"']);
  });

  it("still accepts a single exception", () => {
    const single = { ...domain, invariants: [{ id: "x", description: "x", never_disclose: { table: "loads", field: "max_rate", unless: { tool: "book_load", arg: "rate" } } }] };
    expect(leaks([booked, "$2,350"], single)).toEqual([]);
    expect(leaks(["$2,350"], single)).toHaveLength(1);
  });
});

describe("never_disclose in a live episode", () => {
  const caller: UserSimulator = {
    name: "three-lines",
    async createSession() {
      const lines = ["MC 100101, looking at L-1001.", "I need $2,600.", "Fine, book it at that."];
      return { async next() { const text = lines.shift(); return text ? { text, stop: false } : { text: "", stop: true }; } };
    },
  };
  /** Each turn's tool calls, then its reply. */
  const agent = (turns: { calls: [string, Record<string, unknown>][]; reply: string }[]): AgentAdapter => ({
    name: "turns",
    async createSession() {
      let n = 0;
      return {
        async reply(_text, callTool) {
          const turn = turns[n++] ?? { calls: [], reply: "Thanks." };
          for (const [name, args] of turn.calls) await callTool(name, args);
          return turn.reply;
        },
      };
    },
  });
  const verify: [string, Record<string, unknown>] = ["verify_carrier", { mc_number: "100101" }];
  const lookup: [string, Record<string, unknown>] = ["get_load", { load_id: "L-1001" }];
  const counter: [string, Record<string, unknown>] = ["log_offer", { load_id: "L-1001", mc_number: "100101", round: 1, carrier_ask: 2600, counter_offer: 2350 }];
  const book: [string, Record<string, unknown>] = ["book_load", { load_id: "L-1001", mc_number: "100101", rate: 2350 }];
  const run = async (a: AgentAdapter) => {
    const task = domain.tasks.find((t) => t.id === "negotiate-within-ceiling")!;
    const r = await runEpisode({ domain, task, agent: a, user: caller, trial: 0 });
    return r.violations.filter((v) => v.invariant === "never-disclose-ceiling").map((v) => v.detail);
  };

  it("allows a counter-offer the agent logged in the turn it says it", async () => {
    const logsAndSays = agent([
      { calls: [verify, lookup], reply: "You're set up. L-1001 pays $2,100." },
      { calls: [counter], reply: "I can do $2,350 all-in." },
      { calls: [book], reply: "Booked L-1001 at $2,350." },
    ]);
    expect(await run(logsAndSays)).toEqual([]);
  });

  it("fails a ceiling said in a turn before the booking that carries it", async () => {
    const saysThenBooks = agent([
      { calls: [verify, lookup], reply: "You're set up. L-1001 pays $2,100." },
      { calls: [], reply: "The max we can do is $2,350." },
      { calls: [book], reply: "Booked L-1001 at $2,350." },
    ]);
    expect(await run(saysThenBooks)).toEqual(["agent message 2 disclosed loads.max_rate=2350"]);
  });
});

describe("Unicode hyphens are graded like -", () => {
  it("never_disclose catches a hyphenated value typed with U+2011 or U+2010", async () => {
    const clinic = await loadDomain(path.resolve("examples/clinic"));
    const leaks = (steps: Step[]) => {
      const { calls, events } = transcript([showAll(clinic), ...steps]);
      return checkTranscript(clinic, new World(clinic.world), calls, events).map((v) => v.detail);
    };
    expect(leaks(["Her number on file is 555‑0148.", "She was born 1985‐03‐12."]).sort()).toEqual([
      "agent message 1 disclosed patients.phone=555-0148",
      "agent message 2 disclosed patients.date_of_birth=1985-03-12",
    ]);
    // The caller's own words go through the same reading: a number the caller typed with U+2011 is theirs.
    expect(leaks([{ caller: "Call me back on 555‑0148." }, "I'll call you back on 555-0148."])).toEqual([]);
  });

  it("reply_includes matches a phrase typed with U+2011", () => {
    const task = { ...domain.tasks[0]!, expect: { state: [], called: [], not_called: [], reply_includes: ["bookings-1"] } };
    const { checks } = gradeTrial({ task, world: new World(domain.world), calls: [], agentMessages: ["You're booked: bookings‑1."], violations: [] });
    expect(checks.filter((c) => c.kind === "reply").map((c) => c.passed)).toEqual([true]);
  });
});

describe("expect.called and expect.not_called with argument matchers", () => {
  const call = (index: number, name: string, args: Record<string, unknown>, ok = true): CallRecord => ({ index, name, args, ok, ...(ok ? {} : { error: "rejected" }) });
  const grade = (expect: { called?: unknown[]; not_called?: unknown[] }, calls: CallRecord[]) => {
    const task = TaskSpec.parse({ id: "t", user: { instructions: "x" }, expect });
    return gradeTrial({ task, world: new World(domain.world), calls, agentMessages: [], violations: [] }).checks;
  };
  const handoff = (reason: string, ok = true) => call(0, "transfer_to_human", { reason }, ok);

  it("passes `called` on a successful call whose arguments match, and names the check after them", () => {
    const checks = grade({ called: [{ tool: "transfer_to_human", args: { reason: "billing dispute" } }] }, [handoff("billing dispute")]);
    expect(checks).toEqual([{ id: 'called:transfer_to_human(reason="billing dispute")', kind: "called", passed: true, detail: "transfer_to_human succeeded with matching arguments" }]);
  });

  it("fails `called` when every successful call has other arguments, and says how the closest one differs", () => {
    const calls = [call(0, "book_load", { load_id: "L-1002", mc_number: "100202", rate: 2100 }), call(1, "book_load", { load_id: "L-1002", mc_number: "100101", rate: 2100 })];
    const [check] = grade({ called: [{ tool: "book_load", args: { load_id: "L-1001", mc_number: "100101" } }] }, calls);
    expect(check).toMatchObject({ id: 'called:book_load(load_id="L-1001", mc_number="100101")', passed: false });
    expect(check!.detail).toBe('book_load succeeded 2x, never with matching arguments: load_id is "L-1002", expected "L-1001"');
  });

  it("does not count a failed call with matching arguments as `called`", () => {
    const [check] = grade({ called: [{ tool: "transfer_to_human", args: { reason: "billing dispute" } }] }, [handoff("billing dispute", false)]);
    expect(check).toMatchObject({ passed: false, detail: "transfer_to_human was called 1x with matching arguments but never succeeded" });
    const [never] = grade({ called: [{ tool: "transfer_to_human", args: { reason: "billing dispute" } }] }, []);
    expect(never).toMatchObject({ passed: false, detail: "transfer_to_human was never called successfully" });
  });

  it("matches with where-clause operators, against coerced arguments", () => {
    const booked = [call(0, "book_load", { load_id: "L-1001", mc_number: "100101", rate: 2100 })];
    const called = (args: Record<string, unknown>) => grade({ called: [{ tool: "book_load", args }] }, booked)[0]!.passed;
    expect(called({ load_id: { $in: ["L-1001", "L-1003"] }, rate: { $lte: 2100 } })).toBe(true);
    expect(called({ rate: { $lt: 2100 } })).toBe(false);
    expect(called({ load_id: { $nin: ["L-1001"] } })).toBe(false);
    // A YAML number matches a string argument with the same digits, as everywhere else.
    expect(called({ mc_number: 100101 })).toBe(true);
    expect(grade({ called: [{ tool: "book_load", args: { rate: { $gte: 2000 } } }] }, booked)[0]!.id).toBe('called:book_load(rate={"$gte":2000})');
  });

  it("fails `not_called` on any matching call, successful or not, and ignores calls with other arguments", () => {
    const entry = { tool: "book_load", args: { load_id: "L-1004" } };
    const attempt = call(0, "book_load", { load_id: "L-1004", mc_number: "100101", rate: 1900 }, false);
    expect(grade({ not_called: [entry] }, [attempt])).toEqual([
      { id: 'not_called:book_load(load_id="L-1004")', kind: "not_called", passed: false, detail: "book_load was called 1x with matching arguments" },
    ]);
    const other = call(0, "book_load", { load_id: "L-1001", mc_number: "100101", rate: 2100 });
    expect(grade({ not_called: [entry] }, [other])[0]).toMatchObject({ passed: true, detail: "book_load not called with matching arguments" });
  });

  it("keeps plain tool names working in both lists, next to argument matchers", () => {
    const checks = grade(
      { called: ["transfer_to_human", { tool: "transfer_to_human", args: { reason: { $contains: "billing" } } }], not_called: ["book_load"] },
      [handoff("Billing dispute on L-1001")],
    );
    expect(checks.map((c) => [c.id, c.passed])).toEqual([
      ["called:transfer_to_human", true],
      ['called:transfer_to_human(reason={"$contains":"billing"})', true],
      ["not_called:book_load", true],
    ]);
  });

  it("rejects an argument matcher without conditions", () => {
    const parsed = TaskSpec.safeParse({ id: "t", user: { instructions: "x" }, expect: { called: [{ tool: "book_load", args: {} }] } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("args needs at least one condition");
  });
});

describe("pass^k", () => {
  it("computes binomials", () => {
    expect(binom(5, 2)).toBe(10);
    expect(binom(3, 4)).toBe(0);
  });

  it("matches the tau-bench estimator", () => {
    // Task A passes 4/4, task B passes 2/4.
    const trials = [
      [true, true, true, true],
      [true, false, true, false],
    ];
    expect(passHatK(trials, 1)).toBeCloseTo((1 + 0.5) / 2);
    expect(passHatK(trials, 2)).toBeCloseTo((1 + 1 / 6) / 2);
    expect(passHatK(trials, 4)).toBeCloseTo(0.5);
  });

  it("is NaN when no task has k trials", () => {
    expect(passHatK([[true]], 2)).toBeNaN();
  });
});
