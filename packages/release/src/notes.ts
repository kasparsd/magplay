// Pending release notes. One file per change, consumed by the next release.
import fs from 'node:fs'
import path from 'node:path'

export const APP = '@magplay/server'
export const NOTES_DIR = '.changeset'
export const VERSION_FILE = 'apps/server/package.json'
export const CHANGELOG_FILE = 'CHANGELOG.md'

export type NoteBump = 'major' | 'minor' | 'patch' | 'empty'
export type Bump = Exclude<NoteBump, 'empty'>

export interface Release {
  name: string
  bump: Bump
}

export interface Note {
  id: string
  /** Highest bump in the note, or empty. The root changelog groups by this. */
  bump: NoteBump
  summary: string
  /** Packages this note releases. Empty when the note is empty. The application is `@magplay/server`. */
  packages: Release[]
}

export interface Workspace {
  name: string
  /** Path of the workspace relative to the repository root. */
  dir: string
  version: string
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

const RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 }

/** Workspaces declared by the root manifest. The application is included when it is one of them. */
export function loadWorkspaces (root: string): Workspace[] {
  const rootManifest = path.join(root, 'package.json')
  if (!fs.existsSync(rootManifest)) return []
  const parsed = JSON.parse(fs.readFileSync(rootManifest, 'utf8')) as { workspaces?: unknown }
  const patterns = Array.isArray(parsed.workspaces) ? parsed.workspaces.filter((item): item is string => typeof item === 'string') : []
  const dirs: string[] = []
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) throw new Error(`workspace pattern ${pattern} is not supported`)
    const parent = pattern.slice(0, -2)
    const absolute = path.join(root, parent)
    if (!fs.existsSync(absolute)) continue
    for (const name of fs.readdirSync(absolute).sort()) {
      if (fs.existsSync(path.join(absolute, name, 'package.json'))) dirs.push(path.join(parent, name))
    }
  }
  return dirs.map(dir => readWorkspace(root, dir))
}

/** The bump and summary a note declares, or the problems with its text. */
export function parseNote (text: string, known: ReadonlySet<string>): { bump: NoteBump, summary: string, packages: Release[] } | { problems: string[] } {
  const match = /^---\r?\n([\s\S]*?)^---\r?\n?([\s\S]*)$/m.exec(text)
  if (!match || !text.startsWith('---')) return { problems: ['it has no front matter (--- … ---)'] }
  const lines = (match[1] ?? '').split(/\r?\n/).filter(line => line.trim())
  const summary = (match[2] ?? '').trim()
  if (!lines.length) {
    if (summary) return { problems: ['an empty note has no summary'] }
    return { bump: 'empty', summary: '', packages: [] }
  }
  const problems: string[] = []
  const packages: Release[] = []
  for (const line of lines) {
    const entry = /^\s*(["']?)([^"':]+)\1\s*:\s*(\S+)\s*$/.exec(line)
    if (!entry?.[2] || !entry[3]) {
      problems.push(`"${line.trim()}" is not "package": bump`)
      continue
    }
    const name = entry[2]
    const bump = entry[3]
    if (!known.has(name)) problems.push(`${name} is not a package in this repository`)
    if (packages.some(item => item.name === name)) problems.push(`${name} is named twice`)
    if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
      problems.push(`"${bump}" is not patch, minor or major`)
      continue
    }
    packages.push({ name, bump })
  }
  if (!summary) problems.push('it has a bump but no summary')
  if (problems.length || !packages.length) return { problems }
  return { bump: highest(packages.map(item => item.bump)), summary, packages }
}

export function loadNotes (root: string): { notes: Note[], problems: string[] } {
  const dir = path.join(root, NOTES_DIR)
  if (!fs.existsSync(dir)) return { notes: [], problems: [] }
  const notes: Note[] = []
  const problems: string[] = []
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.md') && file !== 'README.md').sort()) {
    const parsed = parseNote(fs.readFileSync(path.join(dir, name), 'utf8'), knownPackages(root))
    if ('problems' in parsed) {
      for (const problem of parsed.problems) problems.push(`${NOTES_DIR}/${name}: ${problem}`)
    } else {
      notes.push({ id: name.slice(0, -'.md'.length), bump: parsed.bump, summary: parsed.summary, packages: parsed.packages })
    }
  }
  return { notes, problems }
}

export function readAppVersion (root: string): string {
  return readVersionFile(root, VERSION_FILE)
}

/** Replace the manifest's version field once, keeping the rest of the file. */
export function writeVersion (root: string, file: string, version: string): void {
  const absolute = path.join(root, file)
  const text = fs.readFileSync(absolute, 'utf8')
  const current = readVersionFile(root, file)
  const needle = `"version": "${current}"`
  if (!text.includes(needle)) throw new Error(`${file} has no ${needle}`)
  fs.writeFileSync(absolute, text.replace(needle, `"version": "${version}"`))
}

/** Write a note and return its path relative to the root. With no packages, the note names the application. */
export function writeNote (root: string, bump: NoteBump, summary: string, packages: readonly string[] = [], random: () => number = Math.random): string {
  const names = bump === 'empty' ? [] : [...new Set(packages.length ? packages : [APP])].sort()
  const known = knownPackages(root)
  for (const name of names) {
    if (!known.has(name)) throw new Error(`${name} is not a package in this repository.`)
  }
  const dir = path.join(root, NOTES_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const taken = new Set(fs.readdirSync(dir).filter(file => file.endsWith('.md')).map(file => file.slice(0, -'.md'.length)))
  const id = noteId(taken, random)
  const body = bump === 'empty'
    ? '---\n---\n'
    : `---\n${names.map(name => `"${name}": ${bump}`).join('\n')}\n---\n\n${summary.trim()}\n`
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

function knownPackages (root: string): Set<string> {
  return new Set([APP, ...loadWorkspaces(root).map(workspace => workspace.name)])
}

function readWorkspace (root: string, dir: string): Workspace {
  const file = path.join(dir, 'package.json')
  const parsed = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as { name?: unknown }
  if (typeof parsed.name !== 'string' || !parsed.name) throw new Error(`${file} has no name`)
  return { name: parsed.name, dir, version: readVersionFile(root, file) }
}

function readVersionFile (root: string, file: string): string {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(parsed.version)) {
    throw new Error(`${file} version must be x.y.z`)
  }
  return parsed.version
}

function highest (bumps: Bump[]): Bump {
  let bump: Bump = 'patch'
  for (const item of bumps) {
    if (RANK[item] > RANK[bump]) bump = item
  }
  return bump
}

function pick (values: readonly string[], random: () => number): string {
  const value = values[Math.floor(random() * values.length)]
  if (value === undefined) throw new Error('empty word list')
  return value
}
