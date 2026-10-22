import { connect } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { explainClaudeError, providerOf, type ClaudeOptions } from "./claude.ts";
import { importOptional } from "./optional.ts";

/** A side of the conversation and the spec that builds it, as `--agent` and `--user` take them. */
export interface Role {
  role: "agent" | "simulated user";
  spec: string;
}

/**
 * Why a run couldn't get past its first trial, checked before any trial starts: missing credentials, a missing
 * optional package, no region for Bedrock, or an HTTP agent that nothing answers at. One line per role that has
 * a problem; empty when every role can start. Every check is free: Claude on the Anthropic API lists one model,
 * and everything else resolves locally or opens a TCP connection without sending a request.
 */
export async function reachProblems(roles: readonly Role[], p: ClaudeOptions = {}): Promise<string[]> {
  const problems = await Promise.all(
    roles.map(async ({ role, spec }) => {
      const why = await specProblem(spec, p).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      return why ? `the ${role} (${spec}): ${why}` : undefined;
    }),
  );
  return problems.filter((x): x is string => x !== undefined);
}

async function specProblem(spec: string, p: ClaudeOptions): Promise<string | undefined> {
  if (spec === "claude" || spec.startsWith("claude:")) return providerOf(p) === "bedrock" ? claudeOnBedrockProblem(p) : anthropicProblem();
  if (spec.startsWith("bedrock:")) return converseProblem(p);
  if (/^https?:\/\//.test(spec)) return listenerProblem(spec);
  // openai: fails without its key when the spec is resolved; scripted, noop and module agents need nothing.
  return undefined;
}

/** A model list, which costs nothing, shows whether the Anthropic API accepts the credentials. */
async function anthropicProblem(): Promise<string | undefined> {
  try {
    await new Anthropic({ maxRetries: 1, timeout: 20_000 }).models.list({ limit: 1 });
    return undefined;
  } catch (err) {
    const explained = explainClaudeError(err, "anthropic");
    const message = explained instanceof Error ? explained.message : String(explained);
    return message === "Connection error." ? "can't reach the Anthropic API (connection error): check the network or a proxy" : message;
  }
}

/** Claude on Bedrock: the optional client package, and AWS credentials the default chain or --aws-profile can resolve. */
async function claudeOnBedrockProblem(p: ClaudeOptions): Promise<string | undefined> {
  await importOptional("@anthropic-ai/bedrock-sdk", () => import("@anthropic-ai/bedrock-sdk"), "--provider bedrock");
  return awsCredentialsProblem(p.awsProfile, "--provider bedrock");
}

/** A bedrock: agent: the Converse client package, a region, and AWS credentials. */
async function converseProblem(p: ClaudeOptions): Promise<string | undefined> {
  const sdk = await importOptional("@aws-sdk/client-bedrock-runtime", () => import("@aws-sdk/client-bedrock-runtime"), "--agent bedrock:<model-id>");
  const region = p.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const client = new sdk.BedrockRuntimeClient({ ...(region ? { region } : {}), ...(p.awsProfile ? { profile: p.awsProfile } : {}) });
  const resolved = await client.config.region().catch(() => undefined);
  if (!resolved) return "no AWS region for Bedrock: pass --region, or set AWS_REGION or a region in the AWS profile";
  return awsCredentialsProblem(p.awsProfile, "--agent bedrock:<model-id>");
}

async function awsCredentialsProblem(profile: string | undefined, neededFor: string): Promise<string | undefined> {
  const { fromNodeProviderChain } = await importOptional("@aws-sdk/credential-providers", () => import("@aws-sdk/credential-providers"), neededFor);
  try {
    await fromNodeProviderChain(profile ? { profile } : {})();
    return undefined;
  } catch (err) {
    const where = profile ? `the AWS profile ${profile} has none` : "pass --aws-profile or set AWS_PROFILE, or configure the default AWS credential chain";
    return `no AWS credentials for Bedrock: ${where} (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** An HTTP agent: something accepts a TCP connection at its host and port. No request is sent, so no session starts. */
function listenerProblem(url: string): Promise<string | undefined> {
  const { hostname, port, protocol } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(port || (protocol === "https:" ? 443 : 80)), timeout: 5_000 });
    const done = (why?: string) => {
      socket.destroy();
      resolve(why);
    };
    socket.once("connect", () => done());
    socket.once("timeout", () => done(`nothing answered at ${url} within 5s: start the agent first, or check the URL`));
    socket.once("error", (err: NodeJS.ErrnoException) => done(`nothing is listening at ${url} (${err.code ?? err.message}): start the agent first, or check the URL`));
  });
}
