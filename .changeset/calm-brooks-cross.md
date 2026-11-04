---
"@magplay/server": patch
---

The image no longer carries node-datachannel, a 9 MB native WebRTC module magplay never used. WebRTC peers from `wss://` trackers are not supported; peers still connect over TCP and UDP.
