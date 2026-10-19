// Keep the Python launcher's and the Claude Code plugin's versions in sync with package.json,
// so the plugin's skills update when the CLI they document is released.
// npm semver -> PEP 440: 0.1.0-alpha.0 -> 0.1.0a0, -beta.N -> bN, -rc.N -> rcN.
// Usage: node scripts/sync-version.mjs [--check]
//
// Both modes read the values back: a field whose pattern no longer matches is an error, never "in sync",
// and the sync writes no file unless every field can be set.
import { readFileSync, writeFileSync } from "node:fs";

const check = process.argv.includes("--check");
const npm = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const pep440 = npm.replace(/-alpha\.(\d+)$/, "a$1").replace(/-beta\.(\d+)$/, "b$1").replace(/-rc\.(\d+)$/, "rc$1");
if (/-/.test(pep440)) fail(`cannot map ${npm} to PEP 440`);

/** A line-anchored `name = "value"` assignment, as in pyproject.toml and __init__.py. */
const assignment = (name, want) => ({
  name,
  want,
  read: (s) => new RegExp(`^${name} = "([^"]*)"$`, "m").exec(s)?.[1],
  write: (s) => s.replace(new RegExp(`^${name} = "[^"]*"$`, "m"), `${name} = "${want}"`),
});

/** The top-level "version" of a JSON file, rewritten in place so the rest of the formatting is kept. */
const jsonVersion = (want) => ({
  name: '"version"',
  want,
  read: (s) => {
    const v = JSON.parse(s).version;
    return typeof v === "string" ? v : undefined;
  },
  write: (s) => s.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${want}"`),
});

const files = {
  "python/pyproject.toml": [assignment("version", pep440)],
  "python/src/sandtable_ai/__init__.py": [assignment("__version__", pep440), assignment("NPM_VERSION", npm)],
  "plugin/.claude-plugin/plugin.json": [jsonVersion(npm)],
};

const problems = [];
const updates = [];
for (const [rel, fields] of Object.entries(files)) {
  const url = new URL(`../${rel}`, import.meta.url);
  const before = readFileSync(url, "utf8");
  let text = before;
  for (const field of fields) {
    const found = field.read(text);
    if (found === undefined) {
      problems.push(`${rel}: no ${field.name} found to sync`);
      continue;
    }
    if (found === field.want) continue;
    if (check) {
      problems.push(`${rel}: ${field.name} is ${found}, expected ${field.want}`);
      continue;
    }
    text = field.write(text);
    if (field.read(text) !== field.want) problems.push(`${rel}: could not set ${field.name} to ${field.want}`);
  }
  if (text !== before) updates.push([url, text]);
}

if (problems.length) {
  fail(
    `python/ or plugin/ is not in sync with package.json ${npm}:\n  - ${problems.join("\n  - ")}` +
      (check ? "\nRun node scripts/sync-version.mjs, or fix the pattern if a field moved." : ""),
  );
}
for (const [url, text] of updates) writeFileSync(url, text);
console.log(`npm ${npm} <-> PyPI ${pep440}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
