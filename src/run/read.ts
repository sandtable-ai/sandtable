import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SuiteResult } from "./suite.ts";

/** How to name a path the user gave on the command line when it can't be read. */
export interface UserPath {
  /** Where the path came from: an option such as `--prices`, or the command whose argument it is. */
  from: string;
  /** What the path should name, said when nothing is there. Default: "file". */
  what?: string;
  /** What to pass instead, added in parentheses when nothing is there. */
  hint?: string;
  /** The file a directory given instead usually holds, such as results.json: suggested when it does. */
  inDir?: string;
}

/**
 * Node's error for a path the user gave, as a sentence naming where the path came from instead of
 * `ENOENT: no such file or directory, open '…'`. Any other error is returned as it is.
 */
export async function userPathError(err: unknown, file: string, how: UserPath): Promise<unknown> {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new Error(`${how.from}: no ${how.what ?? "file"} at ${file}${how.hint ? ` (${how.hint})` : ""}`);
  if (code === "EISDIR") {
    const inside = how.inDir ? path.join(file, how.inDir) : undefined;
    const found = inside !== undefined && (await stat(inside).catch(() => undefined))?.isFile();
    return new Error(`${how.from}: ${file} is a directory, not a file${found ? `: did you mean ${inside}?` : ""}`);
  }
  if (code === "EACCES" || code === "EPERM") return new Error(`${how.from}: ${file} can't be read (permission denied)`);
  return err;
}

/** Read a file the user named on the command line; a path that can't be read throws a userPathError. */
export async function readUserFile(file: string, how: UserPath): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (err) {
    throw await userPathError(err, file, how);
  }
}

/** readUserFile as UTF-8 text. */
export async function readUserText(file: string, how: UserPath): Promise<string> {
  return (await readUserFile(file, how)).toString("utf8");
}

const RESULTS_HINT = "pass the results.json a run wrote: `sandtable run` writes to .sandtable/runs/ unless -o says otherwise";

/** Read and parse a results.json the user named, as `from` (a command or an option such as `--baseline`). */
export async function readResults(file: string, from: string): Promise<SuiteResult> {
  return parseResults(await readUserText(file, { from, hint: RESULTS_HINT, inDir: "results.json" }), file);
}

/** Parse the JSON text of `file`, or say that the file is not valid JSON. */
export function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The results.json format version this sandtable writes, and the newest it reads. It moves only when a field is
 * removed or changes meaning, never for an added one, and a reader reads every version up to its own.
 */
export const RESULTS_VERSION = 1;

/** Parse a results.json written by `run`, or say what the file is not. */
export function parseResults(text: string, file: string): SuiteResult {
  const r = parseJson(text, file) as Partial<Omit<SuiteResult, "version"> & { version: unknown; rows: unknown }> | null;
  // Every results.json sandtable wrote has a version; one made by hand without it is read as version 1, as before.
  const version = r && typeof r === "object" ? r.version : undefined;
  if (typeof version === "number" && Number.isInteger(version) && version > RESULTS_VERSION) {
    throw new Error(`${file} is results.json format version ${version}, from a newer sandtable; this one reads format version ${RESULTS_VERSION}. Run the command with a newer sandtable-ai, such as \`npx sandtable-ai@latest\`.`);
  }
  if (!r || typeof r !== "object" || !Array.isArray(r.tasks) || typeof r.passHat !== "object" || typeof r.domain !== "string" || !(version === undefined || (Number.isInteger(version) && (version as number) >= 1))) {
    // A leaderboard's own file is the one people pass most often by mistake.
    const leaderboard = r && typeof r === "object" && Array.isArray(r.rows) ? "; it is a leaderboard's leaderboard.json: each model's results.json is in its folder next to it" : "";
    throw new Error(`${file} is not a results.json written by \`sandtable run\`${leaderboard}`);
  }
  return r as SuiteResult;
}
