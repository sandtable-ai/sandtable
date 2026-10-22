import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseResults } from "../src/run/read.ts";

// Every results.json sandtable has written says `version: 1`. A reader refuses a version it doesn't know, so after a
// format change an older CLI says it can't read the file instead of misreading it.

const stored = JSON.parse(readFileSync("plugin-evals/fixtures/wrenfield-run/results.json", "utf8")) as Record<string, unknown>;
const text = (patch: Record<string, unknown>) => JSON.stringify({ ...stored, ...patch });

describe("parseResults and the format version", () => {
  it("reads version 1", () => {
    expect(parseResults(text({}), "r.json").version).toBe(1);
  });

  it("refuses a newer version and says to use a newer sandtable-ai", () => {
    expect(() => parseResults(text({ version: 2 }), "runs/r.json")).toThrow(
      "runs/r.json is results.json format version 2, from a newer sandtable; this one reads format version 1. Run the command with a newer sandtable-ai, such as `npx sandtable-ai@latest`.",
    );
  });

  it("reads a file made without a version as version 1", () => {
    const { version: _, ...rest } = stored;
    expect(parseResults(JSON.stringify(rest), "r.json").domain).toBe(stored.domain);
  });

  it("refuses a version that isn't one", () => {
    for (const version of [0, 1.5, "1", null]) {
      expect(() => parseResults(text({ version }), "r.json"), String(version)).toThrow("r.json is not a results.json written by `sandtable run`");
    }
  });
});
