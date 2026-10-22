import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { draftInvariantsFromSop } from "../src/init/sop.ts";
import { draftTasksFromTranscripts } from "../src/init/transcripts.ts";
import { draftUsageLines } from "../src/report/terminal.ts";
import { loadDomain } from "../src/spec/load.ts";

// `init --sop` and `--transcripts` call Claude once for the SOP and once per transcript. Each step returns what its
// calls used, per model, and the CLI prints it with an estimated cost, as `run` does.

const usage = { input_tokens: 12000, output_tokens: 4000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function fakeClient(outputs: unknown[], model = "claude-sonnet-5-5") {
  const client = {
    beta: {
      messages: {
        parse: async () => ({ stop_reason: "end_turn", parsed_output: outputs.shift() ?? null, content: [], model, usage }),
      },
    },
  };
  return client as unknown as Anthropic;
}

describe("init drafting usage", () => {
  it("records the SOP call's tokens under the model that served it", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const client = fakeClient([{ rules: [], invariants: [], soft_rules: [] }]);
    const res = await draftInvariantsFromSop({ domain, sop: "Look the carrier up first.", sopFile: "sop.md", claude: { client } });
    expect(res.usage).toEqual({ "claude-sonnet-5-5": { calls: 1, input: 12000, output: 4000, cacheRead: 0, cacheWrite: 0 } });
  });

  it("sums one call per transcript, including a transcript that drafted nothing", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const client = fakeClient([null, null]);
    const res = await draftTasksFromTranscripts({
      domain,
      claude: { client },
      transcripts: [
        { file: "call-1.txt", text: "..." },
        { file: "call-2.txt", text: "..." },
      ],
    });
    expect(res.warnings).toEqual(["call-1.txt: no usable proposal", "call-2.txt: no usable proposal"]);
    expect(res.usage).toEqual({ "claude-sonnet-5-5": { calls: 2, input: 24000, output: 8000, cacheRead: 0, cacheWrite: 0 } });
  });

  it("on Bedrock, records the requested profile, whose price the estimate uses", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const client = fakeClient([{ rules: [], invariants: [], soft_rules: [] }], "claude-sonnet-5-5");
    const res = await draftInvariantsFromSop({
      domain,
      sop: "Look the carrier up first.",
      sopFile: "sop.md",
      claude: { client, provider: "bedrock", region: "eu-west-1", model: "claude-sonnet-5-5" },
    });
    const [model] = Object.keys(res.usage);
    expect(model).toMatch(/\.claude-sonnet-5-5$/);
    expect(model).not.toBe("claude-sonnet-5-5");
  });

  it("prints the estimated cost and the token line, as run does", () => {
    // 12k input at $2 and 4k output at $10 per million tokens: $0.064.
    expect(draftUsageLines({ "claude-sonnet-5-5": { calls: 1, input: 12000, output: 4000, cacheRead: 0, cacheWrite: 0 } })).toEqual([
      "  estimated cost $0.06",
      "    model claude-sonnet-5-5: 1 calls, 12.0k in, 4.0k out, 0 cache read, 0 cache write",
    ]);
    expect(draftUsageLines({ "an-unpriced-model": { calls: 1, input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } })[0]).toBe("  estimated cost n/a");
    expect(draftUsageLines({})).toEqual([]);
  });
});
