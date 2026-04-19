import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // ── Pi engine: ESM-only, no CommonJS require() allowed ──
  // Engine kompileras med "type": "module" — runtime require() är inte
  // definierat och kraschar API-anrop med "require is not defined".
  // Bug-historik: pi/src/ble/adapter.ts hade två require('./sysExec.js')
  // som kraschade /api/ble/connect i produktion (build tag esm-require-fix).
  {
    files: ["pi/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='require']",
          message:
            "Pi engine kompileras som ESM — använd 'import' istället för require(). Runtime require() kraschar med \"require is not defined\". Se mem://pi/ble/adapter.ts esm-require-fix.",
        },
      ],
      "@typescript-eslint/no-require-imports": "error",
    },
  },
);
