import { test } from 'node:test'
import assert from 'node:assert/strict'
import { announceList } from './trackers.ts'

const own = ['udp://own:1/announce']
const extras = ['udp://own:1/announce', 'udp://public:2/announce']

test('extra trackers join a public torrent or magnet without repeating its own', () => {
  assert.deepEqual(announceList({ announce: own, private: false }, extras), ['udp://own:1/announce', 'udp://public:2/announce'])
  assert.deepEqual(announceList({}, extras), extras)
})

test('a private torrent keeps only its own trackers', () => {
  assert.deepEqual(announceList({ announce: own, private: true }, extras), own)
  assert.deepEqual(announceList({ private: true }, extras), [])
})

test('with no extras the torrent keeps what it has', () => {
  assert.deepEqual(announceList({ announce: own }, []), own)
})
