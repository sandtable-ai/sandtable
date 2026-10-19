// Keep CHANGELOG.md in Keep a Changelog 2.0.0 form, and do its mechanical steps.
//
//   node scripts/changelog.mjs check                    format is valid (CI)
//   node scripts/changelog.mjs check --release          ...and [Unreleased] has entries (npm preversion)
//   node scripts/changelog.mjs check --base <file>      ...and no released section changed (PR check)
//   node scripts/changelog.mjs release [version]        move [Unreleased] into [version] - today (npm version)
//   node scripts/changelog.mjs notes <version>          print that version's section (release notes)
//
// People and coding agents write the entries; this script never invents one.
import { readFileSync, writeFileSync } from "node:fs";

const REPO = "https://github.com/sandtable-ai/sandtable";
const TYPES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
const VERSION = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\] - (\d{4}-\d{2}-\d{2})( \[YANKED\])?$/;
const file = new URL("../CHANGELOG.md", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Split the file into preamble, [Unreleased] body, released sections and the link block. */
function parse(text) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const linkStart = lines.findIndex((l, i) => /^\[[^\]]+\]: /.test(l) && lines.slice(i).every((m) => m === "" || /^\[[^\]]+\]: /.test(m)));
  const body = linkStart === -1 ? lines : lines.slice(0, linkStart);
  const links = linkStart === -1 ? [] : lines.slice(linkStart).filter(Boolean);
  const heads = body.flatMap((l, i) => (l.startsWith("## ") ? [i] : []));
  const sections = heads.map((start, n) => ({ heading: body[start], lines: body.slice(start + 1, heads[n + 1] ?? body.length) }));
  return { preamble: body.slice(0, heads[0] ?? body.length), sections, links };
}

const trim = (lines) => lines.join("\n").replace(/^\n+|\n+$/g, "");

function problems(text) {
  const { preamble, sections } = parse(text);
  const out = [];
  if (preamble[0] !== "# Changelog") out.push('the first line must be "# Changelog"');
  if (sections[0]?.heading !== "## [Unreleased]") out.push('the first section must be "## [Unreleased]"');
  sections.slice(1).forEach(({ heading }) => {
    if (!VERSION.test(heading)) out.push(`"${heading}": use "## [x.y.z] - YYYY-MM-DD"`);
  });
  for (const { heading, lines } of sections) {
    for (const l of lines) {
      if (l.startsWith("### ") && !TYPES.includes(l.slice(4))) out.push(`${heading}: "${l}" is not one of ${TYPES.join(", ")}`);
      if (/^#{1,2} /.test(l)) out.push(`${heading}: unexpected heading "${l}"`);
    }
  }
  return out;
}

function fail(message) {
  console.error(`CHANGELOG.md: ${message}`);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const text = readFileSync(file, "utf8");

if (command === "check") {
  const found = problems(text);
  const { sections } = parse(text);
  if (args.includes("--release") && !trim(sections[0]?.lines ?? [])) found.push("[Unreleased] is empty: nothing to release");
  const base = args[args.indexOf("--base") + 1];
  if (args.includes("--base") && base) {
    // Released sections are history: the PR's released sections must end with the base's, unchanged.
    const released = (t) => parse(t).sections.slice(1).map((s) => `${s.heading}\n${trim(s.lines)}`);
    const before = released(readFileSync(base, "utf8"));
    const after = released(text);
    const tail = after.slice(after.length - before.length);
    if (before.length > after.length || tail.some((s, i) => s !== before[i])) {
      found.push("a released section changed. New entries go under ## [Unreleased]; to correct history on purpose, a maintainer adds the changelog-history label");
    }
  }
  if (found.length) fail(`\n  - ${found.join("\n  - ")}`);
  console.log("CHANGELOG.md ok");
} else if (command === "release") {
  const version = args[0] ?? pkg.version;
  const { preamble, sections, links } = parse(text);
  const found = problems(text);
  if (found.length) fail(`\n  - ${found.join("\n  - ")}`);
  if (sections.some((s) => s.heading.startsWith(`## [${version}]`))) fail(`[${version}] already exists`);
  const unreleased = trim(sections[0].lines);
  if (!unreleased) fail("[Unreleased] is empty: nothing to release");
  const previous = sections[1] && VERSION.exec(sections[1].heading)[1];
  const date = new Date().toISOString().slice(0, 10);
  const linkFor = (v) => links.find((l) => l.toLowerCase().startsWith(`[${v.toLowerCase()}]: `));
  const otherLinks = links.filter((l) => l !== linkFor("unreleased"));
  const out = [
    ...preamble,
    "## [Unreleased]",
    "",
    `## [${version}] - ${date}`,
    "",
    unreleased,
    "",
    ...sections.slice(1).flatMap((s) => [s.heading, ...s.lines]),
  ];
  const newLinks = [
    `[Unreleased]: ${REPO}/compare/v${version}...HEAD`,
    previous ? `[${version}]: ${REPO}/compare/v${previous}...v${version}` : `[${version}]: ${REPO}/releases/tag/v${version}`,
    ...otherLinks,
  ];
  writeFileSync(file, `${trim(out)}\n\n${newLinks.join("\n")}\n`);
  console.log(`CHANGELOG.md: [Unreleased] -> [${version}] - ${date}`);
} else if (command === "notes") {
  const version = (args[0] ?? pkg.version).replace(/^v/, "");
  const { sections, links } = parse(text);
  const section = sections.find((s) => VERSION.exec(s.heading)?.[1] === version);
  if (!section) fail(`no "## [${version}] - YYYY-MM-DD" section: run npm version, or add one, before tagging`);
  const notes = trim(section.lines);
  if (!notes) fail(`[${version}] has no entries`);
  // Carry over the reference-style link definitions the section uses, so its links still resolve.
  const used = links.filter((l) => notes.includes(l.slice(0, l.indexOf("]: ") + 1)));
  process.stdout.write(`${notes}\n${used.length ? `\n${used.join("\n")}\n` : ""}`);
} else {
  fail("usage: changelog.mjs check [--release] [--base <file>] | release [version] | notes <version>");
}
