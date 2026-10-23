// The one QueryClient, and the queries more than one part of the app shares.
import { QueryClient, queryOptions } from '@tanstack/react-query'
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
  refetchInterval: query => query.state.data?.checks.some(c => c.required && c.level === 'unknown') ? 1000 : 30_000,
  staleTime: 5000,
})

// Settings still refreshes the status itself (after a save or a connection test) until it is a component
onStatus(status => { queryClient.setQueryData(statusQuery.queryKey, status) })
