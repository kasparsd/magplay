// Shared top-bar behaviour, imported by every page: the status menu, and this browser's debug request logging.
import { mountStatusMenu } from './status-menu.ts'
import { getPreference, PREFERENCE } from './preferences.ts'

/** Settings → Debug → "Log requests to the browser console". */
function logRequests (): void {
  const original = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const started = performance.now()
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const url = input instanceof Request ? input.url : String(input)
    try {
      const res = await original(input, init)
      console.debug(`[magplay] ${method} ${url} → ${res.status} in ${Math.round(performance.now() - started)} ms`)
      return res
    } catch (err) {
      console.debug(`[magplay] ${method} ${url} failed after ${Math.round(performance.now() - started)} ms`, err)
      throw err
    }
  }
}

if (getPreference(PREFERENCE.logRequests)) logRequests()
mountStatusMenu()
