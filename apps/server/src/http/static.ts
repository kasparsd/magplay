// Pages from public/ and the page bundles esbuild builds from apps/client into dist/client (see `npm run build`).
import path from 'node:path'
import { route, serveFile } from '@magplay/http-kit'
import type { Handler, Route } from '@magplay/http-kit'

const CONTENT_TYPES: Readonly<Record<string, string>> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }
const BUNDLES = ['search.js', 'torrent.js', 'player.js', 'explore.js', 'title.js', 'settings.js']

/** Serves a front-end file. Pages and scripts revalidate on every load, so a deploy shows up on reload. */
const file = (target: string): Handler<unknown> => ({ req, res }) =>
  serveFile(req, res, target, `${CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream'}; charset=utf-8`)

export function staticRoutes ({ publicDir, distDir }: { publicDir: string, distDir: string }): Route[] {
  const page = (name: string): Handler<unknown> => file(path.join(publicDir, name))
  const asset = (name: string): Handler<unknown> => file(path.join(distDir, name))
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
    route('GET', '/style.css', page('style.css')),
    // Only the bundles and their source maps, never client sources or tests
    ...BUNDLES.flatMap(name => [route('GET', `/${name}`, asset(name)), route('GET', `/${name}.map`, asset(`${name}.map`))]),
  ]
}
