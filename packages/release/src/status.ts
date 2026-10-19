import { gitOk } from './git.ts'
import { isReleaseNote } from './notes.ts'

/** True when the range adds a note. Editing a note that is already on the base does not count. */
export function hasAddedNote (changes: Array<[string, string]>): boolean {
  return changes.some(([status, file]) => status === 'A' && isReleaseNote(file))
}

/** Name-status pairs between the merge base of `since` and the working tree. Untracked files are not included. */
export function changesSince (root: string, since: string): Array<[string, string]> {
  const fork = gitOk(root, ['merge-base', since, 'HEAD']).trim()
  const diff = gitOk(root, ['diff', '--name-status', '--no-renames', fork])
  const changes: Array<[string, string]> = []
  for (const line of diff.split('\n')) {
    if (!line) continue
    const [status, file] = line.split('\t')
    if (status && file) changes.push([status, file])
  }
  return changes
}
