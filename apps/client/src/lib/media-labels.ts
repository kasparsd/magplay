// Readable names for ffprobe's container and audio values, for the Player's Details and track menus.

const FORMATS: Array<[RegExp, string]> = [
  [/^mov,mp4/, 'MP4'], [/^matroska/, 'Matroska'], [/^avi$/, 'AVI'], [/^mpegts$/, 'MPEG-TS'], [/^flv$/, 'Flash Video'],
  [/^ogg$/, 'Ogg'], [/^asf$/, 'Windows Media'], [/^mpeg$/, 'MPEG-PS'],
]

/**
 * "MP4" for ffprobe's format_name "mov,mp4,m4a,3gp,3g2,mj2". ffprobe names a family of containers at once, so the
 * file's extension tells QuickTime from MP4 and WebM from Matroska; an unknown format keeps its first name.
 */
export function containerLabel (formatName: string | null | undefined, fileName = ''): string {
  if (!formatName) return ''
  const ext = /\.(\w+)$/.exec(fileName)?.[1]?.toLowerCase()
  const family = FORMATS.find(([pattern]) => pattern.test(formatName))?.[1]
  if (family === 'MP4' && ext === 'mov') return 'QuickTime'
  if (family === 'Matroska' && ext === 'webm') return 'WebM'
  return family ?? formatName.split(',')[0]!.toUpperCase()
}

const CODECS = new Map(Object.entries({
  aac: 'AAC', mp3: 'MP3', mp2: 'MP2', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', dts: 'DTS', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'ALAC',
}))

/** "AAC", "Dolby Digital" for ffprobe's codec_name; unknown codecs are upper-cased. */
export const audioCodecLabel = (codec: string | null | undefined): string => codec ? CODECS.get(codec) ?? (codec.startsWith('pcm_') ? 'PCM' : codec.toUpperCase()) : ''

/** "mono", "stereo", "5.1", "7.1", otherwise "N ch". */
export function channelsLabel (channels: number | null | undefined): string {
  if (!channels) return ''
  return ({ 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' } as Record<number, string>)[channels] ?? `${channels} ch`
}

export interface AudioTrackInfo {
  codec?: string | null
  channels?: number | null
  language?: string | null
  title?: string | null
}

/** "MP3 stereo", or "Director's commentary (AAC stereo)" when the track has a title. */
export function audioTrackLabel (track: AudioTrackInfo): string {
  const format = [audioCodecLabel(track.codec), channelsLabel(track.channels)].filter(Boolean).join(' ')
  const name = track.title?.trim()
  if (!name) return format || 'Audio'
  return format ? `${name} (${format})` : name
}
