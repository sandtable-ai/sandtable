@AGENTS.md

## Claude Code

- After changing `plugin/` or `.claude-plugin/`, also run `claude plugin validate . --strict` and `claude plugin validate ./plugin --strict`. The first checks only the marketplace file; the second checks the plugin's skills and agent. Try the working copy with `claude --plugin-dir ./plugin`: the marketplace installs `plugin/` from the latest release's tag.
- `.claude/settings.json` turns off Claude Code's commit and PR attribution. Don't add it back by hand.
- Put agent worktrees under `.claude/worktrees/`. That directory is gitignored and vitest skips it.
