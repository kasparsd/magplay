// Isolated local-stack acceptance. It never starts, reconfigures or removes the user's Compose project.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const project = `magplay-observability-check-${process.pid}`
const basePort = 35_000 + (process.pid % 10_000)
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  MAGPLAY_PORT: String(basePort),
  TORRENT_PORT: String(basePort + 1),
  JACKETT_PORT: String(basePort + 2),
  PROWLARR_PORT: String(basePort + 3),
  GRAFANA_PORT: String(basePort + 4),
  DOCKER_SUBNET: `10.78.${process.pid % 200}.0/24`
}
const docker = async (...args) => (await exec('docker', args, {
  env: environment,
  timeout: 180_000,
  maxBuffer: 1024 ** 2
})).stdout.trim()
const compose = (...args) => docker('compose', '--project-name', project, ...args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (label, predicate) => {
  let lastError
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(2_000)
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : ''}`)
}
const prometheus = async query => JSON.parse(await compose(
  'exec', '-T', 'prometheus', 'wget', '-qO-',
  `http://localhost:9090/api/v1/query?query=${encodeURIComponent(query)}`
))
const loki = async query => JSON.parse(await compose(
  'exec', '-T', 'prometheus', 'wget', '-qO-',
  `http://loki:3100/loki/api/v1/query_range?query=${encodeURIComponent(query)}&limit=100`
))
const report = { project, checks: [] }
let started = false

try {
  started = true
  await compose('--profile', 'observability', 'up', '--detach', '--build')

  await waitFor('Prometheus scrape of magplay', async () => {
    const response = await prometheus('up{job="magplay"}')
    return response.data?.result?.some(sample => sample.value?.[1] === '1')
  })
  report.checks.push('Prometheus scraped magplay metrics through the private network')

  const logStreams = await waitFor('Alloy log ingestion into Loki', async () => {
    const response = await loki('{service="magplay"}')
    const streams = response.data?.result?.filter(stream => stream.values?.some(([, line]) => line.includes('"event"'))) ?? []
    return streams.length > 0 ? streams : false
  })
  assert.ok(logStreams.length > 0)
  report.checks.push('Alloy collected structured magplay Docker logs into Loki')

  const grafana = async path => JSON.parse(await compose(
    'exec', '-T', 'grafana', 'curl', '--fail', '--silent', '--show-error', `http://localhost:3000${path}`
  ))
  await waitFor('Grafana', async () => (await grafana('/api/health')).database === 'ok')
  const [metricsHealth, logsHealth, dashboard] = await Promise.all([
    grafana('/api/datasources/uid/magplay-prometheus/health'),
    grafana('/api/datasources/uid/magplay-loki/health'),
    grafana('/api/dashboards/uid/magplay-overview')
  ])
  assert.equal(metricsHealth.status, 'OK')
  assert.equal(logsHealth.status, 'OK')
  assert.equal(dashboard.dashboard?.panels?.length, 9)
  report.grafana = { url: `http://127.0.0.1:${environment.GRAFANA_PORT}`, dashboard: dashboard.dashboard.title, panels: dashboard.dashboard.panels.length }
  report.checks.push('Grafana provisioned both data sources and the overview dashboard')

  console.log(JSON.stringify(report, null, 2))
} finally {
  if (started) await compose('--profile', 'observability', 'down', '--volumes', '--remove-orphans').catch(() => {})
}
