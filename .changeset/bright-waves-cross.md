---
"@magplay/server": patch
"@magplay/playback": patch
---

Videos with 5.1 or other multichannel audio play on iPhones and other browsers without Media Source Extensions when the server has no ffmpeg, instead of never starting. If that conversion ever stops producing video, playback now fails with an error instead of waiting forever.
