// Stands in for the registry's `webrtc-polyfill`, which bittorrent-tracker's simple-peer imports at startup and
// which loads the native `node-datachannel` addon. magplay peers over TCP and UDP only, so that WebRTC stack is
// never wanted. This workspace has the same name and version, so npm links it in the package's place. If a `wss://`
// tracker ever offers a WebRTC peer, creating the connection throws this error and simple-peer reports it,
// instead of the peer hanging.
const unsupported = () => new Error('WebRTC is not available in this build: magplay peers over TCP and UDP only')

export class RTCPeerConnection {
  constructor () { throw unsupported() }
}

export class RTCSessionDescription {
  constructor () { throw unsupported() }
}

export class RTCIceCandidate {
  constructor () { throw unsupported() }
}
