import type { ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { count, formatBytes, tint } from '../lib/ui.ts'
import type { ReleaseRowItem } from '../lib/ui.ts'

interface CatalogContext {
  catalogQuery?: string | undefined
  catalogReturn?: string | undefined
  catalogBack?: boolean | undefined
  catalogReturnState?: CatalogContext | undefined
}

export function CatalogLink ({
  href,
  children,
  back = false,
  ...props
}: {
  href: string
  children: ReactNode
  className?: string
  title?: string
  id?: string
  back?: boolean
  'data-action'?: string
}): ReactNode {
  const router = useRouter()
  const current = router.state.location
  const fromCatalog = current.pathname === '/' || current.pathname === '/explore' || current.pathname.startsWith('/title/')
  const returningToFiles = current.pathname.startsWith('/play/') && href.startsWith('/t/')
  const context: CatalogContext = {
    catalogReturn: current.state.catalogReturn,
    catalogReturnState: current.state.catalogReturnState,
    catalogBack: current.state.catalogBack,
    catalogQuery: (current.search as { q?: string }).q ?? current.state.catalogQuery,
  }
  const next: CatalogContext = href === context.catalogReturn
    ? { ...context.catalogReturnState, catalogBack: false }
    : fromCatalog
      ? { catalogReturn: current.pathname + current.searchStr, catalogReturnState: context, catalogBack: true, catalogQuery: context.catalogQuery }
      : { ...context, catalogBack: returningToFiles ? false : context.catalogBack }
  return (
    <Link
      to={href}
      onClick={e => {
        if (back && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
          e.preventDefault()
          router.history.back()
        }
      }}
      state={next}
      {...props}
    >
      {children}
    </Link>
  )
}
export function Poster ({ title, large = false }: { title: string; large?: boolean }): ReactNode {
  return (
    <div className={`poster ${tint(title)}${large ? ' large' : ''}`} aria-hidden='true'>
      {title}
    </div>
  )
}
export function Status ({
  busy,
  error,
  children,
  retry,
}: {
  busy?: boolean
  error?: Error | null
  children?: ReactNode
  retry?: () => void
}): ReactNode {
  return (
    <p id='status' className={`status ${busy ? 'busy' : error ? 'error' : ''}`}>
      {error && !busy
        ? (
            <>
              {error.message}{' '}
              <button type='button' className='retry' onClick={retry}>
                Try again
              </button>
            </>
          )
        : (
            children
          )}
    </p>
  )
}
const effortDescriptions = {
  direct: 'The title looks like 8-bit H.264 with AAC. Native playback still depends on the container and this browser; otherwise the server remuxes.',
  remux: 'H.264 video. A cheap pass can repackage the file or convert the audio. The video is not re-encoded.',
  transcode: "The title's video codec has to be re-encoded. That stays off unless Convert unsupported video is enabled.",
}
export function ReleaseRow ({
  item: r,
  href,
  note,
  meta = [],
  best = false,
}: {
  item: ReleaseRowItem
  href: string
  note?: string | false
  meta?: Array<string | null | false>
  best?: boolean
}): ReactNode {
  return (
    <li>
      <div className='main'>
        <CatalogLink href={href} className='title'>
          {r.name}
        </CatalogLink>
        <div className='badges'>
          {r.warning && <span className='badge note'>{r.warning}</span>}
          {r.episode && <span className='badge note'>{r.episode}</span>}
          {r.badges?.map((b) => (
            <span className='badge' key={b}>
              {b}
            </span>
          ))}
          {r.playbackEffort && (
            <span
              className={`badge${r.playbackEffort === 'transcode' ? '' : ' good'}`}
              title={effortDescriptions[r.playbackEffort]}
            >
              {r.playbackEffort === 'transcode' ? 'needs transcode' : `likely ${r.playbackEffort}`}
            </span>
          )}
          {best && <span className='badge good'>best</span>}
        </div>
        {note && <div className='meta'>{note}</div>}
      </div>
      <span className='size'>
        {[...meta, formatBytes(r.size), r.seeders != null && count(r.seeders, 'seeder')]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </li>
  )
}

declare module '@tanstack/react-router' {
  interface HistoryState {
    catalogQuery?: string | undefined
    catalogReturnState?: CatalogContext | undefined
    catalogBack?: boolean | undefined
    catalogReturn?: string | undefined
  }
}
