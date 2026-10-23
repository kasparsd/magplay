// The application version, from this manifest. Releases bump it (see docs/releases.md).
import { readFileSync } from 'node:fs'

export const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
