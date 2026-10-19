import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Local agent worktrees (.claude/) and private notes (notes/, gitignored) can hold copies of the tests.
    // Each framework example has its own dependencies and its own check (npm run check in its folder).
    exclude: [...configDefaults.exclude, ".claude/**", "notes/**", "examples/frameworks/**"],
  },
});
