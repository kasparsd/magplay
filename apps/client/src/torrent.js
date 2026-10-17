// The torrent page, /t/<infohash>: file list, downloads, external players and live activity.
// /t?link=<id> opens a search result that only had a download link, then switches to /t/<infohash>.
import { api } from './lib/api.js'
import { $, copyButton, el, episodeLabel, fill, formatBytes, formatClock as clock, formatSpeed, menu, menuHeading, menuSeparator, recall, setStatus, sleep, timeAgo } from './lib/ui.js'
import { baseName, playerApps, streamUrl, urls } from './lib/urls.js'
import { progressKey, resumePosition } from './lib/progress.js'

const params = new URLSearchParams(location.search)
const status = $('#status')
let infoHash = location.pathname.split('/')[2] || null

// Back to the results without searching again, when we came from them
const back = $('#back')
if (document.referrer.startsWith(`${location.origin}/?`)) {
  back.href = document.referrer
  back.addEventListener('click', e => { e.preventDefault(); history.back() })
}

function showName (name) {
  $('#name').textContent = name
  document.title = `${name} · magplay`
}

async function load () {
  showName(params.get('title') || infoHash || 'Torrent')
  const started = Date.now()
  const tick = () => setStatus(status, `Finding peers and the file list… ${Math.round((Date.now() - started) / 1000)} s`, 'busy')
  tick()
  const timer = setInterval(tick, 1000)
  let t
  try {
    t = params.get('link')
      ? await api('/api/torrents', { json: { linkId: params.get('link') } })
      : await api(`/api/torrents/${infoHash}`)
  } catch (err) {
    setStatus(status, err.message, 'error')
    fill($('#torrent'), el('p', { className: 'actions' },
      el('button', { type: 'button', className: 'button', textContent: 'Try again', onclick: () => location.reload() })))
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

const fileLabel = f => episodeLabel(f) || baseName(f.name)

/** A thin bar under a file; pollActivity fills it with how much of the file is on the NAS. */
function progressBar (bars, f) {
  const fillEl = el('span')
  bars.set(f.idx, fillEl)
  return el('div', { className: 'bar', title: 'Downloaded to the NAS' }, fillEl)
}

/** "6 episodes · 829 MB · ID d797d14f…" under the name. */
function renderSummary (t, videos) {
  const total = t.files.reduce((sum, f) => sum + f.size, 0)
  const episodes = videos.filter(f => f.episode != null).length
  const count = episodes > 1 ? `${episodes} episodes` : videos.length > 1 ? `${videos.length} videos` : `${t.files.length} file${t.files.length > 1 ? 's' : ''}`
  return el('p', { className: 'meta' }, `${count} · ${formatBytes(total)} ·`,
    copyButton(`ID ${t.infoHash.slice(0, 8)}…`, t.infoHash, `Copy the infohash ${t.infoHash}`))
}

/** The main action, plus everything that applies to the whole torrent in one menu. */
function renderActions (t, videos) {
  const total = t.files.reduce((sum, f) => sum + f.size, 0)
  const magnet = urls.magnet(t.infoHash, t.name)
  // Pick up where this browser left off, otherwise start at the first video
  const last = videos.find(f => f.idx === recall(`last:${t.infoHash}`)?.idx)
  const first = last ?? videos[0]
  const saved = first ? resumePosition(recall(progressKey(t.infoHash, first.idx))) : 0
  return el('p', { className: 'actions' },
    // Name the episode only when there's a choice of videos
    first && el('a', { className: 'button primary', href: urls.player(t.infoHash, first.idx) },
      `▶ ${saved ? 'Resume' : 'Play'}${videos.length > 1 ? ` ${fileLabel(first)}` : ''}${saved ? ` at ${clock(saved)}` : ''}`),
    menu('More ▾', [
      menuHeading('Whole torrent'),
      videos.length > 1 && el('a', { href: urls.m3u(t.infoHash), textContent: `Play all ${videos.length} in an external player (.m3u)` }),
      t.files.length > 1 && el('a', { href: urls.tar(t.infoHash, t.name), textContent: `Download all (.tar, ${formatBytes(total)})` }),
      menuSeparator(),
      el('a', { href: magnet, textContent: 'Open in your torrent client' }),
      copyButton('Copy magnet link', magnet, 'Copy the magnet link'),
      copyButton('Copy infohash', t.infoHash, 'Copy the infohash'),
    ].filter(Boolean), { className: 'button' }))
}

/** Everything you can do with one file besides playing it in the browser. */
function fileMenu (t, f) {
  return menu('⋯', [
    menuHeading(baseName(f.name)),
    ...(f.isVideo ? playerApps(t.infoHash, f.idx, f.name).map(([label, href, title = '']) => el('a', { href, title, textContent: label })) : []),
    f.isVideo && copyButton('Copy stream link', streamUrl(t.infoHash, f.idx, f.name), 'Copy the stream link for any player'),
    f.isVideo && menuSeparator(),
    el('a', { href: urls.download(t.infoHash, f.idx, f.name), textContent: 'Download file' }),
  ].filter(Boolean), { title: 'More for this file', className: 'file-menu' })
}

function renderFiles (t, videos, bars) {
  const others = t.files.filter(f => !f.isVideo)
  const last = recall(`last:${t.infoHash}`)
  const videoRow = f => el('li', { className: 'file' },
    el('a', { className: 'play', href: urls.player(t.infoHash, f.idx), title: `Play ${fileLabel(f)} in the browser`, textContent: '▶' }),
    el('div', { className: 'main' },
      el('a', { href: urls.player(t.infoHash, f.idx), className: 'label', textContent: fileLabel(f) }),
      last?.idx === f.idx && el('span', { className: 'badge', textContent: `last played ${timeAgo(last.at)}` }),
      episodeLabel(f) && el('div', { className: 'filename', textContent: baseName(f.name) }),
      progressBar(bars, f)),
    el('span', { className: 'size', textContent: formatBytes(f.size) }),
    fileMenu(t, f))
  const plainRow = f => el('li', { className: 'file plain' },
    el('div', { className: 'main' }, el('span', { textContent: f.name }), progressBar(bars, f)),
    el('span', { className: 'size', textContent: formatBytes(f.size) }),
    el('a', { href: urls.download(t.infoHash, f.idx, f.name), textContent: 'Download', title: `Download ${baseName(f.name)}` }))
  if (!videos.length) return [el('p', { textContent: `${t.warning}. The torrent contains:` }), el('ul', { className: 'files' }, ...others.map(plainRow))]
  return [
    el('ul', { className: 'files' }, ...videos.map(videoRow)),
    others.length > 0 && el('details', { className: 'others' },
      el('summary', { textContent: `${others.length} other file${others.length > 1 ? 's' : ''}` }),
      el('ul', { className: 'files' }, ...others.map(plainRow))),
  ]
}

function render (t) {
  const videos = t.files.filter(f => f.isVideo)
  const bars = new Map()
  const activity = el('div', { className: 'live' })
  fill($('#torrent'), renderSummary(t, videos), renderActions(t, videos), activity, ...renderFiles(t, videos, bars))
  pollActivity(activity, bars)
}

function renderPeers (peers) {
  return el('table', { className: 'peers' },
    el('thead', {}, el('tr', {}, ...['Address', 'Client', '↓', '↑', 'Has'].map(h => el('th', { textContent: h })))),
    el('tbody', {}, ...peers.slice(0, 40).map(p => el('tr', { className: p.choking ? 'choking' : '', title: `${p.type}${p.choking ? ', not sending to us' : ''}, received ${formatBytes(p.downloaded)}` },
      el('td', { textContent: p.address ?? '?' }),
      el('td', { textContent: p.client ?? '' }),
      el('td', { textContent: p.downloadSpeed ? formatSpeed(p.downloadSpeed) : '' }),
      el('td', { textContent: p.uploadSpeed ? formatSpeed(p.uploadSpeed) : '' }),
      el('td', { textContent: `${Math.round(p.share * 100)}%` })))))
}

/** One activity line (peers, speed, how much is on the NAS) that opens into the peer table; every 2 s. */
async function pollActivity (box, bars) {
  for (;;) {
    const st = document.hidden ? null : await api(`/api/torrents/${infoHash}/status`).catch(() => null)
    if (st?.loaded) {
      for (const f of st.files) if (bars.has(f.idx)) bars.get(f.idx).style.width = `${(f.progress * 100).toFixed(1)}%`
      const open = box.querySelector('details')?.open ?? false
      const line = [`${st.peers.length} peer${st.peers.length === 1 ? '' : 's'}`, `↓ ${formatSpeed(st.downloadSpeed)}`,
        `${(st.progress * 100).toFixed(st.progress > 0 && st.progress < 1 ? 1 : 0)}% on the NAS`].join(' · ')
      fill(box, st.peers.length
        ? el('details', { open }, el('summary', { textContent: line }), renderPeers(st.peers),
          st.peers.length > 40 && el('p', { textContent: `…and ${st.peers.length - 40} more` }))
        : el('p', { textContent: `${line}. Looking for peers…` }))
    } else if (st) {
      fill(box, el('p', { textContent: 'Not active right now. Playing or downloading a file starts it again.' }))
    }
    await sleep(2000)
  }
}

load()
