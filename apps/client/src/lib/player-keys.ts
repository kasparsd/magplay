// The Player's keys. The page decides when keys are ignored (typing, buttons) and what each command does.
export type PlayerCommand = 'playPause' | 'back' | 'forward' | 'volumeUp' | 'volumeDown' | 'mute' | 'fullscreen' | 'subtitles' | 'next' | 'slower' | 'faster'

const KEYS: Record<string, PlayerCommand> = {
  ' ': 'playPause',
  Space: 'playPause',
  Spacebar: 'playPause',
  space: 'playPause',
  spacebar: 'playPause',
  k: 'playPause',
  ArrowLeft: 'back',
  j: 'back',
  ArrowRight: 'forward',
  l: 'forward',
  ArrowUp: 'volumeUp',
  ArrowDown: 'volumeDown',
  m: 'mute',
  f: 'fullscreen',
  c: 'subtitles',
  n: 'next',
  '<': 'slower',
  '>': 'faster',
}

/** The command for a KeyboardEvent.key; letters and key names match in either case. */
export function keyCommand (key: string): PlayerCommand | undefined {
  if (Object.hasOwn(KEYS, key)) return KEYS[key]
  const lower = key.toLowerCase()
  if (Object.hasOwn(KEYS, lower)) return KEYS[lower]
  return undefined
}
