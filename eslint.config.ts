import neostandard from 'neostandard'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  // Global ignores; neostandard's own `ignores` option only scopes its config objects.
  { ignores: ['dist/**', '.tsbuild/**', 'test-results/**', 'playwright-report/**'] },
  neostandard({ ts: true }),
  {
    // Browser globals for the client pages and for e2e callbacks that execute
    // inside page.evaluate(); the server packages use Node types.
    files: ['apps/client/**/*.js', 'apps/client/**/*.ts', 'tests/e2e/**/*.js', 'tests/e2e/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Type-aware rules: correctness the compiler misses, mainly around the
    // abort/lifecycle code (floating or misused promises) and exhaustive
    // switches over discriminated unions.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // node:test's test()/describe() return promises the runner already tracks.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-expect-error': 'allow-with-description',
        'ts-ignore': false,
        'ts-nocheck': false,
        'ts-check': false,
      }],
    },
  }
)
