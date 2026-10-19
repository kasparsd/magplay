// Turn pending notes into the version and the changelog. The lockfile is left
// for the release workflow, which refreshes it after this writes the version.
import fs from 'node:fs'
import path from 'node:path'
import { addChangelogSection, changelogEntry, renderSection } from './changelog.ts'
import { CHANGELOG_FILE, loadNotes, NOTES_DIR, readAppVersion, writeAppVersion } from './notes.ts'
import type { Bump, Note } from './notes.ts'
import { makePlan } from './plan.ts'

export interface ApplyResult {
  /** True only when this run wrote files. A dry run and an empty plan are false. */
  applied: boolean
  dryRun: boolean
  current: string
  next: string | null
  bump: Bump | null
  /** Changelog section body, without the version heading. */
  notes: string
}

/**
 * Apply the pending release. Empty notes alone are left in place, so a run of
 * internal changes does not open a release that does not raise the version.
 */
export function applyRelease (root: string, options?: { dryRun?: boolean }): ApplyResult {
  const dryRun = options?.dryRun === true
  const loaded = loadNotes(root)
  if (loaded.problems.length) throw new Error(loaded.problems.join('\n'))
  const plan = makePlan(readAppVersion(root), loaded.notes)
  const next = plan.next
  if (plan.bump === null || next === null) {
    return { applied: false, dryRun, current: plan.current, next: null, bump: null, notes: '' }
  }
  const notes = sectionBody(root, next, plan.notes)
  if (!dryRun) {
    const changelogPath = path.join(root, CHANGELOG_FILE)
    const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : null
    fs.writeFileSync(changelogPath, addChangelogSection(existing, renderSection(next, plan.notes)))
    writeAppVersion(root, next)
    for (const note of plan.notes) fs.unlinkSync(path.join(root, NOTES_DIR, `${note.id}.md`))
  }
  return { applied: !dryRun, dryRun, current: plan.current, next, bump: plan.bump, notes }
}

/** Title and body for the release pull request of an applied version. */
export function releasePullRequest (result: ApplyResult): { title: string, body: string } {
  if (result.next === null) throw new Error('no version bump is pending')
  return {
    title: `Release ${result.next}`,
    body: `Merging this pull request tags v${result.next} and publishes the container image.\n\n${result.notes.trim()}\n`,
  }
}

export function formatApply (result: ApplyResult): string {
  if (result.next === null || result.bump === null) return `${result.current}, no version bump pending\n`
  const line = `${result.current} → ${result.next} (${result.bump})`
  return result.dryRun ? `Dry run: ${line}\n` : `${line}\n`
}

function sectionBody (root: string, version: string, notes: Note[]): string {
  const changelogPath = path.join(root, CHANGELOG_FILE)
  const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : null
  if (existing !== null && changelogEntry(existing, version) !== null) {
    throw new Error(`${CHANGELOG_FILE} already has a section for ${version}`)
  }
  const written = addChangelogSection(existing, renderSection(version, notes))
  return changelogEntry(written, version) ?? ''
}
