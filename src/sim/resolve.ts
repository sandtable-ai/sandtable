import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clinicScriptedAgent } from "../demo/clinic-agents.ts";
import { freightScriptedAgent } from "../demo/freight-agents.ts";
import { bedrockConverseAgent } from "./bedrock-converse.ts";
import { claudeAgent, claudeUser, type ClaudeOptions, type Effort } from "./claude.ts";
import { httpAgent } from "./http.ts";
import { noopAgent } from "./noop.ts";
import { DEFAULT_OPENAI_BASE_URL, openaiCompatAgent, openaiCompatUser, type OpenAICompatOptions } from "./openai-compat.ts";
import { scriptedUser } from "./scripted.ts";
import type { AgentAdapter, UserSimulator } from "./types.ts";

// What the CLI's --agent and --user specs build, shared by `run` and `leaderboard`.

/**
 * Endpoint for an `openai:<model>` spec. The key comes from OPENAI_API_KEY, the usual convention
 * for OpenAI-compatible servers; local servers such as Ollama and vLLM need none.
 */
export function openaiEndpoint(spec: string, baseUrlFlag?: string): OpenAICompatOptions {
  const model = spec.slice("openai:".length);
  if (!model) throw new Error(`"${spec}" names no model: use openai:<model>, e.g. openai:gpt-4.1-mini`);
  const baseUrl = baseUrlFlag || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && baseUrl.startsWith(DEFAULT_OPENAI_BASE_URL)) {
    throw new Error(`${spec} on ${baseUrl} needs OPENAI_API_KEY (or point --openai-base-url at another endpoint)`);
  }
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

export async function resolveAgent(spec: string, p: ClaudeOptions = {}, openaiBaseUrl?: string): Promise<AgentAdapter> {
  if (spec === "noop") return noopAgent();
  if (spec === "claude") return claudeAgent(p);
  if (spec.startsWith("claude:")) return claudeAgent({ ...p, model: spec.slice("claude:".length) });
  if (spec.startsWith("bedrock:")) {
    return bedrockConverseAgent({
      modelId: spec.slice("bedrock:".length),
      ...(p.region ? { region: p.region } : {}),
      ...(p.awsProfile ? { awsProfile: p.awsProfile } : {}),
    });
  }
  if (spec.startsWith("openai:")) return openaiCompatAgent(openaiEndpoint(spec, openaiBaseUrl));
  if (/^https?:\/\//.test(spec)) return httpAgent(spec);
  if (spec === "scripted:naive" || spec === "scripted:careful") return freightScriptedAgent(spec.endsWith("naive") ? "naive" : "careful");
  if (spec === "scripted:clinic-naive" || spec === "scripted:clinic-careful") return clinicScriptedAgent(spec.endsWith("naive") ? "naive" : "careful");
  const file = path.resolve(spec);
  if (!(await stat(file).catch(() => undefined))) {
    throw new Error(
      `unknown agent "${spec}": use claude, claude:<model>, bedrock:<model-id>, openai:<model>, noop, an http(s):// URL, scripted:naive|careful|clinic-naive|clinic-careful, or the path of a JS/TS module (there is no file at ${file})`,
    );
  }
  const mod = (await import(pathToFileURL(file).href).catch((err: unknown) => {
    throw new Error(`could not load the agent module ${spec}: ${err instanceof Error ? err.message : String(err)}`);
  })) as { default?: unknown };
  const exported = typeof mod.default === "function" ? await (mod.default as () => unknown)() : mod.default;
  if (!exported || typeof (exported as AgentAdapter).createSession !== "function") {
    throw new Error(`${spec} must default-export an AgentAdapter (or a function returning one)`);
  }
  return exported as AgentAdapter;
}

export function resolveUser(spec: string, p: ClaudeOptions = {}, openaiBaseUrl?: string): UserSimulator {
  if (spec === "scripted") return scriptedUser();
  if (spec === "claude") return claudeUser(p);
  if (spec.startsWith("claude:")) return claudeUser({ ...p, model: spec.slice("claude:".length) });
  if (spec.startsWith("openai:")) return openaiCompatUser(openaiEndpoint(spec, openaiBaseUrl));
  throw new Error(`unknown user simulator "${spec}" (use claude, claude:<model>, openai:<model> or scripted)`);
}

/** A leaderboard entry's agent: what `run --agent` builds from its spec, at the entry's effort when it sets one (claude: only). */
export function leaderboardAgent(spec: string, effort: Effort | undefined, p: ClaudeOptions = {}, openaiBaseUrl?: string): Promise<AgentAdapter> {
  return resolveAgent(spec, effort ? { ...p, effort } : p, openaiBaseUrl);
}
