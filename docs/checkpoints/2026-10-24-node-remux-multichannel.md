# Node remux of multichannel audio: validation (2026-10-24)

Evidence for the Node remux in [playback decisions](../architecture.md). macOS, Node 26.12, Mediabunny 1.61.6.

## The hang

A 30 s 1080p H.264 MKV with 5.1 AC-3 (`-ac 6 -c:a ac3 -b:a 384k`) never finished: the producer wrote the 28-byte `ftyp` and then spun at 100% CPU with no output and no error. The same file with stereo AC-3 remuxed in under 1 s.

Mediabunny remixes or resamples audio through `AudioResampler`, which fills a 5 s buffer before it hands any audio to the encoder. With the 5.1 file, a direct `Conversion` run with `until: 10` wrote nothing; its first fragments came out during the next step. Asked for 6 channels instead of 2 (no resampler), it wrote 8.3 MB by the same point. The producer asked for `until: produced + 10`, where `produced` is the start of the last video fragment it emitted, so with no fragment `until` stayed at 10, every `execute()` returned at once, and the microtask loop starved the event loop (timers never fired). 5.0 AC-3 (through the resampler) hung the same way.

## After the fix

5.1 is downmixed in a `process` function (no resampler) and the run advances `until` by 10 s per step, failing after 60 s without a video fragment.

| Input (30 s unless noted) | Result |
| --- | --- |
| 1080p, AC-3 5.1 384k | 0.73 s, stereo AAC; mean volume −31.8 dB vs −32.0 dB for ffmpeg's `aformat=channel_layouts=stereo` |
| 1080p, AC-3 stereo | 0.75 s, unchanged |
| 360p, E-AC-3 5.1 | 0.88 s, stereo AAC, −31.8 dB |
| 360p, DTS 5.1 (`dca`) | 1.19 s, stereo AAC, −31.7 dB |
| 360p, AC-3 5.0 at 44.1 kHz (through the resampler) | 1.25 s, stereo AAC; the previous producer still hangs on it |
| AC-3 5.1 at 32 kHz | 1.75 s, stereo AAC at 32 kHz |

`test-fixtures/h264-ac3-5.1-5.0.mkv` (16 s, 64×36, 32 kbps AC-3 5.1 and 5.0 tracks) hangs the previous producer on either track; `node-remux.test.ts` remuxes both to the end.
