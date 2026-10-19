#!/usr/bin/env node
// Commands for local use and for the release workflows.
//   note --patch|--minor|--major|--empty -m "summary"
//   status [--since <ref>] [--json]
//   version [--dry-run] [--json]
//   tag [--push] [--json]
import { fileURLToPath } from 'node:url'
import { applyRelease, formatApply, type ApplyResult } from './apply.ts'
import { findRoot, loadNotes, type NoteBump, readAppVersion, writeNote } from './notes.ts'
import { formatPlan, makePlan, type Plan } from './plan.ts'
import { changesSince, hasAddedNote } from './status.ts'
import { formatTag, tagRelease, type TagResult } from './tag.ts'

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
      process.stdout.write(`${writeNote(root, noteBump(args.flags), noteSummary(args.flags))}\n`)
      return
    case 'status':
      writeStatus(root, flagString(args.flags, 'since'), json)
      return
    case 'version':
      writeVersion(applyRelease(root, { dryRun: args.flags.get('dry-run') === true }), json)
      return
    case 'tag':
      writeTag(tagRelease(root, { push: args.flags.get('push') === true }), json)
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
  const plan = makePlan(readAppVersion(root), loaded.notes)
  const added = since === undefined ? null : hasAddedNote(changesSince(root, since))
  process.stdout.write(json ? `${JSON.stringify(statusJson(plan, added), null, 2)}\n` : formatPlan(plan))
  if (added === false) {
    throw new ReleaseExit(2, 'Add a release note: npm run release -- note --patch -m "..." (or --empty when users see no change).')
  }
}

function statusJson (plan: Plan, added: boolean | null) {
  return { current: plan.current, next: plan.next, bump: plan.bump, notes: plan.notes, added }
}

function writeVersion (result: ApplyResult, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatApply(result))
}

function writeTag (result: TagResult, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatTag(result))
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
  positionals: string[]
}

function parseArgs (argv: string[]): Args {
  const [command = 'help', ...rest] = argv
  const flags = new Map<string, string | true>()
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
    if (eq >= 0) {
      flags.set(raw.slice(0, eq), raw.slice(eq + 1))
      continue
    }
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(raw, next)
      i++
      continue
    }
    flags.set(raw, true)
  }
  return { command, flags, positionals }
}

const HELP = `Release notes, the application version and the changelog.

  note --patch|--minor|--major|--empty -m "what changed"
  status [--since <ref>]     pending notes; exit 2 when --since added none
  version [--dry-run]        write the version and CHANGELOG.md, and delete the notes
  tag [--push]               tag v<version> when the changelog has that version

--json prints the result as JSON. A push to main opens the release pull request;
merging release/next tags the version.
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
