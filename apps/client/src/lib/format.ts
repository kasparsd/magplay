// Formatting shared by every page. No DOM, so modules tested under Node can use it.

export const formatBytes = (n: number | null | undefined): string => n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
export const formatSpeed = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB/s` : `${Math.round(n / 1e3)} KB/s`
export function formatClock (seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds || 0))
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(sec).padStart(2, '0')
}
export const episodeLabel = (f: { season?: number | null, episode?: number | null }): string => f.episode == null ? '' : `S${String(f.season ?? 0).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`
