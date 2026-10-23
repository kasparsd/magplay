import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ebmlHeader, keyframeIndex } from './keyframes.ts'
import type { ReadRange } from './keyframes.ts'
import { box, full, u32 } from './test-helpers.ts'

// ---- Matroska builders ----

function vint (n: number): number[] {
  for (let length = 1; length <= 8; length++) {
    if (n < 2 ** (7 * length) - 1) {
      const out: number[] = []
      for (let i = length - 1; i >= 0; i--) out.push(Math.floor(n / 256 ** i) % 256)
      out[0]! |= 0x80 >> (length - 1)
      return out
    }
  }
  throw new Error('too large')
}
const idBytes = (id: number): number[] => { const out: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256); return out }
const el = (id: number, ...body: number[][]): number[] => { const data = body.flat(); return [...idBytes(id), ...vint(data.length), ...data] }
const uintEl = (id: number, value: number, width = 4): number[] => el(id, Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** (width - 1 - i)) % 256))

const EBML = el(0x1a45dfa3, el(0x4282, [...'matroska'].map(c => c.charCodeAt(0))))
const info = (scale: number): number[] => el(0x1549a966, uintEl(0x2ad7b1, scale))
const tracks = el(0x1654ae6b,
  el(0xae, uintEl(0xd7, 1, 1), uintEl(0x83, 2, 1)), // audio, track 1
  el(0xae, uintEl(0xd7, 2, 1), uintEl(0x83, 1, 1))) // video, track 2
const cuePoint = (time: number, track: number): number[] => el(0xbb, uintEl(0xb3, time), el(0xb7, uintEl(0xf7, track, 1), uintEl(0xf1, 0)))
const cues = (points: Array<[number, number]>): number[] => el(0x1c53bb6b, ...points.map(([t, track]) => cuePoint(t, track)))
const seek = (id: number, position: number): number[] => el(0x4dbb, el(0x53ab, idBytes(id)), uintEl(0x53ac, position, 8))
const cluster = (bytes: number): number[] => el(0x1f43b675, new Array<number>(bytes).fill(0))

/** A Segment whose children are laid out in order; `seekHead` gets the Segment-relative offsets of the named children. */
function segment (parts: Array<[name: string, bytes: number[]]>, seekTo: Array<[number, string]>): Uint8Array {
  // The SeekHead has a fixed size (8-byte positions), so offsets can be computed with a placeholder first
  const layout = (head: number[]): Map<string, number> => {
    const offsets = new Map<string, number>()
    let at = head.length
    for (const [name, bytes] of parts) { offsets.set(name, at); at += bytes.length }
    return offsets
  }
  const seekHead = (offsets: Map<string, number>): number[] => el(0x114d9b74, ...seekTo.map(([id, name]) => seek(id, offsets.get(name) ?? 0)))
  const head = seekHead(layout(seekHead(new Map())))
  const body = [...head, ...parts.flatMap(([, bytes]) => bytes)]
  return Uint8Array.from([...EBML, ...el(0x18538067, body)])
}

const reader = (bytes: Uint8Array, reads: Array<[number, number]> = []): ReadRange => (start, end) => {
  reads.push([start, end])
  return Promise.resolve(bytes.subarray(start, Math.min(end, bytes.length)))
}

test('ebmlHeader reads IDs with their marker and sizes without it, and marks unknown sizes', () => {
  assert.deepEqual(ebmlHeader(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x84]), 0), { id: 0x1a45dfa3, data: 5, size: 4, header: 5 })
  assert.deepEqual(ebmlHeader(Uint8Array.from([0xb3, 0x40, 0x02]), 0), { id: 0xb3, data: 3, size: 2, header: 3 })
  assert.equal(ebmlHeader(Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0)?.size, null)
  assert.equal(ebmlHeader(Uint8Array.from([0x1a, 0x45]), 0), null)
})

test('Matroska cues at the end of the file: video cue times in seconds via the SeekHead, scaled by TimestampScale', async () => {
  const file = segment([
    ['info', info(1_000_000)],
    ['tracks', tracks],
    ['cluster', cluster(300_000)], // pushes the cues past the first read
    ['cues', cues([[0, 2], [0, 1], [2500, 2], [7750, 2], [9000, 1], [12_000, 2]])],
  ], [[0x1549a966, 'info'], [0x1654ae6b, 'tracks'], [0x1c53bb6b, 'cues']])
  const reads: Array<[number, number]> = []
  assert.deepEqual(await keyframeIndex(reader(file, reads), file.length), [0, 2.5, 7.75, 12])
  assert.ok(reads.length <= 4, `${reads.length} reads`)
})

test('Matroska with a non-default TimestampScale and Info found only through the SeekHead', async () => {
  const file = segment([
    ['cluster', cluster(300_000)],
    ['info', info(100_000)],
    ['tracks', tracks],
    ['cues', cues([[0, 2], [25_000, 2]])],
  ], [[0x1549a966, 'info'], [0x1654ae6b, 'tracks'], [0x1c53bb6b, 'cues']])
  assert.deepEqual(await keyframeIndex(reader(file), file.length), [0, 2.5])
})

test('Matroska without cues has no index', async () => {
  const file = segment([['info', info(1_000_000)], ['tracks', tracks], ['cluster', cluster(100)]], [[0x1549a966, 'info']])
  assert.equal(await keyframeIndex(reader(file), file.length), null)
})

// ---- MP4 ----

function moov ({ syncs, deltas, offsets, elst }: { syncs: number[], deltas: Array<[number, number]>, offsets?: Array<[number, number]>, elst?: Array<[number, number]> }): number[] {
  const stbl = box('stbl',
    full('stts', 0, u32(deltas.length), deltas.flatMap(([n, d]) => [...u32(n), ...u32(d)])),
    ...(offsets ? [full('ctts', 0, u32(offsets.length), offsets.flatMap(([n, o]) => [...u32(n), ...u32(o >>> 0)]))] : []),
    full('stss', 0, u32(syncs.length), syncs.flatMap(n => u32(n))))
  return box('moov',
    full('mvhd', 0, u32(0), u32(0), u32(1000), u32(0)),
    box('trak',
      full('tkhd', 0, u32(0), u32(0), u32(1)),
      ...(elst ? [box('edts', full('elst', 0, u32(elst.length), elst.flatMap(([d, m]) => [...u32(d), ...u32(m >>> 0), 0, 1, 0, 0])))] : []),
      box('mdia', full('mdhd', 0, u32(0), u32(0), u32(12_800), u32(0)), full('hdlr', 0, u32(0), [...'vide'].map(c => c.charCodeAt(0))), box('minf', stbl))))
}

test('MP4 keyframes come from stss, stts and ctts, shifted by the edit list, with moov before or after mdat', async () => {
  // 30 fps at timescale 12800: 426.67 per frame; use 512 (25 fps) for exact numbers
  const tables = { syncs: [1, 26, 76], deltas: [[100, 512]] as Array<[number, number]>, offsets: [[100, 1024]] as Array<[number, number]>, elst: [[4000, 1024]] as Array<[number, number]> }
  const ftyp = box('ftyp', [...'isom'].map(c => c.charCodeAt(0)), u32(0))
  const mdat = box('mdat', new Array<number>(400_000).fill(0))
  for (const layout of [[ftyp, moov(tables), mdat], [ftyp, mdat, moov(tables)]]) {
    const file = Uint8Array.from(layout.flat())
    assert.deepEqual(await keyframeIndex(reader(file), file.length), [0, 1, 3])
  }
})

test('MP4 with an empty first edit delays every keyframe', async () => {
  const file = Uint8Array.from([...box('ftyp', u32(0)), ...moov({ syncs: [1, 51], deltas: [[100, 512]], elst: [[500, -1], [4000, 0]] })])
  assert.deepEqual(await keyframeIndex(reader(file), file.length), [0.5, 2.5])
})

test('MP4 without a sync sample table, fragmented MP4 and other formats have no index', async () => {
  const noSync = Uint8Array.from([...box('ftyp', u32(0)), ...box('moov', box('trak', box('mdia', full('mdhd', 0, u32(0), u32(0), u32(1000), u32(0)), full('hdlr', 0, u32(0), [...'vide'].map(c => c.charCodeAt(0))))))])
  assert.equal(await keyframeIndex(reader(noSync), noSync.length), null)
  const fragmented = Uint8Array.from([...box('ftyp', u32(0)), ...box('moof', full('mfhd', 0, u32(1))), ...box('mdat', [0])])
  assert.equal(await keyframeIndex(reader(fragmented), fragmented.length), null)
  const ts = new Uint8Array(1880).fill(0x47)
  assert.equal(await keyframeIndex(reader(ts), ts.length), null)
  assert.equal(await keyframeIndex(reader(new Uint8Array(0)), 0), null)
})
