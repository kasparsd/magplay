// Request bodies are unknown until checked here; responses are typed by the api-contract shape they send.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddTorrentRequest, PlayRequest } from '@magplay/api-contract'
import { HttpError } from './errors.ts'

/** Sends a JSON body; the type parameter names the api-contract response it must match. */
export function json<T> (res: ServerResponse, status: number, body: T): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** A JSON object body of at most 1 MB; anything else is a 400 or 413. An empty body is {}. */
export async function readJson (req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > 1e6) throw new HttpError(413, 'Request too large')
  }
  let parsed: unknown
  try { parsed = JSON.parse(body || '{}') } catch { throw new HttpError(400, 'Invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Expected a JSON object')
  return parsed as Record<string, unknown>
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** POST /api/play. Numbers may arrive as strings; ih is checked by the engine. */
export function parsePlayRequest (body: Record<string, unknown>): PlayRequest {
  const { ih, tab, caps = {} } = body
  const idx = Number(body.idx)
  const audio = Number(body.audio ?? 0)
  const start = Number(body.start ?? 0)
  if (!Number.isInteger(idx) || idx < 0 || !Number.isInteger(audio) || audio < 0 || !Number.isFinite(start) || start < 0 ||
      !isPlainObject(caps) || (tab !== undefined && typeof tab !== 'string')) {
    throw new HttpError(400, 'Invalid playback options')
  }
  return {
    ih: typeof ih === 'string' ? ih : '',
    idx,
    audio,
    start,
    ...(tab !== undefined && { tab }),
    caps: Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, !!value])),
  }
}

const optionalString = (v: unknown): string | undefined => typeof v === 'string' && v ? v : undefined

/** POST /api/torrents. Wrong types count as missing. */
export function parseAddRequest (body: Record<string, unknown>): AddTorrentRequest {
  const [infoHash, magnet, linkId] = [optionalString(body.infoHash), optionalString(body.magnet), optionalString(body.linkId)]
  return { ...(infoHash && { infoHash }), ...(magnet && { magnet }), ...(linkId && { linkId }) }
}
