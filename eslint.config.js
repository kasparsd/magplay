import { defineConfig, globalIgnores } from 'eslint/config'
import neostandard, { resolveIgnoresFromGitignore } from 'neostandard'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default defineConfig(
  globalIgnores(resolveIgnoresFromGitignore()),
  neostandard({ ts: true }),
  // Client pages, and e2e callbacks that run inside page.evaluate()
  { files: ['apps/client/**', 'tests/e2e/**'], languageOptions: { globals: globals.browser } },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      // The node:test runner tracks the promises test() and describe() return
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }],
      }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  }
)
