// A page's state that lives in its query string: typed reads, writes that leave out defaults, and Back/Forward.
// Reload, Back and shared links then all show the same thing, and a page never parses location by hand.

/** One query parameter: its default, and optionally the only values allowed (anything else reads as the default). */
export interface Param { default: string, values?: readonly string[] }
export type Schema = Record<string, Param>
export type StateOf<S extends Schema> = { [K in keyof S]: string }

/** What urlState() needs from the window; tests pass a fake. */
export interface UrlHost {
  search: () => string
  pathname: () => string
  push: (url: string) => void
  replace: (url: string) => void
  onPop: (listener: () => void) => void
}

const windowHost = (): UrlHost => ({
  search: () => location.search,
  pathname: () => location.pathname,
  push: url => { history.pushState(null, '', url) },
  replace: url => { history.replaceState(null, '', url) },
  onPop: listener => { addEventListener('popstate', listener) },
})

export function parse<S extends Schema> (schema: S, search: string): StateOf<S> {
  const params = new URLSearchParams(search)
  const out: Record<string, string> = {}
  for (const [name, param] of Object.entries(schema)) {
    const value = params.get(name)?.trim() ?? ''
    out[name] = value && (!param.values || param.values.includes(value)) ? value : param.default
  }
  return out as StateOf<S>
}

/** The query string for `state`, leaving out default values, in schema order. */
export function serialize<S extends Schema> (schema: S, state: StateOf<S>): string {
  const params = new URLSearchParams()
  for (const [name, param] of Object.entries(schema)) {
    const value = state[name]
    if (value && value !== param.default) params.set(name, value)
  }
  return params.size ? `?${params}` : ''
}

export interface UrlState<S extends Schema> {
  get: () => StateOf<S>
  /**
   * Merges `changes` into the URL. `push` makes a history entry, so Back returns to the previous state;
   * otherwise the entry is replaced. Returns false when nothing changed.
   */
  set: (changes: Partial<StateOf<S>>, options?: { push?: boolean }) => boolean
  /** Calls `listener` after Back or Forward with the state that entry asks for. */
  onChange: (listener: (state: StateOf<S>) => void) => void
}

export function urlState<S extends Schema> (schema: S, host: UrlHost = windowHost()): UrlState<S> {
  const get = (): StateOf<S> => parse(schema, host.search())
  return {
    get,
    set: (changes, { push = false } = {}) => {
      const query = serialize(schema, { ...get(), ...changes })
      if (query === serialize(schema, get())) return false
      ;(push ? host.push : host.replace)(host.pathname() + query)
      return true
    },
    onChange: listener => { host.onPop(() => { listener(get()) }) },
  }
}
