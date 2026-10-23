import fs from 'node:fs'
import path from 'node:path'
import { changelogEntry } from './changelog.ts'
import { git, gitOk } from './git.ts'
import { CHANGELOG_FILE, readAppVersion } from './notes.ts'

export interface TagResult {
  created: boolean
  tag: string | null
  title: string | null
  notes: string | null
  reason: 'created' | 'exists' | 'no-changelog'
}

/**
 * Tag v<version> at HEAD when the changelog has that version and the tag is
 * absent. An existing tag is left where it is. With push, a tag that is only
 * local is pushed, and one that is already on the remote is not moved.
 */
export function tagRelease (root: string, options?: { push?: boolean }): TagResult {
  const push = options?.push === true
  const version = readAppVersion(root)
  const changelogPath = path.join(root, CHANGELOG_FILE)
  const markdown = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : ''
  const notes = changelogEntry(markdown, version)
  if (notes === null) return { created: false, tag: null, title: null, notes: null, reason: 'no-changelog' }
  const tag = `v${version}`
  const local = localTag(root, tag)
  const remote = push ? remoteTag(root, tag) : false
  if (remote || (local && !push)) {
    return { created: false, tag, title: tag, notes, reason: 'exists' }
  }
  if (!local) gitOk(root, ['tag', '--', tag])
  if (push) gitOk(root, ['push', 'origin', `refs/tags/${tag}`])
  return { created: true, tag, title: tag, notes, reason: 'created' }
}

export function formatTag (result: TagResult): string {
  if (result.reason === 'no-changelog') return 'The current version has no changelog section.\n'
  if (result.reason === 'exists') return `${result.tag} already exists.\n`
  return `Tagged ${result.tag}.\n`
}

function localTag (root: string, tag: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0
}

function remoteTag (root: string, tag: string): boolean {
  const result = git(root, ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`])
  if (result.status === 0) return true
  if (result.status === 2) return false
  throw new Error(`git ls-remote failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`)
}
