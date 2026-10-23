// Remux in the Node process for a browser that can't repackage a file itself, on a server without ffmpeg.
// Mediabunny copies the video and converts the audio to AAC. The run looks to an HLS session like an ffmpeg run:
// fragmented MP4 with a fragment at every keyframe on fd 3, progress on stdout, and SIGSTOP/SIGCONT/SIGKILL to
// pause, resume and cancel. Its fragments are moved onto the file's timeline (plus TIMELINE_OFFSET), so the session
// cuts the same planned segments from them as from ffmpeg's.
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { Worker } from 'node:worker_threads'
import type { Worker as WorkerInstance } from 'node:worker_threads'
import { ALL_FORMATS, Conversion, FilePathSource, Input, Mp4OutputFormat, Output, QUALITY_HIGH, StreamTarget, UrlSource } from 'mediabunny'
import type { InputAudioTrack, InputVideoTrack, StreamTargetChunk } from 'mediabunny'
import type { FfmpegProcess } from './hls.ts'
import { TIMELINE_OFFSET } from './media.ts'
import { boxes, child, children, fragmentStart, readInit } from './mp4.ts'
import type { InitInfo } from './mp4.ts'

const require = createRequire(import.meta.url)

/** How much media one step of the conversion produces before it checks for a pause or a cancel. */
const STEP_S = 10
/** Bytes of /raw the conversion keeps in memory; the reads are sequential and Mediabunny prefetches at most 8 MiB ahead. */
const READ_CACHE_BYTES = 16 * 1024 ** 2

export interface NodeRemuxOptions {
  /** A /raw URL or a local path. */
  input: string
  /** Audio track index among the file's audio tracks. */
  audio: number
  /** Where the run starts on the file's timeline (runStart()); 0 or the file's start for a run from the beginning. */
  start: number
  /**
   * The file time of the keyframe the run's video begins on, from the keyframe index: Mediabunny rebases its output
   * to start there, and the difference puts it back. Null keeps Mediabunny's own timeline (a growing playlist).
   */
  firstKeyframe: number | null
}

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

/** Adds `seconds` to every track's tfdt in a moof, in place (Mediabunny writes 64-bit tfdt). */
function shiftFragment (moof: Buffer, init: InitInfo, seconds: number): void {
  const root = [...boxes(moof)].find(b => b.type === 'moof')
  if (!root) return
  for (const traf of children(moof, root, 'traf')) {
    const tfhd = child(moof, traf, 'tfhd')
    const tfdt = child(moof, traf, 'tfdt')
    if (!tfhd || !tfdt) continue
    const scale = init.timescales.get(moof.readUInt32BE(tfhd.body + 4))
    if (!scale) continue
    const v1 = moof[tfdt.body] === 1
    const time = v1 ? Number(moof.readBigUInt64BE(tfdt.body + 4)) : moof.readUInt32BE(tfdt.body + 4)
    const shifted = Math.max(0, Math.round(time + seconds * scale))
    if (v1) moof.writeBigUInt64BE(BigInt(shifted), tfdt.body + 4)
    else moof.writeUInt32BE(Math.min(shifted, 0xffffffff), tfdt.body + 4)
  }
}

/** Starts a Node remux run and returns it as an ffmpeg-like process (see the file comment). */
export function nodeRemuxProcess (options: NodeRemuxOptions): FfmpegProcess {
  const events = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const media = new PassThrough()
  let paused = false
  let killed = false
  let wake = (): void => {}
  let conversion: Conversion | null = null
  const proc = Object.assign(events, {
    pid: undefined,
    stdout,
    stderr,
    stdio: [null, stdout, stderr, media],
    kill (signal?: NodeJS.Signals | number): boolean {
      if (signal === 'SIGSTOP') paused = true
      else if (signal === 'SIGCONT') { paused = false; wake() } else { killed = true; paused = false; wake(); conversion?.cancel().catch(() => {}) }
      return true
    },
  })
  const workers: WorkerInstance[] = []
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    for (const worker of workers) worker.terminate().catch(() => {})
    media.end()
    stdout.end()
    stderr.end()
    // 'close' follows the streams' remaining data, as it does for a child process
    setImmediate(() => events.emit('close', code, signal))
  }
  owners.run(workers, async () => {
    await prepare()
    await convert(options, media, stdout, () => paused, () => killed, resolve => { wake = resolve }, c => { conversion = c })
  }).then(() => finish(killed ? null : 0, killed ? 'SIGKILL' : null), (err: unknown) => {
    if (killed) return finish(null, 'SIGKILL')
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    finish(1, null)
  })
  return proc as unknown as FfmpegProcess
}

async function convert (
  { input, audio, start, firstKeyframe }: NodeRemuxOptions,
  media: PassThrough,
  progress: PassThrough,
  isPaused: () => boolean,
  isKilled: () => boolean,
  onWake: (resolve: () => void) => void,
  onConversion: (conversion: Conversion) => void
): Promise<void> {
  const source = /^https?:\/\//i.test(input)
    ? new UrlSource(input, { maxCacheSize: READ_CACHE_BYTES, getRetryDelay: attempts => attempts < 5 ? Math.min(5, 0.5 * 2 ** attempts) : null })
    : new FilePathSource(input)
  const file = new Input({ source, formats: ALL_FORMATS })
  try {
    const video = await file.getPrimaryVideoTrack()
    const audios = await file.getAudioTracks()
    if (!video) throw new Error('No video track found in this file.')
    const chosen = audios[audio] ?? null
    // Boxes are emitted whole. Until the first video fragment shows where Mediabunny put the starting keyframe,
    // they wait, so every fragment is shifted by the same amount.
    let init: InitInfo | null = null
    let shift: number | null = null
    let held: Buffer[] = []
    let produced = 0
    let lastWall = performance.now()
    let lastMedia = 0
    const send = (box: Buffer, type: string): void => {
      if (type === 'moof' && init && shift !== null) {
        shiftFragment(box, init, shift)
        const at = fragmentStart(box, init)
        if (at !== null) produced = Math.max(produced, at - TIMELINE_OFFSET - start)
      }
      media.write(box)
    }
    const emit = (box: Buffer, type: string): void => {
      if (type === 'moov') init = readInit(box)
      if (shift === null && type === 'moof' && init) {
        const at = fragmentStart(box, init)
        if (at !== null) shift = (firstKeyframe ?? at) - at + TIMELINE_OFFSET
      }
      if (shift === null) { held.push(box); return }
      for (const earlier of held) send(earlier, earlier.toString('latin1', 4, 8))
      held = []
      send(box, type)
    }
    // The muxer writes at absolute positions; keep the unsent tail and cut whole top-level boxes from it
    let bytes = Buffer.alloc(0)
    let base = 0
    let end = 0 // contiguous bytes written
    let high = 0 // furthest byte written, past a gap if the muxer wrote ahead
    let scan = 0
    const take = (): void => {
      for (;;) {
        const offset = scan - base
        if (offset < 0 || offset + 8 > end - base) return
        let size = bytes.readUInt32BE(offset)
        if (size === 1) {
          if (offset + 16 > end - base) return
          size = Number(bytes.readBigUInt64BE(offset + 8))
        }
        if (size < 8 || scan + size > end) return
        const box = Buffer.from(bytes.subarray(offset, offset + size))
        scan += size
        emit(box, box.toString('latin1', 4, 8))
        // Copy the unsent tail into its own buffer: a subarray would keep the whole grown buffer alive
        const tail = Buffer.alloc(Math.max(high - scan, 64 * 1024))
        bytes.copy(tail, 0, scan - base, high - base)
        bytes = tail
        base = scan
      }
    }
    const writable = new WritableStream<StreamTargetChunk>({
      write (chunk) {
        const need = chunk.position + chunk.data.byteLength
        if (chunk.position < base) return
        if (need - base > bytes.length) {
          const grown = Buffer.alloc(Math.max(need - base, bytes.length * 2, 64 * 1024))
          bytes.copy(grown, 0, 0, high - base)
          bytes = grown
        }
        Buffer.from(chunk.data).copy(bytes, chunk.position - base)
        high = Math.max(high, need)
        if (chunk.position <= end) end = Math.max(end, need)
        take()
      },
    })
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0 }), target: new StreamTarget(writable) })
    const conversion = await Conversion.init({
      input: file,
      output,
      video: (track: InputVideoTrack) => track.id === video.id ? {} : { discard: true },
      audio: (track: InputAudioTrack) => track.id !== chosen?.id ? { discard: true } : track.codec === 'aac' ? {} : { codec: 'aac', numberOfChannels: Math.min(2, track.numberOfChannels), quality: QUALITY_HIGH },
      trim: { start },
      copy: { boundaryPolicy: 'expand' },
      tags: {},
      showWarnings: false,
    })
    onConversion(conversion)
    const dropped = conversion.discardedTracks.find(entry => entry.track.id === video.id)
    if (dropped) throw new Error(`The video can't be copied into MP4 (${dropped.reason.replace(/_/g, ' ')}).`)
    if (!conversion.isValid) throw new Error('The output configuration is not valid for this file.')
    while (!isKilled()) {
      if (isPaused()) {
        await new Promise<void>(resolve => onWake(resolve))
        continue
      }
      await conversion.execute({ until: produced + STEP_S }) // output time: the run is rebased to start near 0
      const wall = performance.now()
      const speed = wall > lastWall ? (produced - lastMedia) / ((wall - lastWall) / 1000) : 0
      lastWall = wall
      lastMedia = produced
      progress.write(`out_time_us=${Math.round(produced * 1e6)}\nspeed=${speed.toFixed(2)}x\nprogress=continue\n`)
      if (conversion.state === 'done') break
    }
    for (const box of held) send(box, box.toString('latin1', 4, 8))
  } finally {
    file.dispose()
  }
}
