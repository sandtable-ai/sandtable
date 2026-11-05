import { gradeEpisode, toolEvent, worldChanges, type TrajectoryEvent, type TrialResult } from "../run/episode.ts";
import { inputsFingerprint } from "../run/inputs.ts";
import { runPendingReview, summarize, type SuiteResult } from "../run/suite.ts";
import { createToolRunner } from "../run/tool-runner.ts";
import { sumUsage } from "../run/usage.ts";
import { resolveTrial, type ResolvedPhrase } from "../spec/clock.ts";
import type { Domain, Task } from "../spec/schema.ts";
import { version } from "../version.ts";
import { worldFor, type Snapshot, type World } from "../world/store.ts";
import { HttpError, startWorldServer, type ServedSession, type WorldServer } from "./server.ts";
import type { TranscriptLine } from "./webhook.ts";

/** The simulated user's name in a served run's results: someone else drove the conversation. */
export const EXTERNAL_USER = "external";

/** Minutes a served conversation may go with no request before it is ended without its end, unless told otherwise. */
export const DEFAULT_IDLE_TIMEOUT = 30;
/** The longest idle timeout in minutes: a timer can't wait longer than 2^31 - 1 milliseconds, about 24 days. */
export const MAX_IDLE_TIMEOUT = Math.floor((2 ** 31 - 1) / 60_000);

/** The error a conversation ended for want of a request is graded with. */
function idleError(minutes: number): string {
  return `no request and no end of the conversation came within ${minutes} ${minutes === 1 ? "minute" : "minutes"}, so it was ended without one: check that the platform sends its end of call to this server (--idle-timeout ${minutes})`;
}

/** What `end` answers with: the graded trial's verdict and what failed. */
export interface GradedAnswer {
  session: string;
  task: string;
  trial: number;
  passed: boolean;
  skipped?: true;
  failed: { id: string; detail: string }[];
}

export interface DrivenOptions {
  port: number;
  host?: string;
  /** The task a conversation rehearses unless it names one. */
  task?: Task;
  /** The agent's name in results.json. */
  label: string;
  onOpen?(session: ServedSession): void;
  /** A conversation was graded: its trial, and the run as it stands now. Its end is answered once this settles. */
  onGraded?(trial: TrialResult, result: SuiteResult): void | Promise<void>;
  /** The current time, read as each session opens, for `clock: now`: the system clock unless given. */
  now?: () => Date;
  /**
   * Minutes a conversation may go with no request before it is ended without its end, a whole number: 0 never ends one.
   * It is graded then as a trial that ended in an error, so it is skipped unless the agent broke a rule. Default 30.
   */
  idleTimeout?: number;
}

/**
 * An open session's trial: its domain and task with their dates resolved (and its `reply_includes` in pieces, see
 * resolveTrial), its world as it started and as it is, and its tool calls with the time each came in.
 */
interface OpenSession {
  session: ServedSession;
  domain: Domain;
  task: Task;
  clock?: string;
  phrases?: ResolvedPhrase[];
  world: World;
  initial: Snapshot;
  calls: { at: number; event: TrajectoryEvent }[];
  started: number;
}

/**
 * `sandtable serve`: serves the simulated world for conversations another system drives, such as a hosted voice
 * platform's own simulated callers, and grades each one when it ends. Each conversation is a session and a trial of
 * its task, graded on the end state, the invariants and the tools it called, and on what was said when the platform
 * sends the transcript. The run so far is `result()`: one task summary per task with a graded conversation.
 */
export async function serveConversations(domain: Domain, opts: DrivenOptions): Promise<{ server: WorldServer; result(): SuiteResult | undefined; openSessions(): ServedSession[] }> {
  const idleTimeout = opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
  if (!Number.isInteger(idleTimeout) || idleTimeout < 0 || idleTimeout > MAX_IDLE_TIMEOUT) {
    throw new RangeError(`idleTimeout must be a whole number of minutes, 0-${MAX_IDLE_TIMEOUT} (0 never ends a conversation), not ${idleTimeout}`);
  }
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const runId = `${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}-${Math.random().toString(36).slice(2, 6)}`;
  const trials: TrialResult[] = [];
  let latest: SuiteResult | undefined;
  const open = new Map<string, OpenSession>();

  const server: WorldServer = await startWorldServer(domain, {
    port: opts.port,
    ...(opts.host ? { host: opts.host } : {}),
    driven: {
      open(taskId) {
        const written = taskId === undefined ? opts.task : domain.tasks.find((t) => t.id === taskId);
        if (!written) {
          throw new HttpError(
            taskId === undefined ? 409 : 404,
            taskId === undefined ? "no task to rehearse: start sandtable serve with --task <id>, or open a session with POST /sessions and { \"task\": \"<id>\" }" : `unknown task "${taskId}" in ${domain.name}`,
          );
        }
        // The session is a trial: its dates resolve once, as it opens.
        const trial = resolveTrial(domain, written, opts.now?.());
        const world = worldFor(trial.domain, trial.task);
        const calls: { at: number; event: TrajectoryEvent }[] = [];
        const runner = createToolRunner(trial.domain, world, (e) => calls.push({ at: Date.now(), event: toolEvent(e) }), trial.task);
        const session = server.open(trial.task, runner, trial.domain.tools);
        open.set(session.id, { session, ...trial, world, initial: world.snapshot(), calls, started: Date.now() });
        opts.onOpen?.(session);
        return session;
      },
      async end(session, transcript, problem) {
        const trial = await grade(session, transcript, problem === undefined ? {} : { problem });
        const answer: GradedAnswer = {
          session: session.id,
          task: session.task.id,
          trial: trial.trial,
          passed: trial.passed,
          ...(trial.skipped ? { skipped: true as const } : {}),
          failed: trial.checks.filter((c) => !c.passed).map((c) => ({ id: c.id, detail: c.detail })),
        };
        return answer;
      },
      idleMs: idleTimeout * 60_000,
      async idle(session) {
        await grade(session, undefined, { error: idleError(idleTimeout) });
      },
    },
  });

  /** A conversation ended: stop serving it, grade it as a trial of its task, and report the run as it stands now. */
  async function grade(session: ServedSession, transcript: TranscriptLine[] | undefined, ended: Ended): Promise<TrialResult> {
    const st = open.get(session.id)!;
    open.delete(session.id);
    server.close(session.id);
    const trial = gradeConversation(st, transcript, trials.filter((t) => t.taskId === session.task.id).length, ended);
    trials.push(trial);
    latest = summary();
    await opts.onGraded?.(trial, latest);
    return trial;
  }

  /** The run so far: the tasks with a graded conversation, k their most trials. */
  function summary(): SuiteResult {
    const tasks = domain.tasks.filter((t) => trials.some((tr) => tr.taskId === t.id));
    const k = Math.max(...tasks.map((t) => trials.filter((tr) => tr.taskId === t.id).length));
    return {
      version: 1,
      sandtable: { version },
      runId,
      domain: domain.name,
      agent: opts.label,
      user: EXTERNAL_USER,
      k,
      inputs: inputsFingerprint(domain, tasks.map((t) => t.id), EXTERNAL_USER),
      startedAt,
      durationMs: Date.now() - started,
      ...summarize(domain, tasks, trials, k, EXTERNAL_USER),
      usage: sumUsage(trials.map((t) => t.usage)),
      pendingReview: runPendingReview(domain),
      // The platform's own timing isn't known here.
      latency: { agentTurnP50Ms: null, agentTurnP95Ms: null },
    };
  }

  return { server, result: () => latest, openSessions: () => [...open.values()].map((s) => s.session) };
}

/**
 * How a conversation ended, besides its transcript. `problem`: nothing in it can be trusted to be this call's, such as
 * another call's requests in its world. `error`: it ended without its end, such as when no request came for too long.
 */
interface Ended {
  problem?: string;
  error?: string;
}

/**
 * Grade a conversation another system drove: the end state, the invariants and the tools called, and, with a
 * transcript, what the agent said. The tool calls go between the transcript's lines by time when every line has one;
 * otherwise all of them come before the agent's first line. Without a transcript, a task that checks what the agent
 * said can't be graded on it, so the trial ends in an error: skipped, unless the agent broke a rule. So does a trial
 * that ended in an `error`. With a `problem`, the trial ends in that error, and is skipped whatever it shows.
 */
function gradeConversation(st: OpenSession, transcript: TranscriptLine[] | undefined, trial: number, { problem, error: endError }: Ended = {}): TrialResult {
  const { domain, task, clock, phrases } = st;
  const lines = transcript ?? [];
  const said = (l: TranscriptLine): TrajectoryEvent => (l.role === "user" ? { type: "user", text: l.text } : { type: "agent", text: l.text, latencyMs: 0 });
  let events: TrajectoryEvent[];
  if (lines.length && lines.every((l) => l.time !== undefined)) {
    // Stable: a line and a call at the same millisecond keep the line first.
    events = [...lines.map((l) => ({ at: l.time!, event: said(l) })), ...st.calls].sort((a, b) => a.at - b.at).map((x) => x.event);
  } else {
    const first = lines.findIndex((l) => l.role === "agent");
    const at = first < 0 ? lines.length : first;
    events = [...lines.slice(0, at).map(said), ...st.calls.map((c) => c.event), ...lines.slice(at).map(said)];
  }
  const agentMessages = lines.filter((l) => l.role === "agent").map((l) => l.text);
  const error =
    problem ??
    endError ??
    (transcript === undefined && task.expect.reply_includes.length
      ? "the conversation ended without a transcript, so what the agent said can't be graded: send one to POST /sessions/<id>/end, or have the platform send its end-of-call report"
      : undefined);
  const graded = gradeEpisode({ domain, task, world: st.world, runner: st.session.runner, events, agentMessages, ...(phrases ? { phrases } : {}), ...(error ? { error } : {}) });
  return {
    taskId: task.id,
    trial,
    ...(clock ? { clock } : {}),
    ...graded,
    ...(problem ? { passed: false, skipped: true as const } : {}),
    events,
    changes: worldChanges(domain, st.initial, st.world),
    endReason: error ? "error" : "user_stop",
    turns: agentMessages.length,
    durationMs: Date.now() - st.started,
    usage: { agent: {}, user: {}, costUsd: 0 },
    ...(error ? { error } : {}),
  };
}
