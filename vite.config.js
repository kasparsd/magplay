// The browser client: apps/client/index.html, one shell for every page, with React routing inside it. Vite writes
// it, with its links rewritten to content-hashed bundles and the stylesheet, into dist/client, which the server
// serves (apps/server/src/http/static.ts). `npm run dev` serves it with hot reload and passes everything else to the
// Node server.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const client = path.resolve(import.meta.dirname, 'apps/client')

const server = process.env.MAGPLAY_SERVER ?? 'http://127.0.0.1:8080'

export default defineConfig({
  root: client,
  publicDir: false,
  appType: 'spa',
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    sourcemap: true,
    // Nothing is inlined as a data: URL; every asset is a hashed file under /assets/
    assetsInlineLimit: 0,
    // hls.js and the mediabunny codec chunks are large, but load only when a file needs them
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      // The one stylesheet, named for what it is rather than the first chunk that imports it
      output: { assetFileNames: asset => asset.names.some(name => name.endsWith('.css')) ? 'assets/style-[hash][extname]' : 'assets/[name]-[hash][extname]' },
    },
  },
  server: {
    // API, media and playlists come from the Node server; the Origin header passes through for its same-origin check
    proxy: Object.fromEntries(['/api', '/raw', '/tar', '/hls', '/subs', '/playlist.m3u', '/health'].map(prefix => [prefix, { target: server }])),
  },
  plugins: [react()],
})
