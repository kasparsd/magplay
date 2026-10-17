import { execFile as execFileCallback } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { promisify } from 'node:util'
import { sourceHealthRequest } from './sources/index.js'

const execFile = promisify(execFileCallback)
const rank = { unknown: 0, ok: 1, warn: 2, error: 3 }

/** TTL-cached status registry. Checks run only when somebody requests status. */
export function createStatus ({ config, now = () => Date.now(), fetchImpl = fetch, statfsImpl = statfs, exec = execFile } = {}) {
  const checks = new Map()
  const cache = new Map()
  const events = []
  let restartNeeded = false

  const event = entry => {
    events.unshift({ at: now(), ...entry })
    events.splice(50)
  }
  const registerCheck = check => { checks.set(check.id, check); return () => checks.delete(check.id) }
  const record = (id, result) => {
    const previous = cache.get(id)?.result
    cache.set(id, { at: now(), result })
    if ((!previous && result.level !== 'ok') || (previous && previous.level !== result.level)) event({ checkId: id, level: result.level, message: result.message || result.value || checkLabel(id) })
    return result
  }
  const run = async check => {
    const hit = cache.get(check.id)
    if (hit && now() - hit.at < check.ttl) return hit.result
    try { return record(check.id, await check.run()) } catch (err) { return record(check.id, { level: 'error', message: plainError(err) }) }
  }
  const snapshot = async () => {
    const results = await Promise.all([...checks.values()].map(async check => ({ id: check.id, label: check.label, required: !!check.required, ...(await run(check)) })))
    results.sort((a, b) => rank[b.level] - rank[a.level] || a.label.localeCompare(b.label))
    const required = results.filter(check => check.required)
    const level = required.some(check => check.level === 'unknown') ? 'unknown' : results.reduce((worst, check) => rank[check.level] > rank[worst] ? check.level : worst, 'ok')
    return { level, checks: results, events }
  }

  for (const bin of [[config.ffmpegPath, 'ffmpeg'], [config.ffprobePath, 'ffprobe']]) {
    registerCheck({
      id: bin[1],
      label: bin[1],
      ttl: Infinity,
      required: true,
      async run () {
        const { stdout } = await exec(bin[0], ['-version'], { timeout: 5000 })
        const version = stdout.match(/\bversion\s+(\S+)/i)?.[1]
        return { level: 'ok', value: version ? `version ${version}` : 'Installed' }
      }
    })
  }
  registerCheck({
    id: 'disk',
    label: 'Disk space',
    ttl: 30_000,
    required: true,
    async run () {
      const disk = await statfsImpl(config.cacheDir)
      const free = Number(disk.bavail) * Number(disk.bsize)
      const gb = free / 1024 ** 3
      const floor = config.minFreeBytes / 1024 ** 3
      return { level: gb < floor ? 'error' : gb < floor * 2 ? 'warn' : 'ok', value: `${gb.toFixed(1)} GB free`, message: gb < floor ? 'Free space is below the configured floor.' : undefined, action: gb < floor ? '/settings' : undefined }
    }
  })
  registerCheck({
    id: 'explore',
    label: 'Explore',
    ttl: 60_000,
    required: false,
    async run () {
      if (!config.bitmagnetUrl) return { level: 'warn', value: 'Not configured', message: 'Explore needs BitMagnet’s address.', action: '/settings' }
      const response = await fetchImpl(config.bitmagnetUrl, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) return { level: 'error', value: `HTTP ${response.status}`, message: 'Explore did not answer successfully.', action: '/settings' }
      return { level: 'ok', value: 'Connected' }
    }
  })
  registerCheck({
    id: 'restart',
    label: 'Restart',
    ttl: 0,
    required: false,
    run: () => restartNeeded
      ? { level: 'warn', value: 'Needed', message: 'Restart magplay to apply saved connection settings.', action: '/settings' }
      : { level: 'ok', value: 'Not needed' }
  })

  function refreshSources () {
    for (const id of [...checks.keys()]) if (id.startsWith('source:')) checks.delete(id)
    for (const source of config.sources) {
      registerCheck({
        id: `source:${source.name}`,
        label: source.name,
        ttl: 60_000,
        required: true,
        async run () {
          const { url, headers } = sourceHealthRequest(source)
          const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) })
          if (response.status === 401 || response.status === 403) return { level: 'error', value: 'API key refused', message: 'The source refused its API key.', action: '/settings' }
          if (!response.ok) return { level: 'error', value: `HTTP ${response.status}`, message: 'The source did not answer successfully.', action: '/settings' }
          return { level: 'ok', value: 'Connected' }
        },
      })
    }
  }
  refreshSources()

  return {
    registerCheck,
    snapshot,
    refreshSources,
    settingsSaved (keys) {
      if (keys.some(key => ['port', 'torrentPort', 'cacheDir', 'dhtEnabled', 'lsdEnabled'].includes(key))) restartNeeded = true
      event({ checkId: 'settings', level: 'ok', message: `Settings saved: ${keys.join(', ')}` })
    },
  }
}

const plainError = err => err?.name === 'TimeoutError' ? 'Timed out. Try again in a moment.' : 'Could not run this check.'
const checkLabel = id => id.replace(/^source:/, '')
