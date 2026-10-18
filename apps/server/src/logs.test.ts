import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureConsole } from './logs.ts'

test('captured and printed lines have API keys and URL passwords removed', () => {
  const printed: string[] = []
  const print = (...args: unknown[]): number => printed.push(args.join(' '))
  const sink = { debug: print, log: print, info: print, warn: print, error: print }
  const logs = captureConsole(sink as unknown as Console)
  sink.log('magplay listening on :8080, sources: %s', 'Jackett (jackett http://jackett:9117/api?apikey=s3cret)')
  sink.error('[search] failed', new Error('GET https://user:pw@prowlarr.lan/api failed'))
  assert.ok(!printed.join('\n').includes('s3cret') && !printed.join('\n').includes(':pw@'))
  assert.match(printed[0] ?? '', /apikey=\*\*\*/)
  assert.deepEqual(logs().map(l => l.level), ['info', 'error'])
  assert.ok(logs().every(l => !l.text.includes('s3cret') && !l.text.includes(':pw@')))
})
