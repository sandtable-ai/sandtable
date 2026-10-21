import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { reachProblems } from "../src/sim/preflight.ts";

// `run` and `demo --live` check, before the first trial, that the agent and the simulated user can start. A role
// without credentials used to fail every trial one by one, after the other role had made, and billed, its calls.

/** No keys, no AWS settings, and an empty home, so neither the Anthropic SDK nor the AWS chain finds real credentials. */
function cleanEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "sandtable-preflight-home-"));
  const kept = Object.entries(process.env).filter(([k]) => !k.startsWith("AWS_") && !k.startsWith("ANTHROPIC_") && k !== "OPENAI_API_KEY" && k !== "SANDTABLE_PROVIDER");
  return {
    ...Object.fromEntries(kept),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    AWS_CONFIG_FILE: path.join(home, "aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, "aws-credentials"),
    // Keep the AWS SDK from asking EC2 instance metadata, a network call.
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

const cli = (args: string[]) =>
  promisify(execFile)(process.execPath, [path.resolve("src/cli.ts"), ...args], { env: cleanEnv() }).then(
    (r) => ({ code: 0, stderr: r.stderr }),
    (e: { code: number; stderr: string }) => e,
  );

/** A local port nothing listens on: bind one, then close it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.skipIf(!process.features.typescript)("before the first trial", () => {
  const run = (agent: string, ...flags: string[]) => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "sandtable-preflight-")), "out");
    return { out, result: cli(["run", "examples/freight", "-t", "book-at-posted-rate", "--agent", agent, "--user", "scripted", "--no-html", "-o", out, ...flags]) };
  };

  it("run stops with exit 2 and writes nothing when the Claude agent has no credentials", async () => {
    const { out, result } = run("claude");
    const r = await result;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Nothing ran: the agent (claude): no Anthropic credentials: set ANTHROPIC_API_KEY");
    expect(existsSync(out)).toBe(false);
  });

  it("demo --live names both roles at once, before any trial", async () => {
    const r = await cli(["demo", "--live", "-k", "1", "--no-open"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Nothing ran: 2 problems:");
    expect(r.stderr).toContain("- the agent (claude): no Anthropic credentials");
    expect(r.stderr).toContain("- the simulated user (claude): no Anthropic credentials");
    expect(r.stderr).not.toContain("Every trial ended in an error");
  });

  it("Claude on Bedrock without AWS credentials, and a bedrock: agent without a region, say so", async () => {
    const claude = await run("claude", "--provider", "bedrock", "--region", "eu-west-1").result;
    expect(claude.code).toBe(2);
    expect(claude.stderr).toContain("the agent (claude): no AWS credentials for Bedrock: pass --aws-profile or set AWS_PROFILE");
    const converse = await run("bedrock:example.model-v1").result;
    expect(converse.code).toBe(2);
    expect(converse.stderr).toContain("the agent (bedrock:example.model-v1): no AWS region for Bedrock: pass --region");
  });

  it("an HTTP agent that nothing listens at stops the run", async () => {
    const url = `http://127.0.0.1:${await closedPort()}/step`;
    const r = await run(url).result;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`the agent (${url}): nothing is listening at ${url} (ECONNREFUSED): start the agent first`);
  });
});

describe("reachProblems", () => {
  it("passes an HTTP agent that accepts a connection, without sending it anything", async () => {
    let received = 0;
    const server = createServer((socket) => {
      socket.on("data", () => received++);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await reachProblems([{ role: "agent", spec: `http://127.0.0.1:${port}/step` }])).toEqual([]);
      expect(received).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("checks nothing for agents that need no credentials", async () => {
    const free = ["noop", "scripted:careful", "./my-agent.mjs", "scripted"];
    expect(await reachProblems(free.map((spec) => ({ role: "agent" as const, spec })))).toEqual([]);
  });
});
