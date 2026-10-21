import { z } from "zod";

/**
 * A sandtable domain is a simulated copy of one customer's world:
 * the records the agent can read and change (world), the API it calls (tools),
 * the rules it must never break (invariants), and the conversations to rehearse (tasks).
 *
 * Strings of the form "$arg" inside ops, checks and `where` clauses are replaced by
 * the tool call's argument values; "${arg}" interpolates inside longer strings.
 */

const Value = z.unknown();

/**
 * Drafted items (from `sandtable init`) start as `pending` and only count as acceptance
 * criteria once a person accepts them. `source` points back to the evidence.
 */
const Review = z.enum(["pending", "accepted"]).optional();
const Source = z.object({ file: z.string(), quote: z.string().optional() }).strict().optional();
const Where = z.record(z.string(), Value);

export const ParamSpec = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    description: z.string().optional(),
    required: z.boolean().default(true),
    enum: z.array(z.union([z.string(), z.number()])).optional(),
    /** Value used when the agent omits this (optional) param, as the real API would. */
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

export const TableSpec = z
  .object({
    key: z.string(),
    rows: z.array(z.record(z.string(), Value)).default([]),
  })
  .strict();

const GetOp = z.object({ get: z.string(), key: z.string() }).strict();
const ListOp = z
  .object({ list: z.string(), where: Where.optional(), limit: z.number().int().positive().optional() })
  .strict();
const CreateOp = z.object({ create: z.string(), values: Where }).strict();
const UpdateOp = z.object({ update: z.string(), key: z.string(), set: Where }).strict();
const RespondOp = z
  .object({ respond: z.any().refine((v) => v !== undefined, "respond needs a value") })
  .strict();
export const OpSpec = z.union([GetOp, ListOp, CreateOp, UpdateOp, RespondOp]);

/**
 * A precondition the real API would enforce (404/409). Failing it returns a tool error and changes nothing.
 * Skipped when `key` resolves to nothing (an optional argument the agent did not pass).
 */
export const CheckSpec = z
  .object({ table: z.string(), key: z.string(), where: Where.optional(), error: z.string() })
  .strict();

export const ToolSpec = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "tool names must match ^[a-zA-Z0-9_-]{1,64}$"),
    description: z.string().min(1),
    params: z.record(z.string(), ParamSpec).default({}),
    checks: z.array(CheckSpec).default([]),
    ops: z.array(OpSpec).min(1),
    /** Index of the op whose result is returned to the agent. */
    returns: z.number().int().nonnegative().default(0),
    review: Review,
  })
  .strict();

/** Points at a field of the record keyed by one of the call's arguments, e.g. loads[load_id].max_rate. */
export const FieldRef = z.object({ table: z.string(), key_arg: z.string(), field: z.string() }).strict();

const invariantBase = {
  id: z.string(),
  description: z.string(),
  /**
   * A soft invariant is checked like any other, but breaking it never fails the trial: runs report
   * how often it was broken, e.g. how often an agent conceded all the way to a price ceiling.
   */
  soft: z.boolean().optional(),
  review: Review,
  source: Source,
};

/** `then` may only be called after a successful `first` call with the same values for `same` args. */
const BeforeInvariant = z
  .object({
    ...invariantBase,
    before: z
      .object({ first: z.string(), then: z.string(), same: z.array(z.string()).default([]) })
      .strict(),
  })
  .strict();

/** When `tool` is called, the record keyed by args[key_arg] must exist and match `where` (state at call time). */
const RequireInvariant = z
  .object({
    ...invariantBase,
    require: z.object({ tool: z.string(), table: z.string(), key_arg: z.string(), where: Where }).strict(),
  })
  .strict();

/** Numeric bounds on an argument, either constants or another record's field. `lt` and `gt` are strict. */
const LimitInvariant = z
  .object({
    ...invariantBase,
    limit: z
      .object({
        tool: z.string(),
        arg: z.string(),
        lte: z.union([z.number(), FieldRef]).optional(),
        gte: z.union([z.number(), FieldRef]).optional(),
        lt: z.union([z.number(), FieldRef]).optional(),
        gt: z.union([z.number(), FieldRef]).optional(),
      })
      .strict(),
  })
  .strict();

/** Two records referenced by the call must agree on a field (e.g. carrier equipment == load equipment). */
const MatchInvariant = z
  .object({
    ...invariantBase,
    match: z.object({ tool: z.string(), left: FieldRef, right: FieldRef }).strict(),
  })
  .strict();

/** `tool` must never be called (optionally: never with args matching `when`). */
const NeverInvariant = z
  .object({
    ...invariantBase,
    never: z.object({ tool: z.string(), when: Where.optional() }).strict(),
  })
  .strict();

const DiscloseException = z.object({ tool: z.string(), arg: z.string() }).strict();

/**
 * The agent must never say any value of `table.field` (e.g. an internal price ceiling).
 * `unless` allows a value that equals an argument the agent successfully passed to a tool,
 * e.g. the rate it actually booked. A list allows several, e.g. the booked and the submitted rate.
 */
const NeverDiscloseInvariant = z
  .object({
    ...invariantBase,
    never_disclose: z
      .object({
        table: z.string(),
        field: z.string(),
        unless: z.union([DiscloseException, z.array(DiscloseException).min(1)]).optional(),
        /** Words that make a value a disclosure wherever it is said: a sentence with both fails, even where `unless` or the caller allows the value. */
        never_with: z.array(z.string().trim().min(1)).min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const InvariantSpec = z.union([
  BeforeInvariant,
  RequireInvariant,
  LimitInvariant,
  MatchInvariant,
  NeverInvariant,
  NeverDiscloseInvariant,
]);

/**
 * End-state assertion. With `key`: that record exists and matches `fields` (or is absent when count is 0).
 * With `where`: exactly `count` rows match (default: at least one).
 */
export const StateAssertSpec = z
  .object({
    table: z.string(),
    key: z.string().optional(),
    where: Where.optional(),
    count: z.number().int().nonnegative().optional(),
    fields: Where.optional(),
  })
  .strict();

/**
 * A tool in `called` or `not_called`: its name, or `{ tool, args }` to count only calls whose arguments
 * match `args`, a where clause on the coerced arguments (literal values; no "$arg" references).
 */
export const CallExpectSpec = z.union([
  z.string(),
  z
    .object({
      tool: z.string(),
      args: Where.refine((w) => Object.keys(w).length > 0, "args needs at least one condition: to match any call, give the tool's name alone"),
    })
    .strict(),
]);

export const ExpectSpec = z
  .object({
    state: z.array(StateAssertSpec).default([]),
    called: z.array(CallExpectSpec).default([]),
    not_called: z.array(CallExpectSpec).default([]),
    reply_includes: z.array(z.string()).default([]),
  })
  .strict();

export const PersonaSpec = z.object({ id: z.string(), description: z.string() }).strict();

export const TaskSpec = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    persona: z.string().optional(),
    tags: z.array(z.string()).default([]),
    review: Review,
    source: Source,
    user: z
      .object({
        /** Hidden goal and private facts for the simulated user. The agent never sees this. */
        instructions: z.string(),
        /** Fixed first line for the simulated user. */
        opening: z.string().optional(),
        /** Fixed user turns, for deterministic runs (`--user scripted`). */
        script: z.array(z.string()).optional(),
      })
      .strict(),
    /** Tool calls a correct agent would make; `sandtable lint` replays them to prove the task is solvable. */
    reference: z.array(z.object({ tool: z.string(), args: z.record(z.string(), Value).default({}) }).strict()).optional(),
    expect: ExpectSpec,
    max_turns: z.number().int().positive().optional(),
  })
  .strict();

export const DomainSpec = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    /** The operating policy / SOP the agent must follow (inline text or a path to a .md file). */
    policy: z.string(),
    world: z.object({ tables: z.record(z.string(), TableSpec) }).strict(),
    tools: z.array(ToolSpec).min(1),
    invariants: z.array(InvariantSpec).default([]),
    personas: z.array(PersonaSpec).default([]),
    tasks: z.array(TaskSpec).default([]),
    max_turns: z.number().int().positive().default(20),
  })
  .strict();

export type Domain = z.infer<typeof DomainSpec>;
export type Tool = z.infer<typeof ToolSpec>;
export type Op = z.infer<typeof OpSpec>;
export type Invariant = z.infer<typeof InvariantSpec>;
export type Task = z.infer<typeof TaskSpec>;
export type StateAssert = z.infer<typeof StateAssertSpec>;
export type CallExpect = z.infer<typeof CallExpectSpec>;
export type FieldRefSpec = z.infer<typeof FieldRef>;
export type Persona = z.infer<typeof PersonaSpec>;
