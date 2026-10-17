/** @typedef {{from: number, to: number, text: string}} SubtitleCue Times are seconds in the input WebVTT timeline, before any player offset. */

function timestamp (value) {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value)
  if (!match) return NaN
  const [, hours = '0', minutes, seconds, milliseconds] = match
  if (Number(minutes) >= 60 || Number(seconds) >= 60) return NaN
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) + Number(milliseconds) / 1000
}

/**
 * Read the cue subset emitted by ffmpeg's WebVTT conversion. Cue identifiers
 * and timing settings are accepted; NOTE/STYLE/REGION metadata is not cue text.
 * Keep payload markup/multiline text intact for VTTCue, trimming trailing space
 * as the player did before extraction. Malformed/incomplete timing is skipped.
 *
 * This is a snapshot parser, not a streaming decoder or full WebVTT renderer.
 * A final cue can have valid timing but incomplete text. The player still owns
 * withholding the last cue while an HLS subtitle file is growing, applying the
 * session offset, and adding/replacing cues after subsequent polls.
 *
 * @param {string} text
 * @returns {SubtitleCue[]}
 */
export function parseVtt (text) {
  const cues = []
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  for (const block of normalized.split(/\n\n+/)) {
    const lines = block.split('\n')
    if (/^(?:WEBVTT(?:[ \t]|$)|NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0])) continue
    const i = lines.findIndex(line => line.includes('-->'))
    if (i < 0) continue
    const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+.*)?$/.exec(lines[i].trim())
    if (!timing || lines[i].indexOf('-->') !== lines[i].lastIndexOf('-->')) continue
    const from = timestamp(timing[1])
    const to = timestamp(timing[2])
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
    cues.push({ from, to, text: lines.slice(i + 1).join('\n').trimEnd() })
  }
  return cues
}
