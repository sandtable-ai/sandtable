import { chmodSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeWritable(dir: string): void {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) makeWritable(path.join(dir, entry.name));
  }
}

/**
 * Removes a run's temp folder, whatever its tests left in it. It warns rather than throws: vitest fails the run
 * when a teardown throws, and leftovers aren't a reason to fail a run whose tests passed.
 */
export function removeTempFolder(dir: string): void {
  try {
    // A CLI started by a test that timed out may still be writing here. Once the folder has another name, what
    // it writes next fails, so the removal doesn't race it.
    const removing = `${dir}.removing`;
    renameSync(dir, removing);
    const remove = () => rmSync(removing, { recursive: true, force: true, maxRetries: 3 });
    try {
      remove();
    } catch {
      // A test that timed out may not have undone its chmod, and a read-only folder can't be emptied.
      makeWritable(removing);
      remove();
    }
  } catch (err) {
    console.warn(`could not remove the test run's temp folder ${dir}: ${(err as Error).message}`);
  }
}

/**
 * vitest's globalSetup. Every temp folder of a run goes in one folder, which this removes when the run ends, pass or
 * fail, so a test can mkdtemp under tmpdir() with no cleanup of its own. os.tmpdir() reads these variables at each call,
 * and vitest builds a worker's environment after this runs, so workers and the processes they start inherit them.
 * A run that's killed leaves this one folder.
 */
export default function setup(): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), "sandtable-tests-"));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
  return () => removeTempFolder(dir);
}
