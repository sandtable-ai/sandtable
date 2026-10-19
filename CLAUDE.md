@AGENTS.md

## Claude Code

- After changing `plugin/` or `.claude-plugin/`, also run `claude plugin validate . --strict`.
- `.claude/settings.json` turns off Claude Code's commit and PR attribution. Don't add it back by hand.
- Put agent worktrees under `.claude/worktrees/`. That directory is gitignored and vitest skips it.
