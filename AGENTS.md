# sandtable

sandtable rehearses AI agents on simulated copies of a customer's world. A simulated caller talks to the agent, the agent's tool calls hit stateful mocks of the customer's systems, and every trial is graded deterministically (end state, policy invariants, tool log) into pass^k. One repo ships the `sandtable-ai` CLI and library (npm), a Python launcher (`python/`, PyPI) and a Claude Code plugin (`plugin/`), all on one version.

<!-- Maintainers: keep this file under ~150 lines. Add a rule when an agent makes the same mistake twice; move anything long to CONTRIBUTING.md or docs/ and link it. test/agents-md.test.ts checks the commands and paths below. -->

## Commands

Development needs Node ≥ 22.18, which runs `src/*.ts` directly: no build step. The published CLI is compiled to `dist/` and must run on Node 20.

```bash
npm ci
npm test                                  # vitest, offline, a few seconds
npx vitest run test/grading.test.ts       # one file; add -t "<test name>" for one test
npm run typecheck
npm run sandtable -- <command> --help     # the CLI from source, same as node src/cli.ts
node src/cli.ts validate examples/freight --strict
node src/cli.ts lint examples/clinic
node src/cli.ts run examples/freight --agent scripted:careful --user scripted --fail-under 100 --no-html
```

Before you push, run what CI runs, and fix every failure. Never assume a failure was already on main.

```bash
npm run check   # typecheck, tests, build, package contents, version and changelog checks, then `npm run smoke`:
                # lint both examples and run their careful scripted agents offline at --fail-under 100
```

Also run these when you touch the area: `claude plugin validate . --strict` (`plugin/`, `.claude-plugin/`), `cd docs && npx mint broken-links` (`docs/`), `uv build python --out-dir python/dist` (`python/`).

Ask before running anything that calls a model, because it needs keys and costs money. That covers `run` or `leaderboard` with a `claude`, `openai:` or `bedrock:` agent, `demo --live`, `init --sop` and `init --transcripts`. The default simulated user is Claude, so an offline run always passes `--user scripted`. Runs write to `.sandtable/runs/` (gitignored) unless you pass `-o`.

## Workflow

1. Every change starts from a GitHub issue. One issue, one branch, one PR. Anything else you find becomes a new issue, not part of this PR.
2. Branch from up-to-date main as `<type>/<issue>-<slug>`, e.g. `feat/22-clinic-example`.
3. Never commit or push to `main`, never force-push a branch someone else uses, and never create tags or publish. Releases are a maintainer's job.
4. Open the PR with `gh pr create`. Its body starts with `Closes #<issue>`, then says what changed for users and how you verified it (commands; for a live model run, the model, k and cost).
5. You are done when CI is green on the PR, not when you push. Fix what fails and push again to the same branch.
6. PRs are squash-merged. Don't merge unless the maintainer asks.

## Commits and PR titles

- Use a Conventional Commit title: `type(scope): summary`. The squash merge turns the PR title into the commit on main.
  - Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`, `chore`.
  - Scopes: `cli`, `spec`, `world`, `adapters`, `run`, `grading`, `report`, `init`, `plugin`, `examples`, `docs`, `release`.
- Write the summary in lowercase, with no final period, as the outcome for users, e.g. `fix(run): agent session ids are unique per run`.
- A breaking change adds `!` (`feat(spec)!: ...`) and a **Breaking:** changelog entry.
- No AI attribution anywhere: no `Co-Authored-By` trailer naming an agent, no "Generated with" line, in commits, PR bodies, issues or code comments.
- Write for a reader who has not seen your session. Say what the code does now, not how you got there.

## Changelog: required in every PR that users can notice

- Any PR that changes `src/`, `examples/`, `plugin/`, `.claude-plugin/`, `docs/`, `python/src/` or `README.md` adds an entry under `## [Unreleased]` in `CHANGELOG.md`, in the same PR. The `pr / changelog` check fails otherwise.
- If no user can notice the change (a refactor, tests only, CI, a typo), skip the entry and label the PR instead: `gh pr edit <n> --add-label no-changelog`.
- File each entry under `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed` or `### Security`. Create the heading if it is missing, in that order.
- Each entry names the area in backticks or bold, then says in one or two sentences what users can do now or what changed for them, ending with the issue link:
  `` - `examples/clinic`: a fictional clinic front desk with 25 tasks and 12 invariants, runnable offline with `--agent scripted:clinic-careful` ([#22](https://github.com/sandtable-ai/sandtable/issues/22)). ``
- Mark a break **Breaking:** and say what to change (a renamed flag, spec key or export). Before 1.0, breaks ship in a minor release.
- Never edit a released `## [x.y.z]` section, never add a version heading or date (`npm version` does that), and never paste commit lists or PR titles.
- If `CHANGELOG.md` conflicts after main moves, rebase, keep every entry, and keep yours under `[Unreleased]`.

## Rules

- Grading stays deterministic. Pass and fail come only from the end state, invariants, required and forbidden tools, and `never_disclose`. Never put a model call in `src/grade/` or `lint`. LLM-judged checks, when they land, will be a separate soft score.
- No network in tests. For SDK-based adapters, use the fake client in `test/adapters.test.ts`. For HTTP adapters, stub `fetch` as in `test/openai-compat.test.ts`. A test that needs an API key is a bug.
- Use fictional data only. Examples, docs, tests, fixtures and changelog entries use invented companies, people, IDs and procedures, never a real company, customer or anything from a customer's documents.
- Maintainers' clones run a pre-commit hook that scans for private names. Never bypass it with `--no-verify`. If it blocks, replace the name with a fictional one.
- Never commit secrets. Keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, AWS profiles), never from a file in the repo.
- Keep the spec small. Prefer a new, clearly named invariant kind over a general expression language.
- These are contracts users build on, so a change to one is a changelog entry, and removing or renaming in one is **Breaking**:
  - the exports of `src/index.ts`
  - the spec (`src/spec/schema.ts`)
  - CLI flags
  - `results.json`
  - the HTTP step protocol
- Never edit by hand:
  - `dist/`
  - `.sandtable/`
  - the version fields in `python/` or `plugin/.claude-plugin/plugin.json` (`npm version` syncs them)
- Ask before adding a runtime dependency, or before changing `.github/workflows/release.yml` or workflow permissions.
- There is no formatter: match the style of the file you are editing.

## Keep docs, plugin and README in sync with the code

Update these in the same PR as the code change:

| When you change | Also update |
|---|---|
| a command or flag (`src/cli.ts`) | `docs/reference/cli.mdx`, every skill in `plugin/skills/` that uses it, README examples |
| the domain spec (`src/spec/schema.ts`) | `docs/reference/spec.mdx`, `plugin/skills/drafting-a-domain/references/spec-cheatsheet.md`, affected `examples/` |
| `results.json` | `docs/reference/results-schema.mdx`, `plugin/skills/running-and-reading-results/references/results-json.md` |
| the HTTP step protocol (`src/sim/http.ts`) | `docs/reference/http-protocol.mdx` |
| the set of skills | `test/plugin.test.ts` (its skill list), the README skill table, `docs/guides/claude-code-plugin.mdx` |

`test/plugin.test.ts` fails when a skill uses a command or flag that `--help` doesn't list, or a YAML snippet that the schema rejects. Take flags from `npm run sandtable -- <command> --help`, never from memory.

## Releasing (maintainers only)

1. `git switch -c release/vX.Y.Z origin/main`
2. `npm version <patch|minor|prerelease --preid alpha> --no-git-tag-version`. This:
   - refuses if `[Unreleased]` is empty
   - moves `[Unreleased]` into `## [X.Y.Z] - <date>`
   - syncs `python/` and `plugin/`
3. Open the new section with a one-sentence summary, and check every **Breaking:** entry.
4. Commit `chore(release): vX.Y.Z`, open a PR, wait for CI, then squash-merge.
5. On the merged main, run `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
6. The `release` workflow then:
   - checks everything, and refuses a tag that has no matching CHANGELOG section
   - stages npm (pre-releases under `next`)
   - publishes to PyPI
   - creates the GitHub release from that section
7. Approve the staged npm release on npmjs.com, or with `npm stage approve <id>`.

## Map

- `src/cli.ts`: the commander CLI.
- `src/index.ts`: the public library API.
- `src/spec/`: the zod schema of a domain, and a YAML loader with cross-reference checks.
- `src/world/`: the in-memory world store, where-clause matching and tool execution.
- `src/sim/`: agent and simulated-user adapters:
  - Claude, on Anthropic or Bedrock
  - Bedrock Converse
  - OpenAI-compatible
  - HTTP
  - scripted
  - noop
  - prompts
- `src/run/`: the episode, suite and leaderboard runners, the tool runner, and token usage and cost.
- `src/grade/`: invariants, end-state expectations, pass^k and `lint`.
- `src/report/`: the terminal summary and the self-contained HTML report.
- `src/init/`: drafts domains from an OpenAPI spec, an SOP or transcripts (PII is scrubbed locally), then merges and renders them.
- `src/demo/`: rule-based agents for the bundled examples.
- Outside `src/`:
  - `examples/freight` and `examples/clinic` are bundled domains, shipped in the npm package.
  - `examples/frameworks/` holds worked examples for agent frameworks. Each has its own dependencies and offline check (`npm run check` in its folder, the `frameworks` CI job); none is in the npm package.
  - `plugin/` and `.claude-plugin/` hold the Claude Code plugin, which is not in the npm package.
  - `python/` holds the PyPI launcher.
  - `docs/` is the Mintlify site; its rules are in `CONTRIBUTING.md`.
  - `scripts/` holds the version sync, the changelog script and Bedrock prices.
