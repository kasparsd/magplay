import { defineConfig } from '@playwright/test'

// One worker: the suite shares one app server and one ffmpeg-bound HLS session limit
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    viewport: { width: 1100, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
