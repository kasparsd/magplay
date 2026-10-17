// Streams files as a tar archive without buffering them. The layout is computed up front from the file sizes,
// so the total size is known and any byte range can be produced (resumable downloads).
// Each file gets a PAX header with its full path, so long and non-ASCII names survive.

const BLOCK = 512
const MAX_USTAR_SIZE = 8 ** 11 - 1 // the ustar size field holds 11 octal digits
const padding = n => (BLOCK - (n % BLOCK)) % BLOCK

function header (name, size, mtime, type) {
  const b = Buffer.alloc(BLOCK)
  // A fallback name for readers without PAX support; the real one is in the PAX record
  b.write(name.replace(/[^\x20-\x7e]/g, '_').slice(-100), 0, 'ascii')
  b.write('0000644\0', 100)
  b.write('0000000\0', 108) // uid
  b.write('0000000\0', 116) // gid
  b.write((size > MAX_USTAR_SIZE ? 0 : size).toString(8).padStart(11, '0') + '\0', 124)
  b.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136)
  b.fill(' ', 148, 156) // checksum is computed with this field as spaces
  b.write(type, 156)
  b.write('ustar\0' + '00', 257, 'ascii')
  let sum = 0
  for (const byte of b) sum += byte
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return b
}

/** A PAX record: "<length> key=value\n", where length counts its own digits. */
function paxRecord (key, value) {
  const body = ` ${key}=${value}\n`
  const bodyLength = Buffer.byteLength(body)
  let length = bodyLength + 1
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength
  return length + body
}

/** Turns a torrent path into a safe relative archive path. */
export function safePath (path) {
  return path.split(/[/\\]+/).filter(p => p && p !== '.' && p !== '..').join('/') || 'file'
}

/**
 * @param {Array<{path: string, length: number}>} files
 * @param {number} mtime  seconds since the epoch, the same on every request so ranges line up
 * @returns {{segments: Array<{length: number, data?: Buffer, file?: number}>, size: number}}
 */
export function tarLayout (files, mtime) {
  const segments = []
  const add = seg => { if (seg.length) segments.push(seg) }
  const bytes = data => add({ length: data.length, data })
  files.forEach((f, i) => {
    const path = safePath(f.path)
    const pax = Buffer.from(paxRecord('path', path) + (f.length > MAX_USTAR_SIZE ? paxRecord('size', f.length) : ''))
    bytes(header(`PaxHeaders/${path}`, pax.length, mtime, 'x'))
    bytes(Buffer.concat([pax, Buffer.alloc(padding(pax.length))]))
    bytes(header(path, f.length, mtime, '0'))
    add({ length: f.length, file: i })
    bytes(Buffer.alloc(padding(f.length)))
  })
  bytes(Buffer.alloc(2 * BLOCK)) // end of archive
  return { segments, size: segments.reduce((sum, s) => sum + s.length, 0) }
}

/**
 * Bytes start..end (inclusive) of the archive.
 * @param {(file: number, start: number, end: number) => AsyncIterable<Uint8Array>} readFile  bytes start..end of a file
 */
export async function * tarBytes ({ segments }, start, end, readFile) {
  let pos = 0
  for (const seg of segments) {
    const last = pos + seg.length - 1
    if (last >= start && pos <= end) {
      const from = Math.max(start, pos) - pos
      const to = Math.min(end, last) - pos
      if (seg.data) yield seg.data.subarray(from, to + 1)
      else yield * readFile(seg.file, from, to)
    }
    pos += seg.length
    if (pos > end) return
  }
}
