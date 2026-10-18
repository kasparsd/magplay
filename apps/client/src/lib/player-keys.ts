// The Player's keys. The page decides when keys are ignored (typing, buttons) and what each command does.
export type PlayerCommand = 'playPause' | 'back' | 'forward' | 'volumeUp' | 'volumeDown' | 'mute' | 'fullscreen' | 'subtitles' | 'next' | 'slower' | 'faster'

const KEYS: Record<string, PlayerCommand> = {
  ' ': 'playPause',
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

/** The command for a KeyboardEvent.key; letters match in either case. */
export function keyCommand (key: string): PlayerCommand | undefined {
  const name = key.length === 1 ? key.toLowerCase() : key
  return Object.hasOwn(KEYS, name) ? KEYS[name] : undefined
}
