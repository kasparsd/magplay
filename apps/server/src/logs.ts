// The last log lines in memory, for the Debug section. Every console line is copied here, and both copies have
// secrets (API keys in URLs, URL passwords, X-Api-Key values) replaced, so neither the container log nor Debug shows them.
import { format } from 'node:util'
import { redactSecrets } from '@magplay/api-contract'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LogLine { at: number, level: LogLevel, text: string }
export type LogTail = () => LogLine[]

const LIMIT = 200

/** Copies every console line, redacted, into a ring buffer and prints the redacted line; main.ts calls it first, so it sees every line. */
export function captureConsole (target: Console = console): LogTail {
  const lines: LogLine[] = []
  const methods: Array<[keyof Console & ('debug' | 'log' | 'info' | 'warn' | 'error'), LogLevel]> = [['debug', 'debug'], ['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]
  for (const [method, level] of methods) {
    const original = target[method].bind(target)
    target[method] = (...args: unknown[]) => {
      const text = redactSecrets(format(...args))
      lines.push({ at: Date.now(), level, text })
      if (lines.length > LIMIT) lines.splice(0, lines.length - LIMIT)
      original(text)
    }
  }
  return () => [...lines]
}
