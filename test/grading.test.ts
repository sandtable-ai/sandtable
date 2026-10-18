import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkCall, type CallRecord } from "../src/grade/invariants.ts";
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
