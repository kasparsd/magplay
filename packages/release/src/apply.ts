// Turn pending notes into the version and the changelog. The lockfile is left
// for the release workflow, which refreshes it after this writes the version.
import fs from 'node:fs'
import path from 'node:path'
import { addChangelogSection, changelogEntry, notesForPackage, renderSection } from './changelog.ts'
import { CHANGELOG_FILE, loadNotes, loadWorkspaces, NOTES_DIR, readAppVersion, writeVersion, VERSION_FILE } from './notes.ts'
import type { Bump } from './notes.ts'
import { makePlan } from './plan.ts'
import type { PackageRelease } from './plan.ts'

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
  const plan = makePlan(readAppVersion(root), loaded.notes, loadWorkspaces(root))
  const next = plan.next
  if (plan.bump === null || next === null) {
    return { applied: false, dryRun, current: plan.current, next: null, bump: null, notes: '' }
  }
  const versions = new Map(plan.packages.map(item => [item.name, item.next]))
  const notes = sectionBody(root, CHANGELOG_FILE, next, renderSection(next, plan.notes, versions))
  for (const item of plan.packages) {
    sectionBody(root, packageChangelog(item), item.next, renderSection(item.next, notesForPackage(plan.notes, item.name)))
  }
  if (!dryRun) {
    writeChangelog(root, CHANGELOG_FILE, next, renderSection(next, plan.notes, versions))
    writeVersion(root, VERSION_FILE, next)
    for (const item of plan.packages) {
      writeChangelog(root, packageChangelog(item), item.next, renderSection(item.next, notesForPackage(plan.notes, item.name)), item.name)
      writeVersion(root, path.join(item.dir, 'package.json'), item.next)
    }
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

function packageChangelog (item: PackageRelease): string {
  return path.join(item.dir, 'CHANGELOG.md')
}

function sectionBody (root: string, file: string, version: string, section: string): string {
  const existing = readChangelog(root, file)
  if (existing !== null && changelogEntry(existing, version) !== null) {
    throw new Error(`${file} already has a section for ${version}`)
  }
  return changelogEntry(addChangelogSection(existing, section), version) ?? ''
}

function writeChangelog (root: string, file: string, version: string, section: string, title?: string): void {
  const existing = readChangelog(root, file)
  if (existing !== null && changelogEntry(existing, version) !== null) {
    throw new Error(`${file} already has a section for ${version}`)
  }
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), addChangelogSection(existing, section, title))
}

function readChangelog (root: string, file: string): string | null {
  const changelogPath = path.join(root, file)
  return fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : null
}
