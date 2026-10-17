import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tarLayout, tarBytes, safePath } from './tar.js'
import { rangeFor, attachment } from './range.js'

// Over 100 bytes in total (so the ustar name field can't hold it) but each part under Linux's 255-byte limit
const longName = `${'Очень длинная папка/'.repeat(4)}Очень длинное название фильма (2026) 1080p.mkv`
const files = [
  { path: 'Show.S01/Show.S01E01.mkv', data: Buffer.alloc(1000, 1) },
  { path: `Show.S01/Extras/${longName}`, data: Buffer.alloc(512, 2) },
  { path: 'Show.S01/empty.nfo', data: Buffer.alloc(0) },
  { path: 'Show.S01/../../escape.txt', data: Buffer.from('should land inside the archive root\n') },
  { path: 'Show.S01/one-byte.txt', data: Buffer.from('x') },
]
const layout = tarLayout(files.map(f => ({ path: f.path, length: f.data.length })), 1_700_000_000)
// Mimics the torrent reader: yields the requested bytes in uneven chunks
async function * readFile (i, start, end) {
  const bytes = files[i].data.subarray(start, end + 1)
  for (let at = 0; at < bytes.length; at += 300) yield bytes.subarray(at, at + 300)
}
async function collect (start, end) {
  const parts = []
  for await (const chunk of tarBytes(layout, start, end, readFile)) parts.push(chunk)
  return Buffer.concat(parts)
}

test('layout: 512-byte blocks and the size the stream actually produces', async () => {
  assert.equal(layout.size % 512, 0)
  assert.equal((await collect(0, layout.size - 1)).length, layout.size)
})

test('extracts with the system tar: same paths and contents, no path escapes', async t => {
  if (spawnSync('tar', ['--version']).status !== 0) return t.skip('no tar on this system')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magplay-tar-'))
  try {
    fs.writeFileSync(path.join(dir, 'archive.tar'), await collect(0, layout.size - 1))
    const out = path.join(dir, 'out')
    fs.mkdirSync(out)
    const run = spawnSync('tar', ['-xf', path.join(dir, 'archive.tar'), '-C', out], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    for (const f of files) {
      assert.deepEqual(fs.readFileSync(path.join(out, safePath(f.path))), f.data, f.path)
    }
    assert.ok(fs.existsSync(path.join(out, 'Show.S01/escape.txt')))
    assert.ok(!fs.existsSync(path.join(dir, 'escape.txt')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('any split into two ranges joins back into the whole archive (resumable)', async () => {
  const whole = await collect(0, layout.size - 1)
  for (const cut of [0, 1, 511, 512, 513, 1023, 1500, 2047, 2048, layout.size - 2]) {
    const joined = Buffer.concat([await collect(0, cut), await collect(cut + 1, layout.size - 1)])
    assert.deepEqual(joined, whole, `cut at ${cut}`)
  }
  assert.deepEqual(await collect(100, 99), Buffer.alloc(0))
})

test('safe paths', () => {
  assert.equal(safePath('a/../../b/./c'), 'a/b/c')
  assert.equal(safePath('/etc/passwd'), 'etc/passwd')
  assert.equal(safePath('..'), 'file')
})

test('range requests', () => {
  const etag = '"abc-tar"'
  assert.deepEqual(rangeFor({}, 1000, etag), { start: 0, end: 999, partial: false })
  assert.deepEqual(rangeFor({ range: 'bytes=0-0' }, 1000, etag), { start: 0, end: 0, partial: true })
  assert.deepEqual(rangeFor({ range: 'bytes=500-' }, 1000, etag), { start: 500, end: 999, partial: true })
  assert.deepEqual(rangeFor({ range: 'bytes=-100' }, 1000, etag), { start: 900, end: 999, partial: true })
  assert.deepEqual(rangeFor({ range: 'bytes=900-5000' }, 1000, etag), { start: 900, end: 999, partial: true })
  assert.equal(rangeFor({ range: 'bytes=1000-' }, 1000, etag), null)
  assert.deepEqual(rangeFor({ range: 'bytes=0-1,5-6' }, 1000, etag), { start: 0, end: 999, partial: false }) // multipart: send it all
  // Resuming with a matching validator gets the range; a stale one gets the whole thing again
  assert.deepEqual(rangeFor({ range: 'bytes=500-', 'if-range': etag }, 1000, etag), { start: 500, end: 999, partial: true })
  assert.deepEqual(rangeFor({ range: 'bytes=500-', 'if-range': '"other"' }, 1000, etag), { start: 0, end: 999, partial: false })
})

test('download file names', () => {
  assert.equal(attachment('Show.S01E01.mkv'), 'attachment; filename="Show.S01E01.mkv"; filename*=UTF-8\'\'Show.S01E01.mkv')
  assert.equal(attachment('Фильм "1".tar'), 'attachment; filename="_____ _1_.tar"; filename*=UTF-8\'\'%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC%20%221%22.tar')
})
