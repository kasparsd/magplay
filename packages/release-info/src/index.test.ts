import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badges, contentWarning, detectEpisode, listFiles } from './index.ts'
import type { Episode } from './index.ts'

test('episode patterns', () => {
  const cases: Array<[string, Episode]> = [
    ['Show/Show.S01E02.720p.mkv', { season: 1, episode: 2 }],
    ['show.s1e2.mkv', { season: 1, episode: 2 }],
    ['Show 1x02 Title.mkv', { season: 1, episode: 2 }],
    ['Show.S01.E02.mkv', { season: 1, episode: 2 }],
    ['Show Season 2/Episode 5.mkv', { season: 2, episode: 5 }],
    ['Show/Ep03.mkv', { season: null, episode: 3 }],
    ['Movie.1920x1080.x264.mkv', { season: null, episode: null }],
  ]
  for (const [path, expected] of cases) assert.deepEqual(detectEpisode(path), expected, path)
  assert.deepEqual(detectEpisode('Pack/Ep03.mkv', 'Show.S04.COMPLETE'), { season: 4, episode: 3 })
})

test('file list: samples, extras and small files are not videos; episodes sorted', () => {
  const MB = 1024 ** 2
  const torrent = {
    name: 'Show.S01',
    files: [
      { path: 'Show.S01/Show.S01E02.mkv', name: 'Show.S01E02.mkv', length: 500 * MB },
      { path: 'Show.S01/Show.S01E01.mkv', name: 'Show.S01E01.mkv', length: 500 * MB },
      { path: 'Show.S01/Sample/show.sample.mkv', name: 'show.sample.mkv', length: 150 * MB },
      { path: 'Show.S01/Extras/Featurette.mkv', name: 'Featurette.mkv', length: 300 * MB },
      { path: 'Show.S01/Show.S01E01.eng.srt', name: 'Show.S01E01.eng.srt', length: 50_000 },
      { path: 'Show.S01/tiny.mp4', name: 'tiny.mp4', length: 20 * MB },
    ],
  }
  const files = listFiles(torrent)
  assert.deepEqual(files.filter(f => f.isVideo).map(f => f.idx), [1, 0])
  assert.deepEqual(files.filter(f => f.isSub).map(f => f.name), ['Show.S01E01.eng.srt'])
})

test('title badges and the Firefox hint', () => {
  assert.deepEqual(badges('Big Buck Bunny.S01.720p.BluRay.x264-OpenContent'), { badges: ['720p', 'H.264', 'AAC', 'BluRay'], likelyDirect: true, warning: null })
  assert.equal(badges('Show.S01.1080p.WEB-DL.DDP5.1.H.264').likelyDirect, false)
  assert.equal(badges('Show.1080p.x265.10bit.AAC').likelyDirect, false)
  assert.deepEqual(badges('Movie.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.Atmos').badges, ['2160p', 'HEVC', 'HDR', 'TrueHD', 'Atmos', 'Remux'])
})

test('a program file is flagged and is never a video', () => {
  const files = listFiles({
    name: 'Movie 2026.1080p. HD h264- OpenContent.exe',
    files: [
      { path: 'Movie 2026.1080p. HD h264- OpenContent.exe', name: 'Movie 2026.1080p. HD h264- OpenContent.exe', length: 1_458_371_843 },
    ],
  })
  assert.equal(files[0]?.isVideo, false)
  assert.equal(files[0]?.isProgram, true)
})

test('older containers count as video', () => {
  for (const ext of ['ogv', 'ogm', 'wmv', 'asf', 'flv', 'mpg', 'mpeg', 'vob', 'm2ts', 'mts', 'divx', 'rm', 'rmvb', '3gp']) {
    assert.equal(listFiles({ name: 'Film', files: [{ path: `Film/Film.${ext}`, name: `Film.${ext}`, length: 1 }] })[0]?.isVideo, true, ext)
  }
  assert.equal(listFiles({ name: 'Album', files: [{ path: 'Album/song.ogg', name: 'song.ogg', length: 1 }] })[0]?.isVideo, false)
})

test('small videos count when nothing big exists; extras count when nothing else does', () => {
  const MB = 1024 ** 2
  const trailer = listFiles({ name: 'Big Buck Bunny trailer', files: [{ path: 'Big Buck Bunny trailer.mp4', name: 'Big Buck Bunny trailer.mp4', length: 5 * MB }] })
  assert.equal(trailer[0]?.isVideo, true)
  const shortFilm = listFiles({
    name: 'Short',
    files: [
      { path: 'Short/short.mkv', name: 'short.mkv', length: 60 * MB },
      { path: 'Short/Sample/sample.mkv', name: 'sample.mkv', length: 5 * MB },
    ],
  })
  assert.deepEqual(shortFilm.filter(f => f.isVideo).map(f => f.name), ['short.mkv'])
})

test('titles of programs and archives get a note instead of the Firefox hint', () => {
  const exe = badges('You Can See Everything 2026.1080p. HD h264- OpenContent.exe')
  assert.equal(exe.likelyDirect, false)
  assert.equal(exe.warning, 'Download (.exe)')
  assert.equal(badges('Movie.2020.1080p.x264.rar').warning, 'Download archive (.rar)')
  assert.equal(badges('Big Buck Bunny.S01.720p.BluRay.x264-OpenContent').warning, null)
})

test('content note from the file list', () => {
  const v = { name: 'Movie.mkv', isVideo: true, isProgram: false }
  const exe = { name: 'dir/Movie.1080p.exe', isVideo: false, isProgram: true }
  assert.equal(contentWarning([exe]), 'Download only · no video files')
  assert.equal(contentWarning([v, exe]), null)
})

test('OpenContent releases count as H.264 with AAC', () => {
  assert.deepEqual(badges('It Was Just An Accident (2025) [1080p] [WEBRip] [5.1] [OpenContent]'), { badges: ['1080p', 'H.264', 'AAC', 'WEBRip'], likelyDirect: true, warning: null })
  assert.equal(badges('Movie.2020.1080p.BluRay.x265-OpenContent').badges.includes('HEVC'), true) // an explicit codec wins
})

test('audio, books and disk images remain downloadable without claiming browser video playback', () => {
  const files = listFiles({
    name: 'Downloads',
    files: ['song.flac', 'guide.pdf', 'linux.iso'].map(name => ({ name, path: `Downloads/${name}`, length: 1000 })),
  })
  assert.equal(files.length, 3)
  assert.equal(files.some(f => f.isVideo), false)
  assert.equal(contentWarning(files), 'Download only · no video files')
  assert.equal(badges('linux.iso').warning, 'Download archive (.iso)')
  assert.equal(badges('linux.iso').likelyDirect, false)
})
