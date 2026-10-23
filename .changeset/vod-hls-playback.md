---
"@magplay/server": minor
---

Seeking in a remuxed or converted video is now an ordinary seek. The player gets one playlist for the whole file, the server converts whatever part you jump to, and parts already converted play straight away when you seek back. Subtitles and the seek bar stay in step after seeks and audio switches. Files without a keyframe index (MPEG-TS, AVI) play from the start and can be seeked as far as conversion has reached.
