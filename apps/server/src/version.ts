// The running application version. @magplay/server is the release unit; it ships the bundled client.
import { readFileSync } from 'node:fs'

const manifestUrl = new URL('../package.json', import.meta.url)

export function readAppVersion (): string {
  const { name, version } = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { name?: unknown, version?: unknown }
  if (name !== '@magplay/server' || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Application version is missing from apps/server/package.json')
  }
  return version
}
