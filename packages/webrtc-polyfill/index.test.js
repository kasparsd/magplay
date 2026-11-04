import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import Peer from '@thaunknown/simple-peer/lite.js'

// A `wss://` tracker makes bittorrent-tracker create WebRTC peers. Without the real addon each one must fail as a
// peer error (which the tracker reports as a warning), not throw out of the process.
test('a WebRTC peer fails with an error event instead of throwing', async () => {
  const peer = new Peer({ initiator: true, trickle: false })
  const [err] = await once(peer, 'error')
  assert.equal(err.code, 'ERR_PC_CONSTRUCTOR')
  assert.match(err.message, /WebRTC is not available/)
})
