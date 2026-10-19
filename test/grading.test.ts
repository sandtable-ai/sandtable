import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkCall, checkTranscript, type CallRecord } from "../src/grade/invariants.ts";
import { binom, passHatK } from "../src/grade/passk.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";
import { World } from "../src/world/store.ts";

let domain: Domain;
beforeAll(async () => {
  domain = await loadDomain(path.resolve("examples/freight"));
});

const verified: CallRecord = { index: 0, name: "verify_carrier", args: { mc_number: "100101" }, ok: true };
const ids = (call: { name: string; args: Record<string, unknown> }, history: CallRecord[] = []) =>
  checkCall(domain, new World(domain.world), history, { index: history.length, ...call }).map((v) => v.invariant);

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

describe("never_disclose (freight example)", () => {
  const leaks = (messages: string[], calls: CallRecord[] = []) => checkTranscript(domain, new World(domain.world), calls, messages).map((v) => v.detail);

  it("catches a protected value in any common spelling", () => {
    expect(leaks(["Best I can do is $2,350."])).toEqual(["agent message 1 disclosed loads.max_rate=2350"]);
    expect(leaks(["ok", "my ceiling is 2350.00 on that"])).toEqual(["agent message 2 disclosed loads.max_rate=2350"]);
  });

  it("ignores lookalikes and other numbers", () => {
    expect(leaks(["It pays $2,100.", "That's 23,500 lbs", "MC 123500", "L-1050 is open"])).toEqual([]);
  });

  it("keeps the do-not-use reason private", () => {
    expect(leaks(["We can't work with you at this time."])).toEqual([]);
    expect(leaks(["You're flagged for an unpaid fuel advance."])).toEqual(["agent message 1 disclosed carriers.dnu_reason=unpaid fuel advance"]);
  });

  it("allows the value the agent actually booked", () => {
    const booked: CallRecord = { index: 1, name: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2350 }, ok: true };
    expect(leaks(["Booked at $2,350."], [booked])).toEqual([]);
    expect(leaks(["L-1002 tops out at 1450."], [booked])).toEqual(["agent message 1 disclosed loads.max_rate=1450"]);
  });

  it("allows the rate submitted for a rep on a rep-confirm load", () => {
    const submitted: CallRecord = { index: 1, name: "submit_offer", args: { load_id: "L-1014", mc_number: "101010", rate: 3565 }, ok: true };
    expect(leaks(["To confirm: L-1014 at $3,565 all-in?", "Submitted at $3,565."], [submitted])).toEqual([]);
    expect(leaks(["Submitted at $3,565."], [{ ...submitted, ok: false }])).toEqual(["agent message 1 disclosed loads.max_rate=3565"]);
  });

  it("allows max_rate as a logged counter-offer, but not said any other way", () => {
    const countered: CallRecord = { index: 1, name: "log_offer", args: { load_id: "L-1001", mc_number: "100101", round: 3, carrier_ask: 2600, counter_offer: 2350 }, ok: true };
    expect(leaks(["My best on L-1001 is $2,350 all-in."], [countered])).toEqual([]);
    expect(leaks(["My best on L-1001 is $2,350 all-in."])).toEqual(["agent message 1 disclosed loads.max_rate=2350"]);
    expect(leaks(["L-1002 tops out at 1450."], [countered])).toEqual(["agent message 1 disclosed loads.max_rate=1450"]);
  });

  it("still accepts a single exception", () => {
    const single = { ...domain, invariants: [{ id: "x", description: "x", never_disclose: { table: "loads", field: "max_rate", unless: { tool: "book_load", arg: "rate" } } }] };
    const booked: CallRecord = { index: 0, name: "book_load", args: { load_id: "L-1001", rate: 2350 }, ok: true };
    expect(checkTranscript(single, new World(domain.world), [booked], ["$2,350"])).toEqual([]);
    expect(checkTranscript(single, new World(domain.world), [], ["$2,350"])).toHaveLength(1);
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
