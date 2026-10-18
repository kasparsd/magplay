// The last log lines in memory, for the Debug section: console output is kept as it is, and copied here.
import { format } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LogLine { at: number, level: LogLevel, text: string }
export type LogTail = () => LogLine[]

const LIMIT = 200

/** Copies every console line into a ring buffer; main.ts calls it first, so it sees every line. */
export function captureConsole (target: Console = console): LogTail {
  const lines: LogLine[] = []
  const methods: Array<[keyof Console & ('debug' | 'log' | 'info' | 'warn' | 'error'), LogLevel]> = [['debug', 'debug'], ['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]
  for (const [method, level] of methods) {
    const original = target[method].bind(target)
    target[method] = (...args: unknown[]) => {
      lines.push({ at: Date.now(), level, text: format(...args) })
      if (lines.length > LIMIT) lines.splice(0, lines.length - LIMIT)
      original(...args)
    }
  }
  return () => [...lines]
}
