// Tab fencing: each player page (a browser "tab" id) owns at most one HLS session, and a page that closed
// stays closed for a while, so a playback request still in flight can't start ffmpeg for nobody.
import type { HlsSession, HlsSessions, StartOptions } from '@magplay/playback'
import { HttpError } from '../http/errors.ts'

const FENCE_MS = 180_000

export interface Tabs {
  /** Starts a session for `tab`, replacing the tab's previous one. A closed tab gets a 409. */
  start: (tab: string | undefined, options: Omit<StartOptions, 'replaces'>) => HlsSession
  /** Stops the tab's session (direct play needs none). */
  stop: (tab: string | undefined) => void
  /** Closes a document activation, including a playback POST whose result is not known yet. */
  close: (tab: string) => void
  /** Forgets a stopped session; pass to createHlsSessions' onStop. */
  forget: (sessionId: string) => void
}

export function createTabs (sessions: () => HlsSessions): Tabs {
  const byTab = new Map<string, string>() // browser tab id -> session id
  const closedTabs = new Map<string, number>() // short-lived fence for a page closed before its POST arrives

  const stop = (tab: string | undefined): void => {
    const id = tab && byTab.get(tab)
    if (id) sessions().stop(id)
  }

  return {
    start (tab, options) {
      if (tab && (closedTabs.get(tab) ?? 0) > Date.now()) throw new HttpError(409, 'This player was closed. Open the file again.')
      const s = sessions().start({ ...options, replaces: tab ? byTab.get(tab) : undefined })
      if (tab) byTab.set(tab, s.id)
      return s
    },
    stop,
    close (tab) {
      if (!/^[\w-]{1,64}$/.test(tab)) throw new HttpError(400, 'Invalid player tab')
      stop(tab)
      for (const [key, expires] of closedTabs) if (expires < Date.now()) closedTabs.delete(key)
      closedTabs.set(tab, Date.now() + FENCE_MS)
      if (closedTabs.size > 1000) closedTabs.delete(closedTabs.keys().next().value!)
    },
    forget (sessionId) {
      for (const [tab, id] of byTab) if (id === sessionId) byTab.delete(tab)
    },
  }
}
