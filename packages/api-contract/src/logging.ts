export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LogRecord {
  time: string
  level: LogLevel
  event: string
  msg: string
  component: string
  service: string
  version: string
  runId: string
  [field: string]: unknown
}
