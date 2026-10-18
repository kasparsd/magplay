// A tiny router: route(methods, pattern, handler) rows, where a pattern like '/raw/:ih/:idx/:name?' captures path segments.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MalformedPathError } from './errors.ts'

/** The params a path pattern captures: '/raw/:ih/:name?' gives { ih: string, name?: string }. */
export type RouteParams<Pattern extends string> =
  Pattern extends `${infer Head}/${infer Rest}` ? SegmentParam<Head> & RouteParams<Rest> : SegmentParam<Pattern>

type SegmentParam<Segment extends string> =
  Segment extends `:${infer Name}?` ? { [K in Name]?: string }
    : Segment extends `:${infer Name}` ? { [K in Name]: string }
      : unknown

export interface Context<Params = Record<string, string>> {
  requestId?: string
  req: IncomingMessage
  res: ServerResponse
  params: Params
  query: URLSearchParams
}

export type Handler<Params = Record<string, string>> = (ctx: Context<Params>) => unknown

export interface Route {
  /** '|'-separated, e.g. 'GET|HEAD' */
  methods: string
  pattern: string
  handler: Handler
}

export interface Match {
  pattern: string
  handler: Handler
  params: Record<string, string>
}

/** A route whose handler sees params typed from its pattern. */
export function route<Pattern extends string> (methods: string, pattern: Pattern, handler: Handler<RouteParams<Pattern>>): Route {
  // The router only ever passes the params the pattern captured, so widening the handler is safe.
  return { methods, pattern, handler: handler as Handler }
}

export function createRouter (routes: readonly Route[]): (method: string, pathname: string) => Match | null {
  const compiled = routes.map(({ methods, pattern, handler }) => {
    const keys: string[] = []
    const source = pattern.split('/').map(segment => {
      if (!segment) return ''
      const param = /^:(\w+)(\?)?$/.exec(segment)
      if (!param) return '/' + segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      keys.push(param[1]!)
      return param[2] ? '(?:/([^/]+))?' : '/([^/]+)'
    }).join('')
    return { pattern, methods: methods.split('|'), re: new RegExp(`^${source}/?$`), keys, handler }
  })
  return function match (method, pathname) {
    for (const { pattern, methods, re, keys, handler } of compiled) {
      if (!methods.includes(method)) continue
      const m = re.exec(pathname)
      if (!m) continue
      const params: Record<string, string> = {}
      try {
        keys.forEach((key, i) => {
          const value = m[i + 1]
          if (value !== undefined) params[key] = decodeURIComponent(value)
        })
      } catch {
        throw new MalformedPathError('Malformed URL encoding')
      }
      return { pattern, handler, params }
    }
    return null
  }
}
