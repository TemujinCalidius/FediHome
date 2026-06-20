import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const reactHooksFlat = reactHooks.configs.flat["recommended-latest"];

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "src/generated/**",
      "next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooks,
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooksFlat.rules,
      // The tree uses `// eslint-disable @typescript-eslint/no-explicit-any` comments;
      // register + enable the rule (as a warning) so those directives resolve.
      "@typescript-eslint/no-explicit-any": "warn",
      // Scope guard: React 19 "Rules of React" are valuable but the existing tree predates
      // them — surface as WARNINGS, not errors. Lint isn't in CI, so nothing is gated on
      // them. The two confirmed violations are fixed in #78; others are follow-ups.
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/incompatible-library": "warn",
    },
  },
];

export default eslintConfig;
