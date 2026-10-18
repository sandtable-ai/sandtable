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
