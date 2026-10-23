// Builders for MP4 boxes in tests: box('moov', box('trak', …)), full boxes with a version and flags, big-endian integers.

export const u32 = (n: number): number[] => [n >>> 24 & 0xff, n >>> 16 & 0xff, n >>> 8 & 0xff, n & 0xff]
export const u64 = (n: number): number[] => [...u32(Math.floor(n / 2 ** 32)), ...u32(n % 2 ** 32)]

export function box (type: string, ...body: number[][]): number[] {
  const data = body.flat()
  return [...u32(8 + data.length), ...[...type].map(c => c.charCodeAt(0)), ...data]
}

/** A full box: version, 24-bit flags, then the body. */
export const full = (type: string, version: number, ...body: number[][]): number[] => box(type, [version, 0, 0, 0], ...body)

/** An init segment with one video track (id 1, timescale 1000) and one audio track (id 2, timescale 48000). */
export function initSegment (): Buffer {
  const trak = (id: number, scale: number, handler: string): number[] => box('trak',
    full('tkhd', 0, u32(0), u32(0), u32(id)),
    box('mdia', full('mdhd', 0, u32(0), u32(0), u32(scale), u32(0)), full('hdlr', 0, u32(0), [...handler].map(c => c.charCodeAt(0)))))
  return Buffer.from([...box('ftyp', u32(0)), ...box('moov', full('mvhd', 0, u32(0), u32(0), u32(1000), u32(0)), trak(1, 1000, 'vide'), trak(2, 48_000, 'soun'))])
}

/** A fragment (moof + mdat) whose video track starts at `seconds` (timescale 1000) and carries `size` bytes. */
export function fragment (seconds: number, size = 16): Buffer {
  const traf = (id: number, time: number): number[] => box('traf', full('tfhd', 0, u32(id)), full('tfdt', 1, u64(time)))
  return Buffer.from([...box('moof', full('mfhd', 0, u32(1)), traf(2, Math.round(seconds * 48_000)), traf(1, Math.round(seconds * 1000))), ...box('mdat', new Array<number>(size).fill(7))])
}
