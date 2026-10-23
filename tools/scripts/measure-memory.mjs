// Memory of the server in a container through one torrent's life: idle, streaming /raw from a peer on the host,
// reading it again from the finished cache, then a Node remux HLS session (the core image has no ffmpeg).
// Usage: node tools/scripts/measure-memory.mjs --image=magplay:core [--memory=384m] [--seconds=120] [--piece-mib=4]
//   [--remux-seconds=60]
// Needs Docker and ffmpeg on the host; ffmpeg only generates the test file.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import WebTorrent from 'webtorrent'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
if (!args.image) throw new Error('--image is required')
const seconds = Number(args.seconds ?? 120)
const pieceLength = Number(args['piece-mib'] ?? 4) * 1024 ** 2
const remuxSeconds = Number(args['remux-seconds'] ?? 60)
const memory = args.memory ?? '384m'
const exec = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const mib = bytes => Math.round(bytes / 1024 ** 2)
const log = message => console.error(`${new Date().toISOString().slice(11, 19)} ${message}`)

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-memory-'))
const media = path.join(dir, 'movie.mkv')
log('generating the test file')
await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=24:duration=${seconds}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6M', '-g', '48', '-c:a', 'ac3', '-b:a', '192k', media])
const size = (await fs.stat(media)).size

const seeder = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, torrentPort: 0 })
const seeded = await new Promise(resolve => seeder.seed(media, { private: true, pieceLength }, resolve))
await new Promise(resolve => { if (seeder.torrentPort) resolve(); else seeder.once('listening', resolve) })
const magnet = `${seeded.magnetURI}&x.pe=host.docker.internal:${seeder.torrentPort}`

// The server writes its own heap and buffer numbers for the sampler; the healthcheck's node process doesn't
const preload = path.join(dir, 'preload.mjs')
await fs.writeFile(preload, `import fs from 'node:fs'
if (process.argv[1]?.endsWith('main.ts')) setInterval(() => fs.writeFileSync('/tmp/memory.json', JSON.stringify(process.memoryUsage())), 200).unref()
`)
const imageOptions = await exec('docker', ['image', 'inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', args.image])
  .then(r => /^NODE_OPTIONS=(.*)$/m.exec(r.stdout)?.[1] ?? '')
const container = `magplay-memory-${process.pid}`
const docker = (...rest) => exec('docker', rest, { maxBuffer: 1024 ** 2 }).then(r => r.stdout.trim())
await docker('run', '-d', '--name', container, `--memory=${memory}`, `--memory-swap=${memory}`, '-v', `${preload}:/measure/preload.mjs:ro`,
  '-e', `NODE_OPTIONS=${imageOptions} --import=/measure/preload.mjs`.trim(),
  '-e', 'TORRENT_PORT=0', '-e', 'DHT_ENABLED=false', '-e', 'LSD_ENABLED=false', '-p', '127.0.0.1::8080', args.image)
const origin = `http://${(await docker('port', container, '8080')).split('\n')[0]}`

let phase = 'starting'
const peaks = new Map()
const sampling = { on: true } // cleared in finally, while the loop awaits
const sampler = (async () => {
  while (sampling.on) {
    const [status, usage] = (await docker('exec', container, 'sh', '-c', 'cat /proc/1/status; echo ---; cat /tmp/memory.json').catch(() => '---')).split('---')
    const field = name => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? 0) * 1024
    const peak = peaks.get(phase) ?? { rss: 0, anon: 0 }
    let node = peak.node
    try { node = JSON.parse(usage) } catch {}
    if (status) peaks.set(phase, { rss: Math.max(peak.rss, field('VmRSS')), anon: Math.max(peak.anon, field('RssAnon')), lastAnon: field('RssAnon'), node })
    await sleep(200)
  }
})()
const request = (url, options) => fetch(origin + url, options)
const drain = async response => {
  if (!response.ok) throw new Error(`${response.url}: ${response.status} ${await response.text()}`)
  const reader = response.body.getReader()
  while (!(await reader.read()).done);
}

try {
  for (let i = 0; !(await request('/health').then(r => r.ok, () => false)); i++) {
    if (i > 100) throw new Error('the server did not start')
    await sleep(100)
  }
  phase = 'idle'
  log(phase)
  await sleep(5000)

  const added = await request('/api/torrents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet }), signal: AbortSignal.timeout(60_000) })
  if (!added.ok) throw new Error(`add: ${added.status} ${await added.text()}`)
  phase = 'stream from peer'
  log(phase)
  await drain(await request(`/raw/${seeded.infoHash}/0`, { signal: AbortSignal.timeout(300_000) }))
  phase = 'stream from cache'
  log(phase)
  await drain(await request(`/raw/${seeded.infoHash}/0`, { signal: AbortSignal.timeout(120_000) }))
  phase = 'settled'
  log(phase)
  await sleep(30_000)

  phase = 'node remux'
  log(phase)
  const play = await request('/api/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ih: seeded.infoHash, idx: 0, browserRemux: false, tab: 'measure', caps: { h264: true, aac: true } }) })
  const decision = await play.json()
  if (decision.mode !== 'remux') throw new Error(`play: expected remux, got ${JSON.stringify(decision)}`)
  const playlist = await (await request(decision.url)).text()
  const base = new URL(decision.url, origin)
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1]
  const segments = []
  let covered = 0
  for (const [, duration, uri] of playlist.matchAll(/#EXTINF:([\d.]+),\n(\S+)/g)) {
    if (covered >= remuxSeconds) break
    segments.push(uri)
    covered += Number(duration)
  }
  if (init) await drain(await fetch(new URL(init, base), { signal: AbortSignal.timeout(120_000) }))
  for (const segment of segments) await drain(await fetch(new URL(segment, base), { signal: AbortSignal.timeout(120_000) }))
  await request(`/api/play/${decision.session}`, { method: 'DELETE' })

  phase = 'after'
  log(phase)
  await sleep(30_000)
  console.log(`${args.image}, --memory=${memory}: file ${mib(size)} MiB (${seconds} s), ${Math.ceil(size / pieceLength)} pieces of ${mib(pieceLength)} MiB, remuxed ${Math.round(covered)} s`)
  console.log('  phase              peak resident  peak anonymous  at the end: anonymous  heap used  heap total  array buffers (MiB)')
  for (const [name, { rss, anon, lastAnon, node }] of peaks) {
    if (name === 'starting') continue
    const cells = [rss, anon, lastAnon, node?.heapUsed, node?.heapTotal, node?.arrayBuffers].map(n => String(n === undefined ? '—' : mib(n)))
    console.log(`  ${name.padEnd(18)} ${cells[0].padStart(13)} ${cells[1].padStart(15)} ${cells[2].padStart(22)} ${cells[3].padStart(10)} ${cells[4].padStart(11)} ${cells[5].padStart(14)}`)
  }
} catch (err) {
  const state = await docker('inspect', '-f', '{{.State.OOMKilled}} {{.State.Status}}', container).catch(() => 'gone')
  console.log(`${args.image}: failed during "${phase}" (${err.message}); container OOM-killed/status: ${state}`)
  process.exitCode = 1
} finally {
  sampling.on = false
  await sampler
  await docker('logs', '--tail', '5', container).then(out => out && log(out)).catch(() => {})
  await docker('rm', '-f', container).catch(() => {})
  await new Promise(resolve => seeder.destroy(resolve))
  await fs.rm(dir, { recursive: true, force: true })
}
