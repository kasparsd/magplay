import { execFile } from 'node:child_process'
import config, { httpError } from './config.js'
import { createLimiter } from './limits.js'

const runProbeJob = createLimiter(config.maxProbes, 'Media probing')
const runSubtitleJob = createLimiter(config.maxSubtitleJobs, 'Subtitle conversion')

export const rawUrl = (ih, idx) => `http://127.0.0.1:${config.port}/raw/${ih}/${idx}`

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'])
const VIDEO_KEYS = { h264: 'h264', hevc: 'hevc', vp9: 'vp9', av1: 'av1' }
const AUDIO_KEYS = { aac: 'aac', ac3: 'ac3', eac3: 'eac3', opus: 'opus', flac: 'flac' }
const VIDEO_NAMES = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1' }

const probes = new Map() // "ih/idx" -> Promise<summary>

/** ffprobe summary of a torrent file, read through /raw. Cached per file. */
export function probe (ih, idx, fileName) {
  const key = `${ih}/${idx}`
  if (!probes.has(key)) {
    const p = runProbeJob(() => runProbe(ih, idx, fileName))
    p.catch(() => probes.delete(key))
    probes.set(key, p)
  }
  return probes.get(key)
}

function runProbe (ih, idx, fileName) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', rawUrl(ih, idx)]
  return new Promise((resolve, reject) => {
    execFile(config.ffprobePath, args, { timeout: 120_000, maxBuffer: 16 * 1024 ** 2 }, (err, stdout, stderr) => {
      if (err) return reject(httpError(502, `ffprobe failed: ${err.killed ? 'timed out waiting for data' : stderr.trim().split('\n').pop()}`))
      let data
      try { data = JSON.parse(stdout) } catch { return reject(httpError(502, 'ffprobe returned invalid JSON')) }
      if (!data || typeof data !== 'object' || (data.streams !== undefined && !Array.isArray(data.streams))) {
        return reject(httpError(502, 'ffprobe returned an invalid media summary'))
      }
      const { format = {}, streams = [] } = data
      const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
      const lang = s => s.tags?.language && s.tags.language !== 'und' ? s.tags.language : null
      resolve({
        duration: Number(format.duration) || Number(v?.duration) || null,
        container: format.format_name,
        isWebm: /\.webm$/i.test(fileName),
        video: v && {
          codec: v.codec_name,
          tag: v.codec_tag_string,
          profile: v.profile ?? null,
          width: v.width,
          height: v.height,
          bitDepth: Number(v.bits_per_raw_sample) || (/1[02]le|p010/.test(v.pix_fmt) ? 10 : 8),
        },
        audio: streams.filter(s => s.codec_type === 'audio').map((s, i) => ({
          index: i, codec: s.codec_name, channels: s.channels, language: lang(s), title: s.tags?.title ?? null, default: !!s.disposition?.default,
        })),
        subtitles: streams.filter(s => s.codec_type === 'subtitle').map((s, i) => ({
          index: i, codec: s.codec_name, language: lang(s), title: s.tags?.title ?? null, text: TEXT_SUBS.has(s.codec_name),
        })),
      })
    })
  })
}

/**
 * Picks direct play, remux or transcode for this browser.
 * @returns {{mode: 'direct'|'remux'|'transcode', reason: string}}
 */
export function decide (info, caps, audio) {
  const v = info.video
  if (!v) throw httpError(422, 'No video stream found in this file.')
  if (!Number.isInteger(audio) || audio < 0 || (info.audio.length && !info.audio[audio])) {
    throw httpError(400, 'No such audio track')
  }
  const a = info.audio[audio]
  const vKey = VIDEO_KEYS[v.codec]
  const vName = (VIDEO_NAMES[v.codec] || v.codec.toUpperCase()) + (v.bitDepth > 8 ? ` ${v.bitDepth}-bit` : '')
  // Browsers don't decode 10-bit H.264 (Hi10P)
  const videoOk = !!(vKey && caps[vKey] && !(vKey === 'h264' && v.bitDepth > 8))
  const audioOk = !a || !!caps[AUDIO_KEYS[a.codec]]
  const container = info.isWebm ? 'webm' : /mp4|mov/.test(info.container) ? 'mp4' : null
  const containerOk = container === 'webm'
    ? ['vp9', 'av1'].includes(vKey) && (!a || ['opus', 'vorbis'].includes(a.codec))
    : container === 'mp4' && ['h264', 'hevc', 'av1'].includes(vKey) && !(vKey === 'hevc' && v.tag === 'hev1')

  if (videoOk && audioOk && containerOk && (audio === 0 || info.audio.length <= 1)) {
    return { mode: 'direct', reason: `${vName}${a ? ' + ' + a.codec : ''} in ${container} plays natively` }
  }
  if (videoOk) {
    const why = [!containerOk && `repackaging ${info.container.split(',')[0]}`, a && a.codec !== 'aac' && `converting ${a.codec} audio to AAC`]
    return { mode: 'remux', reason: `copying ${vName} video; ${why.filter(Boolean).join(', ') || 'switching audio track'}` }
  }
  if (config.allowTranscode) {
    return { mode: 'transcode', reason: `this browser can't play ${vName}; re-encoding to H.264 ${config.transcodeMaxHeight}p (slow on this server)` }
  }
  const safari = vKey === 'hevc' && v.bitDepth <= 10 ? ', open it in Safari,' : ''
  throw httpError(422, `This file is ${vName}. This browser can't play it and this server is too slow to convert it. Open it in an external player (VLC, IINA, Infuse…)${safari} or choose an x264 release.`)
}

/** ffmpeg arguments for an HLS session starting at `start` seconds, plus WebVTT outputs for text subtitles. */
export function ffmpegArgs ({ ih, idx, info, audio, start, mode, dir }) {
  const a = info.audio[audio]
  const video = mode === 'transcode'
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-vf', `scale=-2:'min(${config.transcodeMaxHeight},ih)'`, '-g', '48', '-keyint_min', '48', '-sc_threshold', '0']
    : ['-c:v', 'copy', ...(info.video.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
  const audioArgs = !a ? [] : a.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '192k']
  const subs = info.subtitles.filter(s => s.text).flatMap(s =>
    ['-map', `0:s:${s.index}`, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', `${dir}/sub_${s.index}.vtt`])
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1',
    // FLV can't seek even to 0 and would skip to the next keyframe
    ...(start ? ['-ss', String(start)] : []), '-i', rawUrl(ih, idx),
    '-map', '0:v:0', ...(a ? ['-map', `0:a:${audio}`] : []),
    ...video, ...audioArgs,
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', `${dir}/seg_%05d.m4s`, `${dir}/index.m3u8`,
    ...subs,
  ]
}

/** Converts a subtitle track (embedded stream N, or a whole .srt/.vtt/.ass file when track is null) to WebVTT. */
export function subtitleToVtt (ih, idx, track) {
  const map = track === null ? ['-map', '0:s:0'] : ['-map', `0:s:${track}`]
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', rawUrl(ih, idx), ...map, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1']
  return runSubtitleJob(() => new Promise((resolve, reject) => {
    execFile(config.ffmpegPath, args, { timeout: 600_000, maxBuffer: 32 * 1024 ** 2 }, (err, stdout, stderr) =>
      err ? reject(httpError(502, `Subtitle conversion failed: ${stderr.trim().split('\n').pop() || err.message}`)) : resolve(stdout))
  }))
}
