// Boundary for the existing JavaScript harness: fields consumed by typed browser tests.
import type { PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, TestType } from '@playwright/test'

interface AppFixture {
  origin: string
  cache: string
  torrent: string
}

export const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions, PlaywrightWorkerArgs & PlaywrightWorkerOptions & { app: AppFixture }>
export { expect } from '@playwright/test'
