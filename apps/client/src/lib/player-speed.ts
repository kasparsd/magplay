// Playback speeds the Player offers, and stepping through them with < and >.
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export const speedLabel = (rate: number): string => `${rate}×`

/** One step slower (-1) or faster (1); a rate outside the list steps from normal speed. */
export function steppedSpeed (rate: number, direction: -1 | 1): number {
  const i = SPEEDS.indexOf(rate as typeof SPEEDS[number])
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + direction))]!
}

/** A remembered speed, if it is still one of the offered ones; else normal speed. */
export const savedSpeed = (value: unknown): number => SPEEDS.includes(value as typeof SPEEDS[number]) ? value as number : 1
