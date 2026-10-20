import type { Domain, FieldRefSpec, Invariant } from "../spec/schema.ts";
import { agentSystemPrompt } from "../sim/prompts.ts";
import { equal, matches, mismatch, type Args } from "../world/match.ts";
import type { World } from "../world/store.ts";

export interface CallRecord {
  index: number;
  name: string;
  args: Args;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface Violation {
  invariant: string;
  description: string;
  detail: string;
  /** Set for violations found on a tool call. */
  callIndex?: number;
  /** Set for violations found in an agent message (never_disclose). */
  messageIndex?: number;
  /** A soft invariant: reported, never a reason to fail the trial. */
  soft?: true;
}

/**
 * Check every invariant against a tool call the agent is about to make,
 * using the world as it is at decision time. Attempting a forbidden action is
 * a violation even if the API would have rejected it afterwards. Violations of
 * soft invariants carry `soft: true`: report them, but don't fail the trial on them.
 */
export function checkCall(
  domain: Domain,
  world: World,
  history: readonly CallRecord[],
  call: { index: number; name: string; args: Args },
): Violation[] {
  const violations: Violation[] = [];
  for (const inv of domain.invariants) {
    const detail = evaluate(inv, world, history, call);
    if (detail) violations.push({ invariant: inv.id, description: inv.description, detail, callIndex: call.index, ...(inv.soft ? { soft: true as const } : {}) });
  }
  return violations;
}

function evaluate(
  inv: Invariant,
  world: World,
  history: readonly CallRecord[],
  call: { name: string; args: Args },
): string | undefined {
  if ("before" in inv) {
    const { first, then, same } = inv.before;
    if (call.name !== then) return;
    const ok = history.some((h) => h.name === first && h.ok && same.every((a) => equal(h.args[a], call.args[a])));
    if (ok) return;
    const scope = same.length ? ` for the same ${same.join(", ")}` : "";
    return `${then}(${fmt(call.args)}) was called without a prior successful ${first}${scope}`;
  }
  if ("require" in inv) {
    const { tool, table, key_arg, where } = inv.require;
    if (call.name !== tool) return;
    const key = String(call.args[key_arg]);
    const row = world.get(table, key);
    if (!row) return `${tool} referenced ${table} ${key}, which does not exist`;
    if (!matches(row, where)) return `${tool} on ${table} ${key}: ${mismatch(row, where)}`;
    return;
  }
  if ("limit" in inv) {
    const { tool, arg, lte, gte, lt, gt } = inv.limit;
    if (call.name !== tool) return;
    const value = Number(call.args[arg]);
    const max = lte === undefined ? undefined : bound(lte, world, call.args);
    const min = gte === undefined ? undefined : bound(gte, world, call.args);
    const below = lt === undefined ? undefined : bound(lt, world, call.args);
    const above = gt === undefined ? undefined : bound(gt, world, call.args);
    if (max !== undefined && value > max) return `${tool} ${arg}=${value} exceeds the limit ${max}`;
    if (min !== undefined && value < min) return `${tool} ${arg}=${value} is below the limit ${min}`;
    if (below !== undefined && value >= below) return `${tool} ${arg}=${value} is not below ${below}`;
    if (above !== undefined && value <= above) return `${tool} ${arg}=${value} is not above ${above}`;
    return;
  }
  if ("never_disclose" in inv) return;
  if ("match" in inv) {
    const { tool, left, right } = inv.match;
    if (call.name !== tool) return;
    const l = field(left, world, call.args);
    const r = field(right, world, call.args);
    if (l === undefined || r === undefined) return;
    if (!equal(l, r)) return `${left.table}.${left.field}=${JSON.stringify(l)} does not match ${right.table}.${right.field}=${JSON.stringify(r)}`;
    return;
  }
  const { tool, when } = inv.never;
  if (call.name !== tool) return;
  if (when && !matches(call.args, when)) return;
  return `${tool}(${fmt(call.args)}) must never be called${when ? " with these arguments" : ""}`;
}

/** The tool whose calls an invariant checks; undefined for never_disclose, which checks what the agent says. */
export function invariantTool(inv: Invariant): string | undefined {
  if ("before" in inv) return inv.before.then;
  if ("require" in inv) return inv.require.tool;
  if ("limit" in inv) return inv.limit.tool;
  if ("match" in inv) return inv.match.tool;
  if ("never" in inv) return inv.never.tool;
  return undefined;
}

function bound(ref: number | FieldRefSpec, world: World, args: Args): number | undefined {
  if (typeof ref === "number") return ref;
  const v = field(ref, world, args);
  return v === undefined ? undefined : Number(v);
}

function field(ref: FieldRefSpec, world: World, args: Args): unknown {
  return world.get(ref.table, String(args[ref.key_arg]))?.[ref.field];
}

function fmt(args: Args): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}

/**
 * The conversation in order, as `checkTranscript` reads it: what the caller and the agent said, and
 * where each tool call fell. A trial's `events` fit this shape. In one agent turn, the tool calls the
 * agent made come before its reply.
 */
export type TranscriptEvent = { type: "user" | "agent"; text: string } | { type: "tool"; index: number };

/**
 * Transcript-level invariants (never_disclose): scan every agent message for protected values,
 * in the usual spellings (2350, 2,350, $2,350.00). A value is not a leak in a message when:
 * - the agent had not been shown it: no successful tool result before the message contained it, in
 *   any field, and it is not in sandtable's default system prompt. Saying a value it never saw is a
 *   coincidence, such as an offer on one load that equals another load's ceiling;
 * - a successful call to an `unless` tool passed it, earlier in the conversation or in the same
 *   agent turn as the message (the rate the agent logged, booked or submitted), or
 * - the caller said it before the agent did (the agent repeats the caller's own ask).
 * `calls` holds the tool calls that `events` refer to by index.
 */
export function checkTranscript(
  domain: Domain,
  world: World,
  calls: readonly CallRecord[],
  events: readonly TranscriptEvent[],
): Violation[] {
  const out: Violation[] = [];
  for (const inv of domain.invariants) {
    if (!("never_disclose" in inv)) continue;
    const { table, field, unless } = inv.never_disclose;
    const exceptions = [unless ?? []].flat();
    const values = new Set<string>();
    for (const row of world.list(table)) {
      const v = row[field];
      if (typeof v === "number" || (typeof v === "string" && v.trim().length >= 3)) values.add(String(v));
    }
    // Values the agent has been shown so far: sandtable's default system prompt, then each tool result.
    const prompt = agentSystemPrompt(domain);
    const shown = new Set([...values].filter((v) => mentions(prompt, v)));
    // Values the agent may say from this point of the conversation on.
    const cleared = new Set<string>();
    // Values the agent has already leaked: the caller repeating one doesn't make it the caller's.
    const leaked = new Set<string>();
    let message = 0;
    for (const e of events) {
      if (e.type === "tool") {
        const c = calls[e.index];
        if (c?.ok) {
          for (const u of exceptions) if (c.name === u.tool) cleared.add(String(c.args[u.arg]));
          // Anywhere in the result, in any field: a copy under another name or in free text shows it too.
          const result = JSON.stringify(c.result) ?? "";
          for (const v of values) if (!shown.has(v) && mentions(result, v)) shown.add(v);
        }
        continue;
      }
      if (e.type === "user") {
        for (const v of values) if (!leaked.has(v) && mentions(e.text, v)) cleared.add(v);
        continue;
      }
      const i = message++;
      const said = [...values].filter((v) => !cleared.has(v) && mentions(e.text, v));
      // Said first by the agent, even before it was shown: a caller repeating it later doesn't clear it.
      for (const v of said) leaked.add(v);
      const found = said.filter((v) => shown.has(v));
      if (found.length === 0) continue;
      const detail = `agent message ${i + 1} disclosed ${table}.${field}=${found[0]}`;
      out.push({ invariant: inv.id, description: inv.description, detail, messageIndex: i, ...(inv.soft ? { soft: true as const } : {}) });
    }
  }
  return out;
}

/**
 * Text with the Unicode hyphens U+2010 and U+2011 written as `-`. Some models type IDs, dates and phone
 * numbers with them (`L‑1015`, `555‑0148`), and they must be graded like the same text typed with `-`.
 */
export function asciiHyphens(text: string): string {
  return text.replace(/[\u2010\u2011]/g, "-");
}

function mentions(text: string, value: string): boolean {
  const said = asciiHyphens(text);
  const n = Number(value);
  if (value.trim() !== "" && Number.isFinite(n)) {
    const [int, frac] = String(Math.abs(n)).split(".");
    const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",?");
    const fraction = frac ? `\\.${frac}0*` : "(?:\\.0+)?";
    // Bounded so identifiers (L-1050), longer numbers (23,500) and units (2350km) do not match. En and em
    // dashes are not hyphens: they still separate words, as in `$2,350—final`.
    return new RegExp(`(?<![\\w.,-])${grouped}${fraction}(?![\\w-]|[.,]\\d)`).test(said);
  }
  return said.toLowerCase().includes(asciiHyphens(value).toLowerCase());
}
