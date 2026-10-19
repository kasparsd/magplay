import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyRelease, releasePullRequest } from './apply.ts'
import { changelogEntry } from './changelog.ts'
import { formatGitHubOutput } from './github.ts'
import { gitOk } from './git.ts'
import { APP, loadNotes, loadWorkspaces, parseNote, writeNote } from './notes.ts'
import type { Note, NoteBump } from './notes.ts'
import { makePlan } from './plan.ts'
import { hasAddedNote } from './status.ts'
import { tagRelease } from './tag.ts'

const SERVER = {
  name: '@magplay/server',
  version: '0.1.0',
  private: true,
}

test('a note names the app or a package with a bump and a summary; an empty note is valid', () => {
  const known = new Set([APP, '@magplay/playback', '@magplay/http-kit'])
  assert.deepEqual(parseNote(`---\n"${APP}": patch\n---\n\nSeeking restarts conversion.\n`, known), {
    bump: 'patch',
    summary: 'Seeking restarts conversion.',
    packages: [{ name: APP, bump: 'patch' }],
  })
  assert.deepEqual(parseNote(`---\n'${APP}': minor\n---\nSummary\n`, known), {
    bump: 'minor',
    summary: 'Summary',
    packages: [{ name: APP, bump: 'minor' }],
  })
  assert.deepEqual(parseNote('---\n"@magplay/playback": minor\n"@magplay/http-kit": patch\n---\n\nSeeking restarts conversion.\n', known), {
    bump: 'minor',
    summary: 'Seeking restarts conversion.',
    packages: [
      { name: '@magplay/playback', bump: 'minor' },
      { name: '@magplay/http-kit', bump: 'patch' },
    ],
  })
  assert.deepEqual(parseNote('---\n---\n', known), { bump: 'empty', summary: '', packages: [] })
  assert.match(noteProblems('Just text', known)[0] ?? '', /front matter/)
  assert.match(noteProblems('---\n"@magplay/nope": patch\n---\n\nInternal\n', known)[0] ?? '', /not a package/)
  assert.match(noteProblems(`---\n"${APP}": huge\n---\n\nx\n`, known)[0] ?? '', /not patch, minor or major/)
  assert.match(noteProblems(`---\n"${APP}": patch\n---\n`, known)[0] ?? '', /no summary/)
  assert.match(noteProblems('---\nnot a pair\n---\n\nx\n', known)[0] ?? '', /is not "package": bump/)
})

test('the highest bump wins, and empty notes do not raise the version', () => {
  const notes = [appNote('b', 'patch', 'Fix'), appNote('a', 'minor', 'Add'), appNote('c', 'empty', '')]
  assert.deepEqual(makePlan('0.1.0', notes).next, '0.2.0')
  assert.equal(makePlan('0.9.0', [appNote('a', 'patch', 'Fix')]).next, '0.9.1')
  assert.equal(makePlan('0.9.0', [appNote('a', 'minor', 'Add')]).next, '0.10.0')
  assert.equal(makePlan('0.1.0', [appNote('a', 'major', 'Break')]).next, '1.0.0')
  assert.equal(makePlan('0.1.0', [appNote('a', 'empty', '')]).next, null)
  assert.deepEqual(makePlan('0.1.0', notes).packages, [])
})

test('a release consumes notes, raises the version and writes the changelog section', () => {
  const root = fixture({
    'apps/server/package.json': `${JSON.stringify(SERVER, null, 2)}\n`,
    'package-lock.json': '{ "version": "0.1.0" }\n',
    '.changeset/README.md': '# notes\n',
    '.changeset/empty-weeks.md': '---\n---\n',
    '.changeset/seeding.md': `---\n"${APP}": minor\n---\n\nSharing keeps completed downloads available.\n`,
    '.changeset/seeking.md': `---\n"${APP}": patch\n---\n\nSeeking restarts conversion.\n`,
    'README.md': 'leave me\n',
  })
  try {
    const dry = applyRelease(root, { dryRun: true })
    assert.equal(dry.applied, false)
    assert.equal(dry.next, '0.2.0')
    assert.match(dry.notes, /Sharing keeps completed downloads available/)
    assert.equal(fs.readFileSync(path.join(root, 'apps/server/package.json'), 'utf8').includes('"version": "0.1.0"'), true)

    const applied = applyRelease(root)
    assert.equal(applied.applied, true)
    assert.equal(applied.bump, 'minor')
    assert.match(applied.notes, /### Minor\n\n- Sharing/)
    assert.match(applied.notes, /### Patch\n\n- Seeking/)
    assert.doesNotMatch(applied.notes, /empty/)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/server/package.json'), 'utf8')) as { version: string }
    assert.equal(manifest.version, '0.2.0')
    assert.equal(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), '{ "version": "0.1.0" }\n')
    assert.equal(fs.existsSync(path.join(root, '.changeset/seeding.md')), false)
    assert.equal(fs.existsSync(path.join(root, '.changeset/empty-weeks.md')), false)
    assert.equal(fs.existsSync(path.join(root, '.changeset/README.md')), true)
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'leave me\n')
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
    assert.equal(changelogEntry(changelog, '0.2.0'), applied.notes)
    assert.equal(applyRelease(root).applied, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('empty notes alone do not change the version or the changelog', () => {
  const root = fixture({
    'apps/server/package.json': `${JSON.stringify(SERVER, null, 2)}\n`,
    '.changeset/empty-weeks.md': '---\n---\n',
  })
  try {
    const result = applyRelease(root)
    assert.equal(result.applied, false)
    assert.equal(result.next, null)
    assert.equal(fs.existsSync(path.join(root, '.changeset/empty-weeks.md')), true)
    assert.equal(fs.existsSync(path.join(root, 'CHANGELOG.md')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a range adds a note; editing one that already exists does not count', () => {
  assert.equal(hasAddedNote([['M', 'apps/client/src/player.ts'], ['A', '.changeset/odd-owls-run.md']]), true)
  assert.equal(hasAddedNote([['M', 'apps/client/src/player.ts']]), false)
  assert.equal(hasAddedNote([['M', '.changeset/brave-cats-sing.md'], ['M', 'README.md']]), false)
  assert.equal(hasAddedNote([['A', '.changeset/README.md']]), false)
  assert.equal(hasAddedNote([['D', '.changeset/brave-cats-sing.md'], ['M', 'apps/server/package.json']]), false)
})

test('tag refuses a version with no changelog section, and does not move an existing tag', () => {
  const root = gitFixture({
    'apps/server/package.json': `${JSON.stringify(SERVER, null, 2)}\n`,
  })
  try {
    assert.deepEqual(tagRelease(root), { created: false, tag: null, title: null, notes: null, reason: 'no-changelog' })
    assert.equal(gitOk(root, ['tag', '--list']).trim(), '')

    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# magplay\n\n## 0.2.0\n\n### Patch\n\n- Seeking restarts conversion.\n')
    fs.writeFileSync(path.join(root, 'apps/server/package.json'), `${JSON.stringify({ ...SERVER, version: '0.2.0' }, null, 2)}\n`)
    gitOk(root, ['add', '-A'])
    gitOk(root, ['commit', '-m', 'release'])
    const created = tagRelease(root)
    assert.equal(created.created, true)
    assert.equal(created.tag, 'v0.2.0')
    assert.match(created.notes ?? '', /Seeking restarts conversion/)
    const again = tagRelease(root)
    assert.equal(again.created, false)
    assert.equal(again.reason, 'exists')
    assert.equal(gitOk(root, ['tag', '--list']).trim(), 'v0.2.0')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a package note bumps that package and the application, and the root changelog lists it once', () => {
  const playback = { name: '@magplay/playback', version: '0.0.0', private: true }
  const httpKit = { name: '@magplay/http-kit', version: '0.0.0', private: true }
  const root = fixture({
    'package.json': `${JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] })}\n`,
    'apps/server/package.json': `${JSON.stringify(SERVER, null, 2)}\n`,
    'packages/playback/package.json': `${JSON.stringify(playback, null, 2)}\n`,
    'packages/http-kit/package.json': `${JSON.stringify(httpKit, null, 2)}\n`,
    'package-lock.json': '{ "lock": true }\n',
    '.changeset/seeking.md': '---\n"@magplay/playback": minor\n"@magplay/http-kit": patch\n---\n\nSeeking restarts conversion.\n',
  })
  try {
    const applied = applyRelease(root)
    assert.equal(applied.next, '0.2.0')
    assert.match(applied.notes, /### Minor\n\n- `@magplay\/http-kit` 0\.0\.1, `@magplay\/playback` 0\.1\.0: Seeking restarts conversion\./)
    assert.doesNotMatch(applied.notes, /0\.1\.0: Seeking[\s\S]*Seeking/)
    const playbackLog = fs.readFileSync(path.join(root, 'packages/playback/CHANGELOG.md'), 'utf8')
    assert.match(playbackLog, /^# @magplay\/playback\n\n## 0\.1\.0\n\n### Minor\n\n- Seeking restarts conversion\.\n/)
    const httpLog = fs.readFileSync(path.join(root, 'packages/http-kit/CHANGELOG.md'), 'utf8')
    assert.match(httpLog, /## 0\.0\.1\n\n### Patch\n\n- Seeking restarts conversion\./)
    assert.equal(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), '{ "lock": true }\n')
    assert.equal(fs.existsSync(path.join(root, 'apps/server/CHANGELOG.md')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the workspaces and pending notes in this repository parse', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const workspaces = loadWorkspaces(root)
  assert.ok(workspaces.some(item => item.name === APP))
  assert.ok(workspaces.some(item => item.name === '@magplay/api-contract'))
  assert.deepEqual(loadNotes(root).problems, [])
})

test('status exits 2 when the range adds no note, and note writes a changeset', () => {
  const root = gitFixture({
    'apps/server/package.json': `${JSON.stringify(SERVER, null, 2)}\n`,
  })
  try {
    const missing = run(root, ['status', '--since', 'HEAD'])
    assert.equal(missing.status, 2)
    const wrote = run(root, ['note', '--patch', '-m', 'Seeking restarts conversion.'])
    assert.equal(wrote.status, 0)
    assert.match(wrote.stdout, /^\.changeset\/.+\.md\n$/)
    const written = parseNote(fs.readFileSync(path.join(root, wrote.stdout.trim()), 'utf8'), new Set([APP]))
    assert.equal('bump' in written ? written.bump : '', 'patch')
    gitOk(root, ['add', '-A'])
    gitOk(root, ['commit', '-m', 'note'])
    assert.equal(run(root, ['status', '--since', 'HEAD~1']).status, 0)
    assert.equal(writeNote(root, 'empty', '').startsWith('.changeset/'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('github output keeps a multiline pull request body in one value', () => {
  const text = formatGitHubOutput({ applied: true, body: 'First line.\n\n- Seeking restarts conversion.' })
  const delimiter = /^applied=true\nbody<<(\S+)\n/.exec(text)?.[1]
  assert.ok(delimiter)
  assert.ok(text.endsWith(`${delimiter}\n`))
  assert.match(text, /First line\.\n\n- Seeking restarts conversion\./)
})

test('version --github-output reports the pull request, or applied=false when nothing is pending', () => {
  const root = fixture({
    'apps/server/package.json': `${JSON.stringify(SERVER, null, 2)}\n`,
    '.changeset/seeking.md': `---\n"${APP}": patch\n---\n\nSeeking restarts conversion.\n`,
  })
  const output = path.join(root, 'github-output.txt')
  try {
    assert.equal(releasePullRequest(applyRelease(root, { dryRun: true })).title, 'Release 0.1.1')
    const applied = run(root, ['version', '--github-output'], { GITHUB_OUTPUT: output })
    assert.equal(applied.status, 0, applied.stderr)
    const text = fs.readFileSync(output, 'utf8')
    assert.match(text, /applied=true/)
    assert.match(text, /title=Release 0\.1\.1/)
    assert.match(text, /tags v0\.1\.1/)
    assert.match(text, /Seeking restarts conversion/)

    const nothing = path.join(root, 'nothing.txt')
    const again = run(root, ['version', '--github-output'], { GITHUB_OUTPUT: nothing })
    assert.equal(again.status, 0, again.stderr)
    assert.equal(fs.readFileSync(nothing, 'utf8'), 'applied=false\n')

    const missing = run(root, ['version', '--github-output'], { GITHUB_OUTPUT: '' })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /GITHUB_OUTPUT/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('tag --github-output hands the tag and its notes to the release step', () => {
  const root = gitFixture({
    'apps/server/package.json': `${JSON.stringify({ ...SERVER, version: '0.2.0' }, null, 2)}\n`,
    'CHANGELOG.md': '# magplay\n\n## 0.2.0\n\n### Patch\n\n- Seeking restarts conversion.\n',
  })
  try {
    const output = path.join(root, 'tag.txt')
    const tagged = run(root, ['tag', '--github-output'], { GITHUB_OUTPUT: output })
    assert.equal(tagged.status, 0, tagged.stderr)
    const text = fs.readFileSync(output, 'utf8')
    assert.match(text, /^created=true\ntag=v0\.2\.0\nnotes<</)
    assert.match(text, /### Patch\n\n- Seeking restarts conversion\./)

    const again = path.join(root, 'again.txt')
    assert.equal(run(root, ['tag', '--github-output'], { GITHUB_OUTPUT: again }).status, 0)
    assert.match(fs.readFileSync(again, 'utf8'), /^created=false\ntag=v0\.2\.0\n/)

    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# magplay\n')
    const none = path.join(root, 'none.txt')
    assert.equal(run(root, ['tag', '--github-output'], { GITHUB_OUTPUT: none }).status, 0)
    assert.equal(fs.readFileSync(none, 'utf8'), 'created=false\ntag=\nnotes=\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function appNote (id: string, bump: NoteBump, summary: string): Note {
  return { id, bump, summary, packages: bump === 'empty' ? [] : [{ name: APP, bump }] }
}

function noteProblems (text: string, known: ReadonlySet<string>): string[] {
  const parsed = parseNote(text, known)
  return 'problems' in parsed ? parsed.problems : []
}

function fixture (files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magplay-release-'))
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  return root
}

function gitFixture (files: Record<string, string>): string {
  const root = fixture(files)
  gitOk(root, ['init'])
  gitOk(root, ['config', 'user.email', 'release@example.com'])
  gitOk(root, ['config', 'user.name', 'Release'])
  gitOk(root, ['add', '-A'])
  gitOk(root, ['commit', '-m', 'init'])
  return root
}

function run (root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
}
