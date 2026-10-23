// One row in a list of releases, as ui.ts releaseRow() draws it for the pages not yet components: name (linking to its
// torrent page), badges, size and seeders.
import type { ReactNode } from 'react'
import { count, formatBytes } from '../lib/ui.ts'
import type { ReleaseRowItem } from '../lib/ui.ts'

interface ReleaseRowProps {
  release: ReleaseRowItem
  /** The torrent page. A plain link: that page reads document.referrer for its back link until it is a component. */
  href: string
  /** Extra badges after the release's own, such as "best". */
  extra?: ReactNode
  /** Facts before size and seeders on the meta line, such as "2 h ago". */
  meta?: Array<string | null | undefined | false>
  /** A muted line under the badges, such as where the result came from. */
  note?: string | null | false | undefined
}

export function ReleaseRow ({ release: r, href, extra, meta = [], note }: ReleaseRowProps): ReactNode {
  return (
    <li>
      <div className='main'>
        <a href={href} className='title'>{r.name}</a>
        <div className='badges'>
          {r.warning && <span className='badge note'>{r.warning}</span>}
          {r.episode && <span className='badge note'>{r.episode}</span>}
          {(r.badges ?? []).map(b => <span key={b} className='badge'>{b}</span>)}
          {r.playbackEffort === 'direct' && <span className='badge good' title='The title looks like 8-bit H.264 with AAC. Native playback still depends on the container and this browser; otherwise the server remuxes.'>likely direct</span>}
          {r.playbackEffort === 'remux' && <span className='badge good' title='H.264 video. A cheap pass can repackage the file or convert the audio. The video is not re-encoded.'>likely remux</span>}
          {r.playbackEffort === 'transcode' && <span className='badge' title="The title's video codec has to be re-encoded. That stays off unless Convert unsupported video is enabled.">needs transcode</span>}
          {extra}
        </div>
        {note && <div className='meta'>{note}</div>}
      </div>
      <span className='size'>{[...meta, formatBytes(r.size), r.seeders != null && count(r.seeders, 'seeder')].filter(Boolean).join(' · ')}</span>
    </li>
  )
}
