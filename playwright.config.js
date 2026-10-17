import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.test.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
