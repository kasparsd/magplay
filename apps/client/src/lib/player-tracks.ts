// The Player's audio and subtitle choices, built from the probe. The page owns which one is selected.
import type { AudioTrack, ProbeResult } from '@magplay/api-contract'
import { audioFormat, languageFromName, languageName, pickByLanguage } from './naming.ts'
import { baseName } from './urls.ts'

/** A subtitle choice: `value` is 'embedded:<stream>' or 'file:<torrent file idx>'; image subtitles are listed but disabled. */
export interface SubtitleOption {
  value: string
  /** Short name for the button's label ("Subtitles: English"). */
  name: string
  /** Menu text. */
  label: string
  language: string | null
  disabled: boolean
}

const named = (t: { language: string | null, title: string | null }): string => [languageName(t.language), t.title].filter(Boolean).join(' · ')

export function subtitleOptions (info: ProbeResult): SubtitleOption[] {
  return [
    ...info.subtitles.map(s => ({
      value: `embedded:${s.index}`,
      name: named(s) || `Track ${s.index + 1}`,
      label: `${named(s) || `Track ${s.index + 1}`}${s.text ? '' : ' (image, not supported)'}`,
      language: s.language,
      disabled: !s.text,
    })),
    ...info.externalSubtitles.map(f => {
      const language = languageFromName(f.name)
      return { value: `file:${f.idx}`, name: languageName(language) || baseName(f.name), label: baseName(f.name), language, disabled: false }
    }),
  ]
}

/**
 * The choice that the remembered subtitle preference turns on for this file: a language code, 'any' (the first usable
 * track) or 'off'. '' means subtitles stay off.
 */
export function preferredSubtitle (options: readonly SubtitleOption[], pref: unknown): string {
  const usable = options.filter(o => !o.disabled)
  const preferred = pref === 'any' ? usable[0] : typeof pref === 'string' && pref !== 'off' ? pickByLanguage(usable, pref) : undefined
  return preferred?.value ?? ''
}

/** "English · Commentary", or "Track 2" for an unnamed track. */
export const audioTrackName = (a: AudioTrack): string => [languageName(a.language) || `Track ${a.index + 1}`, a.title].filter(Boolean).join(' · ')

/** Menu text with the format: "English (AC-3 5.1)". */
export const audioTrackLabel = (a: AudioTrack): string => `${audioTrackName(a)} (${audioFormat(a.codec, a.channels)})`
