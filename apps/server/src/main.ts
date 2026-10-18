// The magplay server process: config from env, the app, startup checks, and graceful shutdown on SIGTERM/SIGINT.
import { captureConsole } from './logs.ts'
import { loadConfig } from './config.ts'
import { createApp } from './app.ts'
import { installMdnsLookup } from './mdns.ts'

const SHUTDOWN_TIMEOUT_MS = 10_000

const logs = captureConsole() // first, so it sees every line

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}
const reason = (err: unknown): string => err instanceof Error ? err.message : String(err)

function attempt<T> (step: () => T, message: (err: unknown) => string): T {
  try {
    return step()
  } catch (err) {
    return fail(message(err))
  }
}

// An invalid env value stops startup, naming the variable
const config = attempt(() => loadConfig(process.env), reason)
const app = attempt(() => createApp({ config, logs }), err =>
  `Cannot create the cache directory ${config.current().cacheDir} (${reason(err)}). Set CACHE_DIR to a writable location, e.g. CACHE_DIR=./data`)

app.startupChecks()
if (installMdnsLookup()) console.log('Resolving .local names through the host’s avahi-daemon')
await app.listen().catch((err: unknown) => fail(`Cannot listen on port ${config.current().port}: ${reason(err)}`))

let stopping = false
async function shutdown (signal: NodeJS.Signals): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`[server] ${signal}: shutting down`)
  // Paused (SIGSTOPped) ffmpegs would outlive us; close() kills them. A stuck close still exits.
  setTimeout(() => fail('[server] shutdown took too long'), SHUTDOWN_TIMEOUT_MS).unref()
  await app.close()
  process.exit(0)
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((err: unknown) => fail(`[server] shutdown failed: ${reason(err)}`))
  })
}
