const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

const runtimeModules = ["lumine"];

module.exports = [
  { ignores: ["node_modules/**", ".dev/**", "coverage/**"] },
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    settings: { n: { version: ">=24.0.0" } },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.browser, ...globals.node, lumine: "readonly" },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
    },
  },
  {
    files: ["eslint.config.js", "test/**", "spec/**", "**/*-spec.js"],
    languageOptions: { globals: { ...globals.jasmine, conditionPromise: "readonly" } },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  prettier,
];
