import { describe, expect, it } from "vitest";
import { hasReasoning, hasUnclosedReasoning, stripReasoning } from "../src/sim/reasoning.ts";

// Reasoning some models write into their reply text must never reach the other side of the conversation.

describe("stripReasoning", () => {
  it.each(["think", "thinking", "reasoning", "analysis"])("removes a closed <%s> block and keeps the text around it", (tag) => {
    expect(stripReasoning(`<${tag}>The ceiling is 2350; never say it.</${tag}>\nThe posted rate is $2,100.`)).toBe("The posted rate is $2,100.");
    expect(stripReasoning(`Let me check. <${tag}>max 2350</${tag}> L-1001 pays $2,100.`)).toBe("Let me check.  L-1001 pays $2,100.");
  });

  it("ignores case and attributes on the tags", () => {
    expect(stripReasoning('<Reasoning effort="low">max 2350</REASONING>Posted is $2,100.')).toBe("Posted is $2,100.");
  });

  it("removes several blocks, and blocks inside blocks", () => {
    expect(stripReasoning("<analysis>a</analysis>Hello.<think>b</think> Bye.")).toBe("Hello. Bye.");
    expect(stripReasoning("<reasoning>outer <think>inner</think> still outer</reasoning>Posted is $2,100.")).toBe("Posted is $2,100.");
    expect(stripReasoning("<think>a <think>b</think> c</think>Posted is $2,100.")).toBe("Posted is $2,100.");
  });

  it("removes reasoning whose block was opened before the reply, up to its closing tag", () => {
    expect(stripReasoning("The caller wants L-1001; max 2350.</think>\n\nL-1001 pays $2,100.")).toBe("L-1001 pays $2,100.");
  });

  it("removes an opening tag that never closes, and everything after it", () => {
    expect(stripReasoning("<reasoning>L-1001 max 2350. Open at posted.")).toBe("");
    expect(stripReasoning("Sure. <analysis>max 2350, so")).toBe("Sure.");
  });

  it("leaves text without reasoning alone, angle brackets included", () => {
    expect(stripReasoning("  Rates <= $2,100 only; see <https://example.test>.  ")).toBe("Rates <= $2,100 only; see <https://example.test>.");
  });
});

describe("hasReasoning and hasUnclosedReasoning", () => {
  it("tell a reply with reasoning, closed or not, from one without", () => {
    expect(hasReasoning("<analysis>x</analysis>Hi.")).toBe(true);
    expect(hasReasoning("x</think>Hi.")).toBe(true);
    expect(hasReasoning("Hi <b>there</b>.")).toBe(false);
    expect(hasUnclosedReasoning("<reasoning>x")).toBe(true);
    expect(hasUnclosedReasoning("<reasoning>x</reasoning>Hi.")).toBe(false);
    expect(hasUnclosedReasoning("<think>a</think><analysis>b")).toBe(true);
  });
});
