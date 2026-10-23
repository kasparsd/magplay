import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'

const exec = promisify(execFile)

/** Generate original, tiny media; shared by browser, Docker and peer tests. */
export async function generateMedia (dir) {
  await fs.mkdir(dir, { recursive: true })
  const srt = path.join(dir, 'Playback.S01E02.srt')
  await fs.writeFile(srt, '1\n00:00:01,000 --> 00:00:08,000\nFirst subtitle\n\n2\n00:00:30,000 --> 00:00:40,000\nMiddle subtitle\n\n3\n00:01:10,000 --> 00:01:20,000\nLast subtitle\n\n')
  const direct = path.join(dir, 'Playback.S01E01.mp4')
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35',
    '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-movflags', '+faststart', direct], { timeout: 60_000 })
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', direct, '-i', srt, '-map', '0:v', '-map', '0:a', '-map', '0:a', '-map', '1:s',
    '-c:v', 'copy', '-c:a:0', 'ac3', '-c:a:1', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=lav', '-metadata:s:s:0', 'language=eng',
    path.join(dir, 'Playback.S01E02.mkv')], { timeout: 60_000 })
  await fs.copyFile(direct, path.join(dir, 'Playback.S01E03.mp4'))
  // A 2.39:1 "scope" file, for layouts that are width-bound rather than height-bound
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=478x200:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35',
    '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-movflags', '+faststart', path.join(dir, 'Playback.S01E04.mp4')], { timeout: 60_000 })
  // Ten minutes with B-frames and AC-3: long enough that conversion pauses well before the end, so a seek there
  // restarts ffmpeg
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', '600', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '96', '-crf', '40',
    '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '64k', path.join(dir, 'Playback.S02E01.mkv')], { timeout: 120_000 })
  // MPEG-TS has no keyframe index: it plays from a playlist that grows from the start
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', path.join(dir, 'Playback.S01E02.mkv'), '-t', '30', '-map', '0:v', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts',
    path.join(dir, 'Playback.S02E02.ts')], { timeout: 60_000 })
}

export async function prepareCachedMedia (dir) {
  const media = path.join(dir, 'media')
  await generateMedia(media)
  const torrent = await new Promise((resolve, reject) => createTorrent(media, {
    name: 'Playback fixtures', private: true, announceList: [], creationDate: 0,
  }, (err, data) => err ? reject(err) : resolve(data)))
  const parsed = await parseTorrent(torrent)
  const cache = path.join(dir, 'cache')
  const torrentDir = path.join(cache, 'torrents', parsed.infoHash)
  await fs.mkdir(torrentDir, { recursive: true })
  await fs.writeFile(path.join(torrentDir, 'meta.torrent'), torrent)
  await fs.cp(media, path.join(torrentDir, parsed.name), { recursive: true })
  return {
    media,
    cache,
    ih: parsed.infoHash,
    length: parsed.length,
    torrent,
    files: Object.fromEntries(parsed.files.map((f, idx) => [path.basename(f.path), idx]))
  }
}
