// SubRip and WebVTT subtitle files as WebVTT, in Node: the common external subtitle formats need no ffmpeg.

/** Whether a subtitle file name is one this module converts. */
export const isTextSubtitleFile = (name: string): boolean => /\.(srt|vtt)$/i.test(name)

const strip = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

/** SubRip text as WebVTT: timestamps use dots, cue numbers go, and the few tags browsers render stay. */
export function srtToVtt (text: string): string {
  const cues = strip(text).trim().split(/\n{2,}/).flatMap(block => {
    const lines = block.split('\n')
    const at = lines.findIndex(line => /-->/.test(line))
    if (at < 0) return []
    const timing = lines[at]!.replace(/(\d+):(\d+):(\d+)[,.](\d+)/g, (_, h: string, m: string, s: string, ms: string) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0').slice(0, 3)}`)
      .replace(/\s*-->\s*/, ' --> ')
    const body = lines.slice(at + 1).join('\n').replace(/\{\\[^}]*\}/g, '') // ASS-style override tags in SRT are noise
    return body.trim() ? [`${timing}\n${body}`] : []
  })
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/** A subtitle file's text as WebVTT; WebVTT passes through (normalized line ends), SubRip is converted. */
export function subtitleFileToVtt (text: string): string {
  const normalized = strip(text)
  if (/^WEBVTT/.test(normalized.trimStart())) return normalized
  return srtToVtt(normalized)
}
