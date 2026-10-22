import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { DOMAIN_FILE } from "../spec/load.ts";
import type { DraftParam, OpenApiDraft } from "./openapi.ts";

export const POLICY_PLACEHOLDER = `# Policy

TODO: paste the customer's operating procedure (SOP) here, or draft from one with \`npx sandtable-ai init --sop <file>\`.
The reference agent uses this text as its system prompt.
`;

/**
 * The placeholder policy.md that 0.1.0-alpha.1 wrote, before it said `npx sandtable-ai`. A draft made
 * by that release still holds it, and `init --sop` must replace it too, or the TODO stays the policy.
 */
export const POLICY_PLACEHOLDER_0_1_0_ALPHA_1 = `# Policy

TODO: paste the customer's operating procedure (SOP) here, or draft from one with \`sandtable init --sop <file>\`.
The reference agent uses this text as its system prompt.
`;

/** Whether a policy.md still holds the placeholder that `init` wrote, in this release or an earlier one. */
export function isPolicyPlaceholder(text: string | undefined): boolean {
  return text === POLICY_PLACEHOLDER || text === POLICY_PLACEHOLDER_0_1_0_ALPHA_1;
}

export const TASKS_PLACEHOLDER = `# TODO: add tasks (see "personas and tasks" in docs/reference/spec.mdx of the sandtable repo),
# or draft them from call transcripts with \`npx sandtable-ai init --transcripts <dir>\`.
[]
`;

/** Render a draft as sandtable.yaml, with review notes as YAML comments next to what they concern. */
export function renderDraft(d: OpenApiDraft, source: string): string {
  const tables = Object.fromEntries(
    Object.entries(d.tables).map(([name, t]) => [name, t.rows.length ? { key: t.key, rows: t.rows } : { key: t.key }]),
  );
  const tools = d.tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...(Object.keys(t.params).length ? { params: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, paramYaml(p)])) } : {}),
    ...(t.checks.length ? { checks: t.checks } : {}),
    ops: t.ops,
    ...(t.returns !== undefined ? { returns: t.returns } : {}),
    ...(t.notes.length ? { review: "pending" } : {}),
  }));
  const doc = new YAML.Document({
    name: d.name,
    description: d.description,
    policy: "./policy.md",
    world: { tables },
    tools,
    invariants: [],
    tasks: "./tasks.yaml",
  });
  doc.commentBefore = [
    ` Drafted by \`npx sandtable-ai init\` from ${source}.`,
    " Review every TODO, add seed rows and invariants, then run `npx sandtable-ai validate`.",
  ].join("\n");
  for (const [name, t] of Object.entries(d.tables)) {
    if (t.rows.length) continue;
    const node = doc.getIn(["world", "tables", name], true) as YAML.Node | undefined;
    if (node) node.commentBefore = ` TODO: add seed rows. Fields in the spec: ${t.fields.join(", ") || "none"}`;
  }
  d.tools.forEach((tool, i) => {
    // Short maps read better inline: params, checks and operator conditions.
    for (const [name, p] of Object.entries(tool.params)) flowParam(doc, ["tools", i, "params", name], p);
    tool.checks.forEach((_, j) => flow(doc.getIn(["tools", i, "checks", j], true)));
    tool.ops.forEach((op, j) => {
      for (const field of Object.keys((op.where ?? {}) as object)) flow(doc.getIn(["tools", i, "ops", j, "where", field], true));
    });
    if (!tool.notes.length) return;
    const node = doc.getIn(["tools", i], true) as YAML.Node | undefined;
    if (node) node.commentBefore = tool.notes.map((n) => ` TODO(review): ${n}`).join("\n");
  });
  return doc.toString({ lineWidth: 0 });
}

/** A drafted param as YAML: `required` only where it isn't the default, and never on an array's items. */
function paramYaml(p: DraftParam, isItems = false): Record<string, unknown> {
  const { required, properties, items, ...rest } = p;
  return {
    ...rest,
    ...(required || isItems ? {} : { required }),
    ...(properties ? { properties: Object.fromEntries(Object.entries(properties).map(([k, c]) => [k, paramYaml(c)])) } : {}),
    ...(items ? { items: paramYaml(items, true) } : {}),
  };
}

/** A scalar param reads best inline; an object or array param stays a block, with its scalars inline. */
function flowParam(doc: YAML.Document, at: (string | number)[], p: DraftParam) {
  if (p.properties) for (const [name, c] of Object.entries(p.properties)) flowParam(doc, [...at, "properties", name], c);
  else if (p.items) flowParam(doc, [...at, "items"], p.items);
  else flow(doc.getIn(at, true));
}

function flow(node: unknown) {
  if (YAML.isMap(node) || YAML.isSeq(node)) node.flow = true;
}

export interface DraftFiles {
  [file: string]: string;
}

/** Write draft files into `dir`, refusing to overwrite unless `force`. Returns the written paths. */
export async function writeDraft(dir: string, files: DraftFiles, force = false): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const targets = Object.keys(files).map((f) => path.join(dir, f));
  if (!force) {
    const existing = [];
    for (const t of targets) if (await stat(t).catch(() => undefined)) existing.push(t);
    if (existing.length) throw new Error(`refusing to overwrite ${existing.join(", ")} (use --force)`);
  }
  for (const [f, content] of Object.entries(files)) await writeFile(path.join(dir, f), content);
  return targets;
}

export { DOMAIN_FILE };
