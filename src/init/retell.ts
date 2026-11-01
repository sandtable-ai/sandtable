/**
 * `sandtable import retell`: a draft domain from a Retell agent's export, with no model call. The agent's response
 * engine, a Retell LLM or a conversation flow, gives the policy (its prompts) and the tools (custom functions, end_call
 * and transfer_call), and each test case becomes a task: its user prompt as the caller's goal, its tool mocks as that
 * task's seed rows and expected calls, and its dynamic variables as the call's context. What the export can't say, such
 * as what a function changes or how Retell's LLM judge grades a test, becomes a review note, as `init` does.
 */

import { isPlainObject } from "../world/match.ts";
import { slug } from "./openapi.ts";
import {
  addCall,
  article,
  closeTask,
  endCallTool,
  expectedCall,
  itemsOf,
  Mocks,
  picked,
  renderPlatformDraft,
  schemaParams,
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

/** Tool types Retell runs itself, with no server of yours, that a draft can't model. */
const SKIPPED_TYPES = new Set(["press_digit", "send_sms", "code", "mcp", "agent_swap", "extract_dynamic_variable", "bridge_transfer", "cancel_transfer", "integration_app"]);
/** Cal.com tools that Retell replaced with integration_app tools on 2026-10-31, which older exports still have. */
const LEGACY_CAL_TYPES = new Set(["check_availability_cal", "book_appointment_cal"]);

interface Item {
  file: string;
  json: Json;
}

/** The response engine a draft comes from: a Retell LLM or a conversation flow. */
interface Engine extends Item {
  kind: "llm" | "flow";
  id?: string;
}

const isTestCase = (x: Json) => (typeof x.user_prompt === "string" && (Array.isArray(x.metrics) || isPlainObject(x.response_engine))) || typeof x.test_case_definition_id === "string";
// A test case names its response engine too, and has a user_prompt, which an agent never does.
const isAgent = (x: Json) => typeof x.agent_id === "string" || (isPlainObject(x.response_engine) && typeof x.user_prompt !== "string");
const isFlow = (x: Json) => typeof x.conversation_flow_id === "string" || (Array.isArray(x.nodes) && x.start_node_id !== undefined);
const isLlm = (x: Json) => typeof x.llm_id === "string" || typeof x.general_prompt === "string" || Array.isArray(x.general_tools) || Array.isArray(x.states);

const agentName = (a: Item) => str(a.json.agent_name) ?? str(a.json.agent_id) ?? a.file;
const engineName = (kind: Engine["kind"]) => (kind === "llm" ? "Retell LLM" : "conversation flow");

/**
 * The agents, Retell LLMs, conversation flows and test cases among an export's files, by shape. Arrays hold several,
 * and so does a list response: an object whose only list is of test cases. A test case names its response engine too,
 * so it is told apart first.
 */
function classify(files: PlatformFile[], warnings: string[]) {
  const agents: Item[] = [];
  const llms: Item[] = [];
  const flows: Item[] = [];
  const tests: Item[] = [];
  for (const { file, json } of files) {
    for (const item of itemsOf(json)) {
      if (!isPlainObject(item)) {
        warnings.push(`${file}: not a JSON object or a list of them; skipped`);
        continue;
      }
      if (isTestCase(item)) tests.push({ file, json: item });
      else if (isAgent(item)) agents.push({ file, json: item });
      else if (isFlow(item)) flows.push({ file, json: item });
      else if (isLlm(item)) llms.push({ file, json: item });
      else {
        // A list response, such as { items: [...] }: its test cases, and a warning for each element that isn't one.
        const lists = Object.values(item).filter(Array.isArray);
        const list = lists.length === 1 ? lists[0]! : [];
        if (list.some((x) => isPlainObject(x) && isTestCase(x))) {
          list.forEach((x, i) => {
            if (isPlainObject(x) && isTestCase(x)) tests.push({ file, json: x });
            else warnings.push(`${file}: element ${i} of its list isn't a test case (with user_prompt and metrics); skipped`);
          });
        } else warnings.push(`${file}: not a Retell agent (with agent_id or response_engine), Retell LLM (with llm_id), conversation flow (with nodes) or test case (with user_prompt and metrics); skipped`);
      }
    }
  }
  return { agents, llms, flows, tests };
}

/** The engine an agent runs on: embedded in a dashboard export, or the export's LLM or flow its response_engine names. */
function engineOf(agent: Item, c: ReturnType<typeof classify>): Engine | string {
  const engine = isPlainObject(agent.json.response_engine) ? agent.json.response_engine : {};
  const name = agentName(agent);
  if (engine.type === "custom-llm") {
    return `the agent "${name}" uses a custom LLM (response_engine type custom-llm), whose prompt and tools are in your own LLM server, not in the export: there is nothing to draft from`;
  }
  if (isPlainObject(agent.json.retellLlmData)) return { kind: "llm", id: str(engine.llm_id) ?? str(agent.json.retellLlmData.llm_id), file: agent.file, json: agent.json.retellLlmData };
  if (isPlainObject(agent.json.conversationFlow)) {
    return { kind: "flow", id: str(engine.conversation_flow_id) ?? str(agent.json.conversationFlow.conversation_flow_id), file: agent.file, json: agent.json.conversationFlow };
  }
  const llmId = str(engine.llm_id);
  if (llmId) {
    const llm = c.llms.find((l) => l.json.llm_id === llmId);
    return llm ? { kind: "llm", id: llmId, ...llm } : `the agent "${name}" runs on the Retell LLM ${llmId}, which no file in the export has: add it with GET https://api.retellai.com/get-retell-llm/${llmId}`;
  }
  const flowId = str(engine.conversation_flow_id);
  if (flowId) {
    const flow = c.flows.find((f) => f.json.conversation_flow_id === flowId);
    return flow ? { kind: "flow", id: flowId, ...flow } : `the agent "${name}" runs on the conversation flow ${flowId}, which no file in the export has: add it with GET https://api.retellai.com/get-conversation-flow/${flowId}`;
  }
  return `the agent "${name}" has no response_engine that names a Retell LLM or a conversation flow`;
}

/** The agent `--agent` picks, or the only one, and its engine; or why there is none to draft from. */
function resolve(files: PlatformFile[], pick: string | undefined, warnings: string[]): { problem: string } | { c: ReturnType<typeof classify>; agent?: Item; engine: Engine } {
  const c = classify(files, warnings);
  if (c.agents.length) {
    const chosen = picked(c.agents, pick, (a) => [str(a.json.agent_name), str(a.json.agent_id)]);
    if (chosen.length === 0) return { problem: `has no agent named or with the id "${pick}" (it has ${c.agents.map(agentName).join(", ")})` };
    if (chosen.length > 1) return { problem: `has ${chosen.length} agents (${chosen.map(agentName).join(", ")}): pick one with --agent <name or id>` };
    const engine = engineOf(chosen[0]!, c);
    return typeof engine === "string" ? { problem: engine } : { c, agent: chosen[0]!, engine };
  }
  const engines: Engine[] = [
    ...c.llms.map((l): Engine => ({ kind: "llm", id: str(l.json.llm_id), ...l })),
    ...c.flows.map((f): Engine => ({ kind: "flow", id: str(f.json.conversation_flow_id), ...f })),
  ];
  const ids = (list: Engine[]) => list.map((e) => e.id ?? e.file).join(", ");
  if (engines.length === 0) {
    return {
      problem:
        "has no Retell agent, Retell LLM or conversation flow: export the agent with GET https://api.retellai.com/get-agent/<agent_id>, and the LLM or flow its response_engine names, and import those JSON files",
    };
  }
  const chosen = picked(engines, pick, (e) => [e.id]);
  if (chosen.length === 0) return { problem: `has no Retell LLM or conversation flow with the id "${pick}" (it has ${ids(engines)})` };
  if (chosen.length > 1) return { problem: `has ${chosen.length} Retell LLMs or conversation flows and no agent (${ids(chosen)}): pick one with --agent <id>` };
  return { c, engine: chosen[0]! };
}

/** Why the files can't be imported, or undefined when they hold one agent and its engine, or `agent` picks one. */
export function retellProblem(files: PlatformFile[], agent?: string): string | undefined {
  const r = resolve(files, agent, []);
  return "problem" in r ? r.problem : undefined;
}

export function draftFromRetell(files: PlatformFile[], pick?: string): PlatformDraft {
  const warnings: string[] = [];
  const r = resolve(files, pick, warnings);
  if ("problem" in r) throw new Error(r.problem);
  const { c, agent, engine } = r;
  for (const a of c.agents) if (a !== agent) warnings.push(`${a.file}: the agent "${agentName(a)}", which --agent didn't pick; skipped`);
  for (const e of [...c.llms.map((x) => ({ kind: "llm" as const, ...x })), ...c.flows.map((x) => ({ kind: "flow" as const, ...x }))]) {
    if (e.json === engine.json) continue;
    if (agent) warnings.push(`${e.file}: a ${engineName(e.kind)} the agent doesn't use (its response_engine names ${engine.id ?? "the one its export embeds"}); skipped`);
    else warnings.push(`${e.file}: a ${engineName(e.kind)} that --agent didn't pick; skipped`);
  }
  const title = (agent ? str(agent.json.agent_name) : undefined) ?? engine.id ?? "retell-agent";
  const json = engine.json;

  // The policy: the LLM's general prompt and its states' prompts, or the flow's global prompt and its conversation
  // nodes' instructions; then where the call starts and who speaks first.
  const sections: string[] = [];
  const extras: string[] = [];
  const states = (Array.isArray(json.states) ? json.states : []).filter(isPlainObject);
  const nodes = (Array.isArray(json.nodes) ? json.nodes : []).filter(isPlainObject);
  if (engine.kind === "llm") {
    if (str(json.general_prompt)) sections.push(str(json.general_prompt)!);
    for (const s of states) if (str(s.state_prompt)) sections.push(`## ${str(s.name) ?? "state"}\n${str(s.state_prompt)}`);
    if (states.length && str(json.starting_state)) extras.push(`The call starts in the state "${str(json.starting_state)}".`);
  } else {
    if (str(json.global_prompt)) sections.push(str(json.global_prompt)!);
    for (const n of nodes) {
      const text = isPlainObject(n.instruction) ? str(n.instruction.text) : undefined;
      if (n.type === "conversation" && text) sections.push(`## ${str(n.name) ?? str(n.id) ?? "node"}\n${text}`);
    }
  }
  // An empty begin_message, or the user as the start speaker, means the agent waits for the caller.
  if (json.begin_message === "" || json.start_speaker === "user") extras.push("Let the caller speak first.");
  else if (str(json.begin_message)) extras.push(`Open each call with: "${str(json.begin_message)}"`);
  if (sections.length === 0) {
    warnings.push(`${engine.file}: the ${engineName(engine.kind)} has no ${engine.kind === "llm" ? "general_prompt or state prompt" : "global_prompt or conversation node instruction"}, so policy.md is a placeholder`);
  }
  const policy = sections.length ? `# ${title}\n\n${sections.join("\n\n")}\n${extras.map((e) => `\n${e}\n`).join("")}` : POLICY_PLACEHOLDER;
  const templated = templateWarning(sections.join("\n"));
  if (templated) warnings.push(templated);
  const defaults = isPlainObject(json.default_dynamic_variables) && Object.keys(json.default_dynamic_variables).length ? json.default_dynamic_variables : undefined;

  const names = new Set<string>();
  const tools: PlatformTool[] = [];
  const tables: Record<string, { key: string }> = {};
  /** The end and transfer tools, which Retell carries out itself, so a mock of one says only that it was called. */
  const builtins = new Set<string>();
  const add = (tool: PlatformTool | undefined, kind?: "end" | "transfer") => {
    if (!tool) return;
    tools.push(tool);
    if (kind) builtins.add(tool.name);
    if (kind === "transfer") tables.transfers = { key: "transfer_id" };
  };

  if (engine.kind === "llm") {
    // An LLM's tools: its general tools and each state's, which may repeat a general tool by name.
    const seen = new Set<string>();
    for (const t of [...(Array.isArray(json.general_tools) ? json.general_tools : []), ...states.flatMap((s) => (Array.isArray(s.tools) ? s.tools : []))]) {
      if (!isPlainObject(t)) {
        warnings.push(`${engine.file}: a tool that isn't a JSON object (${JSON.stringify(t)}); skipped`);
        continue;
      }
      const raw = str(t.name);
      if (raw && seen.has(raw)) continue;
      if (raw) seen.add(raw);
      const kind = t.type === "end_call" ? "end" : t.type === "transfer_call" ? "transfer" : undefined;
      add(toolFrom(t, engine.file, names, warnings), kind);
    }
    const transitions = [...new Set(states.flatMap((s) => (Array.isArray(s.edges) ? s.edges : []).filter(isPlainObject).map((e) => `transition_to_${String(e.destination_state_name)}`)))];
    if (transitions.length) warnings.push(`${engine.file}: the states' edges are transition tools inside Retell (${transitions.join(", ")}), not your API; skipped`);
  } else {
    // A flow's tools, which its function nodes call by tool_id, and its end and transfer nodes.
    const flowTools = (Array.isArray(json.tools) ? json.tools : []).filter(isPlainObject);
    for (const t of flowTools) add(toolFrom(t, engine.file, names, warnings));
    const ids = new Set(flowTools.map((t) => str(t.tool_id)));
    const destinations: TransferDestination[] = [];
    const order: ("end" | "transfer")[] = [];
    const other = new Map<string, number>();
    for (const n of nodes) {
      const type = String(n.type);
      if (type === "conversation") continue;
      if (type === "function") {
        if (!ids.has(str(n.tool_id))) warnings.push(`${engine.file}: function node ${str(n.name) ?? str(n.id) ?? "?"} calls tool_id ${String(n.tool_id)}, which the flow's tools don't have; skipped`);
      } else if (type === "end") {
        if (!order.includes("end")) order.push("end");
      } else if (type === "transfer_call") {
        if (!order.includes("transfer")) order.push("transfer");
        const d = destinationOf(n.transfer_destination);
        if (d && !destinations.some((x) => x.label === d.label)) destinations.push(d);
      } else other.set(type, (other.get(type) ?? 0) + 1);
    }
    for (const kind of order) add(kind === "end" ? endCallTool(names, "end_call") : transferTool(names, "transfer_call", destinations, "Retell"), kind);
    for (const [type, n] of other) warnings.push(`${engine.file}: ${n} ${type} node${n === 1 ? " has" : "s have"} no sandtable counterpart; skipped`);
  }

  // Each test case of this engine is a task. Its tool mocks are what those tools return in it, as Vapi's are; a mock
  // that matches only some arguments expects a call with them.
  const taskIds = new Set<string>();
  const tasks: PlatformTask[] = [];
  const mocks = new Mocks(tables, "test case");
  for (const { file, json: test } of c.tests) {
    const re = isPlainObject(test.response_engine) ? test.response_engine : {};
    const testEngine = str(re.llm_id) ?? str(re.conversation_flow_id);
    if (testEngine && engine.id && testEngine !== engine.id) {
      warnings.push(`${file}: a test case for another response engine (${testEngine}); skipped`);
      continue;
    }
    const name = str(test.name) ?? `test case ${tasks.length + 1}`;
    const task: PlatformTask = { id: taskId(taskIds, name), description: name, source: file, instructions: str(test.user_prompt) ?? name, called: [], notes: [] };
    const variables = isPlainObject(test.dynamic_variables) && Object.keys(test.dynamic_variables).length ? test.dynamic_variables : defaults;
    if (variables) task.context = variables;
    for (const mock of Array.isArray(test.tool_mocks) ? test.tool_mocks : []) {
      if (!isPlainObject(mock)) continue;
      const mocked = str(mock.tool_name);
      // A mock that names no tool is for none: undefined would match every tool with no platform name.
      const tool = mocked === undefined ? undefined : tools.find((t) => t.name === mocked || t.platformName === mocked);
      if (!tool) {
        warnings.push(`${file}: a tool mock for ${mocked ?? "a tool with no tool_name"}, which the agent doesn't have; skipped`);
        continue;
      }
      const rule = isPlainObject(mock.input_match_rule) ? mock.input_match_rule : {};
      const call = () =>
        rule.type === "partial_match" && isPlainObject(rule.args)
          ? expectedCall(tool, flat(rule.args), task.notes, (field, value) => `Its test case's mock of ${tool.name} matched calls with ${field} = ${JSON.stringify(value)}, which isn't a param of ${tool.name}: left out of the expected call.`)
          : tool.name;
      if (builtins.has(tool.name)) {
        addCall(task.called, call());
        continue;
      }
      if (typeof mock.output !== "string" || mock.output === "") {
        warnings.push(`${file}: the tool mock for ${mocked} has no output; skipped`);
        continue;
      }
      mocks.add(task, tool, mock.output, file, call());
    }
    const metrics = (Array.isArray(test.metrics) ? test.metrics : []).map(str).filter((m): m is string => m !== undefined);
    if (metrics.length) {
      task.notes.push(`Retell's LLM judge graded it on: ${metrics.map((m) => JSON.stringify(m)).join("; ")}. sandtable doesn't: write each as expect.state, called or not_called, which sandtable grades without a model.`);
    }
    closeTask(task, "test case");
    tasks.push(task);
  }

  const source = agent ? `the Retell agent "${title}" (${agent.file})` : `the ${engineName(engine.kind)} "${title}" (${engine.file})`;
  return { name: slug(title), description: `Imported from ${source}. Every tool, table and task is a draft to review.`, policy, tables, tools, tasks, warnings };
}

/** A transfer's destination: a number, or one Retell's model infers from a prompt. */
function destinationOf(raw: unknown): TransferDestination | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (raw.type === "inferred") return { label: "a number Retell infers", ...(str(raw.prompt) ? { description: str(raw.prompt) } : {}) };
  const number = str(raw.number);
  return number ? { target: number, label: number } : undefined;
}

/** A Retell tool as a sandtable tool, or undefined for a type the draft can't model. */
function toolFrom(json: Json, file: string, names: Set<string>, warnings: string[]): PlatformTool | undefined {
  const type = str(json.type);
  if (!type) {
    warnings.push(`${file}: a tool with no type; skipped`);
    return undefined;
  }
  const raw = str(json.name);
  if (type === "custom") {
    if (!raw) {
      warnings.push(`${file}: a custom function with no name; skipped`);
      return undefined;
    }
    const name = toolName(raw, names, `${file}: custom function`, warnings);
    const notes: string[] = [];
    const params = schemaParams(withoutConst(json.parameters, "", notes), "Retell", notes);
    const url = str(json.url);
    const method = (str(json.method) ?? "POST").toUpperCase();
    notes.unshift(`No test case mocks it, so what it returns is unknown: model what it reads and changes with get, list, create or update ops on a table${url ? ` (Retell calls ${method} ${url} for it)` : ""}.`);
    // Retell POSTs { name, call, args }, or the args alone with args_at_root, which /webhook/<tool> takes either way.
    notes.push(`To grade the agent's own test calls with sandtable serve, set its URL to the world server's /webhook/${name}: that route takes Retell's request with or without args_at_root.`);
    if (method === "GET" || method === "DELETE") warnings.push(`${file}: custom function "${raw}" uses ${method}, and Retell sends the LLM's arguments only with POST, PUT or PATCH: check its params`);
    return {
      name,
      ...(name !== raw ? { platformName: raw } : {}),
      description: str(json.description) ?? `${name} (no description in the Retell config: write one for the model)`,
      params,
      ops: [{ respond: { status: "ok" } }],
      notes,
    };
  }
  if (type === "end_call") return endCallTool(names, raw ?? "end_call", str(json.description));
  if (type === "transfer_call") {
    const d = destinationOf(json.transfer_destination);
    return transferTool(names, raw ?? "transfer_call", d ? [d] : [], "Retell", str(json.description));
  }
  const why = SKIPPED_TYPES.has(type) ? ", which Retell runs itself," : LEGACY_CAL_TYPES.has(type) ? ", which Retell runs itself (it moved Cal.com tools to integration_app on 2026-10-31)," : "";
  warnings.push(`${file}: ${article(type)} ${type} tool${why} has no sandtable counterpart; skipped`);
  return undefined;
}

/**
 * A parameters schema without the properties that have a `const`: Retell sends those values itself, so the agent never
 * fills them. An object whose properties are all fixed goes too. Each one left out gets a note.
 */
function withoutConst(schema: unknown, at: string, notes: string[]): unknown {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return schema;
  const properties: Json = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    const path = at ? `${at}.${name}` : name;
    if (isPlainObject(prop) && "const" in prop) {
      notes.push(`Parameter "${path}" is a fixed value (const ${JSON.stringify(prop.const)}) in the Retell config, so it was left out: the agent never fills it.`);
      continue;
    }
    const inner = withoutConst(prop, path, notes);
    const emptied = isPlainObject(prop) && isPlainObject(prop.properties) && Object.keys(prop.properties).length > 0 && isPlainObject(inner) && Object.keys(inner.properties as Json).length === 0;
    if (!emptied) properties[name] = inner;
  }
  return { ...schema, properties };
}

/** Arguments with nested objects as dotted fields, so each one is matched on its own, as Retell's partial match does. */
function flat(args: Json, at = ""): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(args)) {
    const path = at ? `${at}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length) Object.assign(out, flat(v, path));
    else out[path] = v;
  }
  return out;
}

/** The draft as sandtable.yaml and tasks.yaml, with review notes as YAML comments next to what they concern. */
export function renderRetellDraft(d: PlatformDraft): { domain: string; tasks: string } {
  return renderPlatformDraft(d, {
    from: "a Retell agent",
    command: "import retell",
    noTasks: "export the agent's test cases (GET https://api.retellai.com/get-test-case-definition/<id>)",
  });
}
