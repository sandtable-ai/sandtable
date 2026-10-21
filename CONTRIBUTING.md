# Contributing

Thanks for helping. Issues, example domains and adapters are all welcome.

## How contributions work

- **Anyone** can open an issue (a bug, a feature or a new example domain, through the issue forms), start a [Discussion](https://github.com/sandtable-ai/sandtable/discussions), or send a pull request from a fork. For anything bigger than a small fix, open or comment on an issue first, so we agree on the approach before you write code.
- **Maintainers** triage issues, review pull requests, merge them and cut releases. Each pull request automatically requests a review from the maintainers team (see [`.github/CODEOWNERS`](.github/CODEOWNERS)).
- **A pull request is merged** by a maintainer, squashed, once CI is green and every review conversation is resolved. CI covers the tests on Node 20, 22 and 24, the Python launcher, and the title and changelog checks. On a first-time contributor's pull request, CI starts once a maintainer approves the run.
- **Releases** are tagged by maintainers only (see [Releasing](#releasing)), and `v*` tags are protected.
- **Security problems** go in a private report, never a public issue: see [SECURITY.md](SECURITY.md).
- Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

```bash
npm install
npm test            # vitest, no network
npm run typecheck
npm run demo        # offline demo from the TypeScript sources
```

Development needs Node ≥ 22.18, which runs `src/*.ts` directly (type stripping), so there is no build step. The published CLI is compiled to `dist/` and runs on Node ≥ 20.

## Ground rules

- **Grading stays deterministic.** Hard pass/fail comes from state, invariants and the tool log. LLM-judged checks, when they land, will be a separate judged score.
- **No network in tests.** Use the fake client pattern in `test/adapters.test.ts` for SDK-based model adapters, or a stubbed `fetch` as in `test/openai-compat.test.ts` for HTTP ones.
- **Example domains are fictional.** No real company names, customer data or proprietary procedures.
- Keep the spec small. Prefer a new invariant kind with a clear name over a general expression language.

## Adding an example domain

1. Create `examples/<name>/sandtable.yaml`, `policy.md` and `tasks.yaml`.
2. Include tasks that should end with a write and tasks that must end without one. A suite of only refusal tasks lets a do-nothing agent score well.
3. Add a `user.script` to each task so the domain runs offline with `--user scripted`.
4. `npm run sandtable -- validate examples/<name>` and `npm run sandtable -- lint examples/<name>`.
5. Optional: rule-based careful and naive agents in `src/demo/` (see `clinic-agents.ts`), so CI can run the domain offline with `--fail-under 100`.

## Changing the CLI or the spec

The Claude Code plugin in `plugin/` teaches coding agents exact commands and YAML. When you change a command, a flag or the spec, update its skills and the docs pages too. `test/plugin.test.ts` checks every `npx sandtable-ai` command and flag in them against `--help`, and every YAML snippet against the schema. If you have Claude Code, also run `claude plugin validate . --strict`.

## Docs

The docs site is built with [Mintlify](https://mintlify.com) from `docs/`: `docs/docs.json` holds the navigation, and each page is an `.mdx` file with `title` and `description` frontmatter. The [domain spec](docs/reference/spec.mdx) and the [CLI reference](docs/reference/cli.mdx) must match the code, so update them in the same change as the code.

```bash
cd docs
npx mint dev            # preview at http://localhost:3000
npx mint broken-links   # check internal links
```

Keep examples fictional, and check every flag against `npm run sandtable -- <command> --help`.

## Pull requests and the changelog

Every change starts from an issue and lands through a pull request with a Conventional Commit title (`fix(run): ...`), squash-merged once CI is green. Before you push, `npm run check` runs what CI runs.

If users can notice your change, add one entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) in the same pull request: what they can do now or what changed for them, with the issue link. The `pr / changelog` check asks for it when you touch `src/`, `examples/`, `plugin/`, `docs/`, `python/src/` or the README. Changes nobody can notice (refactors, tests, CI) carry the `no-changelog` label instead. The full brief, written for people and coding agents alike, is in [AGENTS.md](AGENTS.md).

## Releasing

Releases go through a release pull request and then a tag on main: see [AGENTS.md](AGENTS.md#releasing-maintainers-only). Both registries use Trusted Publishing, and the npm release goes live only after a maintainer approves it on npmjs.com.
