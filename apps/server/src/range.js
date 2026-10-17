// HTTP Range handling shared by /raw and /tar, with ETag + If-Range so interrupted browser downloads can resume.

/**
 * The byte range to send for a request.
 * @returns {{start: number, end: number, partial: boolean} | null} null when the range can't be satisfied (416)
 */
export function rangeFor (headers, size, etag) {
  const full = { start: 0, end: size - 1, partial: false }
  const m = /^bytes=(\d*)-(\d*)$/.exec(headers.range || '')
  // If-Range: only honour the range if the client's copy is the same content
  if (!m || (headers['if-range'] && headers['if-range'] !== etag)) return full
  let start, end
  if (m[1] === '') {
    if (m[2] === '') return full
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  return start > end || start >= size ? null : { start, end, partial: true }
}

/** Content-Disposition for a download, with an ASCII fallback name and the real one in UTF-8. */
export function attachment (filename) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
