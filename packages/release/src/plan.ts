import type { Bump, Note } from './notes.ts'
import { bumpVersion } from './version.ts'

export interface Plan {
  current: string
  /** The version a release would write, or null when every pending note is empty. */
  next: string | null
  bump: Bump | null
  notes: Note[]
}

const RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 }

/** The highest real bump wins. Empty notes ride along and do not change the version. */
export function makePlan (current: string, notes: Note[]): Plan {
  const sorted = [...notes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  let bump: Bump | null = null
  for (const note of sorted) {
    if (note.bump === 'empty') continue
    if (bump === null || RANK[note.bump] > RANK[bump]) bump = note.bump
  }
  return { current, next: bump === null ? null : bumpVersion(current, bump), bump, notes: sorted }
}

export function formatPlan (plan: Plan): string {
  const lines: string[] = []
  lines.push(plan.bump !== null && plan.next !== null
    ? `${plan.current} → ${plan.next} (${plan.bump})`
    : `${plan.current}, no version bump pending`)
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
