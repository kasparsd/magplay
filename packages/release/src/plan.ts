import { APP, type Bump, type Note, type Workspace } from './notes.ts'
import { bumpVersion } from './version.ts'

export interface PackageRelease {
  name: string
  dir: string
  current: string
  next: string
  bump: Bump
}

export interface Plan {
  current: string
  /** The application version a release would write, or null when every pending note is empty. */
  next: string | null
  bump: Bump | null
  notes: Note[]
  /** Workspaces named by a note, apart from the application. */
  packages: PackageRelease[]
}

const RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 }

/**
 * The highest real bump wins, including a note that names only a package:
 * that change ships in the application. Empty notes ride along and do not
 * change a version. A package moves only when a note names it.
 */
export function makePlan (current: string, notes: Note[], workspaces: readonly Workspace[] = []): Plan {
  const sorted = [...notes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  let bump: Bump | null = null
  for (const note of sorted) {
    if (note.bump === 'empty') continue
    if (bump === null || RANK[note.bump] > RANK[bump]) bump = note.bump
  }
  return {
    current,
    next: bump === null ? null : bumpVersion(current, bump),
    bump,
    notes: sorted,
    packages: packageReleases(sorted, workspaces),
  }
}

function packageReleases (notes: Note[], workspaces: readonly Workspace[]): PackageRelease[] {
  const releases: PackageRelease[] = []
  for (const workspace of workspaces) {
    if (workspace.name === APP) continue
    let bump: Bump | null = null
    for (const note of notes) {
      const named = note.packages.find(item => item.name === workspace.name)
      if (!named) continue
      if (bump === null || RANK[named.bump] > RANK[bump]) bump = named.bump
    }
    if (bump === null) continue
    releases.push({
      name: workspace.name,
      dir: workspace.dir,
      current: workspace.version,
      next: bumpVersion(workspace.version, bump),
      bump,
    })
  }
  return releases.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export function formatPlan (plan: Plan): string {
  const lines: string[] = []
  lines.push(plan.bump !== null && plan.next !== null
    ? `${plan.current} → ${plan.next} (${plan.bump})`
    : `${plan.current}, no version bump pending`)
  for (const item of plan.packages) lines.push(`${item.name} ${item.current} → ${item.next} (${item.bump})`)
  lines.push('')
  const empty = plan.notes.filter(note => note.bump === 'empty').length
  for (const note of plan.notes) {
    if (note.bump === 'empty') continue
    lines.push(`${note.bump}  ${note.id}`)
    for (const line of note.summary.split('\n')) lines.push(`  ${line}`)
    lines.push('')
  }
  if (empty) lines.push(`${empty} empty ${empty === 1 ? 'note' : 'notes'}`)
  return `${lines.join('\n').trimEnd()}\n`
}
