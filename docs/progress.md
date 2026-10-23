# Resume and restart

Playback progress is stored **per torrent file in this browser**, not on the server or in an account. Existing last-episode history is retained; its old records simply have no resume timestamp.

On a fresh player load, meaningful saved progress offers **Resume** and **Start over**. The torrent page's main action shows the saved time. Every playback mode uses the file's own timeline, so the saved position is `video.currentTime`, and Resume asks for that position. A file without a keyframe index plays from the start and jumps to the resume position once conversion reaches it.

Progress is saved at most every five seconds during playback, and immediately on playing, seek completion, pause, page exit and media end. Data is only persisted when the current media has enough data to report a valid position, so a pending replacement stream cannot overwrite history with zero. The duration comes from the probe, not the HLS playlist, which grows for files without a keyframe index.

- Progress below five seconds does not offer resume.
- An ended file, or a position within the smaller of 30 seconds / 5% of the known file end, restarts instead of offering a nearly-finished resume.
- Start over clears completion/resume state for that file without affecting other files.
- Missing, malformed or blocked browser storage is non-fatal: playback still works without persistence.
- The UI does not infer where the actual credits start, sync devices, retain audio/subtitle preferences or manage a server watch-history database.

Pure rules live in `apps/client/src/lib/progress.ts` with colocated tests. Chromium regressions exercise direct resume/restart, HLS absolute timestamps, completed-file behavior, the torrent action label and blocked storage.
