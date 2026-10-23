// The one QueryClient, and the queries more than one part of the app shares.
import { QueryClient, queryOptions } from '@tanstack/react-query'
import type { SearchResponse } from '@magplay/api-contract'
import { api } from './api.ts'
import { onStatus, refreshStatus } from './status-menu.ts'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
})

/** Overall health: polled every 30 s while the tab is visible, and again on focus once 5 s old. */
export const statusQuery = queryOptions({
  queryKey: ['status'],
  queryFn: refreshStatus,
  refetchInterval: 30_000,
  staleTime: 5000,
})

/** One search. Back to the results shows them at once; a new search of the same query asks again (see TopBar). */
export const searchQuery = (q: string, cat: string) => queryOptions({
  queryKey: ['search', q, cat],
  queryFn: ({ signal }) => api<SearchResponse>(`/api/search?${new URLSearchParams({ q, cat })}`, { signal }),
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
})

// Settings still refreshes the status itself (after a save or a connection test) until it is a component
onStatus(status => { queryClient.setQueryData(statusQuery.queryKey, status) })
