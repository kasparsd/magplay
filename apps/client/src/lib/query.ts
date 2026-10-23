// One QueryClient owns server data and deduplicates status requests across views.
import { QueryClient, queryOptions } from '@tanstack/react-query'
import type { StatusResponse } from '@magplay/api-contract'
import { api } from './api.ts'
import { mergeStatus } from './status-menu.ts'
import type { MergedStatus } from './status-menu.ts'
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
export const statusQuery = queryOptions({
  queryKey: ['status'],
  queryFn: async ({ signal }) => {
    try {
      return mergeStatus(await api<StatusResponse>('/api/status', { cache: 'no-store', signal }))
    } catch (error) {
      if (signal.aborted) throw error
      return mergeStatus(null)
    }
  },
  refetchInterval: (query) =>
    query.state.data?.checks.some((c) => c.required && c.level === 'unknown') ? 1000 : 30_000,
  staleTime: 5000,
})
export function refreshBrowserChecks (): void {
  queryClient.setQueryData<MergedStatus>(statusQuery.queryKey, (previous) =>
    previous ? mergeStatus(previous.reachable ? previous : null) : undefined
  )
}
