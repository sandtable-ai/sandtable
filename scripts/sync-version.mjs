// Keep the Python launcher's and the Claude Code plugin's versions in sync with package.json,
// so the plugin's skills update when the CLI they document is released. The marketplace installs the
// plugin from the release tag (`ref`), so its skills always describe the CLI that `npx sandtable-ai` runs:
// a stable version moves the tag; a pre-release, published under npm's `next`, leaves it on the last
// stable release, which npm's `latest` still serves.
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

/** The release tag the marketplace installs the plugin from: v<version> for a stable version. */
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const pluginRef = (version) => ({
  name: '"ref" of the sandtable plugin\'s source',
  want: /-/.test(version) ? undefined : `v${version}`,
  read: (s) => {
    const ref = JSON.parse(s).plugins?.find((p) => p.name === "sandtable")?.source?.ref;
    return typeof ref === "string" ? ref : undefined;
  },
  // A pre-release keeps the last stable tag: any stable tag is in sync, and nothing is written.
  accepts: (found, want) => (want === undefined ? STABLE_TAG.test(found) : found === want),
  write: (s, want) => s.replace(/("ref"\s*:\s*)"[^"]*"/, `$1"${want}"`),
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
  ".claude-plugin/marketplace.json": [pluginRef(npm)],
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
    if (field.accepts ? field.accepts(found, field.want) : found === field.want) continue;
    const expected = field.want ?? "a stable release tag such as v1.2.3";
    if (check || field.want === undefined) {
      problems.push(`${rel}: ${field.name} is ${found}, expected ${expected}`);
      continue;
    }
    text = field.write(text, field.want);
    if (field.read(text) !== field.want) problems.push(`${rel}: could not set ${field.name} to ${field.want}`);
  }
  if (text !== before) updates.push([url, text]);
}

if (problems.length) {
  fail(
    `python/, plugin/ or .claude-plugin/ is not in sync with package.json ${npm}:\n  - ${problems.join("\n  - ")}` +
      (check ? "\nRun node scripts/sync-version.mjs, or fix the pattern if a field moved." : ""),
  );
}
for (const [url, text] of updates) writeFileSync(url, text);
console.log(`npm ${npm} <-> PyPI ${pep440}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
