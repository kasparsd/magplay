// The torrent page, /t/<infohash>: file list, downloads, external players and live activity.
// /t?link=<id> opens a search result that only had a download link, then switches to /t/<infohash>.
// A magnet parameter adds the full URI, retaining trackers and web seeds.
import './lib/topbar.ts'
import type { PeerStats, TorrentFileInfo, TorrentInfo, TorrentStatus } from '@magplay/api-contract'
import type { Child } from './lib/ui.ts'
import { api } from './lib/api.ts'
import { requireElement, copyButton, el, episodeLabel, fill, formatBytes, formatClock as clock, formatSpeed, menu, menuHeading, menuSeparator, recall, setError, setStatus, shortHash, timeAgo } from './lib/ui.ts'
import { backTarget } from './lib/back.ts'
import { poll } from './lib/resource.ts'
import { baseName, playerApps, streamUrl, urls } from './lib/urls.ts'
import { progressKey, resumePosition } from './lib/progress.ts'

const params = new URLSearchParams(location.search)
const status = requireElement('#status', HTMLParagraphElement)
let infoHash = location.pathname.split('/')[2] || null

// Back to the results, Explore or title the user came from, without loading them again; no link after a direct visit
const back = backTarget(document.referrer, location.origin)
if (back) {
  Object.assign(requireElement('#back', HTMLAnchorElement), { href: back.href, textContent: back.label })
  requireElement('#back', HTMLAnchorElement).addEventListener('click', e => { e.preventDefault(); history.back() })
  requireElement('.back', HTMLParagraphElement).hidden = false
}

function showName (name: string): void {
  requireElement('#name', HTMLHeadingElement).textContent = name
  document.title = `${name} · magplay`
}

async function load (): Promise<void> {
  showName(params.get('title') || (infoHash ? `Torrent ${shortHash(infoHash)}` : 'Torrent'))
  const started = Date.now()
  const tick = () => setStatus(status, `Loading the file list… ${Math.round((Date.now() - started) / 1000)} s`, 'busy')
  tick()
  const timer = setInterval(tick, 1000)
  let t: TorrentInfo
  try {
    t = params.get('magnet')
      ? await api<TorrentInfo>('/api/torrents', { json: { magnet: params.get('magnet') } })
      : params.get('link')
        ? await api<TorrentInfo>('/api/torrents', { json: { linkId: params.get('link') } })
        : await api<TorrentInfo>(`/api/torrents/${infoHash}`)
  } catch (err) {
    setError(status, err instanceof Error ? err.message : String(err), () => { load().catch(console.error) })
    return
  } finally {
    clearInterval(timer)
  }
  infoHash = t.infoHash
  history.replaceState(null, '', urls.torrent(t.infoHash))
  setStatus(status, '')
  showName(t.name)
  render(t)
}

const fileLabel = (f: TorrentFileInfo): string => episodeLabel(f) || baseName(f.name)

type FileBars = Map<number, HTMLSpanElement>

/** Stored history is untrusted, including when another page wrote it. */
function lastPlayed (ih: string): { idx: number, at: number } | null {
  const value = recall(`last:${ih}`)
  if (!value || typeof value !== 'object' || !('idx' in value) || !('at' in value)) return null
  return typeof value.idx === 'number' && Number.isInteger(value.idx) && value.idx >= 0 &&
    typeof value.at === 'number' && Number.isFinite(value.at)
    ? { idx: value.idx, at: value.at }
    : null
}

/** A thin bar under a file; pollActivity fills it with how much of the file is on the server. */
function progressBar (bars: FileBars, f: TorrentFileInfo): HTMLDivElement {
  const fillEl = el('span')
  bars.set(f.idx, fillEl)
  return el('div', { className: 'bar', title: 'Downloaded to the server (not playback position)', ariaLabel: 'Download progress on the server' }, fillEl)
}

/** "6 episodes · 829 MB · ID d797d14f…" under the name. */
function renderSummary (t: TorrentInfo, videos: TorrentFileInfo[]): HTMLParagraphElement {
  const total = t.files.reduce((sum, f) => sum + f.size, 0)
  const episodes = videos.filter(f => f.episode != null).length
  const count = episodes > 1 ? `${episodes} episodes` : videos.length > 1 ? `${videos.length} videos` : `${t.files.length} file${t.files.length > 1 ? 's' : ''}`
  return el('p', { className: 'meta' }, `${count} · ${formatBytes(total)} ·`,
    copyButton(`ID ${shortHash(t.infoHash)}`, t.infoHash, `Copy the infohash ${t.infoHash}`))
}

/** The main action, plus everything that applies to the whole torrent in one menu. */
function renderActions (t: TorrentInfo, videos: TorrentFileInfo[]): HTMLParagraphElement {
  const total = t.files.reduce((sum, f) => sum + f.size, 0)
  const magnet = urls.magnet(t.infoHash, t.name)
  // Pick up where this browser left off, otherwise start at the first video
  const last = videos.find(f => f.idx === lastPlayed(t.infoHash)?.idx)
  const first = last ?? videos[0]
  const saved = first ? resumePosition(recall(progressKey(t.infoHash, first.idx))) : 0
  const onlyFile = t.files.length === 1 ? t.files[0] : undefined
  return el('p', { className: 'actions' },
    // Name the episode only when there's a choice of videos
    first && el('a', { className: 'button primary', href: urls.player(t.infoHash, first.idx) },
      `▶ ${saved ? 'Resume' : 'Play'}${videos.length > 1 ? ` ${fileLabel(first)}` : ''}${saved ? ` at ${clock(saved)}` : ''}`),
    !first && onlyFile && el('a', { className: 'button primary', href: urls.download(t.infoHash, onlyFile.idx, onlyFile.name), textContent: 'Download file' }),
    !first && t.files.length > 1 && el('a', { className: 'button primary', href: urls.tar(t.infoHash, t.name), textContent: `Download all (.tar, ${formatBytes(total)})` }),
    menu('More ▾', [
      menuHeading('Whole torrent'),
      videos.length > 1 && el('a', { href: urls.m3u(t.infoHash), textContent: `Play all ${videos.length} in an external player (.m3u)` }),
      !!first && t.files.length > 1 && el('a', { href: urls.tar(t.infoHash, t.name), textContent: `Download all (.tar, ${formatBytes(total)})` }),
      !!first && t.files.length > 1 && menuSeparator(),
      el('a', { href: magnet, textContent: 'Open in your torrent client' }),
      copyButton('Copy magnet link', magnet, 'Copy the magnet link'),
    ], { className: 'button' }))
}

/** Everything you can do with one file besides playing it in the browser. */
function fileMenu (t: TorrentInfo, f: TorrentFileInfo): HTMLDetailsElement {
  return menu('⋯', [
    menuHeading(baseName(f.name)),
    ...(f.isVideo ? playerApps(t.infoHash, f.idx, f.name).map(([label, href, title = '']) => el('a', { href, title, textContent: label })) : []),
    f.isVideo && copyButton('Copy stream link', streamUrl(t.infoHash, f.idx, f.name), 'Copy the stream link for any player'),
    f.isVideo && menuSeparator(),
    el('a', { href: urls.download(t.infoHash, f.idx, f.name), textContent: 'Download file' }),
  ], { title: 'More for this file', className: 'file-menu' })
}

function renderFiles (t: TorrentInfo, videos: TorrentFileInfo[], bars: FileBars): Child[] {
  const others = t.files.filter(f => !f.isVideo)
  const last = lastPlayed(t.infoHash)
  const videoRow = (f: TorrentFileInfo): HTMLLIElement => el('li', { className: 'file' },
    el('a', { className: 'play', href: urls.player(t.infoHash, f.idx), title: `Play ${fileLabel(f)} in the browser`, textContent: '▶' }),
    el('div', { className: 'main' },
      el('a', { href: urls.player(t.infoHash, f.idx), className: 'label', textContent: fileLabel(f) }),
      last?.idx === f.idx && el('span', { className: 'badge', textContent: `last played ${timeAgo(last.at)}` }),
      episodeLabel(f) && el('div', { className: 'filename', textContent: baseName(f.name) }),
      progressBar(bars, f)),
    el('span', { className: 'size', textContent: formatBytes(f.size) }),
    fileMenu(t, f))
  const plainRow = (f: TorrentFileInfo): HTMLLIElement => el('li', { className: 'file plain' },
    el('div', { className: 'main' }, el('a', { className: 'label', href: urls.download(t.infoHash, f.idx, f.name), textContent: f.name }), progressBar(bars, f)),
    el('span', { className: 'size', textContent: formatBytes(f.size) }),
    el('a', { href: urls.download(t.infoHash, f.idx, f.name), textContent: 'Download', title: `Download ${baseName(f.name)}` }))
  if (!t.files.length) return [el('p', { textContent: 'This torrent has no files to download.' })]
  if (!videos.length) return [el('p', { textContent: 'No videos in this torrent. Download the files or open it in your torrent client.' }), el('ul', { className: 'files' }, ...others.map(plainRow))]
  return [
    el('ul', { className: 'files' }, ...videos.map(videoRow)),
    others.length > 0 && el('details', { className: 'others' },
      el('summary', { textContent: `${others.length} other file${others.length > 1 ? 's' : ''}` }),
      el('ul', { className: 'files' }, ...others.map(plainRow))),
  ]
}

function render (t: TorrentInfo): void {
  const videos = t.files.filter(f => f.isVideo)
  const bars: FileBars = new Map()
  const activity = el('div', { className: 'live' })
  fill(requireElement('#torrent', HTMLDivElement), renderSummary(t, videos), renderActions(t, videos), activity, ...renderFiles(t, videos, bars))
  pollActivity(t.infoHash, activity, bars)
}

function renderPeers (peers: PeerStats[]): HTMLTableElement {
  return el('table', { className: 'peers' },
    el('thead', {}, el('tr', {}, ...['Address', 'Client', '↓', '↑', 'Has'].map(h => el('th', { textContent: h })))),
    el('tbody', {}, ...peers.slice(0, 40).map(p => el('tr', { className: p.choking ? 'choking' : '', title: `${p.type}${p.choking ? ', not sending to us' : ''}, received ${formatBytes(p.downloaded)}` },
      el('td', { textContent: p.address ?? '?' }),
      el('td', { textContent: p.client ?? '' }),
      el('td', { textContent: p.downloadSpeed ? formatSpeed(p.downloadSpeed) : '' }),
      el('td', { textContent: p.uploadSpeed ? formatSpeed(p.uploadSpeed) : '' }),
      el('td', { textContent: `${Math.round(p.share * 100)}%` })))))
}

/** One activity line (peers, speed, how much is on the server) that opens into the peer table; every 2 s while visible. */
function pollActivity (ih: string, box: HTMLDivElement, bars: FileBars): void {
  poll(async signal => {
    const st = await api<TorrentStatus>(`/api/torrents/${ih}/status`, { signal }).catch(() => null)
    if (st?.loaded) {
      for (const f of st.files) {
        const bar = bars.get(f.idx)
        if (bar) bar.style.width = `${(f.progress * 100).toFixed(1)}%`
      }
      const open = box.querySelector('details')?.open ?? false
      const line = [`${st.peers.length} peer${st.peers.length === 1 ? '' : 's'}`, `↓ ${formatSpeed(st.downloadSpeed)}`,
        `${(st.progress * 100).toFixed(st.progress > 0 && st.progress < 1 ? 1 : 0)}% on the server`].join(' · ')
      fill(box, st.peers.length
        ? el('details', { open }, el('summary', { textContent: line }), renderPeers(st.peers),
          st.peers.length > 40 && el('p', { textContent: `…and ${st.peers.length - 40} more` }))
        : el('p', { textContent: `${line}. Looking for peers…` }))
    } else if (st) {
      fill(box, el('p', { textContent: 'Not active right now. Playing or downloading a file starts it again.' }))
    }
  }, { everyMs: 2000 })
}

load().catch(console.error)
