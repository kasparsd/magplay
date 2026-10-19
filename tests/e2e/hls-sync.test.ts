// Audio/video alignment of the HLS output the server's ffmpeg arguments produce, decoded the way browsers'
// MSE parsers do: edit lists ignored. hls.js never reads them and Chrome skips empty edits, so an offset
// that only exists in an edit list (the gap between the seek keyframe and the trimmed audio, the B-frame delay)
// plays as audio ahead of video. No browser is needed: the check is on the segments themselves.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ffmpegArgs, keyframeBefore } from '@magplay/playback'
import { test, expect } from './fixtures.js'

const exec = promisify(execFile)
const FLASH_AT = 11 // the picture turns white and a tone starts at this second of the source; keyframes are 2 s apart

/** A short MKV like a real release: H.264 with B-frames (so pts ≠ dts) and AC3 audio, silent and dark except for one marked second. */
async function markerSource (dir: string): Promise<string> {
  const file = path.join(dir, 'marker.mkv')
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    '-t', '20',
    '-vf', `drawbox=enable='between(t,${FLASH_AT},${FLASH_AT + 1})':color=white:t=fill`,
    '-af', `volume=enable='lt(t,${FLASH_AT})+gte(t,${FLASH_AT + 1})':volume=0`,
    '-c:v', 'libx264', '-preset', 'medium', '-bf', '3', '-g', '48', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', '-b:a', '192k', file], { timeout: 60_000 })
  return file
}

/** Runs the server's remux arguments for `start` and returns init + segments as one fragmented MP4. */
async function remuxed (dir: string, input: string, start: number): Promise<{ file: string, init: Buffer }> {
  const out = path.join(dir, `hls-${start}`)
  await fs.mkdir(out)
  const info = { video: { codec: 'h264' }, audio: [{ index: 0, codec: 'ac3', channels: 2, language: null, title: null, default: true }], subtitles: [] }
  await exec('ffmpeg', ffmpegArgs({ input, info, audio: 0, start, mode: 'remux', dir: out, transcodeMaxHeight: 720 }), { timeout: 60_000 })
  const segments = (await fs.readdir(out)).filter(name => name.endsWith('.m4s')).sort()
  expect(segments.length).toBeGreaterThan(0)
  const init = await fs.readFile(path.join(out, 'init.mp4'))
  const file = path.join(dir, `joined-${start}.mp4`)
  await fs.writeFile(file, Buffer.concat([init, ...await Promise.all(segments.map(name => fs.readFile(path.join(out, name))))]))
  return { file, init }
}

/** When the picture first turns white and when the tone first starts, in the file's own timeline. */
async function markers (file: string): Promise<{ flash: number, beep: number }> {
  const ignoreEdits = ['-hide_banner', '-nostdin', ...(file.endsWith('.mp4') ? ['-ignore_editlist', '1'] : [])]
  const video = await exec('ffmpeg', [...ignoreEdits, '-i', file, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'])
  let at = NaN
  let flash = NaN
  for (const line of video.stdout.split('\n')) {
    const time = /pts_time:([\d.]+)/.exec(line)
    if (time) at = Number(time[1])
    const luma = /YAVG=([\d.]+)/.exec(line)
    if (luma && Number(luma[1]) > 200) { flash = at; break }
  }
  const audio = await exec('ffmpeg', [...ignoreEdits, '-i', file, '-vn', '-af', 'silencedetect=noise=-30dB:d=0.05', '-f', 'null', '-'])
  const beep = Number(/silence_end: ([\d.]+)/.exec(audio.stderr)?.[1])
  expect(Number.isFinite(flash) && Number.isFinite(beep), `markers in ${path.basename(file)}: flash ${flash}, beep ${beep}`).toBeTruthy()
  return { flash, beep }
}

test('HLS remux keeps audio and video aligned without edit lists, from the start and after a resume', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-sync-'))
  try {
    const source = await markerSource(dir)
    const reference = await markers(source)
    expect(Math.abs(reference.flash - reference.beep)).toBeLessThan(0.05) // the detector's own onset latency
    // Resume half a second after a keyframe, where converted audio used to be trimmed to `start` while copied
    // video began at the keyframe; and a fresh start, where only the B-frame delay was in the edit list
    for (const start of [FLASH_AT - 0.5, 0]) {
      const { file, init } = await remuxed(dir, source, start)
      const { flash, beep } = await markers(file)
      expect(Math.abs(flash - beep), `start ${start}: audio leads video by ${(flash - beep).toFixed(3)} s (flash at ${flash}, beep at ${beep})`).toBeLessThan(0.05)
      expect(init.includes('elst'), `start ${start}: init.mp4 relies on an edit list`).toBe(false)
      // The session begins where the seek landed, so the markers are near the start of a resumed timeline
      if (start) expect(flash).toBeLessThan(2)
      else expect(flash).toBeGreaterThan(FLASH_AT - 0.1)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** Direct child box of this range, not nested ones. */
function childBox (buf: Buffer, start: number, end: number, type: string): { off: number, size: number } | null {
  for (let off = start; off + 8 <= end;) {
    let size = buf.readUInt32BE(off)
    const kind = buf.toString('latin1', off + 4, off + 8)
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8))
    if (size < 8 || off + size > end) return null
    if (kind === type) return { off, size }
    off += size
  }
  return null
}

/** Timescale of the first track, which is the video. */
function videoTimescale (init: Buffer): number {
  const moov = childBox(init, 0, init.length, 'moov')
  const trak = moov && childBox(init, moov.off + 8, moov.off + moov.size, 'trak')
  const mdia = trak && childBox(init, trak.off + 8, trak.off + trak.size, 'mdia')
  const mdhd = mdia && childBox(init, mdia.off + 8, mdia.off + mdia.size, 'mdhd')
  if (!mdhd) throw new Error('init segment has no video timescale')
  const version = init[mdhd.off + 8] ?? 0
  return init.readUInt32BE(mdhd.off + 8 + (version === 1 ? 20 : 12))
}

/** Presentation time of the first video sample, in the track's timescale. */
function firstVideoPts (seg: Buffer): number {
  const moof = childBox(seg, 0, seg.length, 'moof')
  const traf = moof && childBox(seg, moof.off + 8, moof.off + moof.size, 'traf')
  if (!traf) throw new Error('segment has no video fragment')
  let dts = 0
  let cts = 0
  for (let off = traf.off + 8; off + 8 <= traf.off + traf.size;) {
    let size = seg.readUInt32BE(off)
    const kind = seg.toString('latin1', off + 4, off + 8)
    if (size === 1) size = Number(seg.readBigUInt64BE(off + 8))
    if (size < 8) break
    if (kind === 'tfdt') {
      const version = seg[off + 8] ?? 0
      dts = version === 1 ? Number(seg.readBigUInt64BE(off + 12)) : seg.readUInt32BE(off + 12)
    }
    if (kind === 'trun') {
      const version = seg[off + 8] ?? 0
      const flags = seg.readUInt32BE(off + 8) & 0xffffff
      let p = off + 16
      if (flags & 1) p += 4
      if (flags & 4) p += 4
      if (flags & 0x100) p += 4
      if (flags & 0x200) p += 4
      if (flags & 0x400) p += 4
      if (flags & 0x800) cts = version === 1 ? seg.readInt32BE(p) : seg.readUInt32BE(p)
    }
    off += size
  }
  return dts + cts
}

test('an open GOP keeps each segment\'s opening frame, and a resume begins at the preceding keyframe', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-opengop-'))
  try {
    const source = path.join(dir, 'open.mkv')
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '20', '-c:v', 'libx264', '-preset', 'medium', '-bf', '3', '-x264-params', 'open-gop=1',
      '-g', '48', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '192k', source], { timeout: 60_000 })
    // Keyframes are every 2 s. 11.4 s can only start at 10; 12 s is itself a keyframe.
    expect(await keyframeBefore(source, 11.4)).toBe(10)
    expect(await keyframeBefore(source, 12)).toBe(12)
    expect(await keyframeBefore(source, 0)).toBe(0)
    const out = path.join(dir, 'hls')
    await fs.mkdir(out)
    const info = { video: { codec: 'h264' }, audio: [{ index: 0, codec: 'ac3', channels: 2, language: null, title: null, default: true }], subtitles: [] }
    await exec('ffmpeg', ffmpegArgs({ input: source, info, audio: 0, start: 0, mode: 'remux', dir: out, transcodeMaxHeight: 720 }), { timeout: 60_000 })
    const timescale = videoTimescale(await fs.readFile(path.join(out, 'init.mp4')))
    const playlist = await fs.readFile(path.join(out, 'index.m3u8'), 'utf8')
    let boundary = 0
    let segments = 0
    for (const match of playlist.matchAll(/#EXTINF:([\d.]+),[^\n]*\r?\n(seg_\d+\.m4s)/g)) {
      const first = firstVideoPts(await fs.readFile(path.join(out, match[2] ?? ''))) / timescale
      expect(first, `segment ${segments} opens at ${first.toFixed(3)} s, before its boundary ${boundary}`).toBeGreaterThanOrEqual(boundary - 0.001)
      boundary += Number(match[1])
      segments++
    }
    expect(segments).toBeGreaterThan(2)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
