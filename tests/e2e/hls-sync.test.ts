// Audio/video alignment of the HLS output the server's ffmpeg arguments produce, decoded the way browsers'
// MSE parsers do: edit lists ignored. hls.js never reads them and Chrome skips empty edits, so an offset
// that only exists in an edit list (the gap between the seek keyframe and the trimmed audio, the B-frame delay)
// plays as audio ahead of video. No browser is needed: the check is on the segments themselves.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ffmpegArgs } from '@magplay/playback'
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
