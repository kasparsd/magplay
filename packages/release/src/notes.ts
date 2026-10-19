// Pending release notes. One file per change, consumed by the next release.
import fs from 'node:fs'
import path from 'node:path'

export const APP = '@magplay/server'
export const NOTES_DIR = '.changeset'
export const VERSION_FILE = 'apps/server/package.json'
export const CHANGELOG_FILE = 'CHANGELOG.md'

export type NoteBump = 'major' | 'minor' | 'patch' | 'empty'
export type Bump = Exclude<NoteBump, 'empty'>

export interface Note {
  id: string
  bump: NoteBump
  summary: string
}

const ADJECTIVES = ['brave', 'bright', 'calm', 'clear', 'eager', 'fair', 'gentle', 'keen', 'kind', 'lucky', 'quick', 'quiet', 'swift', 'warm', 'wild', 'wise']
const NOUNS = ['brooks', 'clouds', 'ferns', 'fields', 'harbors', 'islands', 'maples', 'meadows', 'rivers', 'springs', 'stones', 'trails', 'valleys', 'waves', 'winds', 'woods']
const VERBS = ['begin', 'build', 'carry', 'cross', 'gather', 'grow', 'keep', 'lift', 'meet', 'open', 'reach', 'settle', 'shine', 'start', 'turn', 'walk']

/** A note path relative to the repository root. The directory README is not a note. */
export function isReleaseNote (file: string): boolean {
  return /^\.changeset\/[^/]+\.md$/.test(file) && file !== '.changeset/README.md'
}

export function findRoot (start: string): string {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, VERSION_FILE))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`could not find ${VERSION_FILE} above ${start}`)
    dir = parent
  }
}

/** The bump and summary a note declares, or the problems with its text. */
export function parseNote (text: string): { bump: NoteBump, summary: string } | { problems: string[] } {
  const match = /^---\r?\n([\s\S]*?)^---\r?\n?([\s\S]*)$/m.exec(text)
  if (!match || !text.startsWith('---')) return { problems: ['it has no front matter (--- … ---)'] }
  const lines = (match[1] ?? '').split(/\r?\n/).filter(line => line.trim())
  const summary = (match[2] ?? '').trim()
  if (!lines.length) {
    if (summary) return { problems: ['an empty note has no summary'] }
    return { bump: 'empty', summary: '' }
  }
  if (lines.length !== 1) return { problems: [`a note names only ${APP}`] }
  const line = lines[0] ?? ''
  const entry = /^\s*(["']?)([^"':]+)\1\s*:\s*(\S+)\s*$/.exec(line)
  if (!entry?.[2] || !entry[3]) return { problems: [`"${line.trim()}" is not "package": bump`] }
  if (entry[2] !== APP) return { problems: [`${entry[2]} is not released on its own; name ${APP}`] }
  if (entry[3] !== 'patch' && entry[3] !== 'minor' && entry[3] !== 'major') {
    return { problems: [`"${entry[3]}" is not patch, minor or major`] }
  }
  if (!summary) return { problems: ['it has a bump but no summary'] }
  return { bump: entry[3], summary }
}

export function loadNotes (root: string): { notes: Note[], problems: string[] } {
  const dir = path.join(root, NOTES_DIR)
  if (!fs.existsSync(dir)) return { notes: [], problems: [] }
  const notes: Note[] = []
  const problems: string[] = []
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.md') && file !== 'README.md').sort()) {
    const parsed = parseNote(fs.readFileSync(path.join(dir, name), 'utf8'))
    if ('problems' in parsed) {
      for (const problem of parsed.problems) problems.push(`${NOTES_DIR}/${name}: ${problem}`)
    } else {
      notes.push({ id: name.slice(0, -'.md'.length), bump: parsed.bump, summary: parsed.summary })
    }
  }
  return { notes, problems }
}

export function readAppVersion (root: string): string {
  const json = JSON.parse(fs.readFileSync(path.join(root, VERSION_FILE), 'utf8')) as { version?: unknown }
  if (typeof json.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(json.version)) {
    throw new Error(`${VERSION_FILE} version must be x.y.z`)
  }
  return json.version
}

export function writeAppVersion (root: string, version: string): void {
  const file = path.join(root, VERSION_FILE)
  const text = fs.readFileSync(file, 'utf8')
  const current = readAppVersion(root)
  const needle = `"version": "${current}"`
  if (!text.includes(needle)) throw new Error(`${VERSION_FILE} has no ${needle}`)
  fs.writeFileSync(file, text.replace(needle, `"version": "${version}"`))
}

/** Write a note and return its path relative to the root. */
export function writeNote (root: string, bump: NoteBump, summary: string, random: () => number = Math.random): string {
  const dir = path.join(root, NOTES_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const taken = new Set(fs.readdirSync(dir).filter(file => file.endsWith('.md')).map(file => file.slice(0, -'.md'.length)))
  const id = noteId(taken, random)
  const body = bump === 'empty'
    ? '---\n---\n'
    : `---\n"${APP}": ${bump}\n---\n\n${summary.trim()}\n`
  const relative = `${NOTES_DIR}/${id}.md`
  fs.writeFileSync(path.join(root, relative), body)
  return relative
}

function noteId (taken: Set<string>, random: () => number): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = [pick(ADJECTIVES, random), pick(NOUNS, random), pick(VERBS, random)].join('-')
    if (!taken.has(id)) return id
  }
  throw new Error('could not pick a release note name')
}

function pick (values: readonly string[], random: () => number): string {
  const value = values[Math.floor(random() * values.length)]
  if (value === undefined) throw new Error('empty word list')
  return value
}
