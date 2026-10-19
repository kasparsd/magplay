import type { Bump } from './notes.ts'

export function bumpVersion (version: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  const major = match?.[1]
  const minor = match?.[2]
  const patch = match?.[3]
  if (major === undefined || minor === undefined || patch === undefined) throw new Error(`version ${version} is not x.y.z`)
  if (bump === 'major') return `${Number(major) + 1}.0.0`
  if (bump === 'minor') return `${major}.${Number(minor) + 1}.0`
  return `${major}.${minor}.${Number(patch) + 1}`
}
