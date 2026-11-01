/**
 * `sandtable import elevenlabs`: a draft domain from an ElevenLabs agent, with no model call. It reads the project the
 * ElevenLabs CLI pulls (agents.json, tools.json and tests.json, with agent_configs/, tool_configs/ and test_configs/),
 * or the API's responses for an agent, its tools and its tests. The agent's prompt and its workflow's subagent prompts
 * become the policy; its webhook and client tools, and the end_call and transfer_to_number system tools, become tools,
 * a webhook with its URL's path as its http route; and each test becomes a task. What the export can't say, such as
 * what a tool changes or how ElevenLabs' LLM judges a test, becomes a review note, as `init` does.
 */

import path from "node:path";
import { isPlainObject } from "../world/match.ts";
import { slug, toParam, type DraftParam } from "./openapi.ts";
import {
  addCall,
  article,
  closeTask,
  endCallTool,
  expectedCall,
  itemsOf,
  Mocks,
  PARAM_NAME,
  paramAt,
  picked,
  renderPlatformDraft,
  routeProblem,
  str,
  taskId,
  templateWarning,
  toolName,
  transferTool,
  type Json,
  type PlatformDraft,
  type PlatformFile,
  type PlatformTask,
  type PlatformTool,
  type TransferDestination,
} from "./platform.ts";
import { POLICY_PLACEHOLDER } from "./render.ts";

const TEST_TYPES = new Set(["llm", "tool", "simulation"]);
/** Tool types ElevenLabs runs itself, with no server of yours, that a draft can't model. */
const SKIPPED_TYPES = new Set(["code", "mcp", "api_integration_webhook", "smb", "workflow"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

interface Item {
  file: string;
  json: Json;
}

/** An agent, or a branch of one, which `--agent` can pick. */
interface Agent extends Item {
  name: string;
  id?: string;
  /** For a branch: its name, its id and the agent it branches. */
  branch?: string;
  branchId?: string;
  main?: string;
}

/** A tool the agent may use: its config, the file it came from, its id, and the mocks its API response holds. */
interface ToolRef {
  file: string;
  config: Json;
  id?: string;
  mocks: unknown[];
}

/** A file's path in one spelling, so a config path in an index file matches the path the file was read at. */
const norm = (p: string) => path.posix.normalize(p.split(path.sep).join("/")).replace(/^\.\//, "");
const isIndex = (x: unknown, key: string) => isPlainObject(x) && Array.isArray(x[key]) && x[key].every((e) => isPlainObject(e) && typeof e.config === "string");
const agentLabel = (a: Agent) => (a.branch ? `${a.main}.${a.branch}` : a.name);
const agentConfig = (a: Item): Json => (isPlainObject(a.json.conversation_config) && isPlainObject(a.json.conversation_config.agent) ? a.json.conversation_config.agent : {});

/** The export's files by kind, with each index file's entries resolved to the files they name. */
function classify(files: PlatformFile[], warnings: string[]) {
  const indexes = { agents: [] as Item[], tools: [] as Item[], tests: [] as Item[] };
  const agentItems: Item[] = [];
  const toolResponses: Item[] = [];
  const toolConfigs: Item[] = [];
  const tests: Item[] = [];
  for (const { file, json } of files) {
    for (const item of itemsOf(json)) {
      if (!isPlainObject(item)) warnings.push(`${file}: not a JSON object or a list of them; skipped`);
      else if (isIndex(item, "agents")) indexes.agents.push({ file, json: item });
      else if (isIndex(item, "tools")) indexes.tools.push({ file, json: item });
      else if (isIndex(item, "tests")) indexes.tests.push({ file, json: item });
      else if (isPlainObject(item.conversation_config)) agentItems.push({ file, json: item });
      else if (isPlainObject(item.tool_config)) toolResponses.push({ file, json: item });
      else if (typeof item.type === "string" && TEST_TYPES.has(item.type)) tests.push({ file, json: item });
      else if (typeof item.type === "string" && (typeof item.name === "string" || item.type === "mcp")) toolConfigs.push({ file, json: item });
      else {
        warnings.push(`${file}: not an ElevenLabs agent (with conversation_config), tool (with tool_config, or type and name), test (with type llm, tool or simulation), or agents.json, tools.json or tests.json; skipped`);
      }
    }
  }
  // An index file names each config by its path from the project's folder, where the index file is.
  const byPath = new Map(files.filter((f) => isPlainObject(f.json)).map((f) => [norm(f.file), { file: f.file, json: f.json as Json }]));
  const at = (index: Item, config: unknown) => (typeof config === "string" ? byPath.get(norm(path.posix.join(path.posix.dirname(norm(index.file)), norm(config)))) : undefined);
  const named = new Set<Json>();

  const agents: Agent[] = [];
  for (const index of indexes.agents) {
    for (const entry of index.json.agents as Json[]) {
      const main = at(index, entry.config);
      if (!main) {
        warnings.push(`${index.file}: the config of agent ${str(entry.id) ?? "?"} (${String(entry.config)}) isn't in the export; skipped`);
        continue;
      }
      named.add(main.json);
      const name = str(main.json.name) ?? str(entry.id) ?? main.file;
      agents.push({ ...main, name, ...(str(entry.id) ? { id: str(entry.id) } : {}) });
      for (const [branch, def] of Object.entries(isPlainObject(entry.branches) ? entry.branches : {})) {
        const b = isPlainObject(def) ? at(index, def.config) : undefined;
        if (!b) continue;
        named.add(b.json);
        agents.push({ ...b, name, branch, main: name, ...(isPlainObject(def) && str(def.branch_id) ? { branchId: str(def.branch_id) } : {}) });
      }
    }
  }
  for (const a of agentItems) {
    if (!named.has(a.json)) agents.push({ ...a, name: str(a.json.name) ?? str(a.json.agent_id) ?? a.file, ...(str(a.json.agent_id) ? { id: str(a.json.agent_id) } : {}) });
  }

  const tools = new Map<string, ToolRef>();
  for (const index of indexes.tools) {
    for (const entry of index.json.tools as Json[]) {
      const config = at(index, entry.config);
      if (!config || !str(entry.id)) continue;
      named.add(config.json);
      tools.set(str(entry.id)!, { file: config.file, config: config.json, id: str(entry.id), mocks: [] });
    }
  }
  for (const t of toolResponses) {
    const id = str(t.json.id);
    if (id) tools.set(id, { file: t.file, config: t.json.tool_config as Json, id, mocks: Array.isArray(t.json.response_mocks) ? t.json.response_mocks : [] });
  }
  for (const t of toolConfigs) {
    if (!named.has(t.json)) warnings.push(`${t.file}: a tool config with no id, which no tools.json entry names, so the agent's tool_ids can't name it; skipped`);
  }

  /** Each test's id: its own, or the one tests.json gives the file. */
  const testIds = new Map<Json, string>();
  for (const index of indexes.tests) {
    for (const entry of index.json.tests as Json[]) {
      const test = at(index, entry.config);
      if (test && str(entry.id)) testIds.set(test.json, str(entry.id)!);
    }
  }
  for (const t of tests) if (str(t.json.id)) testIds.set(t.json, str(t.json.id)!);
  return { agents, tools, tests, testIds };
}

/** The agent `--agent` picks, or the only one that isn't a branch; or why there is none to draft from. */
function resolve(files: PlatformFile[], pick: string | undefined, warnings: string[]): { problem: string } | { c: ReturnType<typeof classify>; agent: Agent } {
  const c = classify(files, warnings);
  if (c.agents.filter((a) => !a.branch).length === 0) {
    return {
      problem:
        "has no ElevenLabs agent: pull the project with `elevenlabs agents pull`, `elevenlabs tools pull` and `elevenlabs tests pull`, or export the agent with GET https://api.elevenlabs.io/v1/convai/agents/<agent_id>, and import that",
    };
  }
  const chosen = pick === undefined ? c.agents.filter((a) => !a.branch) : picked(c.agents, pick, (a) => (a.branch ? [a.branch, a.branchId, agentLabel(a)] : [a.name, a.id]));
  if (chosen.length === 0) return { problem: `has no agent or branch named or with the id "${pick}" (it has ${c.agents.map(agentLabel).join(", ")})` };
  if (chosen.length > 1) return { problem: `has ${chosen.length} agents (${chosen.map(agentLabel).join(", ")}): pick one with --agent <name or id>` };
  return { c, agent: chosen[0]! };
}

/** Why the files can't be imported, or undefined when they hold one agent, or `agent` picks one. */
export function elevenLabsProblem(files: PlatformFile[], agent?: string): string | undefined {
  const r = resolve(files, agent, []);
  return "problem" in r ? r.problem : undefined;
}

export function draftFromElevenLabs(files: PlatformFile[], pick?: string): PlatformDraft {
  const warnings: string[] = [];
  const r = resolve(files, pick, warnings);
  if ("problem" in r) throw new Error(r.problem);
  const { c, agent } = r;
  for (const a of c.agents) {
    if (a === agent) continue;
    if (!a.branch) warnings.push(`${a.file}: the agent "${a.name}", which --agent didn't pick; skipped`);
    else if (pick === undefined) warnings.push(`${a.file}: the "${a.branch}" branch of the agent "${a.main}"; skipped (import it with --agent ${a.branch})`);
    else warnings.push(`${a.file}: the "${a.branch}" branch of the agent "${a.main}", which --agent didn't pick; skipped`);
  }
  const config = agentConfig(agent);
  const prompt = isPlainObject(config.prompt) ? config.prompt : {};
  const title = agent.name;

  // The policy: the agent's prompt, then each subagent node's own prompt, and how the call opens.
  const workflow = isPlainObject(agent.json.workflow) ? agent.json.workflow.nodes : undefined;
  const nodes: [string, Json][] = (Array.isArray(workflow) ? workflow.map((n, i): [string, unknown] => [isPlainObject(n) ? (str(n.id) ?? String(i)) : String(i), n]) : Object.entries(isPlainObject(workflow) ? workflow : {})).filter(
    (e): e is [string, Json] => isPlainObject(e[1]) && e[1].type === "override_agent",
  );
  const sections: string[] = [];
  if (str(prompt.prompt)) sections.push(str(prompt.prompt)!);
  for (const [id, n] of nodes) if (str(n.additional_prompt)) sections.push(`## ${str(n.label) ?? id}\n${str(n.additional_prompt)}`);
  // An empty first message, the default, means the agent waits for the caller.
  const opening = str(config.first_message) ? `Open each call with: "${str(config.first_message)}"` : "Let the caller speak first.";
  if (sections.length === 0) warnings.push(`${agent.file}: the agent has no conversation_config.agent.prompt.prompt, so policy.md is a placeholder`);
  const policy = sections.length ? `# ${title}\n\n${sections.join("\n\n")}\n\n${opening}\n` : POLICY_PLACEHOLDER;
  const templated = templateWarning(sections.join("\n"));
  if (templated) warnings.push(templated);
  const placeholders = isPlainObject(config.dynamic_variables) ? config.dynamic_variables.dynamic_variable_placeholders : undefined;
  const defaults = isPlainObject(placeholders) && Object.keys(placeholders).length ? placeholders : undefined;

  // The agent's tools: those prompt.tool_ids and its subagent nodes' additional_tool_ids name, its inline tools (a
  // deprecated field), and its built-in system tools.
  const used: ToolRef[] = [];
  const byId = (id: unknown, where: string) => {
    if (typeof id !== "string") return;
    const ref = c.tools.get(id);
    if (!ref) warnings.push(`${where} names the tool ${id}, which no file in the export has: fetch it with \`elevenlabs tools pull\` (or GET https://api.elevenlabs.io/v1/convai/tools/${id})`);
    else if (!used.includes(ref)) used.push(ref);
  };
  for (const id of Array.isArray(prompt.tool_ids) ? prompt.tool_ids : []) byId(id, "conversation_config.agent.prompt.tool_ids");
  for (const t of (Array.isArray(prompt.tools) ? prompt.tools : []).filter(isPlainObject)) {
    // The same tool by id in tool_ids and in the deprecated inline list is one tool.
    const id = str(t.id);
    if (id !== undefined && used.some((u) => u.id === id)) continue;
    used.push({ file: agent.file, config: t, ...(id !== undefined ? { id } : {}), mocks: [] });
  }
  for (const [id, n] of nodes) for (const tid of Array.isArray(n.additional_tool_ids) ? n.additional_tool_ids : []) byId(tid, `workflow node "${str(n.label) ?? id}"'s additional_tool_ids`);
  for (const [name, t] of Object.entries(isPlainObject(prompt.built_in_tools) ? prompt.built_in_tools : {})) {
    if (isPlainObject(t)) used.push({ file: agent.file, config: { type: "system", name, ...t }, mocks: [] });
  }
  for (const ref of new Set(c.tools.values())) {
    if (!used.includes(ref)) warnings.push(`${ref.file}: a tool the agent doesn't use (it isn't in prompt.tool_ids or a workflow node's additional_tool_ids); skipped`);
  }

  const names = new Set<string>();
  const tools: PlatformTool[] = [];
  const tables: Record<string, { key: string }> = {};
  const routes = new Map<string, string>();
  /** The drafted tool for each tool id, which tests name tools by. */
  const toolOf = new Map<string, PlatformTool>();
  /** The end and transfer tools, which ElevenLabs carries out itself, so a mock of one says only that it was called. */
  const builtins = new Set<string>();
  const systemKinds = new Set<string>();
  for (const ref of used) {
    // One end-call tool and one transfer tool, though tool_ids and built_in_tools may both have one.
    const kind = systemKind(ref.config);
    if (kind === "end_call" || kind === "transfer_to_number") {
      if (systemKinds.has(kind)) continue;
      systemKinds.add(kind);
    }
    const drafted = toolFrom(ref, names, warnings, routes);
    if (!drafted) continue;
    tools.push(drafted.tool);
    if (ref.id) toolOf.set(ref.id, drafted.tool);
    if (drafted.builtin) builtins.add(drafted.tool.name);
    if (drafted.builtin === "transfer") tables.transfers = { key: "transfer_id" };
  }
  const toolFor = (id: string) => toolOf.get(id) ?? tools.find((t) => builtins.has(t.name) && t.name === id);

  // Each test is a task. A simulation gives the caller's goal and the tools' mocks; a tool or next-reply test gives
  // the caller's lines, and a tool test the call it checks.
  const settings = isPlainObject(agent.json.platform_settings) ? agent.json.platform_settings : {};
  const testing = isPlainObject(settings.testing) ? settings.testing : {};
  const attached = new Set((Array.isArray(testing.attached_tests) ? testing.attached_tests : []).filter(isPlainObject).map((t) => str(t.test_id)));
  const taskIds = new Set<string>();
  const tasks: PlatformTask[] = [];
  const mocks = new Mocks(tables, "test");
  for (const { file, json: test } of c.tests) {
    const id = c.testIds.get(test);
    if (attached.size && !(id && attached.has(id))) {
      warnings.push(`${file}: a test the agent doesn't list in platform_settings.testing.attached_tests; skipped`);
      continue;
    }
    const name = str(test.name) ?? `test ${tasks.length + 1}`;
    const task: PlatformTask = { id: taskId(taskIds, name), description: name, source: file, instructions: name, called: [], notes: [] };
    const variables = isPlainObject(test.dynamic_variables) && Object.keys(test.dynamic_variables).length ? test.dynamic_variables : defaults;
    if (variables) task.context = variables;
    let checked: string | undefined;
    if (test.type === "simulation") {
      task.instructions = str(test.simulation_scenario) ?? name;
      if (typeof test.simulation_max_turns === "number" && Number.isInteger(test.simulation_max_turns) && test.simulation_max_turns > 0) task.maxTurns = test.simulation_max_turns;
      // The test's own mocks come first; a tool's shared mocks apply where the test mocks that tool.
      const cfg = isPlainObject(test.tool_mock_config) ? test.tool_mock_config : {};
      const selected = new Set(Array.isArray(cfg.mocked_tool_ids) ? cfg.mocked_tool_ids : []);
      const lists: [string, unknown[]][] = Object.entries(isPlainObject(test.tool_mock_overrides) ? test.tool_mock_overrides : {}).map(([tid, list]) => [tid, Array.isArray(list) ? list : []]);
      for (const ref of used) {
        if (ref.id && ref.mocks.length && (cfg.mocking_strategy === "all" || (cfg.mocking_strategy === "selected" && selected.has(ref.id)))) lists.push([ref.id, ref.mocks]);
      }
      for (const [tid, list] of lists) {
        const tool = toolFor(tid);
        if (!tool) {
          warnings.push(`${file}: a tool mock for ${tid}, which the agent doesn't have; skipped`);
          continue;
        }
        for (const mock of list.filter(isPlainObject)) {
          if (mock.is_error === true) task.notes.push(`Its test mocks ${tool.name} to fail (${JSON.stringify(mock.mock_result ?? "")}): model that failure with a fault or a check, which this draft leaves out.`);
          else if (builtins.has(tool.name)) addCall(task.called, tool.name);
          else if (typeof mock.mock_result !== "string") warnings.push(`${file}: a mock of ${tool.name} has no mock_result; skipped`);
          else {
            mocks.add(task, tool, mock.mock_result, file);
            const when = mock.parameter_conditions;
            if (when !== undefined && when !== null && !(Array.isArray(when) && when.length === 0) && !(isPlainObject(when) && Object.keys(when).length === 0)) {
              task.notes.push(`Its test answers ${tool.name} with this mock only for some arguments (${JSON.stringify(when)}), and the draft gives it for any: model that with a table keyed by those arguments.`);
            }
          }
        }
      }
      const conditions = [...(Array.isArray(test.success_conditions) ? test.success_conditions : []), test.success_condition].map(str).filter((x): x is string => x !== undefined);
      if (conditions.length) {
        task.notes.push(`ElevenLabs judged it with an LLM on: ${conditions.map((x) => JSON.stringify(x)).join("; ")}. sandtable doesn't: write each as expect.state, called or not_called, which sandtable grades without a model.`);
      }
    } else {
      const lines = (Array.isArray(test.chat_history) ? test.chat_history : [])
        .filter((m): m is Json => isPlainObject(m) && m.role === "user")
        .map((m) => str(m.message))
        .filter((m): m is string => m !== undefined);
      if (lines.length) {
        task.instructions = `In this call you say, in order: ${lines.map((l) => JSON.stringify(l)).join(", then ")}`;
        task.opening = lines[0];
        task.script = lines;
      }
      if (test.type === "tool") checked = expectToolCall(test, task, toolFor, file, warnings);
      else task.notes.push(replyNote(test));
      if (lines.length) {
        task.notes.push("ElevenLabs tested the agent's next turn after this chat history; a run plays the whole call, with the user's lines in order whatever the agent says, so check that they still make sense.");
      }
    }
    closeTask(task, "test", checked);
    tasks.push(task);
  }

  return {
    name: slug(title),
    description: `Imported from the ElevenLabs agent "${agentLabel(agent)}" (${agent.file}). Every tool, table and task is a draft to review.`,
    policy,
    tables,
    tools,
    tasks,
    warnings,
  };
}

/**
 * What a tool test checks, as the task's expected calls: the call of the tool it names, with the arguments it checks
 * exactly, or no call of it with `verify_absence`. Returns the note on what the task expects, when it expects a call.
 */
function expectToolCall(test: Json, task: PlatformTask, toolFor: (id: string) => PlatformTool | undefined, file: string, warnings: string[]): string | undefined {
  const check = isPlainObject(test.tool_call_parameters) ? test.tool_call_parameters : {};
  const id = isPlainObject(check.referenced_tool) ? str(check.referenced_tool.id) : undefined;
  if (!id) return undefined;
  const tool = toolFor(id);
  if (!tool) {
    warnings.push(`${file}: the test's tool_call_parameters name the tool ${id}, which the agent doesn't have, so its check is left out of the task`);
    return undefined;
  }
  if (check.verify_absence === true) {
    task.notCalled = [tool.name];
    return `It expects no call of ${tool.name}, as ElevenLabs checked: add the end state a correct call leaves.`;
  }
  const args: Json = {};
  for (const p of (Array.isArray(check.parameters) ? check.parameters : []).filter(isPlainObject)) {
    const field = str(p.path);
    const ev = isPlainObject(p.eval) ? p.eval : {};
    if (!field) continue;
    if (ev.type === "exact") args[field] = coerce(paramAt(tool.params, field), String(ev.expected_value ?? ""));
    else if (ev.type === "regex") task.notes.push(`ElevenLabs checked ${tool.name}'s ${field} against the pattern ${String(ev.pattern)}: where clauses have no regex yet (#20), so check it another way, such as $contains.`);
    else if (ev.type === "llm") task.notes.push(`ElevenLabs judged ${tool.name}'s ${field} with an LLM (${JSON.stringify(ev.description ?? "")}): write the value it expects as an argument of the expected call.`);
  }
  addCall(task.called, expectedCall(tool, args, task.notes, (f, v) => `ElevenLabs checked ${tool.name}'s ${f} for ${JSON.stringify(v)}, which isn't a param of ${tool.name}: left out of the expected call.`));
  return "It expects the call ElevenLabs checked: check that, and add the end state.";
}

/** The note on a next-reply test's LLM judgment, which sandtable doesn't make. */
function replyNote(test: Json): string {
  const condition = str(test.success_condition);
  const examples = (key: string) =>
    (Array.isArray(test[key]) ? test[key] : [])
      .filter(isPlainObject)
      .map((e) => str(e.response))
      .filter((x): x is string => x !== undefined)
      .map((x) => JSON.stringify(x))
      .join("; ");
  const passing = examples("success_examples");
  const failing = examples("failure_examples");
  return [
    `ElevenLabs judged the agent's next reply with an LLM${condition ? `: ${JSON.stringify(condition)}` : ""}.`,
    ...(passing ? [`Replies it counted as passing: ${passing}.`] : []),
    ...(failing ? [`Replies it counted as failing: ${failing}.`] : []),
    "sandtable doesn't: write it as reply_includes, expect.state, called or not_called, which sandtable grades without a model.",
  ].join(" ");
}

/** A test's expected value, which ElevenLabs gives as text, as the param's type, since args are matched coerced. */
function coerce(param: DraftParam | undefined, value: string): unknown {
  if ((param?.type === "integer" || param?.type === "number") && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (param?.type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

/** A system tool's kind, such as end_call, by its system_tool_type, else its name; undefined for another tool. */
const systemKind = (config: Json) => (config.type === "system" ? ((isPlainObject(config.params) ? str(config.params.system_tool_type) : undefined) ?? str(config.name) ?? "system") : undefined);

/** An ElevenLabs tool as a sandtable tool, or undefined for a type the draft can't model. */
function toolFrom(ref: ToolRef, names: Set<string>, warnings: string[], routes: Map<string, string>): { tool: PlatformTool; builtin?: "end" | "transfer" } | undefined {
  const { file, config } = ref;
  const type = str(config.type);
  if (!type) {
    warnings.push(`${file}: a tool with no type; skipped`);
    return undefined;
  }
  const raw = str(config.name);
  const kind = systemKind(config);
  if (kind) {
    if (kind === "end_call") return { tool: endCallTool(names, raw ?? "end_call", str(config.description)), builtin: "end" };
    if (kind === "transfer_to_number") {
      const transfers = (isPlainObject(config.params) && Array.isArray(config.params.transfers) ? config.params.transfers : []).filter(isPlainObject);
      const destinations = transfers.flatMap((t): TransferDestination[] => {
        const d = isPlainObject(t.transfer_destination) ? t.transfer_destination : {};
        const target = str(d.phone_number) ?? str(d.sip_uri) ?? str(t.phone_number);
        return target ? [{ target, label: target, ...(str(t.condition) ? { description: str(t.condition) } : {}) }] : [];
      });
      return { tool: transferTool(names, raw ?? "transfer_to_number", destinations, "ElevenLabs", str(config.description)), builtin: "transfer" };
    }
    warnings.push(`${file}: ${article(kind)} ${kind} system tool, which ElevenLabs runs itself, has no sandtable counterpart; skipped`);
    return undefined;
  }
  if (type !== "webhook" && type !== "client") {
    warnings.push(`${file}: ${article(type)} ${type} tool${SKIPPED_TYPES.has(type) ? ", which ElevenLabs runs itself," : ""} has no sandtable counterpart; skipped`);
    return undefined;
  }
  if (!raw) {
    warnings.push(`${file}: a ${type} tool with no name; skipped`);
    return undefined;
  }
  const name = toolName(raw, names, `${file}: ${type} tool`, warnings);
  const notes: string[] = [];
  const api = isPlainObject(config.api_schema) ? config.api_schema : {};
  const params: Record<string, DraftParam> = {};
  if (type === "webhook") {
    // Path params are each required; query and body params have their schema's required list.
    for (const [p, prop] of Object.entries(isPlainObject(api.path_params_schema) ? api.path_params_schema : {})) addParam(params, p, prop, true, notes);
    objectParams(params, api.query_params_schema, notes);
    objectParams(params, api.request_body_schema, notes);
  } else objectParams(params, config.parameters, notes);
  const url = str(api.url);
  const method = (str(api.method) ?? "GET").toUpperCase();
  const where = type === "client" ? " (it's a client tool, which the caller's app runs, so sandtable serve never sees a call to it)" : url ? ` (ElevenLabs calls ${method} ${url} for it)` : "";
  notes.unshift(`No test mocks it, so what it returns is unknown: model what it reads and changes with get, list, create or update ops on a table${where}.`);
  const tool: PlatformTool = {
    name,
    ...(name !== raw ? { platformName: raw } : {}),
    description: str(config.description) ?? `${name} (no description in the ElevenLabs config: write one for the model)`,
    params,
    ops: [{ respond: { status: "ok" } }],
    notes,
  };
  // ElevenLabs calls the webhook's URL itself, with its path, query and body params: the route a tool's http serves.
  if (type === "webhook" && url && METHODS.has(method)) {
    const http = { method, path: urlPath(url) };
    const problem = routeProblem(tool, http, routes);
    if (problem) warnings.push(`${file}: no http route for webhook tool "${name}" (${problem}); sandtable serve still serves it at /tools/${name}`);
    else {
      tool.http = http;
      notes.push("Its http route is its URL's path: to grade the agent's own test calls with sandtable serve, point the tool's base URL at the world server.");
    }
  }
  return { tool };
}

/** The path of a webhook URL, with its {placeholders}: no scheme, host (or {{variable}} for one) or query string. */
function urlPath(url: string): string {
  const rest = url
    .trim()
    .replace(/^\{\{[^}]*\}\}/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
    .split(/[?#]/)[0]!;
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** The params of an object schema's properties, by its required list. */
function objectParams(params: Record<string, DraftParam>, schema: unknown, notes: string[]) {
  if (!isPlainObject(schema)) return;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  for (const [p, prop] of Object.entries(isPlainObject(schema.properties) ? schema.properties : {})) addParam(params, p, prop, required.has(p), notes);
}

function addParam(params: Record<string, DraftParam>, name: string, prop: unknown, required: boolean, notes: string[]) {
  if (params[name]) {
    notes.push(`Parameter "${name}" is in more than one of the path, the query and the body: only the first was drafted.`);
    return;
  }
  const filled = llmFilled(prop, name, notes);
  if (!filled) return;
  const param = toParam(filled, (x) => x, required);
  if (!param) {
    notes.push(`Parameter "${name}" has a schema the draft can't map, so it was left out: add it by hand.`);
    return;
  }
  params[name] = param;
  if (!PARAM_NAME.test(name)) notes.push(`Parameter "${name}" has a name model APIs reject (they take ${PARAM_NAME.source}): rename it here and in the agent's tool.`);
}

/**
 * The part of a property the LLM fills, or undefined when none is. ElevenLabs fills a property from a dynamic
 * variable, a constant or the system, or omits it; only one with a description is the LLM's, and of an object, only
 * the properties that are. Each one left out gets a note.
 */
function llmFilled(prop: unknown, at: string, notes: string[], isItems = false): Json | undefined {
  if (!isPlainObject(prop)) {
    notes.push(`Parameter "${at}" has a schema the draft can't map, so it was left out: add it by hand.`);
    return undefined;
  }
  const variable = str(prop.dynamic_variable);
  if (variable) {
    notes.push(`Parameter "${at}" comes from the dynamic variable {{${variable}}}, so it was left out: the agent never fills it.`);
    return undefined;
  }
  if (prop.constant_value !== undefined && prop.constant_value !== null) {
    notes.push(`Parameter "${at}" is the constant ${JSON.stringify(prop.constant_value)}, so it was left out: the agent never fills it.`);
    return undefined;
  }
  if (prop.is_system_provided === true) {
    notes.push(`Parameter "${at}" is filled in by ElevenLabs (is_system_provided), so it was left out: the agent never fills it.`);
    return undefined;
  }
  if (prop.is_omitted === true) {
    notes.push(`Parameter "${at}" is omitted from the request (is_omitted), so it was left out.`);
    return undefined;
  }
  const allowed = isPlainObject(prop.allowed_values) ? str(prop.allowed_values.dynamic_variable) : str(prop.allowed_values_dynamic_variable);
  if (allowed) notes.push(`Parameter "${at}" accepts only the values in the dynamic variable {{${allowed}}}, which ElevenLabs checks itself (allowed_values): add an enum or a check if that matters.`);
  if (prop.type === "object" || (prop.type === undefined && isPlainObject(prop.properties))) {
    const properties: Json = {};
    for (const [k, v] of Object.entries(isPlainObject(prop.properties) ? prop.properties : {})) {
      const child = llmFilled(v, `${at}.${k}`, notes);
      if (child) properties[k] = child;
    }
    if (!Object.keys(properties).length) return undefined;
    return { ...prop, properties, required: (Array.isArray(prop.required) ? prop.required : []).filter((k) => typeof k === "string" && k in properties) };
  }
  if (prop.type === "array") {
    const items = isPlainObject(prop.items) ? llmFilled(prop.items, `${at}[]`, notes, true) : undefined;
    return { ...prop, ...(items ? { items } : {}) };
  }
  // An array's items need no description of their own; any other value does, or the LLM doesn't fill it.
  if (!isItems && !str(prop.description)) {
    notes.push(`Parameter "${at}" has no description, so the LLM doesn't fill it: it was left out.`);
    return undefined;
  }
  return prop;
}

/** The draft as sandtable.yaml and tasks.yaml, with review notes as YAML comments next to what they concern. */
export function renderElevenLabsDraft(d: PlatformDraft): { domain: string; tasks: string } {
  return renderPlatformDraft(d, { from: "an ElevenLabs agent", command: "import elevenlabs", noTasks: "pull the agent's tests with `elevenlabs tests pull`" });
}
