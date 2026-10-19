import type { Bump, Note } from './notes.ts'

const GROUPS: Array<[Bump, string]> = [
  ['major', 'Major'],
  ['minor', 'Minor'],
  ['patch', 'Patch'],
]

/**
 * The changelog section for one version, without a trailing blank line.
 * In the root changelog, a note that names packages lists each package and its
 * new version once. A note that names only the application is the summary.
 */
export function renderSection (version: string, notes: Note[], packageVersions: ReadonlyMap<string, string> = new Map()): string {
  const lines = [`## ${version}`]
  for (const [bump, title] of GROUPS) {
    const items = notes.filter(note => note.bump === bump).sort((a, b) => a.id < b.id ? -1 : 1)
    if (!items.length) continue
    lines.push('', `### ${title}`, '')
    for (const note of items) lines.push(bullet(entryText(note, packageVersions)))
  }
  return lines.join('\n')
}

/** The same notes grouped by one package's own bump, with the bare summary. */
export function notesForPackage (notes: Note[], name: string): Note[] {
  const selected: Note[] = []
  for (const note of notes) {
    const named = note.packages.find(item => item.name === name)
    if (!named) continue
    selected.push({ ...note, bump: named.bump })
  }
  return selected
}

/** Insert a section after the document title, or start the document with one. */
export function addChangelogSection (existing: string | null, section: string, title = 'magplay'): string {
  const block = `${section.trimEnd()}\n`
  if (!existing?.trim()) return `# ${title}\n\n${block}`
  const heading = /^# .+\n+/.exec(existing)
  const headingText = heading?.[0]
  if (headingText === undefined) return `${block}\n${existing.trimStart()}`
  return `${existing.slice(0, headingText.length)}${block}\n${existing.slice(headingText.length)}`
}

/** The body under `## <version>`, or null when that version has no section. */
export function changelogEntry (markdown: string, version: string): string | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => line === `## ${version}`)
  if (start < 0) return null
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

function entryText (note: Note, packageVersions: ReadonlyMap<string, string>): string {
  const named = note.packages.filter(item => packageVersions.has(item.name))
    .slice()
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (!named.length) return note.summary
  const prefix = named.map(item => {
    const version = packageVersions.get(item.name)
    if (version === undefined) throw new Error(`no version for ${item.name}`)
    return `\`${item.name}\` ${version}`
  }).join(', ')
  return `${prefix}: ${note.summary}`
}

function bullet (summary: string): string {
  return summary.split('\n').map((line, index) => index === 0 ? `- ${line}` : `  ${line}`).join('\n')
}
