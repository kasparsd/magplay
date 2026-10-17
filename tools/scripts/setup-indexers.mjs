#!/usr/bin/env node
// For the local compose stack: adds the indexers named on the command line to Jackett and Prowlarr through their APIs,
// writes their API keys to .env and recreates magplay so it picks them up.
//   node tools/scripts/setup-indexers.mjs [indexer ...]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Everything below resolves against the repository root, wherever the script is started from.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const localPath = (...segments) => path.join(ROOT, ...segments)

const INDEXERS = process.argv.slice(2)
const JACKETT = 'http://localhost:9117'
const PROWLARR = 'http://localhost:9696'

async function waitFor (url) {
  for (let i = 0; i < 60; i++) {
    if (await fetch(url, { redirect: 'manual' }).then(r => r.status < 500, () => false)) return
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`${url} didn't come up; is "docker compose up -d" running?`)
}

async function json (res, what) {
  const body = await res.text()
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${body.slice(0, 200)}`)
  return body ? JSON.parse(body) : null
}

async function jackettSession () {
  const jar = new Map([['TestCookie', '1']])
  let url = `${JACKETT}/UI/Login`
  for (let hop = 0; hop < 5 && !jar.has('Jackett'); hop++) {
    const res = await fetch(url, { redirect: 'manual', headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      jar.set(pair.slice(0, i), pair.slice(i + 1))
    }
    if (!res.headers.get('location')) break
    url = new URL(res.headers.get('location'), url).href
  }
  if (!jar.has('Jackett')) throw new Error('No Jackett session; is an admin password set? Remove it, or add indexers in the Jackett UI.')
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function setupJackett () {
  await waitFor(`${JACKETT}/UI/Login`)
  const apiKey = JSON.parse(fs.readFileSync(localPath('tools/docker/jackett/config/Jackett/ServerConfig.json'), 'utf8')).APIKey
  // The admin API needs a session cookie. Without an admin password, the login page issues one after a cookie check:
  // /UI/Login -> TestCookie -> Login?cookiesChecked=1 (sets Jackett=…)
  const cookie = await jackettSession()
  const configured = new Set((await json(await fetch(`${JACKETT}/api/v2.0/indexers?configured=true`, { headers: { cookie } }), 'Jackett indexers')).map(i => i.id))
  for (const id of INDEXERS) {
    if (configured.has(id)) { console.log(`Jackett   ${id}: already added`); continue }
    try {
      const config = await json(await fetch(`${JACKETT}/api/v2.0/indexers/${id}/config`, { headers: { cookie } }), 'config')
      await json(await fetch(`${JACKETT}/api/v2.0/indexers/${id}/config`, {
        method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(config),
      }), 'save')
      console.log(`Jackett   ${id}: added`)
    } catch (err) {
      console.log(`Jackett   ${id}: FAILED ${err.message}`)
    }
  }
  return apiKey
}

async function setupProwlarr () {
  await waitFor(`${PROWLARR}/ping`)
  const apiKey = fs.readFileSync(localPath('tools/docker/prowlarr/config/config.xml'), 'utf8').match(/<ApiKey>([^<]+)/)[1]
  const headers = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }
  const schemas = await json(await fetch(`${PROWLARR}/api/v1/indexer/schema`, { headers }), 'Prowlarr schema')
  const existing = new Set((await json(await fetch(`${PROWLARR}/api/v1/indexer`, { headers }), 'Prowlarr indexers')).map(i => i.definitionName))
  for (const id of INDEXERS) {
    if (existing.has(id)) { console.log(`Prowlarr  ${id}: already added`); continue }
    const schema = schemas.find(s => s.definitionName === id)
    if (!schema) { console.log(`Prowlarr  ${id}: no such definition`); continue }
    try {
      await json(await fetch(`${PROWLARR}/api/v1/indexer`, {
        method: 'POST', headers, body: JSON.stringify({ ...schema, name: schema.name, enable: true, appProfileId: 1, priority: 25 }),
      }), 'add')
      console.log(`Prowlarr  ${id}: added`)
    } catch (err) {
      console.log(`Prowlarr  ${id}: FAILED ${err.message.replace(/\s+/g, ' ')}`)
    }
  }
  return apiKey
}

function writeEnv (values) {
  const envPath = localPath('.env')
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n').filter(l => l && !Object.keys(values).some(k => l.startsWith(`${k}=`))) : []
  fs.writeFileSync(envPath, [...lines, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n')
}

const jackettKey = await setupJackett()
const prowlarrKey = await setupProwlarr()
writeEnv({ JACKETT_APIKEY: jackettKey, PROWLARR_APIKEY: prowlarrKey })
console.log('Wrote API keys to .env; recreating magplay…')
execFileSync('docker', ['compose', 'up', '-d', 'magplay'], { cwd: ROOT, stdio: 'inherit' })
