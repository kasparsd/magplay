/** Per-browser memory (last episode played…). Storage can be blocked, so failures are ignored. */
export function recall (key: string): unknown {
  try { return JSON.parse(localStorage.getItem(`magplay:${key}`) ?? 'null') } catch { return null }
}
export function remember (key: string, value: unknown): void {
  try { localStorage.setItem(`magplay:${key}`, JSON.stringify(value)) } catch {}
}
