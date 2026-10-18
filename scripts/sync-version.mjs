// Keep the Python launcher's and the Claude Code plugin's versions in sync with package.json,
// so the plugin's skills update when the CLI they document is released.
// npm semver -> PEP 440: 0.1.0-alpha.0 -> 0.1.0a0, -beta.N -> bN, -rc.N -> rcN.
// Usage: node scripts/sync-version.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";

const npm = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const pep440 = npm.replace(/-alpha\.(\d+)$/, "a$1").replace(/-beta\.(\d+)$/, "b$1").replace(/-rc\.(\d+)$/, "rc$1");
if (/-/.test(pep440)) throw new Error(`cannot map ${npm} to PEP 440`);

const files = {
  "../python/pyproject.toml": (s) => s.replace(/^version = ".*"$/m, `version = "${pep440}"`),
  "../python/src/sandtable_ai/__init__.py": (s) =>
    s.replace(/^__version__ = ".*"$/m, `__version__ = "${pep440}"`).replace(/^NPM_VERSION = ".*"$/m, `NPM_VERSION = "${npm}"`),
  "../plugin/.claude-plugin/plugin.json": (s) => s.replace(/^  "version": ".*",$/m, `  "version": "${npm}",`),
};
let stale = false;
for (const [rel, update] of Object.entries(files)) {
  const url = new URL(rel, import.meta.url);
  const before = readFileSync(url, "utf8");
  const after = update(before);
  if (before !== after) {
    stale = true;
    if (!process.argv.includes("--check")) writeFileSync(url, after);
  }
}
if (process.argv.includes("--check") && stale) {
  console.error(`python/ or plugin/ is not in sync with package.json ${npm}: run node scripts/sync-version.mjs`);
  process.exit(1);
}
console.log(`npm ${npm} <-> PyPI ${pep440}`);
