// Runs magplay's own ffmpeg arguments (packages/playback/src/media.ts) against the ffmpeg inside an image, over a
// matrix of containers and codecs, and checks what comes out. The `magplay` image's ffmpeg is built from source with
// a named list of components (Dockerfile, `ffmpeg` stage); a codec or container missing from that list shows up here.
//
//   docker build --target full -t magplay:local .
//   node tools/scripts/check-ffmpeg.mjs [magplay:local]
//
// With REFERENCE=<image> (any image with `sh` and an ffmpeg of the same version, such as `alpine:3.24` plus
// `apk add ffmpeg`), every run also executes there and its output must be byte-identical.
//
// The fixtures are made by an ffmpeg on the host (`FFMPEG`, default `ffmpeg`) with libx264, libx265, libvpx-vp9,
// libsvtav1, libopus, libmp3lame, ac3, eac3, dca and truehd. A fixture whose encoder the host lacks is skipped and
// listed, so a green run on a thin host covers less; the summary says how many cases ran.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { encoderProbeArgs, ffmpegArgs, parseEncoders, subtitleToVtt } from '../../packages/playback/src/media.ts'

const exec = promisify(execFile)
const image = process.argv[2] ?? 'magplay:local'
const reference = process.env.REFERENCE
const generator = process.env.FFMPEG ?? 'ffmpeg'
const probeTool = process.env.FFPROBE ?? 'ffprobe'
// Mounted at the same path inside the container, so one path names a file on both sides.
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-ffmpeg-')))
const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : []
const docker = (extra, command, args, img = image) => exec('docker', ['run', '--rm', '--add-host=host.docker.internal:host-gateway', ...user, '-v', `${dir}:${dir}`, ...extra, '--entrypoint', command, img, ...args], { maxBuffer: 64 * 1024 ** 2, timeout: 300_000 })
// subtitleToVtt() takes a path to an ffmpeg, so give it one that runs in the container.
const wrapper = path.join(dir, 'ffmpeg-in-container')
await fs.writeFile(wrapper, `#!/bin/sh\nexec docker run --rm -i ${user.join(' ')} -v "${dir}:${dir}" --entrypoint ffmpeg ${image} "$@"\n`, { mode: 0o755 })

const results = []
const skipped = []
const check = async (name, fn) => {
  try { await fn(); results.push(name); console.log(`ok   ${name}`) } catch (err) { results.push(null); console.error(`FAIL ${name}\n     ${String(err.message ?? err).split('\n').slice(0, 6).join('\n     ')}`) }
}

// --- fixtures ---------------------------------------------------------------------------------------------------
await fs.writeFile(path.join(dir, 'en.srt'), '1\n00:00:00,500 --> 00:00:01,500\nHello <i>there</i>\n\n2\n00:00:01,800 --> 00:00:02,800\nSecond line\n')
await fs.writeFile(path.join(dir, 'en.ass'), '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,Styled {\\b1}line{\\b0}\n')
await fs.writeFile(path.join(dir, 'en.vtt'), 'WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nFrom WebVTT\n')
const subtitleInputs = ['-i', path.join(dir, 'en.srt'), '-i', path.join(dir, 'en.ass')]
const sources = ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=48000']
const surround = ['-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=48000', '-filter_complex', '[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]']
// video/audio are what the output must hold for a remux: the source's video codec, and AAC (copied or encoded).
// `transcodeOnly`: the codec has no MP4 tag, so decide() never remuxes it. `copyFailsWithoutAdtsFilter`: ADTS AAC copied
// into MP4 needs `-bsf:a aac_adtstoasc`, which the arguments don't pass, so every run that copies the audio fails
// with the same message on Alpine's ffmpeg too. That is a gap in the app's arguments, not in the build; the case
// asserts the failure so that fixing the arguments turns it into a pass to update.
const fixtures = [
  { name: 'mkv-h264-ac3-subs', file: 'a.mkv', video: 'h264', audio: 'ac3', subs: 2, args: [...sources, ...subtitleInputs, '-map', '0:v', '-map', '1:a', '-map', '2', '-map', '3', '-c:v', 'libx264', '-g', '24', '-c:a', 'ac3', '-c:s:0', 'srt', '-c:s:1', 'ass'] },
  { name: 'mkv-h264-aac', file: 'b.mkv', video: 'h264', audio: 'aac', args: [...sources, '-c:v', 'libx264', '-g', '24', '-c:a', 'aac'] },
  { name: 'mp4-hevc-eac3', file: 'c.mp4', video: 'hevc', audio: 'eac3', args: [...sources, '-c:v', 'libx265', '-tag:v', 'hvc1', '-g', '24', '-c:a', 'eac3'] },
  { name: 'webm-vp9-opus', file: 'd.webm', video: 'vp9', audio: 'opus', args: [...sources, '-c:v', 'libvpx-vp9', '-g', '24', '-deadline', 'realtime', '-c:a', 'libopus'] },
  { name: 'mkv-av1-opus', file: 'e.mkv', video: 'av1', audio: 'opus', args: [...sources, '-c:v', 'libsvtav1', '-g', '24', '-c:a', 'libopus'] },
  { name: 'avi-mpeg4-mp3', file: 'f.avi', video: 'mpeg4', audio: 'mp3', args: [...sources, '-c:v', 'mpeg4', '-g', '24', '-c:a', 'libmp3lame'] },
  { name: 'ts-mpeg2-ac3', file: 'g.ts', video: 'mpeg2video', audio: 'ac3', args: [...sources, '-c:v', 'mpeg2video', '-g', '12', '-c:a', 'ac3'] },
  { name: 'ts-h264-aac-adts', file: 'h.ts', video: 'h264', audio: 'aac', copyFailsWithoutAdtsFilter: true, args: [...sources, '-c:v', 'libx264', '-g', '24', '-c:a', 'aac'] },
  { name: 'mkv-h264-dts', file: 'i.mkv', video: 'h264', audio: 'dts', args: [...sources, '-c:v', 'libx264', '-g', '24', '-c:a', 'dca', '-strict', '-2', '-b:a', '768k'] },
  { name: 'mkv-h264-truehd', file: 'j.mkv', video: 'h264', audio: 'truehd', args: [...sources, '-c:v', 'libx264', '-g', '24', '-c:a', 'truehd', '-strict', '-2'] },
  { name: 'mkv-h264-flac', file: 'k.mkv', video: 'h264', audio: 'flac', args: [...sources, '-c:v', 'libx264', '-g', '24', '-c:a', 'flac'] },
  { name: 'mp4-h264-aac-movtext', file: 'l.mp4', video: 'h264', audio: 'aac', subs: 1, args: [...sources, '-i', path.join(dir, 'en.srt'), '-map', '0:v', '-map', '1:a', '-map', '2', '-c:v', 'libx264', '-g', '24', '-c:a', 'aac', '-c:s', 'mov_text'] },
  { name: 'asf-wmv2-wmav2', file: 'm.wmv', video: 'wmv2', audio: 'wmav2', transcodeOnly: true, args: [...sources, '-c:v', 'wmv2', '-g', '24', '-c:a', 'wmav2'] },
  { name: 'flv-h264-aac', file: 'n.flv', video: 'h264', audio: 'aac', args: [...sources, '-c:v', 'libx264', '-g', '24', '-c:a', 'aac'] },
  { name: 'mkv-h264-ac3-5.1', file: 'o.mkv', video: 'h264', audio: 'ac3', channels: 6, args: ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=3', ...surround, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-g', '24', '-c:a', 'ac3'] },
]
const made = []
for (const fixture of fixtures) {
  try {
    await exec(generator, ['-y', '-v', 'error', ...fixture.args, path.join(dir, fixture.file)], { timeout: 120_000 })
    made.push(fixture)
  } catch (err) { skipped.push(`${fixture.name}: ${String(err.stderr ?? err.message).trim().split('\n').pop()}`) }
}

// --- helpers ----------------------------------------------------------------------------------------------------
const probe = async file => JSON.parse((await exec(probeTool, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,channels,nb_read_frames', '-of', 'json', file])).stdout).streams
const infoFor = fixture => ({
  audio: [{ codec: fixture.audio }],
  subtitles: Array.from({ length: fixture.subs ?? 0 }, (_, index) => ({ index, text: true })),
  startTime: 0,
  video: { codec: fixture.video },
})
let runs = 0
// Each run gets a new directory, as each HLS run does: ffmpeg won't overwrite a sub_N.vtt that is already there.
const play = async (fixture, { mode, start = 0, input = path.join(dir, fixture.file), encoder }) => {
  const out = path.join(dir, `out-${++runs}-${fixture.name}-${mode}-${start}`)
  await fs.mkdir(out, { recursive: true })
  const args = ffmpegArgs({ input, info: infoFor(fixture), audio: 0, start, mode, dir: out, transcodeMaxHeight: 120, ...(encoder ? { transcodeEncoder: encoder } : {}) })
  await docker(['-e', `FF_OUT=${out}/out.mp4`], 'sh', ['-c', 'exec ffmpeg "$@" 3>"$FF_OUT"', 'sh', ...args])
  if (reference) {
    const same = path.join(dir, `ref-${runs}`)
    await fs.mkdir(same, { recursive: true })
    const refArgs = args.map(arg => arg.split(out).join(same))
    await docker(['-e', `FF_OUT=${same}/out.mp4`], 'sh', ['-c', 'exec ffmpeg "$@" 3>"$FF_OUT"', 'sh', ...refArgs], reference)
    for (const name of await fs.readdir(out)) assert.deepEqual(await fs.readFile(path.join(out, name)), await fs.readFile(path.join(same, name)), `${name} differs from the reference`)
  }
  return { out, streams: await probe(path.join(out, 'out.mp4')) }
}

// --- the matrix -------------------------------------------------------------------------------------------------
const failsOnAdts = async (fixture, options) => assert.rejects(play(fixture, options), /aac_adtstoasc/)
for (const fixture of made) {
  if (fixture.copyFailsWithoutAdtsFilter) {
    await check(`${fixture.name}: audio copy fails as it does with Alpine's ffmpeg (no aac_adtstoasc in the arguments)`, async () => {
      await failsOnAdts(fixture, { mode: 'remux' })
      await failsOnAdts(fixture, { mode: 'transcode', encoder: 'libx264' })
    })
    continue
  }
  if (!fixture.transcodeOnly) {
    await check(`${fixture.name}: remux to fragmented MP4 with AAC`, async () => {
      const { streams } = await play(fixture, { mode: 'remux' })
      const video = streams.find(s => s.codec_type === 'video')
      const audio = streams.find(s => s.codec_type === 'audio')
      assert.equal(video?.codec_name, fixture.video, 'video is copied')
      assert.equal(Number(video?.nb_read_frames), 72, `video frames: ${video?.nb_read_frames}`)
      assert.equal(audio?.codec_name, 'aac')
      // Copied AAC keeps its layout (the sine source is mono); anything else is converted with -ac 2.
      assert.equal(audio?.channels, fixture.audio === 'aac' ? 1 : 2)
      assert.ok(Number(audio?.nb_read_frames) > 0, 'audio frames')
    })
    // The fixtures are 3 s long with few cues, so the seek may land anywhere from the start to the keyframe at 1 s.
    await check(`${fixture.name}: remux from t=1s`, async () => {
      const { streams } = await play(fixture, { mode: 'remux', start: 1 })
      const frames = Number(streams.find(s => s.codec_type === 'video')?.nb_read_frames)
      assert.ok(frames >= 24 && frames <= 72, `video frames: ${frames}`)
      assert.equal(streams.find(s => s.codec_type === 'audio')?.codec_name, 'aac')
    })
  }
  await check(`${fixture.name}: transcode to 120p H.264 with libx264`, async () => {
    const { streams } = await play(fixture, { mode: 'transcode', encoder: 'libx264' })
    const video = streams.find(s => s.codec_type === 'video')
    assert.equal(video?.codec_name, 'h264')
    assert.equal(video?.height, 120)
    assert.ok(Number(video?.nb_read_frames) >= 60, `video frames: ${video?.nb_read_frames}`)
    assert.equal(streams.find(s => s.codec_type === 'audio')?.codec_name, 'aac')
  })
  if (fixture.subs) {
    await check(`${fixture.name}: embedded subtitles to WebVTT, in the run and standalone`, async () => {
      const { out } = await play(fixture, { mode: 'remux' })
      for (let i = 0; i < fixture.subs; i++) assert.match(await fs.readFile(path.join(out, `sub_${i}.vtt`), 'utf8'), /^WEBVTT[\s\S]*-->/, `sub_${i}.vtt`)
      assert.match(await subtitleToVtt(path.join(dir, fixture.file), 0, { ffmpegPath: wrapper }), /^WEBVTT[\s\S]*-->/)
    })
  }
}

await check('standalone .srt, .ass and .vtt files convert to WebVTT', async () => {
  for (const [file, text] of [['en.srt', /Hello/], ['en.ass', /Styled/], ['en.vtt', /From WebVTT/]]) {
    const vtt = await subtitleToVtt(path.join(dir, file), null, { ffmpegPath: wrapper })
    assert.match(vtt, /^WEBVTT/, file)
    assert.match(vtt, text, file)
  }
})

const served = made.find(f => f.name === 'mkv-h264-ac3-subs')
if (served) {
  await check('HTTP input with range requests, as the app reads /raw', async () => {
    const file = path.join(dir, served.file)
    const size = (await fs.stat(file)).size
    const server = http.createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
      const start = m ? Number(m[1]) : 0
      const end = m?.[2] ? Number(m[2]) : size - 1
      res.writeHead(m ? 206 : 200, { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska', 'Content-Length': end - start + 1, ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) })
      createReadStream(file, { start, end }).pipe(res)
    })
    await new Promise(resolve => server.listen(0, resolve))
    try {
      const { streams } = await play(served, { mode: 'remux', start: 1, input: `http://host.docker.internal:${server.address().port}/raw/x/0` })
      assert.equal(streams.find(s => s.codec_type === 'video')?.codec_name, 'h264')
    } finally { server.close() }
  })
}

await check('encoder detection: libx264 and the hardware H.264 encoders are listed, an absent device fails cleanly', async () => {
  const listed = parseEncoders((await docker([], 'ffmpeg', ['-hide_banner', '-encoders'])).stdout)
  for (const encoder of ['libx264', 'h264_vaapi']) assert.ok(listed.includes(encoder), `${encoder} in ${listed.join(', ')}`)
  assert.ok(!listed.includes('h264_nvenc'), 'NVENC is not built')
  const probeFailure = await docker([], 'ffmpeg', encoderProbeArgs('h264_vaapi', '/dev/dri/none')).then(() => null, err => String(err.stderr))
  assert.ok(probeFailure, 'no VAAPI device here, so the probe must fail')
  assert.doesNotMatch(probeFailure, /Unknown encoder|not found|No such filter|Unknown input format|Unknown decoder/i)
})

await check('ffmpeg -version runs and names the build', async () => {
  assert.match((await docker([], 'ffmpeg', ['-version'])).stdout, /^ffmpeg version \d/)
})

await fs.rm(dir, { recursive: true, force: true })
const ran = results.filter(r => r !== null).length
console.log(`\n${ran}/${results.length} checks passed on ${image}; ${made.length}/${fixtures.length} fixtures generated`)
for (const line of skipped) console.log(`skipped ${line}`)
process.exit(ran === results.length ? 0 : 1)
