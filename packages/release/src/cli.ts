#!/usr/bin/env node
// Commands for local use and for the release workflows.
//   note --patch|--minor|--major|--empty -m "summary"
//   status [--since <ref>] [--json]
//   version [--dry-run] [--json] [--github-output]
//   tag [--push] [--json] [--github-output]
// The CLI runs git only. GitHub itself (pull requests, releases, dispatch) is
// the workflow's job, fed by --github-output.
import { fileURLToPath } from 'node:url'
import { applyRelease, formatApply, releasePullRequest } from './apply.ts'
import { writeGitHubOutput } from './github.ts'
import { findRoot, loadNotes, loadWorkspaces, type NoteBump, readAppVersion, writeNote } from './notes.ts'
import { formatPlan, makePlan, type Plan } from './plan.ts'
import { changesSince, hasAddedNote } from './status.ts'
import { formatTag, tagRelease } from './tag.ts'

class ReleaseExit extends Error {
  readonly code: number
  constructor (code: number, message: string) {
    super(message)
    this.name = 'ReleaseExit'
    this.code = code
  }
}

function main (): void {
  const args = parseArgs(process.argv.slice(2))
  const json = args.flags.get('json') === true
  const root = findRoot(process.cwd())
  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return
    case 'note':
      process.stdout.write(`${writeNote(root, noteBump(args.flags), noteSummary(args.flags), notePackages(args))}\n`)
      return
    case 'status':
      writeStatus(root, flagString(args.flags, 'since'), json)
      return
    case 'version':
      writeVersion(root, args.flags.get('dry-run') === true, json, args.flags.get('github-output') === true)
      return
    case 'tag':
      writeTag(root, args.flags.get('push') === true, json, args.flags.get('github-output') === true)
      return
    default:
      throw new Error(`Unknown command "${args.command}".\n\n${HELP}`)
  }
}

function writeStatus (root: string, since: string | undefined, json: boolean): void {
  const loaded = loadNotes(root)
  if (loaded.problems.length) {
    throw new Error(`Release notes (docs/releases.md):\n${loaded.problems.map(problem => `- ${problem}`).join('\n')}`)
  }
  const plan = makePlan(readAppVersion(root), loaded.notes, loadWorkspaces(root))
  const added = since === undefined ? null : hasAddedNote(changesSince(root, since))
  process.stdout.write(json ? `${JSON.stringify(statusJson(plan, added), null, 2)}\n` : formatPlan(plan))
  if (added === false) {
    throw new ReleaseExit(2, 'Add a release note: npm run release -- note --patch -m "..." (or --empty when users see no change).')
  }
}

function statusJson (plan: Plan, added: boolean | null) {
  return { current: plan.current, next: plan.next, bump: plan.bump, notes: plan.notes, added }
}

function writeVersion (root: string, dryRun: boolean, json: boolean, githubOutput: boolean): void {
  const result = applyRelease(root, { dryRun })
  if (githubOutput) {
    writeGitHubOutput(result.applied ? { applied: true, ...releasePullRequest(result) } : { applied: false })
  }
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatApply(result))
}

function writeTag (root: string, push: boolean, json: boolean, githubOutput: boolean): void {
  const result = tagRelease(root, { push })
  if (githubOutput) {
    writeGitHubOutput({ created: result.created, tag: result.tag ?? '', notes: result.notes ?? '' })
  }
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatTag(result))
}

function notePackages (args: Args): string[] {
  if (args.flags.get('empty') === true) {
    if (args.packages.length) throw new Error('An empty note names no package.')
    return []
  }
  return args.packages
}

function noteBump (flags: Map<string, string | true>): NoteBump {
  const chosen = (['major', 'minor', 'patch', 'empty'] as const).filter(name => flags.get(name) === true)
  if (chosen.length !== 1) throw new Error('Pass one of --major, --minor, --patch or --empty.')
  const bump = chosen[0]
  if (bump === undefined) throw new Error('Pass one of --major, --minor, --patch or --empty.')
  return bump
}

function noteSummary (flags: Map<string, string | true>): string {
  const message = flags.get('message')
  if (flags.get('empty') === true) {
    if (typeof message === 'string') throw new Error('An empty note has no summary.')
    return ''
  }
  if (typeof message !== 'string' || !message.trim()) throw new Error('Pass the summary with -m "...".')
  return message
}

function flagString (flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name)
  if (value === undefined) return undefined
  if (value === true) throw new Error(`--${name} needs a value.`)
  return value
}

interface Args {
  command: string
  flags: Map<string, string | true>
  packages: string[]
  positionals: string[]
}

function parseArgs (argv: string[]): Args {
  const [command = 'help', ...rest] = argv
  const flags = new Map<string, string | true>()
  const packages: string[] = []
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? ''
    if (arg === '--') {
      positionals.push(...rest.slice(i + 1))
      break
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    const raw = arg === '-m' ? 'message' : arg.replace(/^--/, '')
    const eq = raw.indexOf('=')
    const name = eq >= 0 ? raw.slice(0, eq) : raw
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined
    if (name === 'package') {
      const value = inline ?? rest[i + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--package needs a value.')
      packages.push(value)
      if (inline === undefined) i++
      continue
    }
    if (inline !== undefined) {
      flags.set(name, inline)
      continue
    }
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(name, next)
      i++
      continue
    }
    flags.set(name, true)
  }
  return { command, flags, packages, positionals }
}

const HELP = `Release notes, the application version and the changelog.

  note --patch|--minor|--major|--empty [--package <name>]... -m "what changed"
  status [--since <ref>]     pending notes; exit 2 when --since added none
  version [--dry-run]        write versions and changelogs, and delete the notes
  tag [--push]               tag v<version> when the changelog has that version

--json prints the result as JSON. --github-output writes step outputs:
version sets applied, title and body; tag sets created, tag and notes.
`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message) console.error(message)
    process.exit(error instanceof ReleaseExit ? error.code : 1)
  }
}
