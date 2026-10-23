// Audio/video alignment of the HLS output the server's ffmpeg arguments produce, decoded the way browsers'
// MSE parsers do: edit lists ignored. hls.js never reads them and Chrome skips empty edits, so an offset
// that only exists in an edit list (the gap between the seek keyframe and the trimmed audio, the B-frame delay)
// plays as audio ahead of video. No browser is needed: the check is on the segments themselves.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ffmpegArgs, keyframeIndex, TIMELINE_OFFSET } from '@magplay/playback'
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

const info = { startTime: 0, video: { codec: 'h264' }, audio: [{ index: 0, codec: 'ac3', channels: 2, language: null, title: null, default: true }], subtitles: [] }

/** Runs one HLS run's ffmpeg arguments from `start` and returns the fragmented MP4 it writes to fd 3. */
async function run (dir: string, input: string, start: number): Promise<Buffer> {
  const proc = spawn('ffmpeg', ffmpegArgs({ input, info, audio: 0, start, mode: 'remux', dir, transcodeMaxHeight: 720 }), { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  const chunks: Buffer[] = []
  proc.stdio[3]!.on('data', (chunk: Buffer) => chunks.push(chunk))
  let stderr = ''
  proc.stderr!.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise(resolve => proc.on('close', resolve))
  expect(code, stderr).toBe(0)
  return Buffer.concat(chunks)
}

/** Runs the server's remux arguments for `start` and returns the output as one fragmented MP4 file. */
async function remuxed (dir: string, input: string, start: number): Promise<{ file: string, init: Buffer }> {
  const media = await run(dir, input, start)
  const moof = media.indexOf('moof')
  expect(moof).toBeGreaterThan(0)
  const file = path.join(dir, `joined-${start}.mp4`)
  await fs.writeFile(file, media)
  return { file, init: media.subarray(0, moof - 4) }
}

/** When the picture first turns white and when the tone first starts, in the file's own timeline. */
async function markers (file: string): Promise<{ flash: number, beep: number }> {
  // -copyts reports the file's own timestamps rather than rebasing them to its first packet
  const ignoreEdits = ['-hide_banner', '-nostdin', '-copyts', ...(file.endsWith('.mp4') ? ['-ignore_editlist', '1'] : [])]
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
      // Every run keeps the file's own timeline (plus the fixed offset), wherever it starts
      expect(Math.abs(flash - (FLASH_AT + TIMELINE_OFFSET)), `start ${start}: flash at ${flash}`).toBeLessThan(0.1)
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

/** Timescale of the first track, which is the video (read from the stream's moov). */
function videoTimescale (init: Buffer): number {
  const moov = childBox(init, 0, init.length, 'moov')
  const trak = moov && childBox(init, moov.off + 8, moov.off + moov.size, 'trak')
  const mdia = trak && childBox(init, trak.off + 8, trak.off + trak.size, 'mdia')
  const mdhd = mdia && childBox(init, mdia.off + 8, mdia.off + mdia.size, 'mdhd')
  if (!mdhd) throw new Error('init segment has no video timescale')
  const version = init[mdhd.off + 8] ?? 0
  return init.readUInt32BE(mdhd.off + 8 + (version === 1 ? 20 : 12))
}

/** Presentation time of every video sample in the segment, in the track's timescale and decode order. */
function videoPts (seg: Buffer): number[] {
  const moof = childBox(seg, 0, seg.length, 'moof')
  const traf = moof && childBox(seg, moof.off + 8, moof.off + moof.size, 'traf')
  if (!traf) throw new Error('segment has no video fragment')
  let dts = 0
  const pts: number[] = []
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
      const count = seg.readUInt32BE(off + 12)
      let p = off + 16
      if (flags & 1) p += 4
      if (flags & 4) p += 4
      for (let i = 0; i < count; i++) {
        let duration = 0
        let cts = 0
        if (flags & 0x100) { duration = seg.readUInt32BE(p); p += 4 }
        if (flags & 0x200) p += 4
        if (flags & 0x400) p += 4
        if (flags & 0x800) { cts = version === 1 ? seg.readInt32BE(p) : seg.readUInt32BE(p); p += 4 }
        pts.push(dts + cts)
        dts += duration
      }
    }
    off += size
  }
  return pts
}

/** Each top-level moof (with what follows it) of a fragmented MP4 stream. */
function moofs (media: Buffer): Buffer[] {
  const found: Buffer[] = []
  for (let off = 0; off + 8 <= media.length;) {
    const size = media.readUInt32BE(off)
    if (size < 8) break
    if (media.toString('latin1', off + 4, off + 8) === 'moof') found.push(media.subarray(off))
    off += size
  }
  return found
}

/** Every video packet's presentation time in the source, as ffprobe reports it. */
async function sourcePts (file: string): Promise<number[]> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file])
  return stdout.split('\n').filter(line => line.trim()).map(line => Number(line.replace(',', '')))
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
    // Keyframes are every 2 s, and the file's own index says so
    const handle = await fs.open(source)
    const { size } = await handle.stat()
    const keyframes = await keyframeIndex(async (from, to) => {
      const bytes = Buffer.alloc(Math.max(0, Math.min(to, size) - from))
      await handle.read(bytes, 0, bytes.length, from)
      return bytes
    }, size)
    await handle.close()
    expect(keyframes?.slice(0, 7)).toEqual([0, 2, 4, 6, 8, 10, 12])
    const media = await run(dir, source, 0)
    const timescale = videoTimescale(media)
    const fragments = moofs(media)
    expect(fragments.length).toBeGreaterThan(2)
    // The DASH index used to move a later segment's opening sample onto a time the stream already presents,
    // so Chrome dropped one of the two frames. The remux must keep every source frame at its own time: the
    // same frame count, and one constant shift between source and output (ffmpeg versions place the whole
    // stream a frame or two differently, which is harmless because audio moves with it; the alignment test
    // above covers that). An open GOP's leading pictures legitimately present before the segment's keyframe.
    const frames = (await sourcePts(source)).sort((a, b) => a - b)
    const output = fragments.flatMap(f => videoPts(f).map(pts => pts / timescale)).sort((a, b) => a - b)
    expect(output.length, 'the remux has a different number of frames than the source').toBe(frames.length)
    const shift = (output[0] ?? 0) - (frames[0] ?? 0)
    expect(Math.abs(shift - TIMELINE_OFFSET)).toBeLessThan(0.1)
    output.forEach((pts, i) => {
      expect(Math.abs(pts - shift - (frames[i] ?? NaN)), `frame ${i} presents at ${pts.toFixed(3)} s, expected ${((frames[i] ?? NaN) + shift).toFixed(3)} s`).toBeLessThan(0.002)
    })
    // A run restarted at the 12 s boundary (warming up from the keyframe before it) presents the same frames at
    // the same times from there on, so segments from the two runs join without a gap or a jump
    const restarted = (await run(dir, source, 10.15)).subarray(0)
    const later = moofs(restarted).flatMap(f => videoPts(f).map(pts => pts / timescale)).filter(t => t >= 12 + TIMELINE_OFFSET - 0.001).sort((a, b) => a - b)
    const same = output.filter(t => t >= 12 + TIMELINE_OFFSET - 0.001)
    expect(later.length).toBe(same.length)
    later.forEach((pts, i) => expect(Math.abs(pts - (same[i] ?? NaN)), `restarted frame ${i}`).toBeLessThan(0.002))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
