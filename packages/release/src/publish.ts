// Tag the current commit and publish its GitHub Release. The tag workflow is this one command.
import { execFileSync } from 'node:child_process'
import { tagRelease } from './tag.ts'

export interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

export interface PublishResult {
  published: boolean
  tag: string | null
  reason: 'published' | 'exists' | 'no-changelog' | 'no-token'
}

type Run = (command: string, args: string[]) => CommandResult

/**
 * Publish v<version>. Without a token in GitHub Actions, skip. An existing tag
 * is not moved, and an existing GitHub Release is left as it is.
 */
export function publishRelease (root: string, options: {
  token: string | undefined
  actions: boolean
  push: boolean
  run?: Run
}): PublishResult {
  if (!options.token) {
    if (options.actions) return { published: false, tag: null, reason: 'no-token' }
    throw new Error('RELEASE_TOKEN is not set, so the release was skipped.')
  }
  const run = options.run ?? defaultRun
  if (options.push) {
    const setup = run('gh', ['auth', 'setup-git'])
    if (setup.status !== 0) throw new Error(commandFailed('gh auth setup-git', setup.stderr))
  }
  const tagged = tagRelease(root, { push: options.push })
  if (tagged.tag === null || tagged.notes === null) return { published: false, tag: null, reason: 'no-changelog' }
  const view = run('gh', ['release', 'view', tagged.tag])
  if (view.status === 0) return { published: false, tag: tagged.tag, reason: 'exists' }
  const created = run('gh', ['release', 'create', tagged.tag, '--target', 'HEAD', '--title', tagged.tag, '--notes', tagged.notes])
  if (created.status !== 0) throw new Error(commandFailed('gh release create', created.stderr))
  return { published: true, tag: tagged.tag, reason: 'published' }
}

export function formatPublish (result: PublishResult): string {
  if (result.reason === 'no-token') return 'RELEASE_TOKEN is not set, so the release tag was skipped.\n'
  if (result.reason === 'no-changelog') return 'The current version has no changelog section.\n'
  if (result.reason === 'exists') return `${result.tag} already has a GitHub Release.\n`
  return `Published ${result.tag}.\n`
}

function defaultRun (command: string, args: string[]): CommandResult {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failed = error as { status?: unknown, stdout?: unknown, stderr?: unknown }
    if (typeof failed.status !== 'number') {
      throw new Error(`${command} ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      status: failed.status,
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
    }
  }
}

function commandFailed (command: string, stderr: string): string {
  return `${command} failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`
}
