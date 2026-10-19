// Pages from public/, linked to the content-hashed bundles and stylesheet esbuild builds into dist/client/assets (see `npm run build`).
import fs from 'node:fs/promises'
import path from 'node:path'
import { FileNotFoundError, route, sendCached, serveFile } from '@magplay/http-kit'
import type { Handler, Route } from '@magplay/http-kit'

const CONTENT_TYPES: Readonly<Record<string, string>> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }
/** Bundles, the stylesheet and their source maps, named by esbuild's `[name]-[hash]`; never client sources or tests. */
const ASSET = /^[\w-]+-[A-Z0-9]{8}\.(?:js|css)(?:\.map)?$/
/** A hashed URL never changes content, so any cache may keep it for good. */
const IMMUTABLE = 'public, max-age=31536000, immutable'

interface Metafile { outputs: Record<string, { entryPoint?: string }> }

/** '/search.js' (as the pages link it) → '/assets/search-HASH.js', from esbuild's metafile; re-read after a rebuild. */
function assetLinks (metafilePath: string): () => Promise<Map<string, string>> {
  return async () => {
    const { outputs } = JSON.parse(await fs.readFile(metafilePath, 'utf8')) as Metafile
    const links = new Map<string, string>()
    for (const [output, { entryPoint }] of Object.entries(outputs)) {
      if (entryPoint) links.set('/' + path.basename(entryPoint).replace(/\.ts$/, '.js'), '/assets/' + path.basename(output))
    }
    return links
  }
}

export function staticRoutes ({ publicDir, distDir }: { publicDir: string, distDir: string }): Route[] {
  const links = assetLinks(path.join(distDir, 'meta.json'))
  /**
   * Pages revalidate on every load, so a deploy shows up on reload. The ETag hashes the linked page (not file
   * metadata), so a cache revalidating through a reverse proxy gets the new page and with it the new asset URLs.
   */
  const page = (name: string): Handler<unknown> => async ({ req, res }) => {
    const [html, urls] = await Promise.all([fs.readFile(path.join(publicDir, name), 'utf8'), links()])
    const linked = html.replace(/(src|href)="(\/[\w-]+\.(?:js|css))"/g, (_, attribute: string, url: string) => {
      const hashed = urls.get(url)
      if (!hashed) throw new Error(`${name} links ${url}, which the client build does not produce`)
      return `${attribute}="${hashed}"`
    })
    sendCached(req, res, linked, { 'Content-Type': 'text/html; charset=utf-8' }, 'no-cache')
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
