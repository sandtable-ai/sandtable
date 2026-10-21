import type { SuiteResult } from "./suite.ts";

/** Parse the JSON text of `file`, or say that the file is not valid JSON. */
export function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Parse a results.json written by `run`, or say what the file is not. */
export function parseResults(text: string, file: string): SuiteResult {
  const r = parseJson(text, file) as Partial<SuiteResult & { rows: unknown }> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.tasks) || typeof r.passHat !== "object" || typeof r.domain !== "string") {
    // A leaderboard's own file is the one people pass most often by mistake.
    const leaderboard = r && typeof r === "object" && Array.isArray(r.rows) ? "; it is a leaderboard's leaderboard.json: each model's results.json is in its folder next to it" : "";
    throw new Error(`${file} is not a results.json written by \`sandtable run\`${leaderboard}`);
  }
  return r as SuiteResult;
}
