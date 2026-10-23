import type { ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { count, formatBytes, tint } from '../lib/ui.ts'
import type { ReleaseRowItem } from '../lib/ui.ts'

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
}): ReactNode {
  const router = useRouter()
  return (
    <Link
      to={href}
      // Torrent still uses a document-scoped vanilla script until phase 5.
      reloadDocument={/^\/t(?:\/|$)/.test(href)}
      onClick={e => {
        if (back && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
          e.preventDefault()
          router.history.back()
        }
      }}
      state={{ catalogReturn: location.pathname + location.search, catalogQuery: (router.state.location.search as { q?: string }).q ?? router.state.location.state.catalogQuery }}
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
    <p id='status' className={`status ${error ? 'error' : busy ? 'busy' : ''}`}>
      {error
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
    catalogReturn?: string
  }
}
