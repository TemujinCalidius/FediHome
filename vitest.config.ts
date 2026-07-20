import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Scope discovery to OUR source tree (#303). Without an `include`, Vitest
    // falls back to its default glob across the whole repo root, so any nested
    // checkout — most often a `git worktree` created inside the project folder,
    // but equally a second clone or a backup copy — gets collected too. The
    // suite then runs TWICE, and the second copy is a different commit, so it
    // can fail on code you never touched (or pass on code you just changed).
    // `coverage.include` below does NOT help: it narrows reporting, not
    // collection. Anchored at the root, so `.wt-test/src/**` no longer matches.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Belt-and-braces: Vitest's defaults only cover node_modules/dist/cypress/
    // .{idea,git,cache,output,temp}, which a nested worktree matches none of.
    exclude: [...configDefaults.exclude, "**/.next/**", "**/.wt-*/**", "**/worktrees/**"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
