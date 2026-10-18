#!/usr/bin/env node
// Release-note policy (docs/releases.md): one versioned workspace, valid notes, and a note in every PR.
//   node tools/scripts/check-changesets.mjs              check the configuration and the pending notes
//   node tools/scripts/check-changesets.mjs --base REF   also require this branch to add a note, or to be a release
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const APP = '@magplay/server'
const BUMPS = new Set(['patch', 'minor', 'major'])
const RELEASE_FILES = new Set(['apps/server/package.json', 'apps/server/CHANGELOG.md', 'package-lock.json'])
const isNote = file => /^\.changeset\/[^/]+\.md$/.test(file) && file !== '.changeset/README.md'

/** Problems with a note's text: front matter that names only the app with a valid bump; an empty note has none. */
export function noteProblems (text) {
  const match = /^---\r?\n([\s\S]*?)^---\r?\n?([\s\S]*)$/m.exec(text)
  if (!match || !text.startsWith('---')) return ['it has no front matter (--- … ---)']
  const lines = match[1].split(/\r?\n/).filter(line => line.trim())
  const problems = []
  for (const line of lines) {
    const entry = /^\s*(["']?)([^"':]+)\1\s*:\s*(\S+)\s*$/.exec(line)
    if (!entry) problems.push(`"${line.trim()}" is not "package": bump`)
    else if (entry[2] !== APP) problems.push(`${entry[2]} is not released on its own; name ${APP} for every change`)
    else if (!BUMPS.has(entry[3])) problems.push(`"${entry[3]}" is not patch, minor or major`)
  }
  if (lines.length && !match[2].trim()) problems.push('it has a bump but no summary')
  return problems
}

/** The configuration must version only the app: every other workspace is ignored, and every workspace is private. */
export function configProblems (config, workspaces) {
  const problems = []
  const others = workspaces.filter(w => w.name !== APP).map(w => w.name).sort()
  const ignored = [...(config.ignore ?? [])].sort()
  if (!workspaces.some(w => w.name === APP)) problems.push(`${APP} is not a workspace`)
  if (JSON.stringify(ignored) !== JSON.stringify(others)) {
    const missing = others.filter(name => !ignored.includes(name))
    const extra = ignored.filter(name => !others.includes(name))
    if (missing.length) problems.push(`add to "ignore" in .changeset/config.json: ${missing.join(', ')}`)
    if (extra.length) problems.push(`remove from "ignore" in .changeset/config.json: ${extra.join(', ')}`)
  }
  for (const w of workspaces) if (!w.private) problems.push(`${w.name} must stay private`)
  if (config.privatePackages?.version !== true || config.privatePackages?.tag !== false) problems.push('"privatePackages" must be { "version": true, "tag": false }')
  if ((config.fixed ?? []).length || (config.linked ?? []).length) problems.push('"fixed" and "linked" must stay empty')
  return problems
}

/**
 * Whether a branch's changes against its base satisfy the policy: it adds a note, or it is a release that only consumes
 * notes, raises the app version and updates the changelog and lockfile. `changes` are git's name-status pairs.
 */
export function branchProblems ({ changes, baseVersion, version, lockVersion }) {
  if (changes.some(([status, file]) => status === 'A' && isNote(file))) return []
  const consumed = changes.filter(([status, file]) => status === 'D' && isNote(file))
  if (!consumed.length) return ['add a release note: npm run changeset (or npm run changeset -- --empty when users see no change)']
  const problems = []
  const unrelated = changes.filter(([, file]) => !isNote(file) && !RELEASE_FILES.has(file)).map(([, file]) => file)
  if (unrelated.length) problems.push(`a release changes only notes, the version, the changelog and the lockfile; also changed: ${unrelated.join(', ')}`)
  if (!changes.some(([, file]) => file === 'apps/server/CHANGELOG.md')) problems.push('a release updates apps/server/CHANGELOG.md')
  if (compareVersions(version, baseVersion) <= 0) problems.push(`a release raises the version (${baseVersion} → ${version})`)
  if (lockVersion !== version) problems.push(`package-lock.json has ${APP} ${lockVersion}, not ${version}: run npm run release:version`)
  return problems
}

function compareVersions (a, b) {
  const parts = v => String(v).split('-')[0].split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

function main () {
  const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  const workspaces = ['apps', 'packages'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir))
    .filter(name => fs.existsSync(path.join(ROOT, dir, name, 'package.json')))
    .map(name => JSON.parse(read(`${dir}/${name}/package.json`))))
  const problems = configProblems(JSON.parse(read('.changeset/config.json')), workspaces)
  for (const file of fs.readdirSync(path.join(ROOT, '.changeset')).map(name => `.changeset/${name}`).filter(isNote)) {
    for (const problem of noteProblems(read(file))) problems.push(`${file}: ${problem}`)
  }
  const at = process.argv.indexOf('--base')
  const base = at < 0 ? null : process.argv[at + 1]
  if (at >= 0 && !base) problems.push('--base needs a git ref, such as origin/main')
  else if (base) {
    // Against the working tree, so staged notes count before they are committed
    const fork = git('merge-base', base, 'HEAD').trim()
    const changes = git('diff', '--name-status', '--no-renames', fork).split('\n').filter(Boolean).map(line => line.split('\t'))
    problems.push(...branchProblems({
      changes,
      baseVersion: JSON.parse(git('show', `${fork}:apps/server/package.json`)).version,
      version: JSON.parse(read('apps/server/package.json')).version,
      lockVersion: JSON.parse(read('package-lock.json')).packages['apps/server']?.version,
    }))
  }
  if (problems.length) {
    console.error(`Release notes (docs/releases.md):\n${problems.map(p => `- ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(base ? `Release notes are in order against ${base}.` : 'Release notes are in order.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
