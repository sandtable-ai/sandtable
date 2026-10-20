import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Local agent worktrees (.claude/) and private notes (notes/, gitignored) can hold copies of the tests.
    // Each framework example has its own dependencies and its own check (npm run check in its folder).
    exclude: [...configDefaults.exclude, ".claude/**", "notes/**", "examples/frameworks/**"],
    // Many tests spawn the CLI. Under CPU load (parallel checks in several worktrees) they can pass the
    // 5 s default without being wrong, and a timeout that comes from load hides real failures.
    testTimeout: 30_000,
  },
});
