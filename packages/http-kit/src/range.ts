// HTTP Range handling shared by /raw and /tar, with ETag + If-Range so interrupted browser downloads can resume.

export interface RangeHeaders {
  range?: string | undefined
  'if-range'?: string | undefined
}

export interface ByteRange {
  start: number
  end: number
  partial: boolean
}

/**
 * The byte range to send for a request.
 * @returns null when the range can't be satisfied (416)
 */
export function rangeFor (headers: RangeHeaders, size: number, etag: string): ByteRange | null {
  const full = { start: 0, end: size - 1, partial: false }
  const m = /^bytes=(\d*)-(\d*)$/.exec(headers.range ?? '')
  // If-Range: only honour the range if the client's copy is the same content
  if (!m || (headers['if-range'] && headers['if-range'] !== etag)) return full
  const [, from = '', to = ''] = m
  let start, end
  if (from === '') {
    if (to === '') return full
    start = Math.max(0, size - Number(to))
    end = size - 1
  } else {
    start = Number(from)
    end = to ? Math.min(Number(to), size - 1) : size - 1
  }
  return start > end || start >= size ? null : { start, end, partial: true }
}

/** Content-Disposition for a download, with an ASCII fallback name and the real one in UTF-8. */
export function attachment (filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
