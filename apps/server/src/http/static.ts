// The client's pages and assets as Vite builds them into dist/client (see `npm run build`): pages link content-hashed
// bundles and the stylesheet under /assets/.
import fs from 'node:fs/promises'
import path from 'node:path'
import { FileNotFoundError, route, sendCached, serveFile } from '@magplay/http-kit'
import type { Handler, Route } from '@magplay/http-kit'

const CONTENT_TYPES: Readonly<Record<string, string>> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }
/** Bundles, the stylesheet and their source maps, named `[name]-[hash]` with an 8-character base64url hash. */
const ASSET = /^[\w-]+-[\w-]{8}\.(?:js|css)(?:\.map)?$/
/** A hashed URL never changes content, so any cache may keep it for good. */
const IMMUTABLE = 'public, max-age=31536000, immutable'

export function staticRoutes ({ distDir }: { distDir: string }): Route[] {
  /**
   * Pages revalidate on every load, so a deploy shows up on reload. The ETag hashes the page (not file metadata),
   * so a cache revalidating through a reverse proxy gets the new page and with it the new asset URLs. Read on every
   * request, so a rebuild needs no restart.
   */
  const page = (name: string): Handler<unknown> => async ({ req, res }) => {
    const html = await fs.readFile(path.join(distDir, name), 'utf8')
    sendCached(req, res, html, { 'Content-Type': 'text/html; charset=utf-8' }, 'no-cache')
  }
  return [
    route('GET', '/', page('index.html')),
    route('GET', '/t/:ih?', page('torrent.html')),
    route('GET', '/play/:ih/:idx', page('player.html')),
    route('GET', '/explore', page('explore.html')),
    route('GET', '/title/:type/:source/:id', page('title.html')),
    route('GET', '/settings', page('settings.html')),
    route('GET', '/player.html', ({ res, query }) => { // links from before /play existed
      res.writeHead(301, { Location: `/play/${query.get('ih')}/${query.get('idx')}` })
      res.end()
    }),
    route('GET', '/assets/:name', ({ req, res, params }) => {
      if (!ASSET.test(params.name)) throw new FileNotFoundError('Not found')
      const type = CONTENT_TYPES[path.extname(params.name)] ?? 'application/octet-stream'
      return serveFile(req, res, path.join(distDir, 'assets', params.name), `${type}; charset=utf-8`, IMMUTABLE)
    }),
  ]
}
