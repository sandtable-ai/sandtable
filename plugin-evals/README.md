# Plugin evals

An eval suite for the Claude Code plugin in `../plugin`, run with [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals). Each case gives Claude Code, with the plugin loaded, a job an engineer would ask for, in a workspace with planted traps, and grades what it does. It measures a skill change before and after, as the skill issues ask (#295, #296, #298, #299, #300, #301).

Every run is a real Claude Code session on your account, and `llm` graders call a judge model, so running the suite costs money. CI doesn't run it: `test/plugin-evals.test.ts` only checks, offline, that the fixtures still match the code.

## Cases

Every company, person, order and chat here is invented.

| Case | Tags | The trap | Graded on |
|---|---|---|---|
| `draft-from-sources` | `skill-295` `skill-296` `skill-301` | Draft a domain from an OpenAPI spec, an SOP and four chats, on Bedrock | Runs the free `init --openapi`; runs no `init --sop` or `--transcripts` without a go-ahead; says the calls (five), model, provider and cost, and asks; never reads sandtable's code, in npx's cache or the project's `node_modules/sandtable-ai`; no `npx -p sandtable-ai … sandtable-ai` |
| `draft-preauthorized` | `skill-296` | The same drafting job, with model steps authorized up front and the Bedrock client installed | States the calls, model and a dollar cost before the first `init --sop`/`--transcripts` (an assistant message naming the calls and a dollar amount must come first in the trace), then goes on; never reads sandtable's code, no broken `-p` form |
| `review-drafted-domain` | `skill-298` | A drafted domain with four planted problems and one clean task | Flags the task that contradicts its chat, the seed order that doesn't hold the item, the caller missing the packaging fact, and the rule stricter than the SOP; leaves the clean task alone; accepts nothing |
| `attribute-stored-run` | `skill-299` | A stored run with three failures, each with a different owner | Task spec for the item not on the order; the simulated caller for the invented receipt; the task spec for the too-strict rule; no `run` |
| `confirm-grading-fix` | `skill-300` | The too-strict rule was just made `soft: true` | Confirms with `regrade -o`, not a paid `run`; keeps the original run; reports 25% → 50% |
| `check-cli-features` | `skill-301` | A project pinned to sandtable-ai 0.1.2 is asked for `critical: true`, which came later | Asks the CLI (`--version`, `--help`, `validate`); never reads sandtable's code, in npx's cache or `node_modules/sandtable-ai`; leaves the domain valid; says 0.1.2 can't and what to do instead |
| `install-advice` | `skill-295` | What to install for Claude on Bedrock, without a global install | `npm install --save-dev … sandtable-ai`, `@anthropic-ai/bedrock-sdk`, `npx sandtable-ai validate ./sandtable`, no broken `-p` form |

Each case also has a `skill-fired` grader, which reports whether the expected skill loaded. Under the default `--ablation with-without` it is a plugin-fired indicator and doesn't count toward the score. Under `--ablation none`, the before/after method below, it counts like any other grader: a run in which no skill loaded scores lower, and the other graders then measure Claude without the skill's guidance, so read a change in `skill-fired` before reading the rest.

## Layout

- `<case>/prompt.md`: the request, and the case's run limits and tools. `plugins: ["../../plugin"]` loads the plugin under test.
- `<case>/graders/`: one check per file.
- `<case>/case.yaml`, `<case>/scaffold.sh`: set up the run's workspace. The scaffold copies fixtures in and installs the CLI as a project dependency, with npm's cache and logs inside the project, since the agent's Bash sandbox can't write to its home directory.
- `lib/setup.sh`: what the scaffolds share.
- `fixtures/wrenfield/`: an accepted domain for a fictional returns desk. `fixtures/wrenfield-run/results.json` is a stored run of it, built offline by `fixtures/build-run.ts` from a rule-based agent (`fixtures/careful-agent.ts`) and a scripted caller, then labelled as a live run. Rebuild it with `node plugin-evals/fixtures/build-run.ts` when the agent's or the caller's prompts change, since `test/plugin-evals.test.ts` fails until you do.
- `fixtures/drafted/`: the same desk as `init` would draft it, with the planted problems. `fixtures/discovery/`: the spec and chats it was drafted from.

The suite lives outside `plugin/` so it doesn't ship with the plugin, which the marketplace installs from `plugin/` at the release tag.

## Run it

From the repository root, with Claude Code 2.1.269 or later:

```bash
npm run evals:plugin -- --model claude-sonnet-5-5
```

That builds and packs this checkout's CLI into `plugin-evals/.cache/` (the scaffolds install it), then runs `claude plugin eval . --eval-dir plugin-evals --scaffold --allow-tools Bash Edit Write` with your extra flags:

- `--scaffold` runs the cases' `scaffold.sh` as you, outside the sandbox. They copy fixtures and run `npm install`.
- `--allow-tools Bash Edit Write` lets the cases run the CLI and edit files, inside Claude Code's sandbox, with no network.
- Pin `--model` so a model change isn't read as a skill change.
- Results and the HTML report go to `plugin-evals/results/<time>/`. Add `--no-publish` to keep the report off claude.ai.
- `--tag skill-298` runs only the cases for one issue, `--case <name>` one case, `--runs 1` one run per case, and `--ablation none` skips the no-plugin baseline.

### Before and after a skill change

Run the same suite against `main`'s plugin, then against the change's plugin, at the same model and runs:

```bash
npm run evals:plugin -- --tag skill-298 --ablation none --model claude-sonnet-5-5    # before: main's plugin/
git checkout <skill-branch> -- plugin                                               # after: the branch's skills, this suite
npm run evals:plugin -- --tag skill-298 --ablation none --model claude-sonnet-5-5
git checkout HEAD -- plugin                                                         # back to main's plugin/
```

## What it costs

`claude plugin eval` prints the list-price cost of every run. Each run is a full Claude Code session that loads a skill, reads the workspace and runs a few commands. Expect about $0.20 to $0.40 per run on Claude Sonnet 5.5, and about twice that on Claude Opus 5.5. The `llm` judge calls cost under a cent each.

| Scope | Runs | Claude Sonnet 5.5, roughly |
|---|---|---|
| The whole suite, with the no-plugin baseline (6 cases × 3 runs × 2 arms) | 36 | $7–14 |
| The whole suite, `--ablation none` | 18 | $4–7 |
| One issue's cases, `--ablation none` (e.g. `--tag skill-298`: 1 case × 3 runs) | 3 | $0.60–1.20 |

Set `--max-cost-usd` to stop a run at a budget.

## Limits

- Claude Code refuses to run a case that grants Bash when `~/.ssh` holds a symbolic link anywhere inside it, since its sandbox can't then reliably keep the agent out. The run then fails with "the SSH (~/.ssh) credential store on this machine holds a symbolic link". Keep `~/.ssh` free of links, or run the suite in CI or a container. `install-advice` grants no Bash of its own, but `--allow-tools Bash` applies to every case, so run it alone with `--case install-advice` and without `--allow-tools` if you need to.
- The agent's commands have no network, so a case can't install packages itself. The scaffolds do it before the session starts.
- `npm run evals:plugin` starts the eval without npm's `npm_config_globalconfig`. npm exports it to scripts, and with it in the environment Claude Code's sandbox blocks reads of the directory it names (`/opt/homebrew/etc` with Homebrew's npm), which also holds Homebrew OpenSSL's `openssl.cnf`. Node then fails at startup with `OpenSSL configuration error`, and every `npx sandtable-ai` in a case fails before sandtable runs. If you run `claude plugin eval` yourself from an npm script, drop that variable too.
- `llm` graders vote three times per run on the last message, and a short rubric keeps them stable, but a single run is still noisy: compare at the default three runs.
