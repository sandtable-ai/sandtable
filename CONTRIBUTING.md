# Contributing

Thanks for helping. Issues, example domains and adapters are all welcome.

## Setup

```bash
npm install
npm test            # vitest, no network
npm run typecheck
npm run demo        # offline demo from the TypeScript sources
```

Development needs Node ≥ 22.18, which runs `src/*.ts` directly (type stripping), so there is no build step. The published CLI is compiled to `dist/` and runs on Node ≥ 20.

## Ground rules

- **Grading stays deterministic.** Hard pass/fail comes from state, invariants and the tool log. LLM-judged checks, when they land, will be a separate soft score.
- **No network in tests.** Use the fake client pattern in `test/adapters.test.ts` for SDK-based model adapters, or a stubbed `fetch` as in `test/openai-compat.test.ts` for HTTP ones.
- **Example domains are fictional.** No real company names, customer data or proprietary procedures.
- Keep the spec small. Prefer a new invariant kind with a clear name over a general expression language.

## Adding an example domain

1. Create `examples/<name>/sandtable.yaml`, `policy.md` and `tasks.yaml`.
2. Include tasks that should end with a write and tasks that must end without one. A suite of only refusal tasks lets a do-nothing agent score well.
3. Add a `user.script` to each task so the domain runs offline with `--user scripted`.
4. `npm run sandtable -- validate examples/<name>`.

## Changing the CLI or the spec

The Claude Code plugin in `plugin/` teaches coding agents exact commands and YAML. When you change a command, a flag or the spec, update its skills too. `test/plugin.test.ts` checks every `npx sandtable-ai` command and flag in them against `--help`, and every YAML snippet against the schema. If you have Claude Code, also run `claude plugin validate . --strict`.

## Releasing

1. `npm version <patch|minor|prerelease --preid alpha>`. The `version` script syncs the Python launcher's and the plugin's versions.
2. `git push --follow-tags`. The `release` workflow then:
   - checks everything
   - stages `sandtable-ai` on npm (pre-releases under the `next` tag)
   - publishes it to PyPI
   Both go through Trusted Publishing.
   - creates the GitHub release.
3. Approve the staged npm release on npmjs.com (or with `npm stage approve <id>`). It goes live after that 2FA-protected click.
