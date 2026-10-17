import { defineConfig, globalIgnores } from 'eslint/config'
import neostandard, { resolveIgnoresFromGitignore } from 'neostandard'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import { builtinModules } from 'node:module'

// Package boundaries (Decision 10 in the package-boundaries plan). A later block replaces
// the whole rule for its files, so each list repeats the shared deep-import ban.
const deepImports = {
  group: ['@magplay/*/**'],
  message: 'Import a workspace package by its name; its index is the public API.',
}
const nodeBuiltins = {
  group: ['node:*', ...builtinModules.filter(name => !name.startsWith('_'))],
  message: 'This code runs without Node: no Node built-ins.',
}
const serverOnly = {
  group: ['@magplay/http-kit', '@magplay/seekable-tar', '@magplay/indexers', '@magplay/torrent-engine', '@magplay/server'],
  message: 'The client may only use api-contract and playback (codec keys and types).',
}
const restrictImports = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

export default defineConfig(
  globalIgnores(resolveIgnoresFromGitignore()),
  neostandard({ ts: true }),
  // Client pages, and e2e callbacks that run inside page.evaluate()
  { files: ['apps/client/**', 'tests/e2e/**'], languageOptions: { globals: globals.browser } },
  { rules: restrictImports(deepImports) },
  // Tests run under node:test, so they may import Node built-ins
  { files: ['packages/api-contract/**', 'packages/release-info/**'], ignores: ['**/*.test.*'], rules: restrictImports(deepImports, nodeBuiltins) },
  { files: ['apps/client/**'], ignores: ['**/*.test.*'], rules: restrictImports(deepImports, nodeBuiltins, serverOnly) },
  { files: ['apps/client/**/*.test.*'], rules: restrictImports(deepImports, serverOnly) },
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
