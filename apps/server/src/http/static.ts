// The client's pages (apps/client/*.html, served as written) and what esbuild builds into dist/client/assets
// (see `npm run build`): each page's script and the stylesheet under their own names, and the chunks they share
// under content-hashed names.
import fs from 'node:fs/promises'
import path from 'node:path'
import { FileNotFoundError, route, sendCached, serveFile } from '@magplay/http-kit'
import type { Handler, Route } from '@magplay/http-kit'

const CONTENT_TYPES: Readonly<Record<string, string>> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }
/** Shared chunks and their source maps, named by esbuild's `[name]-[hash]`; never client sources or tests. */
const CHUNK = /^[\w-]+-[A-Z0-9]{8}\.js(?:\.map)?$/
/** Page scripts, the stylesheet and their source maps, as the pages link them: `/assets/search.js`. */
const ENTRY = /^[a-z]+\.(?:js|css)(?:\.map)?$/
/** A hashed URL never changes content, so any cache may keep it for good. */
const IMMUTABLE = 'public, max-age=31536000, immutable'

export function staticRoutes ({ pagesDir, distDir }: { pagesDir: string, distDir: string }): Route[] {
  /**
   * Pages and their entry files revalidate on every load, so a deploy shows up on reload. The ETag hashes the
   * content (not file metadata), so a cache revalidating through a reverse proxy gets the new entry and, through
   * its imports, the new chunk URLs. Read on every request, so a rebuild needs no restart.
   */
  const revalidated = (file: string, type: string): Handler<unknown> => async ({ req, res }) => {
    const body = await fs.readFile(file, 'utf8').catch(() => { throw new FileNotFoundError('Not found') })
    sendCached(req, res, body, { 'Content-Type': `${type}; charset=utf-8` }, 'no-cache')
  }
  const page = (name: string): Handler<unknown> => revalidated(path.join(pagesDir, name), 'text/html')
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
    route('GET', '/assets/:name', (ctx) => {
      const { name } = ctx.params
      const file = path.join(distDir, 'assets', name)
      const type = CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream'
      if (CHUNK.test(name)) return serveFile(ctx.req, ctx.res, file, `${type}; charset=utf-8`, IMMUTABLE)
      if (ENTRY.test(name)) return revalidated(file, type)(ctx)
      throw new FileNotFoundError('Not found')
    }),
  ]
}
