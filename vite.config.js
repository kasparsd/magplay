// The browser client: each page in apps/client is an entry. Vite writes the pages, with their links rewritten to
// content-hashed bundles and the stylesheet, into dist/client, which the server serves (apps/server/src/http/static.ts).
// `npm run dev` serves the same pages with hot reload and passes everything else to the Node server.
import { defineConfig } from 'vite'
import path from 'node:path'

const client = path.resolve(import.meta.dirname, 'apps/client')
const pages = ['index', 'explore', 'title', 'torrent', 'player', 'settings']

/** The page each app URL shows, as the server maps them; the dev server needs the same mapping. */
const pageFor = url => {
  const pathname = url.split('?')[0]
  if (pathname === '/') return 'index'
  if (pathname === '/explore') return 'explore'
  if (/^\/title\/[^/]+\/[^/]+\/[^/]+$/.test(pathname)) return 'title'
  if (/^\/t(\/[^/]*)?$/.test(pathname)) return 'torrent'
  if (/^\/play\/[^/]+\/[^/]+$/.test(pathname)) return 'player'
  if (pathname === '/settings') return 'settings'
  return null
}

const server = process.env.MAGPLAY_SERVER ?? 'http://127.0.0.1:8080'

export default defineConfig({
  root: client,
  publicDir: false,
  appType: 'mpa',
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    sourcemap: true,
    // Nothing is inlined as a data: URL; every asset is a hashed file under /assets/
    assetsInlineLimit: 0,
    // hls.js and the mediabunny codec chunks are large, but load only when a file needs them
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: Object.fromEntries(pages.map(name => [name, path.join(client, `${name}.html`)])),
      // The one stylesheet, named for what it is rather than the first chunk that imports it
      output: { assetFileNames: asset => asset.names.some(name => name.endsWith('.css')) ? 'assets/style-[hash][extname]' : 'assets/[name]-[hash][extname]' },
    },
  },
  server: {
    // API, media and playlists come from the Node server; the Origin header passes through for its same-origin check
    proxy: Object.fromEntries(['/api', '/raw', '/tar', '/hls', '/subs', '/playlist.m3u', '/health'].map(prefix => [prefix, { target: server }])),
  },
  plugins: [{
    name: 'magplay-pages',
    configureServer (dev) {
      dev.middlewares.use((req, _res, next) => {
        const page = req.url && pageFor(req.url)
        if (page) req.url = `/${page}.html`
        next()
      })
    },
  }],
})
