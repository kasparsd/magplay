---
"@magplay/server": patch
---

The default image is 100 MB smaller (125 MB instead of 228 MB unpacked, 43 MB instead of 86 MB to download): its ffmpeg is built with only the codecs and formats magplay uses, and the browser's source maps are no longer shipped or served.
