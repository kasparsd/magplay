// Synthetic local-file preparation comparison; no HTTP/network/browser claim.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { generateMedia } from '../../../tests/fixtures/media.js'
import { createPlay } from '../../../apps/server/src/services/play.ts'
import { createMediaTools, createHlsSessions } from '../../../packages/playback/src/index.ts'
import { createTabs } from '../../../apps/server/src/services/tabs.ts'
import { createLogging, createMetrics, noopLogger, noopMetrics } from '../../../packages/observability/src/index.ts'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.argv[2]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-observe-bench-'))
  try {
    await generateMedia(dir)
    const reports = []
    // Separate processes avoid carrying enabled observers or tail memory into the baseline.
    for (const mode of ['disabled', 'enabled']) {
      const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), mode, dir], { timeout: 60_000 })
      reports.push(JSON.parse(stdout))
    }
    console.log(JSON.stringify({ scope: 'Synthetic local-file domain preparation; no HTTP, Docker, browser or real-server claim', reports }, null, 2))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
} else {
  const mode = process.argv[2]
  const dir = process.argv[3]
  let records = 0
  let logBytes = 0
  const logging = createLogging({ level: mode === 'enabled' ? 'info' : 'silent', sink: { write (line) { records++; logBytes += Buffer.byteLength(line) } } })
  const telemetry = mode === 'enabled' ? createMetrics() : null
  const logger = telemetry ? logging.logger : noopLogger
  const metrics = telemetry?.metrics ?? noopMetrics
  const media = createMediaTools({ live: () => ({ ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg', maxProbes: 2, maxSubtitleJobs: 1 }), logger, metrics })
  const hls = createHlsSessions({ dir: path.join(dir, `hls-${mode}`), logger, metrics })
  const tabs = createTabs(() => hls)
  const names = ['Playback.S01E01.mp4', 'Playback.S01E02.mkv']
  const play = createPlay({ engine: { file: async (_ih, idx) => ({ name: names[idx] }) }, media, tabs, input: (_ih, idx) => path.join(dir, names[idx]), policy: () => ({ allowTranscode: false, transcodeMaxHeight: 720 }), logger, metrics })
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  const samples = []
  const cpu = process.cpuUsage()
  for (let i = 0; i < 6; i++) {
    for (const [kind, idx, at] of [['direct', 0, 0], ['remux', 1, 0], ['seek', 1, 30]]) {
      const started = performance.now()
      const result = await play.play({ ih: 'fixture', idx, start: at, tab: 'bench', caps: { h264: true, aac: true } }, () => false)
      if (result.session) {
        const session = hls.get(result.session)
        for (let tries = 0; hls.stats(session).readyUntil <= 0; tries++) {
          if (tries > 1000 || session.exitCode) throw new Error('No playable output')
          await sleep(5)
        }
        hls.stop(session.id)
      }
      samples.push({ kind, cold: i === 0, ms: Number((performance.now() - started).toFixed(2)) })
    }
  }
  const used = process.cpuUsage(cpu)
  const series = telemetry ? (await telemetry.registry.metrics()).split('\n').filter(line => line && !line.startsWith('#')).length : 0
  const report = { mode, samples, nodeCpuMs: (used.user + used.system) / 1000, residentMiB: process.memoryUsage().rss / 1024 ** 2, eventLoopP99Ms: delay.percentile(99) / 1e6, records, logBytes, applicationTailRecords: logging.tail().length, series }
  delay.disable()
  await hls.close()
  telemetry?.close()
  await logging.flush()
  console.log(JSON.stringify(report))
}
