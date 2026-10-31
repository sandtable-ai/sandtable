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

const SCALAR_TYPES = ["string", "number", "integer", "boolean"] as const;

/**
 * One argument of a tool. Scalars are `string`, `number`, `integer` or `boolean`. An `object` lists its
 * `properties`, each a param that is required unless it says otherwise; an `array` gives the param of its
 * `items`, which has no `required` or `default` of its own. With `nullable: true`, an explicit `null` is kept
 * (to clear a field, say); without it, `null` and `""` mean the argument was left out.
 */
interface Param {
  type: (typeof SCALAR_TYPES)[number] | "object" | "array";
  description?: string;
  required: boolean;
  nullable?: boolean;
  enum?: (string | number)[];
  /** Value used when the agent omits this (optional) param, as the real API would. */
  default?: unknown;
  properties?: Record<string, Param>;
  items?: Param;
}

interface ParamInput extends Omit<Param, "required" | "properties" | "items"> {
  required?: boolean;
  properties?: Record<string, ParamInput>;
  items?: ParamInput;
}

export const ParamSpec: z.ZodType<Param, ParamInput> = z.lazy(() =>
  z
    .object({
      type: z.enum([...SCALAR_TYPES, "object", "array"]),
      description: z.string().optional(),
      required: z.boolean().default(true),
      nullable: z.boolean().optional(),
      enum: z.array(z.union([z.string(), z.number()])).optional(),
      default: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Value), z.record(z.string(), Value)]).optional(),
      properties: z.record(z.string(), ParamSpec).optional(),
      items: ParamSpec.optional(),
    })
    .strict()
    .superRefine((p, ctx) => {
      if (p.type === "object" && !p.properties) ctx.addIssue({ code: "custom", message: "an object param needs properties", path: ["properties"] });
      if (p.type !== "object" && p.properties) ctx.addIssue({ code: "custom", message: `properties are only for an object param, not a ${p.type}`, path: ["properties"] });
      if (p.type === "array" && !p.items) ctx.addIssue({ code: "custom", message: "an array param needs items", path: ["items"] });
      if (p.type !== "array" && p.items) ctx.addIssue({ code: "custom", message: `items are only for an array param, not a ${p.type}`, path: ["items"] });
      if (p.enum && (p.type === "object" || p.type === "array")) ctx.addIssue({ code: "custom", message: `enum is only for a scalar param, not an ${p.type}`, path: ["enum"] });
      if (p.items?.required === false) ctx.addIssue({ code: "custom", message: "an array's items have no required of their own: make the array optional instead", path: ["items", "required"] });
      if (p.items?.default !== undefined) ctx.addIssue({ code: "custom", message: "an array's items have no default of their own: give the array a default instead", path: ["items", "default"] });
    }),
);

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
    require: z
      .object({
        tool: z.string(),
        table: z.string(),
        key_arg: z.string(),
        where: Where,
        /** A call naming a row that doesn't exist doesn't break this rule: leave that to a rule about the row existing. */
        skip_missing: z.boolean().optional(),
      })
      .strict(),
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

/**
 * One call of a task's `reference`. `expect_error` marks a call the API rejects, such as a lookup of an
 * unknown ID in a refusal task: `true` for any tool error, or text the error must contain (case-insensitive).
 * `lint` then requires that call to fail. References are only replayed by `lint`; they never grade a trial.
 */
export const ReferenceCallSpec = z
  .object({
    tool: z.string(),
    args: z.record(z.string(), Value).default({}),
    expect_error: z.union([z.boolean(), z.string().trim().min(1)]).optional(),
  })
  .strict();

export const PersonaSpec = z.object({ id: z.string(), description: z.string() }).strict();

/**
 * What one task changes about the world it starts in, so a scenario needs no copy of the domain.
 * `rows` are merged into the seed by each table's key, for this task only: a row whose key is seeded
 * patches that row's fields, a new key adds a row. `context` is what the system that connected the call
 * already knows (a caller ID, a trigger payload): the agent is given it, the simulated user is not.
 */
export const GivenSpec = z
  .object({
    rows: z.record(z.string(), z.array(z.record(z.string(), Value))).optional(),
    context: z.record(z.string(), Value).optional(),
  })
  .strict();

export const FAULT_ERRORS = ["timeout", "rate_limit", "server_error"] as const;

/**
 * A failure injected into a task's tool calls, the way a flaky dependency fails: an `error` (`timeout`, no response;
 * `rate_limit`, a 429 that says to retry after `retry_after` seconds; `server_error`, a 5xx `status`, 503 by default),
 * a delay of `latency_ms` before the response, or both. `call` picks the calls of `tool` it hits, counting from 1 the
 * calls whose arguments are valid; every call when left out. A fault with an error stops the call before the tool runs,
 * unless `after_commit: true`: then the tool runs and its write lands, and the agent sees the error anyway, the classic
 * double-booking trap. `message` replaces the error's default text. Invariants check the call either way.
 */
export const FaultSpec = z
  .object({
    tool: z.string(),
    call: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)], { error: "call is a call number, 1 or more, or a list of them" }).optional(),
    error: z.enum(FAULT_ERRORS).optional(),
    status: z.number().int().min(500).max(599).optional(),
    retry_after: z.number().nonnegative().optional(),
    after_commit: z.boolean().optional(),
    latency_ms: z.number().int().positive().max(60_000).optional(),
    message: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (!f.error && f.latency_ms === undefined) ctx.addIssue({ code: "custom", message: "a fault needs an error, a latency_ms, or both" });
    if (f.status !== undefined && f.error !== "server_error") ctx.addIssue({ code: "custom", message: "status is for error: server_error", path: ["status"] });
    if (f.retry_after !== undefined && f.error !== "rate_limit") ctx.addIssue({ code: "custom", message: "retry_after is for error: rate_limit", path: ["retry_after"] });
    if (f.after_commit && f.error !== "timeout" && f.error !== "server_error") {
      ctx.addIssue({ code: "custom", message: "after_commit is for a timeout or a server_error: without an error the call succeeds anyway, and a rate limit refuses a call before it runs", path: ["after_commit"] });
    }
    if (f.message !== undefined && !f.error) ctx.addIssue({ code: "custom", message: "message is the text of an error: give the fault an error", path: ["message"] });
  });

/** Which call of a tool an event follows: the `call`-th, counting as faults do, the first by default. */
const EventAfter = z.object({ tool: z.string(), call: z.number().int().positive().default(1) }).strict();

/**
 * A change someone else makes to the world during a task, such as another carrier booking a load the agent found:
 * right after the call that `after` names, `update` sets fields of the row keyed `key`, or `create` adds a row with
 * `values`. Values are literal: a "$arg" in them is not replaced.
 */
export const EventSpec = z.union(
  [z.object({ after: EventAfter, update: z.string(), key: z.string(), set: Where }).strict(), z.object({ after: EventAfter, create: z.string(), values: Where }).strict()],
  { error: "an event has after, and either update with key and set, or create with values" },
);

export const TaskSpec = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    persona: z.string().optional(),
    tags: z.array(z.string()).default([]),
    /** A release blocker: `sandtable run` exits 1 when any of its trials fails, whatever the score and `--fail-under`. */
    critical: z.boolean().optional(),
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
    reference: z.array(ReferenceCallSpec).optional(),
    given: GivenSpec.optional(),
    /** Failures injected into this task's tool calls (see FaultSpec). */
    faults: z.array(FaultSpec).min(1).optional(),
    /** Changes made to the world by someone else during this task (see EventSpec). */
    events: z.array(EventSpec).min(1).optional(),
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
export type ReferenceCall = z.infer<typeof ReferenceCallSpec>;
export type FieldRefSpec = z.infer<typeof FieldRef>;
export type Persona = z.infer<typeof PersonaSpec>;
export type Given = z.infer<typeof GivenSpec>;
export type Fault = z.infer<typeof FaultSpec>;
export type TaskEvent = z.infer<typeof EventSpec>;
