// Browser remux: the page reads /raw itself with Range requests, copies the video packets, converts the audio to AAC
// where the browser can't play it as it is, and feeds fragmented MP4 to Media Source Extensions. Used when the server
// has no ffmpeg. Conversion runs a bounded distance ahead of the playhead; a seek outside the buffered ranges restarts
// it from the keyframe before the target, with the output placed at that time so the timeline stays the whole file.
import { ALL_FORMATS, Conversion, EncodedPacketSink, Input, Mp4OutputFormat, Output, QUALITY_HIGH, StreamTarget, UrlSource } from 'mediabunny'
import type { InputAudioTrack, InputVideoTrack, StreamTargetChunk } from 'mediabunny'

export interface BrowserRemuxOptions {
  /** The same-origin /raw URL. */
  url: string
  /** Audio track index (among audio tracks) to include. */
  audio: number
  /** The whole file's duration in seconds, when known. */
  duration: number | null
  /** Where to begin, in seconds. */
  start: number
  /** A fatal problem: nothing more will play. */
  onError: (title: string, detail: string) => void
}

export interface BrowserRemuxStats {
  /** Seconds converted past the playhead (bounded by the look-ahead). */
  ahead: number
  /** Conversion speed relative to real time over the last stretch, when measured. */
  speed: number | null
  /** The whole requested range has been converted. */
  done: boolean
}

export interface BrowserRemux {
  stats: () => BrowserRemuxStats
  dispose: () => void
}

/** Convert this far past the playhead, then wait: memory for the Range cache and the SourceBuffer stays bounded. */
const AHEAD_S = 60
/** Buffered media further behind the playhead than this is evicted. */
const BEHIND_S = 30
/** The Range cache the demuxer keeps; the browser's own buffer holds the converted output. */
const CACHE_BYTES = 48 * 1024 ** 2

interface MediaSourceClass { new(): MediaSource, isTypeSupported: (type: string) => boolean }
const mediaSourceClass = (): MediaSourceClass | null => {
  const w = window as unknown as { ManagedMediaSource?: MediaSourceClass, MediaSource?: MediaSourceClass }
  return w.ManagedMediaSource ?? w.MediaSource ?? null
}

/** Browsers' own AAC encoders are missing on Linux Chrome and AC-3/DTS decoders everywhere, so the WASM ones register. */
let extensions: Promise<void> | null = null
async function loadExtensions (audioCodec: string | null): Promise<void> {
  extensions ??= (async () => {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
    registerAacEncoder()
  })()
  await extensions
  if (audioCodec === 'ac3' || audioCodec === 'eac3') (await import('@mediabunny/ac3')).registerAc3Decoder()
  if (audioCodec === 'dts') (await import('@mediabunny/dts')).registerDtsDecoder()
}

export async function startBrowserRemux (video: HTMLVideoElement, { url, audio, duration, start, onError }: BrowserRemuxOptions): Promise<BrowserRemux> {
  const MS = mediaSourceClass()
  if (!MS) throw new Error('This browser has no Media Source Extensions, which repackaging in the browser needs.')
  const input = new Input({ source: new UrlSource(url, { maxCacheSize: CACHE_BYTES, getRetryDelay: attempts => attempts < 5 ? Math.min(5, 0.5 * 2 ** attempts) : null }), formats: ALL_FORMATS })
  let videoTrack: InputVideoTrack | null
  let audioTracks: InputAudioTrack[]
  try {
    videoTrack = await input.getPrimaryVideoTrack()
    audioTracks = await input.getAudioTracks()
  } catch (err) {
    input.dispose()
    throw new Error(`Reading the file failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!videoTrack) { input.dispose(); throw new Error('No video track found in this file.') }
  const audioTrack = audioTracks[audio] ?? null
  await loadExtensions(audioTrack ? await audioTrack.getCodec() : null)

  const ms = new MS()
  if ('ManagedMediaSource' in window) video.disableRemotePlayback = true
  const objectUrl = URL.createObjectURL(ms)
  video.src = objectUrl
  await new Promise<void>(resolve => ms.addEventListener('sourceopen', () => resolve(), { once: true }))
  if (duration) ms.duration = duration

  let sb: SourceBuffer | null = null
  let generation = 0
  let conversion: Conversion | null = null
  let disposed = false
  let queue: Uint8Array[] = []
  let convertedUntil = 0 // media time the output has reached
  let target = start // where the latest run was asked to begin
  let speed: number | null = null
  let done = false
  // 'ended' (after endOfStream) still accepts appends and removals, which reopen it
  const open = (): boolean => !disposed && ms.readyState !== 'closed'

  let armed = false // the SourceBuffer is set up for the current run; until then output waits in the queue
  const pump = (): void => {
    if (!armed || !sb || sb.updating || !queue.length || !open()) return
    const total = queue.reduce((n, c) => n + c.byteLength, 0)
    const data = new Uint8Array(total)
    let at = 0
    for (const c of queue) { data.set(c, at); at += c.byteLength }
    queue = []
    try {
      sb.appendBuffer(data)
    } catch (err) {
      if ((err as DOMException).name === 'QuotaExceededError') {
        queue.unshift(data)
        if (!evict(true)) setTimeout(pump, 1000) // nothing to drop yet: playback has to move on first
        return
      }
      onError('Playback stopped', `The browser rejected converted media: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  /** Drops buffered media well behind the playhead, or harder when the browser ran out of room. */
  const evict = (hard = false): boolean => {
    if (!sb || sb.updating || !open()) return false
    const now = video.currentTime
    const floor = now - (hard ? 5 : BEHIND_S)
    for (let i = 0; i < sb.buffered.length; i++) {
      const a = sb.buffered.start(i)
      const b = sb.buffered.end(i)
      if (a < floor) {
        sb.remove(a, Math.min(b, floor))
        return true
      }
      if (hard && a > now + AHEAD_S) { // a stretch far ahead from before a seek
        sb.remove(a, b)
        return true
      }
    }
    return false
  }

  const fail = (err: unknown): void => {
    if (disposed) return
    const message = err instanceof Error ? err.message : String(err)
    onError('This browser could not repackage the file', message)
  }

  /** Starts converting at the keyframe before `at`, replacing any conversion in progress. */
  async function run (at: number): Promise<void> {
    const gen = ++generation
    const previous = conversion
    conversion = null
    armed = false
    done = false
    target = at
    convertedUntil = at
    queue = []
    if (previous) await previous.cancel().catch(() => {})
    if (gen !== generation || disposed) return
    const sink = new EncodedPacketSink(videoTrack!)
    const key = await sink.getKeyPacket(at, { metadataOnly: true }).catch(() => null) ?? await sink.getFirstPacket({ metadataOnly: true }).catch(() => null)
    if (gen !== generation || disposed) return
    const origin = Math.max(0, key?.timestamp ?? at)
    convertedUntil = origin
    const writable = new WritableStream<StreamTargetChunk>({
      write (chunk) {
        if (gen !== generation || disposed) return
        queue.push(chunk.data)
        pump()
      },
    })
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }), target: new StreamTarget(writable) })
    let next: Conversion
    try {
      next = await Conversion.init({
        input,
        output,
        video: track => track.id === videoTrack!.id ? {} : { discard: true },
        audio: track => track.id !== audioTrack?.id ? { discard: true } : track.codec === 'aac' ? {} : { codec: 'aac', numberOfChannels: Math.min(2, track.numberOfChannels), quality: QUALITY_HIGH },
        trim: { start: origin },
        copy: { boundaryPolicy: 'expand' },
        tags: {},
        showWarnings: false,
      })
    } catch (err) { return fail(err) }
    if (gen !== generation || disposed) { await next.cancel().catch(() => {}); return }
    const dropped = next.discardedTracks.find(d => d.track.id === videoTrack!.id)
    if (dropped) return fail(new Error(`The video can't be copied into MP4 (${dropped.reason.replace(/_/g, ' ')}).`))
    if (!next.isValid) return fail(new Error('The output configuration is not valid for this file.'))
    conversion = next
    let lastWall = performance.now()
    let lastMedia = origin
    next.onProgress = (_progress, processedTime) => {
      convertedUntil = origin + processedTime
      const wall = performance.now()
      if (wall - lastWall > 2000) {
        speed = (convertedUntil - lastMedia) / ((wall - lastWall) / 1000)
        lastWall = wall
        lastMedia = convertedUntil
      }
    }
    const lookAhead = (): number => Math.max(0, video.currentTime - origin) + AHEAD_S
    try {
      // The MIME type (with the encoded audio's codec string) is known only once conversion has produced the first
      // packets, so conversion starts first and the SourceBuffer is set up when it arrives; output waits in the queue.
      let executing = next.execute({ until: lookAhead() })
      const mime = await Promise.race([output.getMimeType(), executing.then(() => output.getMimeType())])
      if (gen !== generation || disposed || !open()) return
      if (!MS!.isTypeSupported(mime)) return fail(new Error(`This browser can't play ${mime} through Media Source Extensions.`))
      if (!sb) {
        sb = ms.addSourceBuffer(mime)
        sb.addEventListener('updateend', () => { evict(); pump() })
        sb.addEventListener('error', () => onError('Playback stopped', 'The browser could not decode the converted media.'))
      } else {
        if (sb.updating) sb.abort()
        try { sb.changeType(mime) } catch { /* same codecs */ }
      }
      sb.timestampOffset = origin
      armed = true
      pump()
      for (;;) {
        await executing
        if (gen !== generation || disposed) return
        if (next.state === 'done') break
        await new Promise<void>(resolve => {
          const timer = setTimeout(finish, 1000)
          function finish (): void { clearTimeout(timer); video.removeEventListener('timeupdate', finish); video.removeEventListener('seeking', finish); resolve() }
          video.addEventListener('timeupdate', finish, { once: true })
          video.addEventListener('seeking', finish, { once: true })
        })
        if (gen !== generation || disposed) return
        executing = next.execute({ until: lookAhead() })
      }
      done = true
      speed = null
      // The end of the file is in the buffer once the queue drains; a seek back before `origin` reopens the source
      const finished = (): void => {
        if (gen !== generation || !open() || !sb) return
        if (sb.updating || queue.length) { setTimeout(finished, 100); return }
        try { ms.endOfStream() } catch { /* already ended */ }
      }
      finished()
    } catch (err) {
      if (gen !== generation || disposed) return
      if ((err as Error).name === 'ConversionCanceledError') return
      fail(err)
    }
  }

  /** A seek outside what the browser has buffered means converting from there. */
  const onSeeking = (): void => {
    if (disposed) return
    const t = video.currentTime
    for (let i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) - 0.5 && t <= video.buffered.end(i) + 0.5) return
    }
    // Converting towards the target already (or about to): let it arrive rather than restarting
    if (!done && t >= target - 0.5 && t < Math.max(target, convertedUntil) + AHEAD_S) return
    run(t).catch(fail)
  }
  video.addEventListener('seeking', onSeeking)
  run(start).catch(fail)

  return {
    stats: () => ({ ahead: Math.max(0, convertedUntil - video.currentTime), speed, done }),
    dispose () {
      if (disposed) return
      disposed = true
      generation++
      video.removeEventListener('seeking', onSeeking)
      conversion?.cancel().catch(() => {})
      conversion = null
      input.dispose()
      if (video.src === objectUrl) video.removeAttribute('src')
      URL.revokeObjectURL(objectUrl)
    },
  }
}
