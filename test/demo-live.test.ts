import { describe, expect, it } from "vitest";
import { DEMO_USER_MODEL, demoLiveSides } from "../src/demo/live.ts";

// `demo --live` plays the caller with a cheaper model than the agent's, unless --user-model names another.
// The adapters' names show the model they will call, so this needs no model call and no key.

describe("demo --live", () => {
  it("plays the caller with Claude Haiku 5.5 and keeps the agent's default model", () => {
    const { agent, user } = demoLiveSides({});
    expect(DEMO_USER_MODEL).toBe("claude-haiku-5-5");
    expect(user.name).toBe("claude:claude-haiku-5-5");
    expect(agent.name).toBe("claude:claude-opus-5-5");
  });

  it("takes --user-model and --agent-model over the defaults", () => {
    const { agent, user } = demoLiveSides({}, { agentModel: "claude-sonnet-5-5", userModel: "claude-sonnet-5-5" });
    expect(user.name).toBe("claude:claude-sonnet-5-5");
    expect(agent.name).toBe("claude:claude-sonnet-5-5");
  });

  it("maps the caller's default to a Bedrock inference profile like any other Claude model", () => {
    const { user } = demoLiveSides({ provider: "bedrock", region: "eu-west-1", bedrockClient: "classic" });
    expect(user.name).toBe("bedrock:eu.anthropic.claude-haiku-5-5");
  });
});
