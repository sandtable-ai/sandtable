import { z } from "zod";

/**
 * A rehearsal domain is a simulated copy of one customer's world:
 * the records the agent can read and change (world), the API it calls (tools),
 * the rules it must never break (invariants), and the conversations to rehearse (tasks).
 *
 * Strings of the form "$arg" inside ops, checks and `where` clauses are replaced by
 * the tool call's argument values; "${arg}" interpolates inside longer strings.
 */

const Value = z.unknown();
const Where = z.record(z.string(), Value);

export const ParamSpec = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    description: z.string().optional(),
    required: z.boolean().default(true),
    enum: z.array(z.union([z.string(), z.number()])).optional(),
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

/** A precondition the real API would enforce (404/409). Failing it returns a tool error and changes nothing. */
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
  })
  .strict();

/** Points at a field of the record keyed by one of the call's arguments, e.g. loads[load_id].max_rate. */
export const FieldRef = z.object({ table: z.string(), key_arg: z.string(), field: z.string() }).strict();

const invariantBase = { id: z.string(), description: z.string() };

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

/** Numeric bounds on an argument, either constants or another record's field. */
const LimitInvariant = z
  .object({
    ...invariantBase,
    limit: z
      .object({
        tool: z.string(),
        arg: z.string(),
        lte: z.union([z.number(), FieldRef]).optional(),
        gte: z.union([z.number(), FieldRef]).optional(),
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

export const InvariantSpec = z.union([
  BeforeInvariant,
  RequireInvariant,
  LimitInvariant,
  MatchInvariant,
  NeverInvariant,
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

export const ExpectSpec = z
  .object({
    state: z.array(StateAssertSpec).default([]),
    called: z.array(z.string()).default([]),
    not_called: z.array(z.string()).default([]),
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
    tasks: z.array(TaskSpec).min(1),
    max_turns: z.number().int().positive().default(20),
  })
  .strict();

export type Domain = z.infer<typeof DomainSpec>;
export type Tool = z.infer<typeof ToolSpec>;
export type Op = z.infer<typeof OpSpec>;
export type Invariant = z.infer<typeof InvariantSpec>;
export type Task = z.infer<typeof TaskSpec>;
export type StateAssert = z.infer<typeof StateAssertSpec>;
export type FieldRefSpec = z.infer<typeof FieldRef>;
export type Persona = z.infer<typeof PersonaSpec>;
