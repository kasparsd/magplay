// Typed failures; the app decides which HTTP status each one becomes. Messages are written for the user.

/** ffprobe or ffmpeg failed, timed out or answered with something unreadable. */
export class MediaToolError extends Error {
  override name = 'MediaToolError'
}

/** The file can't be played here: no video stream, or a codec this browser and server can't handle. */
export class UnplayableError extends Error {
  override name = 'UnplayableError'
}

/** The requested audio track doesn't exist. */
export class NoSuchTrackError extends Error {
  override name = 'NoSuchTrackError'
}

/** Too many jobs or sessions, or not enough disk space for HLS output; worth retrying shortly. */
export class PlaybackBusyError extends Error {
  override name = 'PlaybackBusyError'
}
