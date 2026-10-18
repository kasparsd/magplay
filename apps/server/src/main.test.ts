import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const main = new URL('./main.ts', import.meta.url).pathname
const keys = /^(TORZNAB_|JACKETT_|PROWLARR_|BITMAGNET_|EXTRA_TRACKERS|MAX_|HLS_MAX_GB|MIN_FREE_GB|PORT|CACHE_DIR|LOG_LEVEL|METRICS_)/
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !keys.test(key)))

const tempDir = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magplay-main-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function freePort (): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  return typeof address === 'object' && address ? address.port : 0
}

test('invalid env values stop the server at startup, naming the variable', t => {
  const dir = tempDir(t)
  for (const [key, value, message] of [['MAX_PROBES', '0', 'at least 1'], ['HLS_MAX_GB', 'Infinity', 'a number']] as const) {
    const result = spawnSync(process.execPath, [main], { env: { ...baseEnv, CACHE_DIR: dir, [key]: value }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 1, key)
    assert.match(result.stdout, new RegExp(`${key} must be ${message}`))
  }
})

test('SIGTERM shuts down gracefully: the port closes and the process exits 0', { timeout: 20_000 }, async t => {
  const port = await freePort()
  const proc = spawn(process.execPath, [main], {
    env: { ...baseEnv, CACHE_DIR: tempDir(t), PORT: String(port), TORRENT_PORT: '0', DHT_ENABLED: 'off', LSD_ENABLED: 'off', EXTRA_TRACKERS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  proc.stdout.on('data', (chunk: Buffer) => { output += String(chunk) })
  proc.stderr.on('data', (chunk: Buffer) => { output += String(chunk) })
  t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  for (let i = 0; !(await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false)); i++) {
    if (proc.exitCode !== null || i > 200) assert.fail(`Server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  // An open download must not hold the shutdown
  const download = await fetch(`http://127.0.0.1:${port}/api/speedtest`)
  const exited = once(proc, 'exit')
  proc.kill('SIGTERM')
  const [code] = await exited as [number | null]
  await download.body?.cancel().catch(() => {})
  assert.equal(code, 0, output)
  assert.match(output, /"event":"server.stopping"/)
  assert.match(output, /"event":"server.stopped"/)
})

test('bootstrap failures never echo raw configuration values', t => {
  const dir = tempDir(t)
  for (const key of ['LOG_LEVEL', 'METRICS_HOST', 'EXTRA_TRACKERS', 'TORZNAB_URL']) {
    const result = spawnSync(process.execPath, [main], { env: { ...baseEnv, CACHE_DIR: dir, [key]: key === 'METRICS_HOST' ? 'opaque-config-secret/invalid' : 'opaque-config-secret' }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 1)
    const text = result.stdout + result.stderr
    assert.doesNotMatch(text, /opaque-config-secret/)
    assert.match(text, /server.failed/)
  }
})
