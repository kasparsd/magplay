import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { serveFile } from './http-cache.ts'
import { FileNotFoundError } from './errors.ts'

test('serveFile: changed validators, precedence, wildcard, HEAD and missing files over HTTP', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-cache-'))
  const target = path.join(dir, 'asset.js')
  await fs.writeFile(target, 'first')
  const server = http.createServer((req, res) => {
    serveFile(req, res, target, 'text/javascript').catch((err: unknown) => {
      res.writeHead(err instanceof FileNotFoundError ? 404 : 500, { 'Cache-Control': 'no-store' })
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const first = await fetch(url)
  const etag = first.headers.get('etag') ?? ''
  const date = first.headers.get('last-modified') ?? ''
  assert.equal(await first.text(), 'first')
  for (const headers of [{ 'If-None-Match': '*' }, { 'If-None-Match': `"other", ${etag}` }, { 'If-Modified-Since': date }]) {
    const res = await fetch(url, { headers })
    assert.equal(res.status, 304)
    assert.equal(await res.text(), '')
    assert.equal(res.headers.get('content-length'), null)
  }
  const precedence = await fetch(url, { headers: { 'If-None-Match': '"wrong"', 'If-Modified-Since': date } })
  assert.equal(precedence.status, 200)
  await precedence.text()
  const head = await fetch(url, { method: 'HEAD', headers: { 'If-None-Match': etag } })
  assert.equal(head.status, 304)
  assert.equal(await head.text(), '')
  await fs.writeFile(target, 'changed and longer')
  const changed = await fetch(url, { headers: { 'If-None-Match': etag } })
  assert.equal(changed.status, 200)
  assert.notEqual(changed.headers.get('etag'), etag)
  assert.equal(await changed.text(), 'changed and longer')
  await fs.unlink(target)
  const missing = await fetch(url, { headers: { 'If-None-Match': '*' } })
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('cache-control'), 'no-store')
})
