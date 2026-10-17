// A tiny router: [methods, pattern, handler] rows, where a pattern like '/raw/:ih/:idx/:name?' captures path segments.

/**
 * @typedef {{req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, params: Record<string, string>, query: URLSearchParams}} Context
 * @param {Array<[string, string, (ctx: Context) => unknown]>} routes  methods are '|'-separated, e.g. 'GET|HEAD'
 */
export function createRouter (routes) {
  const compiled = routes.map(([methods, pattern, handler]) => {
    const keys = []
    const source = pattern.split('/').map(segment => {
      if (!segment) return ''
      const param = /^:(\w+)(\?)?$/.exec(segment)
      if (!param) return '/' + segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      keys.push(param[1])
      return param[2] ? '(?:/([^/]+))?' : '/([^/]+)'
    }).join('')
    return { methods: methods.split('|'), re: new RegExp(`^${source}/?$`), keys, handler }
  })
  /** @returns {{handler: Function, params: Record<string, string>} | null} */
  return function match (method, pathname) {
    for (const { methods, re, keys, handler } of compiled) {
      if (!methods.includes(method)) continue
      const m = re.exec(pathname)
      if (!m) continue
      const params = {}
      try {
        keys.forEach((key, i) => { if (m[i + 1] !== undefined) params[key] = decodeURIComponent(m[i + 1]) })
      } catch {
        throw Object.assign(new Error('Malformed URL encoding'), { status: 400 })
      }
      return { handler, params }
    }
    return null
  }
}
