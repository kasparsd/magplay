---
"@magplay/server": patch
---

Audio no longer runs ahead of video in converted (HLS) playback in Chrome and Firefox, most noticeably after resuming or seeking to a position. Playback resumed mid-scene now begins at the preceding keyframe with sound, instead of silent video before the audio joins.
