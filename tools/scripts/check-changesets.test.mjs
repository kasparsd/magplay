import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APP, branchProblems, configProblems, noteProblems } from './check-changesets.mjs'

test('a note names the app with a bump and a summary; an empty note is valid', () => {
  assert.deepEqual(noteProblems(`---\n"${APP}": patch\n---\n\nSeeking past the converted part restarts conversion.\n`), [])
  assert.deepEqual(noteProblems(`---\n'${APP}': minor\n---\nSummary\n`), [])
  assert.deepEqual(noteProblems('---\n---\n'), [])
  assert.match(noteProblems('Just text')[0], /front matter/)
  assert.match(noteProblems('---\n"@magplay/playback": patch\n---\n\nInternal\n')[0], /not released on its own/)
  assert.match(noteProblems(`---\n"${APP}": huge\n---\n\nx\n`)[0], /not patch, minor or major/)
  assert.match(noteProblems(`---\n"${APP}": patch\n---\n\n`)[0], /no summary/)
  assert.match(noteProblems('---\nnot a pair\n---\n\nx\n')[0], /is not "package": bump/)
})

test('the configuration versions only the app, and every workspace stays private', () => {
  const config = { ignore: ['@magplay/a'], privatePackages: { version: true, tag: false }, fixed: [], linked: [] }
  const workspaces = [{ name: APP, private: true }, { name: '@magplay/a', private: true }]
  assert.deepEqual(configProblems(config, workspaces), [])
  assert.match(configProblems(config, [...workspaces, { name: '@magplay/new', private: true }])[0], /add to "ignore".*@magplay\/new/)
  assert.match(configProblems({ ...config, ignore: ['@magplay/a', '@magplay/gone'] }, workspaces)[0], /remove from "ignore".*@magplay\/gone/)
  assert.match(configProblems(config, [workspaces[0], { name: '@magplay/a', private: false }])[0], /must stay private/)
  assert.match(configProblems({ ...config, privatePackages: { version: true, tag: true } }, workspaces)[0], /privatePackages/)
})

const release = { baseVersion: '0.1.0', version: '0.2.0', lockVersion: '0.2.0' }
const releaseChanges = [['D', '.changeset/brave-cats-sing.md'], ['M', 'apps/server/package.json'], ['A', 'apps/server/CHANGELOG.md'], ['M', 'package-lock.json']]

test('a branch adds a note; notes already on the base do not count', () => {
  assert.deepEqual(branchProblems({ ...release, changes: [['M', 'apps/client/src/player.js'], ['A', '.changeset/odd-owls-run.md']] }), [])
  assert.match(branchProblems({ ...release, changes: [['M', 'apps/client/src/player.js']] })[0], /add a release note/)
  // Editing a note that is already on the base is not a new one
  assert.match(branchProblems({ ...release, changes: [['M', '.changeset/brave-cats-sing.md'], ['M', 'README.md']] })[0], /add a release note/)
  assert.match(branchProblems({ ...release, changes: [['A', '.changeset/README.md']] })[0], /add a release note/)
})

test('a release consumes notes, raises the version and updates only the changelog and lockfile', () => {
  assert.deepEqual(branchProblems({ ...release, changes: releaseChanges }), [])
  assert.match(branchProblems({ ...release, changes: [...releaseChanges, ['M', 'apps/server/src/app.ts']] }).join(), /also changed: apps\/server\/src\/app.ts/)
  assert.match(branchProblems({ ...release, version: '0.1.0', lockVersion: '0.1.0', changes: releaseChanges }).join(), /raises the version/)
  assert.match(branchProblems({ ...release, lockVersion: '0.1.0', changes: releaseChanges }).join(), /package-lock.json has/)
  assert.match(branchProblems({ ...release, changes: releaseChanges.filter(([, f]) => !f.endsWith('CHANGELOG.md')) }).join(), /CHANGELOG/)
  assert.deepEqual(branchProblems({ baseVersion: '0.9.0', version: '0.10.0', lockVersion: '0.10.0', changes: releaseChanges }), [])
})
