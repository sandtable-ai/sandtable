/** Binomial coefficient C(n, k). */
export function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i;
  return r;
}

/**
 * pass^k as defined by tau-bench: the probability that ALL of k independent trials
 * of a task succeed, estimated without bias from n >= k trials with c successes
 * as C(c, k) / C(n, k), then averaged over tasks.
 *
 * pass^1 is the plain success rate. pass^k drops fast for an agent that is right
 * "most of the time", which is the failure mode customers actually experience.
 */
export function passHatK(trials: readonly (readonly boolean[])[], k: number): number {
  const eligible = trials.filter((t) => t.length >= k);
  if (eligible.length === 0) return Number.NaN;
  const total = eligible.reduce((sum, t) => {
    const c = t.filter(Boolean).length;
    return sum + binom(c, k) / binom(t.length, k);
  }, 0);
  return total / eligible.length;
}

/**
 * pass@k: the probability that AT LEAST ONE of k independent trials of a task succeeds, estimated
 * without bias as 1 - C(n - c, k) / C(n, k), then averaged over tasks with n >= k trials.
 *
 * Next to pass^k it separates the two ways a task falls short: pass@k high and pass^k low means the
 * agent can do the task but not every time (flaky); both low means it can't do it at all.
 */
export function passAtK(trials: readonly (readonly boolean[])[], k: number): number {
  const eligible = trials.filter((t) => t.length >= k);
  if (eligible.length === 0) return Number.NaN;
  const total = eligible.reduce((sum, t) => {
    const c = t.filter(Boolean).length;
    return sum + 1 - binom(t.length - c, k) / binom(t.length, k);
  }, 0);
  return total / eligible.length;
}

/**
 * The 95% Wilson score interval for a pass rate of `passes` out of `trials`, or undefined with no
 * trials. Unlike passes / trials ± a normal margin, it stays inside [0, 1] and is honest at small n:
 * 4 passes out of 4 trials gives 51%–100%, not 100%.
 */
export function wilsonInterval(passes: number, trials: number, z = 1.96): { low: number; high: number } | undefined {
  if (trials <= 0) return undefined;
  const p = passes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}
