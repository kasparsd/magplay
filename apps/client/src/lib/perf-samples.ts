// The Player's last 3 minutes of status polls, for the Performance lanes. Samples live only in memory.

/** 90 polls at 2 s: the last 3 minutes. */
export const SAMPLES = 90

export interface PerfSample {
  /** Torrent download, bytes per second. */
  download: number
  peers: number
  /** ffmpeg speed × realtime; null in direct mode or before ffmpeg reports. */
  speed: number | null
  fps: number | null
  /** ffmpeg's share of all cores (0–1), or null where the server can't measure it. */
  cpu: number | null
  /** ffmpeg is stopped because it is far enough ahead. */
  paused: boolean
  /** Seconds converted ahead of the playhead; null in direct mode. */
  ahead: number | null
  /** Seconds the browser has buffered ahead of the playhead. */
  buffer: number
  /** The video waited for data during this sample. */
  stalled: boolean
}

/** Adds a sample, keeping the newest SAMPLES. */
export function record (history: PerfSample[], sample: PerfSample): void {
  history.push(sample)
  history.splice(0, history.length - SAMPLES)
}
