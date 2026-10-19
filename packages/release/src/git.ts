import { execFileSync } from 'node:child_process'

/** Run git in a repository. A non-zero exit is returned; a failure to spawn is thrown. */
export function git (root: string, args: string[]): { status: number, stdout: string, stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failed = error as { status?: unknown, stdout?: unknown, stderr?: unknown, code?: unknown }
    if (typeof failed.status !== 'number') {
      throw new Error(`git ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      status: failed.status,
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
    }
  }
}

export function gitOk (root: string, args: string[]): string {
  const result = git(root, args)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`)
  }
  return result.stdout
}
