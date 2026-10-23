// Boundary for the existing JavaScript harness: fields consumed by typed browser tests.
import type { PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, TestType } from '@playwright/test'

interface AppFixture {
  origin: string
  ih: string
  files: Record<string, number>
  cache: string
  torrent: string
  logs: () => string
  player: (name: string) => string
}

export const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions, PlaywrightWorkerArgs & PlaywrightWorkerOptions & { app: AppFixture, serverEnv: Record<string, string> }>
export { expect } from '@playwright/test'
