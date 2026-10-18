// Create the repo tag and GitHub release for the version Changesets already calculated.
// It does not publish an npm package. The container tag is applied by the release workflow.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

if (process.env.GITHUB_ACTIONS !== 'true') {
  console.log('release:publish runs in GitHub Actions after the version pull request merges.')
  process.exit(0)
}

const { version } = JSON.parse(readFileSync('apps/server/package.json', 'utf8'))
const tag = `v${version}`
const notes = changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)
if (!notes) {
  console.log(`${version} has no changelog entry, so it is not published.`)
  process.exit(0)
}
const remote = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' })
if (remote.trim()) {
  console.log(`${tag} already exists.`)
  process.exit(0)
}
execFileSync('gh', ['release', 'create', tag, '--title', tag, '--notes', notes], { stdio: 'inherit' })
writeFileSync('.release-version', `${version}\n`)
console.log(`Published ${tag}`)

function changelogSection (changelog, version) {
  const lines = changelog.split('\n')
  const start = lines.findIndex(line => line === `## ${version}`)
  if (start === -1) return ''
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start, next === -1 ? undefined : next).join('\n').trim()
}
