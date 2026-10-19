// Step outputs for the release workflows. One command writes every value the next step reads.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'

/** Encode values for `$GITHUB_OUTPUT`. Multiline values use a delimiter so they cannot set other outputs. */
export function formatGitHubOutput (values: Record<string, string | boolean>): string {
  const delimiter = `release_${randomBytes(8).toString('hex')}`
  return Object.entries(values).map(([name, value]) => {
    const text = String(value)
    if (!text.includes('\n') && !text.includes('\r')) return `${name}=${text}\n`
    return `${name}<<${delimiter}\n${text}\n${delimiter}\n`
  }).join('')
}

export function writeGitHubOutput (values: Record<string, string | boolean>, file = process.env.GITHUB_OUTPUT): void {
  if (!file) throw new Error('--github-output requires the GITHUB_OUTPUT environment variable.')
  fs.appendFileSync(file, formatGitHubOutput(values))
}
