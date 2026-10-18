import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Local agent worktrees live under .claude/ and carry their own copies of the tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
