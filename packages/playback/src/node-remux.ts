// Remux in the Node process for a browser that can't repackage a file itself, on a server without ffmpeg.
// Mediabunny copies the video and converts the audio to AAC, and the fragmented MP4 is published as the same
// fMP4 HLS (init.mp4, seg_NNNNN.m4s, index.m3u8) an ffmpeg session writes, so the player doesn't grow a new path.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Worker as WorkerInstance } from 'node:worker_threads'
import { ALL_FORMATS, Conversion, FilePathSource, Input, Mp4OutputFormat, Output, QUALITY_HIGH, StreamTarget, UrlSource } from 'mediabunny'
import type { InputAudioTrack, InputVideoTrack, StreamTargetChunk } from 'mediabunny'

const require = createRequire(import.meta.url)

/** How far past the playhead to convert before waiting. */
const AHEAD_S = 60
/** One HLS segment, matching ffmpeg's `-hls_time 6`. */
const FRAGMENT_S = 6

export interface NodeRemuxOptions {
  /** A /raw URL or a local path. */
  input: string
  dir: string
  /** Audio track index among the file's audio tracks. */
  audio: number
  /** Start at this time in the input; output timestamps begin at zero. */
  start: number
  signal: AbortSignal
  /** The player's position within this session's output, in seconds. */
  position: () => number
  /** Seconds of output produced, and speed relative to real time. */
  onOutput: (seconds: number, speed: number | null) => void
}

interface Box { type: string, data: Buffer }

const owners = new AsyncLocalStorage<WorkerInstance[]>()
let prepared: Promise<void> | null = null

/**
 * The AAC/AC-3/DTS extensions run their WASM in a worker_threads Worker whose script calls `require`.
 * Node runs that eval as an ES module, where `require` doesn't exist, so the worker is given one.
 * Importing the packages on the main thread also touches `self` and starts a keepalive timer meant for Firefox.
 */
async function prepare (): Promise<void> {
  prepared ??= (async () => {
    const moduleWorker = await new Promise<boolean>(resolve => {
      const probe = new Worker('try { require(\'node:worker_threads\'); parentPort.postMessage(false) } catch { throw new Error(\'esm\') }', { eval: true })
      probe.on('message', () => { resolve(false); probe.terminate().catch(() => {}) })
      probe.on('error', () => resolve(true))
    })
    const threads = require('node:worker_threads') as { Worker: typeof Worker }
    const Original = threads.Worker
    threads.Worker = class extends Original {
      constructor (script: string | URL, options?: ConstructorParameters<typeof Worker>[1]) {
        const source = moduleWorker && options?.eval && typeof script === 'string'
          ? `import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);\n${script}`
          : script
        super(source, options)
        owners.getStore()?.push(this)
      }
    }
    const global = globalThis as { self?: { addEventListener: () => void, postMessage: () => void } }
    global.self ??= { addEventListener () {}, postMessage () {} }
    const original = globalThis.setInterval
    globalThis.setInterval = (handler: () => void, timeout?: number) => {
      const timer = original(handler, timeout)
      ;(timer as { unref?: () => void }).unref?.()
      return timer
    }
    try {
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
      const { registerAc3Decoder } = await import('@mediabunny/ac3')
      const { registerDtsDecoder } = await import('@mediabunny/dts')
      registerAacEncoder()
      registerAc3Decoder()
      registerDtsDecoder()
    } finally {
      globalThis.setInterval = original
    }
  })()
  await prepared
}

function boxes (buf: Buffer): Box[] {
  const found: Box[] = []
  let offset = 0
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > buf.length) break
      size = Number(buf.readBigUInt64BE(offset + 8))
      header = 16
    }
    if (size < header || offset + size > buf.length) break
    found.push({ type, data: buf.subarray(offset + header, offset + size) })
    offset += size
  }
  return found
}

/** track id → media timescale, from each trak's tkhd and mdhd. */
function trackTimescales (moov: Buffer): Map<number, number> {
  const scales = new Map<number, number>()
  for (const trak of boxes(moov).filter(box => box.type === 'trak')) {
    const tkhd = boxes(trak.data).find(box => box.type === 'tkhd')
    const mdia = boxes(trak.data).find(box => box.type === 'mdia')
    const mdhd = mdia && boxes(mdia.data).find(box => box.type === 'mdhd')
    if (!tkhd || tkhd.data.length < 16 || !mdhd || mdhd.data.length < 16) continue
    const id = tkhd.data.readUInt32BE(tkhd.data[0] === 1 ? 20 : 12)
    const scale = mdhd.data.readUInt32BE(mdhd.data[0] === 1 ? 20 : 12)
    if (id && scale) scales.set(id, scale)
  }
  return scales
}

/** Seconds of media in one moof, the longest of its tracks. */
function fragmentSeconds (moof: Buffer, scales: Map<number, number>): number {
  let longest = 0
  for (const traf of boxes(moof).filter(box => box.type === 'traf')) {
    let trackId = 0
    let fallback = 0
    let samples = 0
    for (const box of boxes(traf.data)) {
      if (box.type === 'tfhd' && box.data.length >= 8) {
        const flags = box.data.readUInt32BE(0) & 0xffffff
        let offset = 4
        trackId = box.data.readUInt32BE(offset)
        offset += 4
        if (flags & 0x1) offset += 8
        if (flags & 0x2) offset += 4
        if ((flags & 0x8) && offset + 4 <= box.data.length) fallback = box.data.readUInt32BE(offset)
      }
      if (box.type === 'trun' && box.data.length >= 8) {
        const flags = box.data.readUInt32BE(0) & 0xffffff
        const count = box.data.readUInt32BE(4)
        let offset = 8
        if (flags & 0x1) offset += 4
        if (flags & 0x4) offset += 4
        const duration = !!(flags & 0x100)
        const size = !!(flags & 0x200)
        const sampleFlags = !!(flags & 0x400)
        const timeOffset = !!(flags & 0x800)
        const step = (duration ? 4 : 0) + (size ? 4 : 0) + (sampleFlags ? 4 : 0) + (timeOffset ? 4 : 0)
        if (step === 0) {
          samples += count * fallback
        } else {
          for (let i = 0; i < count && offset + step <= box.data.length; i++) {
            samples += duration ? box.data.readUInt32BE(offset) : fallback
            offset += step
          }
        }
      }
    }
    const scale = scales.get(trackId) ?? 0
    if (scale) longest = Math.max(longest, samples / scale)
  }
  return longest
}

/** Copies video and converts audio into an fMP4 HLS playlist. Resolves when the input is done or the signal aborts. */
export async function runNodeRemux ({ input, dir, audio, start, signal, position, onOutput }: NodeRemuxOptions): Promise<void> {
  await prepare()
  const workers: WorkerInstance[] = []
  await owners.run(workers, async () => {
    try {
      await convert(input, dir, audio, start, signal, position, onOutput)
    } finally {
      for (const worker of workers) await worker.terminate()
    }
  })
}

async function convert (input: string, dir: string, audio: number, start: number, signal: AbortSignal, position: () => number, onOutput: (seconds: number, speed: number | null) => void): Promise<void> {
  const source = /^https?:\/\//i.test(input)
    ? new UrlSource(input, { maxCacheSize: 48 * 1024 ** 2, getRetryDelay: attempts => attempts < 5 ? Math.min(5, 0.5 * 2 ** attempts) : null })
    : new FilePathSource(input)
  const media = new Input({ source, formats: ALL_FORMATS })
  let conversion: Conversion | null = null
  const stop = (): void => { conversion?.cancel().catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    const video = await media.getPrimaryVideoTrack()
    const audios = await media.getAudioTracks()
    if (!video) throw new Error('No video track found in this file.')
    const chosen = audios[audio] ?? null
    const segments: number[] = []
    let scales = new Map<number, number>()
    let init: Buffer[] = []
    let moof: Buffer | null = null
    let produced = 0
    let lastWall = performance.now()
    let lastMedia = 0
    const publish = async (): Promise<void> => {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.max(1, ...segments.map(seconds => Math.ceil(seconds)))}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MAP:URI="init.mp4"']
      segments.forEach((seconds, index) => {
        lines.push(`#EXTINF:${seconds.toFixed(3)},`, `seg_${String(index).padStart(5, '0')}.m4s`)
      })
      if (conversion?.state === 'done') lines.push('#EXT-X-ENDLIST')
      const file = path.join(dir, 'index.m3u8')
      await fs.writeFile(`${file}.tmp`, lines.join('\n') + '\n')
      await fs.rename(`${file}.tmp`, file)
    }
    const emit = async (box: Box): Promise<void> => {
      if (box.type === 'ftyp' || box.type === 'moov') {
        init.push(box.data.length ? Buffer.concat([header(box), box.data]) : header(box))
        if (box.type === 'moov') {
          scales = trackTimescales(box.data)
          await fs.writeFile(path.join(dir, 'init.mp4'), Buffer.concat(init))
          init = []
        }
        return
      }
      if (box.type === 'moof') { moof = Buffer.concat([header(box), box.data]); return }
      if (box.type === 'mdat' && moof) {
        const seconds = fragmentSeconds(moof.subarray(8), scales) || FRAGMENT_S
        const name = `seg_${String(segments.length).padStart(5, '0')}.m4s`
        const file = path.join(dir, name)
        await fs.writeFile(`${file}.tmp`, Buffer.concat([moof, header(box), box.data]))
        await fs.rename(`${file}.tmp`, file)
        moof = null
        segments.push(seconds)
        produced += seconds
        const wall = performance.now()
        const speed = wall - lastWall > 0 ? (produced - lastMedia) / ((wall - lastWall) / 1000) : null
        lastWall = wall
        lastMedia = produced
        await publish()
        onOutput(produced, speed)
      }
    }
    // The muxer writes at absolute positions and may patch earlier bytes; keep the unpublished tail only.
    let file = Buffer.alloc(0)
    let base = 0
    let end = 0
    let scan = 0
    const take = async (): Promise<void> => {
      for (;;) {
        const offset = scan - base
        if (offset + 8 > end - base || offset < 0) return
        let size = file.readUInt32BE(offset)
        let headerLength = 8
        if (size === 1) {
          if (offset + 16 > end - base) return
          size = Number(file.readBigUInt64BE(offset + 8))
          headerLength = 16
        }
        if (size < headerLength || scan + size > end) return
        const data = Buffer.from(file.subarray(offset, offset + size))
        scan += size
        await emit({ type: data.toString('ascii', 4, 8), data: data.subarray(headerLength) })
        if (scan - base > 1024 ** 2) {
          file = file.subarray(scan - base)
          base = scan
        }
      }
    }
    const writable = new WritableStream<StreamTargetChunk>({
      async write (chunk) {
        const need = chunk.position + chunk.data.byteLength
        if (chunk.position < base) return
        if (need - base > file.length) {
          const grown = Buffer.alloc(Math.max(need - base, file.length * 2, 64 * 1024))
          file.copy(grown, 0, 0, end - base)
          file = grown
        }
        Buffer.from(chunk.data).copy(file, chunk.position - base)
        if (chunk.position <= end) end = Math.max(end, need)
        await take()
      },
    })
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: FRAGMENT_S }), target: new StreamTarget(writable) })
    conversion = await Conversion.init({
      input: media,
      output,
      video: (track: InputVideoTrack) => track.id === video.id ? {} : { discard: true },
      audio: (track: InputAudioTrack) => track.id !== chosen?.id ? { discard: true } : track.codec === 'aac' ? {} : { codec: 'aac', numberOfChannels: Math.min(2, track.numberOfChannels), quality: QUALITY_HIGH },
      trim: { start },
      copy: { boundaryPolicy: 'expand' },
      tags: {},
      showWarnings: false,
    })
    if (signal.aborted) return
    const dropped = conversion.discardedTracks.find(entry => entry.track.id === video.id)
    if (dropped) throw new Error(`The video can't be copied into MP4 (${dropped.reason.replace(/_/g, ' ')}).`)
    if (!conversion.isValid) throw new Error('The output configuration is not valid for this file.')
    while (!signal.aborted) {
      const until = Math.max(0, position()) + AHEAD_S
      if (produced >= until && conversion.state !== 'done') {
        await new Promise(resolve => setTimeout(resolve, 200))
        continue
      }
      await conversion.execute({ until })
      if (conversion.state === 'done') break
    }
    if (conversion.state === 'done') await publish()
  } finally {
    signal.removeEventListener('abort', stop)
    media.dispose()
  }
}

function header (box: Box): Buffer {
  const size = 8 + box.data.length
  const bytes = Buffer.alloc(8)
  bytes.writeUInt32BE(size, 0)
  bytes.write(box.type, 4, 'ascii')
  return bytes
}
