// Adding torrents from the pages: an info hash, a magnet, or a search result's private download link.
import { resolveLink } from '@magplay/indexers'
import type { Search } from '@magplay/indexers'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type { AddTorrentRequest, TorrentInfo } from '@magplay/api-contract'
import { HttpError } from '../http/errors.ts'

export async function addTorrent (engine: TorrentEngine, search: Pick<Search, 'linkFor'>, { infoHash, magnet, linkId }: AddTorrentRequest): Promise<TorrentInfo> {
  const link = linkId ? search.linkFor(linkId) : null
  const id = magnet || infoHash || (link && await resolveLink(link))
  if (!id) throw new HttpError(400, 'Send infoHash, magnet or linkId')
  return engine.describe(await engine.add(id))
}
