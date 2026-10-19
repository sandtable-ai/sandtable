import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Local agent worktrees (.claude/) and private notes (notes/, gitignored) can hold copies of the tests.
    exclude: [...configDefaults.exclude, ".claude/**", "notes/**"],
  },
});
