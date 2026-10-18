// The application version: one manifest, the server's, which Changesets bumps (see docs/releases.md).
import { readFileSync } from 'node:fs'

export const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
