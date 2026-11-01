/**
 * `sandtable import vapi`: a draft domain from a Vapi assistant's config, with no model call. The system prompt
 * becomes the policy, the function tools and the transferCall and endCall tools become tools, and simulation
 * scenarios become tasks: the tester's instructions as the caller's goal, the scenario's tool mocks as that task's
 * seed rows, and its variable values as the call's context. What the config can't say, such as what a tool changes
 * or how a scenario is graded, becomes a review note, as `init` does.
 */

import { isPlainObject } from "../world/match.ts";
import { slug } from "./openapi.ts";
import {
  closeTask,
  endCallTool,
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
} from "./platform.ts";
import { POLICY_PLACEHOLDER } from "./render.ts";

/** One JSON file of the export, by its path as given. */
export type VapiFile = PlatformFile;

/** Tool types Vapi runs itself, with no server, that a draft can't model. */
const SKIPPED_TYPES = new Set(["dtmf", "voicemail", "query", "sms", "handoff", "code", "bash", "computer", "textEditor", "output", "mcp", "apiRequest"]);

/** The assistant, tools and simulation scenarios among an export's files, by shape. Arrays hold several. */
function classify(files: VapiFile[], warnings: string[]) {
  const assistants: { file: string; json: Json }[] = [];
  const tools: { file: string; json: Json }[] = [];
  const scenarios: { file: string; json: Json }[] = [];
  for (const { file, json } of files) {
    for (const item of Array.isArray(json) ? json : [json]) {
      if (!isPlainObject(item)) {
        warnings.push(`${file}: not a JSON object or a list of them; skipped`);
      } else if (isPlainObject(item.model)) {
        assistants.push({ file, json: item });
      } else if (typeof item.instructions === "string") {
        scenarios.push({ file, json: item });
      } else if (typeof item.type === "string") {
        tools.push({ file, json: item });
      } else {
        warnings.push(`${file}: not a Vapi assistant (with model), tool (with type) or simulation scenario (with instructions); skipped`);
      }
    }
  }
  return { assistants, tools, scenarios };
}

/** What `--agent` matches an assistant by: its name and its id. */
const assistantKeys = (a: { json: Json }) => [str(a.json.name), str(a.json.id)];

/** Why the files can't be imported, or undefined when they hold exactly one assistant, or `agent` picks one. */
export function vapiProblem(files: VapiFile[], agent?: string): string | undefined {
  const { assistants } = classify(files, []);
  if (assistants.length === 0) return "has no Vapi assistant: export one with GET https://api.vapi.ai/assistant/<id> and import that JSON";
  const chosen = picked(assistants, agent, assistantKeys);
  const names = (list: typeof assistants) => list.map((a) => str(a.json.name) ?? a.file).join(", ");
  if (chosen.length === 0) return `has no assistant named or with the id "${agent}" (it has ${names(assistants)})`;
  if (chosen.length > 1) return `has ${chosen.length} assistants (${names(chosen)}): import one at a time, or pick one with --agent <name or id>`;
  return undefined;
}

export function draftFromVapi(files: VapiFile[], agent?: string): PlatformDraft {
  const warnings: string[] = [];
  const { assistants, tools: toolFiles, scenarios } = classify(files, warnings);
  const { json: assistant, file: assistantFile } = picked(assistants, agent, assistantKeys)[0]!;
  for (const a of assistants) if (a.json !== assistant) warnings.push(`${a.file}: the assistant "${str(a.json.name) ?? "?"}", which --agent didn't pick; skipped`);
  const model = assistant.model as Json;
  const title = str(assistant.name) ?? "vapi-assistant";

  // The system prompt is the policy; the first message is how the assistant opens.
  const system = (Array.isArray(model.messages) ? model.messages : [])
    .filter((m): m is Json => isPlainObject(m) && m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content).trim())
    .filter(Boolean);
  if (system.length === 0) warnings.push(`${assistantFile}: the assistant has no system message, so policy.md is a placeholder`);
  const opening = str(assistant.firstMessage);
  const policy = system.length
    ? `# ${title}\n\n${system.join("\n\n")}\n${opening ? `\nOpen each call with: "${opening}"\n` : ""}`
    : POLICY_PLACEHOLDER;
  const templated = templateWarning(system.join("\n"));
  if (templated) warnings.push(templated);

  // The assistant's tools: inline in model.tools, and those model.toolIds names from the export's tool files.
  const ids = new Set(Array.isArray(model.toolIds) ? model.toolIds.filter((x): x is string => typeof x === "string") : []);
  const byId = new Map(toolFiles.filter((t) => typeof t.json.id === "string").map((t) => [t.json.id as string, t]));
  const used: { file: string; json: Json }[] = (Array.isArray(model.tools) ? model.tools : []).filter(isPlainObject).map((json) => ({ file: assistantFile, json }));
  for (const id of ids) {
    const t = byId.get(id);
    if (t) used.push(t);
    else warnings.push(`model.toolIds names ${id}, which no file in the export has: add it with GET https://api.vapi.ai/tool/${id}`);
  }
  for (const t of toolFiles) {
    if (typeof t.json.id !== "string" || !ids.has(t.json.id)) warnings.push(`${t.file}: a tool the assistant doesn't use (it isn't in model.toolIds); skipped`);
  }

  const names = new Set<string>();
  const tools: PlatformTool[] = [];
  const tables: Record<string, { key: string }> = {};
  for (const { file, json } of used) {
    const tool = toolFrom(json, file, names, warnings);
    if (!tool) continue;
    tools.push(tool);
    if (json.type === "transferCall") tables.transfers = { key: "transfer_id" };
  }

  // Each scenario is a task. Its tool mocks are what those tools return in it: rows of a table per tool, given to
  // that task alone, so two scenarios can mock the same tool differently.
  const taskIds = new Set<string>();
  const tasks: PlatformTask[] = [];
  const mocks = new Mocks(tables, "scenario");
  for (const { file, json } of scenarios) {
    const name = str(json.name) ?? `scenario ${tasks.length + 1}`;
    const task: PlatformTask = { id: taskId(taskIds, name), description: name, source: file, instructions: String(json.instructions).trim(), called: [], notes: [] };
    const overrides = isPlainObject(json.targetOverrides) ? json.targetOverrides.variableValues : undefined;
    const variables = isPlainObject(overrides) ? overrides : isPlainObject(json.variableValues) ? json.variableValues : undefined;
    if (variables && Object.keys(variables).length) task.context = variables;
    for (const mock of Array.isArray(json.toolMocks) ? json.toolMocks : []) {
      if (!isPlainObject(mock)) continue;
      const toolName = str(mock.toolName);
      if (mock.enabled === false) {
        task.notes.push(`Its scenario's mock of ${toolName ?? "a tool"} is disabled, so it was left out.`);
        continue;
      }
      // A mock that names no tool is for none: undefined would match every tool with no platform name.
      const tool = toolName === undefined ? undefined : tools.find((t) => t.name === toolName || t.platformName === toolName);
      if (!tool) {
        warnings.push(`${file}: a tool mock for ${toolName ?? "a tool with no toolName"}, which the assistant doesn't have; skipped`);
        continue;
      }
      if (mock.result === undefined || mock.result === null) {
        warnings.push(`${file}: the tool mock for ${toolName} has no result; skipped`);
        continue;
      }
      mocks.add(task, tool, mock.result, file);
    }
    for (const ev of Array.isArray(json.evaluations) ? json.evaluations : []) {
      if (!isPlainObject(ev)) continue;
      const output = str(ev.structuredOutputId) ?? (isPlainObject(ev.structuredOutput) ? (str(ev.structuredOutput.name) ?? "an inline structured output") : "a structured output");
      const test = ev.value === undefined ? "" : ` ${String(ev.comparator ?? "=")} ${JSON.stringify(ev.value)}`;
      task.notes.push(`Vapi graded it with ${output}${test}: write that as expect.state, called or not_called, which sandtable grades without a model.`);
    }
    closeTask(task, "scenario");
    tasks.push(task);
  }

  return {
    name: slug(title),
    description: `Imported from the Vapi assistant "${title}" (${assistantFile}). Every tool, table and task is a draft to review.`,
    policy,
    tables,
    tools,
    tasks,
    warnings,
  };
}

/** A Vapi tool as a sandtable tool, or undefined for a type the draft can't model. */
function toolFrom(json: Json, file: string, names: Set<string>, warnings: string[]): PlatformTool | undefined {
  const type = str(json.type);
  if (!type) {
    warnings.push(`${file}: a tool with no type; skipped`);
    return undefined;
  }
  if (type === "function") {
    const fn = isPlainObject(json.function) ? json.function : {};
    const raw = str(fn.name);
    if (!raw) {
      warnings.push(`${file}: a function tool with no function.name; skipped`);
      return undefined;
    }
    const name = toolName(raw, names, `${file}: function`, warnings);
    const notes: string[] = [];
    const params = schemaParams(fn.parameters, "Vapi", notes);
    const server = isPlainObject(json.server) ? str(json.server.url) : undefined;
    notes.unshift(
      `No scenario mocks it, so what it returns is unknown: model what it reads and changes with get, list, create or update ops on a table${server ? ` (Vapi calls ${server} for it)` : ""}.`,
    );
    return {
      name,
      ...(name !== raw ? { platformName: raw } : {}),
      description: str(fn.description) ?? `${name} (no description in the Vapi config: write one for the model)`,
      params,
      ops: [{ respond: { status: "ok" } }],
      notes,
    };
  }
  if (type === "transferCall") {
    const destinations = (Array.isArray(json.destinations) ? json.destinations : []).filter(isPlainObject).map((d) => {
      const target = str(d.number) ?? str(d.sipUri) ?? str(d.assistantName);
      return { ...(target ? { target } : {}), label: target ?? "?", ...(str(d.description) ? { description: str(d.description) } : {}) };
    });
    return transferTool(names, "transferCall", destinations, "Vapi");
  }
  if (type === "endCall") return endCallTool(names, "endCall");
  warnings.push(`${file}: ${/^[aeiou]/i.test(type) ? "an" : "a"} ${type} tool${SKIPPED_TYPES.has(type) ? ", which Vapi runs itself," : ""} has no sandtable counterpart; skipped`);
  return undefined;
}

/** The draft as sandtable.yaml and tasks.yaml, with review notes as YAML comments next to what they concern. */
export function renderVapiDraft(d: PlatformDraft): { domain: string; tasks: string } {
  return renderPlatformDraft(d, {
    from: "a Vapi assistant",
    command: "import vapi",
    noTasks: "export the assistant's simulation scenarios (GET https://api.vapi.ai/eval/simulation/scenario/<id>)",
  });
}
