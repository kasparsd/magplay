import type { SettingPresentation, SettingRule } from '@magplay/api-contract'

/** The same rules apply to page settings and sibling fields inside a list item. */
export function presentSetting<T extends { rules?: readonly SettingRule[] }> (def: T, read: (key: string) => unknown): T & SettingPresentation {
  const result: T & SettingPresentation = { ...def }
  for (const { when, ...overrides } of def.rules ?? []) {
    if (read(when.key) === when.equals) Object.assign(result, overrides)
  }
  return result
}
