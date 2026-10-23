import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import type { TorrentFileInfo, TorrentInfo, TorrentStatus } from '@magplay/api-contract'
import { torrentRoute } from './router.tsx'
import { api } from './lib/api.ts'
import { queryClient } from './lib/query.ts'
import { backTarget } from './lib/back.ts'
import { recall, episodeLabel, formatBytes, formatClock, formatSpeed, shortHash, timeAgo } from './lib/ui.ts'
import { baseName, playerApps, streamUrl, urls } from './lib/urls.ts'
import { progressKey, resumePosition } from './lib/progress.ts'
import { CatalogLink, Status } from './components/Catalog.tsx'
import { CopyButton } from './components/CopyButton.tsx'
import { Menu } from './components/Menu.tsx'

const fileLabel = (f: TorrentFileInfo): string => episodeLabel(f) || baseName(f.name)
function lastPlayed (ih: string): { idx: number; at: number } | null {
  const value = recall(`last:${ih}`)
  if (!value || typeof value !== 'object' || !('idx' in value) || !('at' in value)) return null
  return typeof value.idx === 'number' &&
    Number.isInteger(value.idx) &&
    value.idx >= 0 &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at)
    ? { idx: value.idx, at: value.at }
    : null
}
function CountingWait (): ReactNode {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])
  return <>Loading the file list… {seconds} s</>
}
function Activity ({ status: st }: { status: TorrentStatus | undefined }): ReactNode {
  if (!st) return <div className='live' />
  if (!st.loaded) {
    return (
      <div className='live'>
        <p>Not active right now. Playing or downloading a file starts it again.</p>
      </div>
    )
  }
  const line = [
    `${st.peers.length} peer${st.peers.length === 1 ? '' : 's'}`,
    `↓ ${formatSpeed(st.downloadSpeed)}`,
    `${(st.progress * 100).toFixed(st.progress > 0 && st.progress < 1 ? 1 : 0)}% on the server`,
  ].join(' · ')
  return (
    <div className='live'>
      {st.peers.length
        ? (
            <details>
              <summary>{line}</summary>
              <table className='peers'>
                <thead>
                  <tr>
                    {['Address', 'Client', '↓', '↑', 'Has'].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {st.peers.slice(0, 40).map((peer, i) => (
                    <tr
                      key={peer.address ?? i}
                      className={peer.choking ? 'choking' : ''}
                      title={`${peer.type}${peer.choking ? ', not sending to us' : ''}, received ${formatBytes(peer.downloaded)}`}
                    >
                      <td>{peer.address ?? '?'}</td>
                      <td>{peer.client ?? ''}</td>
                      <td>{peer.downloadSpeed ? formatSpeed(peer.downloadSpeed) : ''}</td>
                      <td>{peer.uploadSpeed ? formatSpeed(peer.uploadSpeed) : ''}</td>
                      <td>{Math.round(peer.share * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {st.peers.length > 40 && <p>…and {st.peers.length - 40} more</p>}
            </details>
          )
        : (
            <p>{line}. Looking for peers…</p>
          )}
    </div>
  )
}
function FileMenu ({ torrent: t, file: f }: { torrent: TorrentInfo; file: TorrentFileInfo }): ReactNode {
  return (
    <Menu label='⋯' title='More for this file' className='file-menu'>
      <div className='menu-heading'>{baseName(f.name)}</div>
      {f.isVideo && (
        <>
          {playerApps(t.infoHash, f.idx, f.name).map(([label, href, title]) => (
            <a key={label} href={href} title={title}>
              {label}
            </a>
          ))}
          <CopyButton
            label='Copy stream link'
            text={streamUrl(t.infoHash, f.idx, f.name)}
            title='Copy the stream link for any player'
          />
          <hr />
        </>
      )}
      <a href={urls.download(t.infoHash, f.idx, f.name)}>Download file</a>
    </Menu>
  )
}
function TorrentBody ({ torrent: t }: { torrent: TorrentInfo }): ReactNode {
  const activity = useQuery({
    queryKey: ['torrent-status', t.infoHash],
    queryFn: ({ signal }) => api<TorrentStatus>(`/api/torrents/${t.infoHash}/status`, { signal }),
    refetchInterval: 2000,
  })
  const videos = t.files.filter((f) => f.isVideo)
  const others = t.files.filter((f) => !f.isVideo)
  const last = lastPlayed(t.infoHash)
  const first = videos.find((f) => f.idx === last?.idx) ?? videos[0]
  const saved = first ? resumePosition(recall(progressKey(t.infoHash, first.idx))) : 0
  const total = t.files.reduce((sum, f) => sum + f.size, 0)
  const episodes = videos.filter((f) => f.episode != null).length
  const count =
    episodes > 1
      ? `${episodes} episodes`
      : videos.length > 1
        ? `${videos.length} videos`
        : `${t.files.length} file${t.files.length > 1 ? 's' : ''}`
  const magnet = urls.magnet(t.infoHash, t.name)
  const only = t.files.length === 1 ? t.files[0] : undefined
  const fileStatus = activity.data?.loaded ? activity.data.files : []
  const bar = (f: TorrentFileInfo): ReactNode => (
    <div
      className='bar'
      title='Downloaded to the server (not playback position)'
      aria-label='Download progress on the server'
    >
      <span
        style={{
          width: `${((fileStatus.find((s) => s.idx === f.idx)?.progress ?? 0) * 100).toFixed(1)}%`,
        }}
      />
    </div>
  )
  const plain = (f: TorrentFileInfo): ReactNode => (
    <li key={f.idx} className='file plain'>
      <div className='main'>
        <a className='label' href={urls.download(t.infoHash, f.idx, f.name)}>
          {f.name}
        </a>
        {bar(f)}
      </div>
      <span className='size'>{formatBytes(f.size)}</span>
      <a href={urls.download(t.infoHash, f.idx, f.name)} title={`Download ${baseName(f.name)}`}>
        Download
      </a>
    </li>
  )
  return (
    <div id='torrent'>
      <p className='meta'>
        {count} · {formatBytes(total)} ·{' '}
        <CopyButton
          label={`ID ${shortHash(t.infoHash)}`}
          text={t.infoHash}
          title={`Copy the infohash ${t.infoHash}`}
        />
      </p>
      <div className='actions'>
        {first && (
          <CatalogLink className='button primary' href={urls.player(t.infoHash, first.idx)}>
            ▶ {saved ? 'Resume' : 'Play'}
            {videos.length > 1 ? ` ${fileLabel(first)}` : ''}
            {saved ? ` at ${formatClock(saved)}` : ''}
          </CatalogLink>
        )}
        {!first && only && (
          <a className='button primary' href={urls.download(t.infoHash, only.idx, only.name)}>
            Download file
          </a>
        )}
        {!first && t.files.length > 1 && (
          <a className='button primary' href={urls.tar(t.infoHash, t.name)}>
            Download all (.tar, {formatBytes(total)})
          </a>
        )}
        <Menu label='More ▾' className='button'>
          <div className='menu-heading'>Whole torrent</div>
          {videos.length > 1 && (
            <a href={urls.m3u(t.infoHash)}>Play all {videos.length} in an external player (.m3u)</a>
          )}
          {first && t.files.length > 1 && (
            <>
              <a href={urls.tar(t.infoHash, t.name)}>Download all (.tar, {formatBytes(total)})</a>
              <hr />
            </>
          )}
          <a href={magnet}>Open in your torrent client</a>
          <CopyButton label='Copy magnet link' text={magnet} title='Copy the magnet link' />
        </Menu>
      </div>
      <Activity status={activity.data} />
      {!t.files.length
        ? (
            <p>This torrent has no files to download.</p>
          )
        : !videos.length
            ? (
                <>
                  <p>No videos in this torrent. Download the files or open it in your torrent client.</p>
                  <ul className='files'>{others.map(plain)}</ul>
                </>
              )
            : (
                <>
                  <ul className='files'>
                    {videos.map((f) => (
                      <li key={f.idx} className='file'>
                        <CatalogLink
                          className='play'
                          href={urls.player(t.infoHash, f.idx)}
                          title={`Play ${fileLabel(f)} in the browser`}
                        >
                          ▶
                        </CatalogLink>
                        <div className='main'>
                          <CatalogLink className='label' href={urls.player(t.infoHash, f.idx)}>
                            {fileLabel(f)}
                          </CatalogLink>
                          {last?.idx === f.idx && <span className='badge'>last played {timeAgo(last.at)}</span>}
                          {episodeLabel(f) && <div className='filename'>{baseName(f.name)}</div>}
                          {bar(f)}
                        </div>
                        <span className='size'>{formatBytes(f.size)}</span>
                        <FileMenu torrent={t} file={f} />
                      </li>
                    ))}
                  </ul>
                  {others.length > 0 && (
                    <details className='others'>
                      <summary>
                        {others.length} other file{others.length > 1 ? 's' : ''}
                      </summary>
                      <ul className='files'>{others.map(plain)}</ul>
                    </details>
                  )}
                </>
              )}
    </div>
  )
}
export function Torrent (): ReactNode {
  const { ih } = torrentRoute.useParams()
  const search = torrentRoute.useSearch()
  const navigate = torrentRoute.useNavigate()
  const state = useRouterState({ select: (s) => s.location.state })
  const discovery = search.magnet || search.link
  const metadata = useQuery({
    queryKey: discovery ? ['torrent-discovery', search.magnet, search.link] : ['torrent', ih],
    queryFn: ({ signal }) =>
      search.magnet
        ? api<TorrentInfo>('/api/torrents', { json: { magnet: search.magnet }, signal })
        : search.link
          ? api<TorrentInfo>('/api/torrents', { json: { linkId: search.link }, signal })
          : api<TorrentInfo>(`/api/torrents/${ih ?? ''}`, { signal }),
    staleTime: Infinity,
  })
  const t = metadata.data
  const name = t?.name ?? (search.title || (ih ? `Torrent ${shortHash(ih)}` : 'Torrent'))
  useEffect(() => {
    document.title = `${name} · magplay`
  }, [name])
  useEffect(() => {
    if (!t || (!discovery && !search.title)) return
    queryClient.setQueryData(['torrent', t.infoHash], t)
    navigate({
      params: { ih: t.infoHash },
      search: { title: '', link: '', magnet: '' },
      replace: true,
      state,
    }).catch(console.error)
  }, [t, discovery, search.title, navigate, state])
  const back = backTarget(
    state.catalogReturn ? location.origin + state.catalogReturn : '',
    location.origin
  )
  return (
    <main>
      <p className='back' hidden={!back}>
        {back && (
          <CatalogLink id='back' href={back.href} back={!!state.catalogReturn && state.catalogBack !== false}>
            {back.label}
          </CatalogLink>
        )}
      </p>
      <h1 id='name'>{name}</h1>
      <Status
        busy={metadata.isFetching}
        error={metadata.error}
        retry={() => {
          metadata.refetch().catch(console.error)
        }}
      >
        {metadata.isFetching && <CountingWait />}
      </Status>
      {t ? <TorrentBody torrent={t} /> : <div id='torrent' />}
    </main>
  )
}
