import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { avahiResolve, createLookup, installMdnsLookup } from './mdns.ts'

/** A stand-in avahi-daemon that knows `names` (case-insensitive, like mDNS) and answers anything else with avahi's timeout error. */
async function fakeAvahi (names: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-avahi-'))
  const socketPath = path.join(dir, 'socket')
  const asked: string[] = []
  const server = net.createServer(socket => socket.once('data', line => {
    const [command, name = ''] = line.toString().trim().split(' ')
    asked.push(`${command} ${name}`)
    socket.end(names[name.toLowerCase()] ? `+ 2 0 ${name} ${names[name.toLowerCase()]}\n` : '-15 Timeout reached\n')
  }))
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  return { socketPath, asked, close: () => { server.close(); return fs.rm(dir, { recursive: true, force: true }) } }
}

test('resolves names through the avahi-daemon line protocol', async t => {
  const avahi = await fakeAvahi({ 'nas.local': '192.168.1.20' })
  t.after(avahi.close)
  assert.equal(await avahiResolve(avahi.socketPath, 'nas.local.', 4), '192.168.1.20')
  await assert.rejects(avahiResolve(avahi.socketPath, 'gone.local', 4), /Timeout reached/)
  assert.deepEqual(avahi.asked, ['RESOLVE-HOSTNAME-IPV4 nas.local', 'RESOLVE-HOSTNAME-IPV4 gone.local'])
})

test('only .local names go to avahi; misses and other names use the fallback', async t => {
  const avahi = await fakeAvahi({ 'nas.local': '192.168.1.20' })
  t.after(avahi.close)
  const fellBack: string[] = []
  const lookup = createLookup(avahi.socketPath, (hostname, _options, cb) => { fellBack.push(hostname); cb!(null, '10.0.0.1', 4) })
  const run = (hostname: string, options: object) => new Promise(resolve => lookup(hostname, options, (err, address, family) => resolve({ err, address, family })))
  assert.deepEqual(await run('nas.local', {}), { err: null, address: '192.168.1.20', family: 4 })
  assert.deepEqual(await run('NAS.local', { all: true }), { err: null, address: [{ address: '192.168.1.20', family: 4 }], family: undefined })
  assert.deepEqual(await run('gone.local', {}), { err: null, address: '10.0.0.1', family: 4 })
  assert.deepEqual(await run('example.com', {}), { err: null, address: '10.0.0.1', family: 4 })
  assert.deepEqual(fellBack, ['gone.local', 'example.com'])
  assert.deepEqual(avahi.asked, ['RESOLVE-HOSTNAME-IPV4 nas.local', 'RESOLVE-HOSTNAME-IPV4 NAS.local', 'RESOLVE-HOSTNAME-IPV4 gone.local'])
})

test('once installed, fetch reaches a .local host; without the socket nothing changes', async t => {
  assert.equal(installMdnsLookup('/nonexistent/avahi-socket'), null)
  const avahi = await fakeAvahi({ 'indexer.local': '127.0.0.1' })
  const server = http.createServer((_req, res) => res.end('ok'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const uninstall = installMdnsLookup(avahi.socketPath)
  t.after(() => { uninstall?.(); server.close(); return avahi.close() })
  const { port } = server.address() as net.AddressInfo
  assert.equal(await (await fetch(`http://indexer.local:${port}/`)).text(), 'ok')
})
