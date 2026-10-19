---
"@magplay/server": patch
---

Fix a large empty box in the Settings Playback heading: its status slot shared the player wait-overlay's element id, so the global stylesheet gave it the overlay's huge padding.
