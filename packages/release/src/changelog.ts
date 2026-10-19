import type { Bump, Note } from './notes.ts'

const GROUPS: Array<[Bump, string]> = [
  ['major', 'Major'],
  ['minor', 'Minor'],
  ['patch', 'Patch'],
]

/** The changelog section for one version, without a trailing blank line. */
export function renderSection (version: string, notes: Note[]): string {
  const lines = [`## ${version}`]
  for (const [bump, title] of GROUPS) {
    const items = notes.filter(note => note.bump === bump).sort((a, b) => a.id < b.id ? -1 : 1)
    if (!items.length) continue
    lines.push('', `### ${title}`, '')
    for (const note of items) lines.push(bullet(note.summary))
  }
  return lines.join('\n')
}

/** Insert a section after the document title, or start the document with one. */
export function addChangelogSection (existing: string | null, section: string): string {
  const block = `${section.trimEnd()}\n`
  if (!existing?.trim()) return `# magplay\n\n${block}`
  const title = /^# .+\n+/.exec(existing)
  if (!title) return `${block}\n${existing.trimStart()}`
  return `${existing.slice(0, title[0].length)}${block}\n${existing.slice(title[0].length)}`
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

function bullet (summary: string): string {
  return summary.split('\n').map((line, index) => index === 0 ? `- ${line}` : `  ${line}`).join('\n')
}
