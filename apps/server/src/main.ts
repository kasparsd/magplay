// The process owns bootstrap logging, listeners and the bounded shutdown deadline.
import { createLogging } from '@magplay/observability'
import { loadConfig, loggingConfig } from './config.ts'
import { createApp } from './app.ts'
import type { App } from './app.ts'
import { installMdnsLookup } from './mdns.ts'
import { version } from './version.ts'

let logging = createLogging({ version })
let app: App | undefined
let uninstallMdns: (() => void) | undefined
let stopping = false
async function fail (err: unknown): Promise<never> {
  logging.logger.error('server.failed', { err })
  await logging.flush()
  process.exit(1)
}
async function shutdown (signal: NodeJS.Signals): Promise<void> {
  if (stopping) return
  stopping = true
  const started = performance.now()
  logging.logger.info('server.stopping', { signal }, 'shutting down')
  const deadline = setTimeout(() => { fail(new Error('Server shutdown took too long')).catch(() => process.exit(1)) }, 9500)
  deadline.unref()
  try {
    await app?.close()
    uninstallMdns?.()
    logging.logger.info('server.stopped', { signal, durationMs: performance.now() - started })
    await logging.flush()
    clearTimeout(deadline)
    process.exit(0)
  } catch (err) { await fail(err) }
}
try {
  const options = loggingConfig(process.env)
  await logging.flush()
  logging = createLogging({ version, level: options.logLevel })
  logging.logger.info('server.starting', { configurationRevision: 0 })
  const config = loadConfig(process.env, logging.logger.child({ component: 'settings' }))
  app = createApp({ config, logging })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { shutdown(signal).catch(fail) })
  }
  app.startupChecks()
  uninstallMdns = installMdnsLookup() ?? undefined
  if (uninstallMdns) logging.logger.info('server.mdns.enabled', {}, 'Resolving .local names through the host’s avahi-daemon')
  await app.listen()
  if (options.metricsEnabled) await app.listenMetrics()
} catch (err) {
  // Cleanup partial startup without letting a failed listener leave torrent ports open.
  const deadline = setTimeout(() => { process.exit(1) }, 9500)
  deadline.unref()
  await app?.close().catch(() => {})
  await fail(err)
}
