import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { playerRoute } from './router.tsx'
import {
  fileLabel,
  fileRanges,
  isLocal,
  nothingToPlay,
  PlaybackController,
  playbackSignals,
  sessionStatus,
} from './lib/playback-controller.ts'
import type { PlayerSnapshot, PlaybackOptions } from './lib/playback-controller.ts'
import { playbackPresentation } from './lib/playback-flow.ts'
import type { PlaybackAction } from './lib/playback-status.ts'
import { factRows } from './lib/player-facts.ts'
import { keyCommand } from './lib/player-keys.ts'
import { SPEEDS, speedLabel } from './lib/player-speed.ts'
import { audioTrackLabel, audioTrackName } from './lib/player-tracks.ts'
import { layerBackground, seekHint, seekOutcome } from './lib/seek.ts'
import { episodeLabel, formatClock as clock } from './lib/format.ts'
import { releaseName } from './lib/naming.ts'
import { baseName, playerApps, streamUrl, urls } from './lib/urls.ts'
import { CatalogLink } from './components/Catalog.tsx'
import { CopyButton } from './components/CopyButton.tsx'
import { Icon } from './components/Icon.tsx'
import { Menu } from './components/Menu.tsx'
import { PlaybackFlow } from './components/PlaybackFlow.tsx'
import { Performance } from './components/Performance.tsx'

// The holder is inert during render. Only mount(), called from an effect, creates a controller.
function playbackStore () {
  let value: { player: PlaybackController; snapshot: PlayerSnapshot } | null = null
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    mount: (options: PlaybackOptions) => {
      const player = new PlaybackController(options)
      const update = (): void => {
        value = { player, snapshot: player.getSnapshot() }
        publish()
      }
      const unsubscribe = player.subscribe(update)
      update()
      player.activate()
      const hide = (): void => player.suspend()
      const show = (e: PageTransitionEvent): void => {
        if (e.persisted) player.activate()
      }
      addEventListener('pagehide', hide)
      addEventListener('pageshow', show)
      return () => {
        removeEventListener('pagehide', hide)
        removeEventListener('pageshow', show)
        unsubscribe()
        player.dispose()
        value = null
        publish()
      }
    },
  }
}
export function Player (): ReactNode {
  const { ih, idx: index } = playerRoute.useParams()
  const idx = Number(index)
  const router = useRouter()
  const video = useRef<HTMLVideoElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const tipNode = useRef<HTMLDivElement>(null)
  const seekbar = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const chrome = useRef<HTMLDivElement>(null)
  const [store] = useState(playbackStore)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const player = state?.player
  const s = state?.snapshot
  const [idle, setIdle] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const [tip, setTip] = useState<{ at: number; x: number } | null>(null)
  const [keys, setKeys] = useState(false)
  const [details, setDetails] = useState(false)
  const [performance, setPerformance] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [menus, setMenus] = useState<Set<string>>(() => new Set())
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tapWoke = useRef(false)
  const within = useCallback(() => stage.current, [])
  const model = s ? playbackPresentation(playbackSignals(s), pinned) : null
  if (model && !s?.file) { model.actions = model.actions.filter((name) => name !== 'external' && name !== 'release') }
  const waiting = !!model && model.kind !== 'warning' && model.kind !== 'debug' && model.key !== 'brief'
  const sleepChrome = (): void => {
    if (
      !s ||
      s.media.paused ||
      !s.decision ||
      waiting ||
      menus.size ||
      keys ||
      dragging !== null ||
      stage.current?.querySelector(':focus-visible')
    ) { return }
    setIdle(true)
    setTip(null)
  }
  const latestSleep = useRef<() => void>(() => {})
  useEffect(() => { latestSleep.current = sleepChrome })
  const wake = (): void => {
    setIdle(false)
    clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => latestSleep.current(), 2500)
  }
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) document.exitFullscreen().catch(console.error)
    else if (stage.current?.requestFullscreen) stage.current.requestFullscreen().catch(() => {})
    else {
      const element = video.current as unknown as { webkitEnterFullscreen?: () => void } | null
      element?.webkitEnterFullscreen?.()
    }
  }
  useEffect(() => {
    if (!video.current) return
    const dispose = store.mount({
      ih,
      idx,
      video: video.current,
      navigate: (url) => {
        router.navigate({ to: url }).catch(console.error)
      },
    })
    document.body.classList.add('player-page')
    return () => {
      dispose()
      document.body.classList.remove('player-page')
      clearTimeout(idleTimer.current)
      document.documentElement.style.removeProperty('--topbar-h')
      document.documentElement.style.removeProperty('--title-row-h')
    }
  }, [ih, idx, router, store])
  useEffect(() => {
    if (!player) return
    const input = document.getElementById('seek') as HTMLInputElement | null
    const commit = (): void => {
      setDragging(null)
      setTip(null)
      if (input) player.seek(Number(input.value))
    }
    input?.addEventListener('change', commit)
    return () => input?.removeEventListener('change', commit)
  }, [player])
  const title =
    s?.torrent && s.file
      ? [releaseName(s.torrent.name), episodeLabel(s.file)].filter(Boolean).join(' · ')
      : ''
  useEffect(() => {
    if (title) document.title = `${title} · magplay`
  }, [title])
  useEffect(() => {
    if (!player) return
    const fit = (): void => {
      const topbar = document.querySelector<HTMLElement>('.topbar')
      const row = document.getElementById('titlerow')
      const landscape = matchMedia('(orientation: landscape) and (max-height: 500px)').matches
      document.documentElement.style.setProperty('--topbar-h', `${topbar?.offsetHeight ?? 0}px`)
      document.documentElement.style.setProperty(
        '--title-row-h',
        landscape ? '0px' : `${row?.offsetHeight ?? 0}px`
      )
    }
    const observer = new ResizeObserver(fit)
    for (const el of [document.querySelector('.topbar'), document.getElementById('titlerow')]) { if (el) observer.observe(el) }
    addEventListener('resize', fit)
    fit()
    return () => {
      observer.disconnect()
      removeEventListener('resize', fit)
    }
  }, [player])
  useEffect(() => {
    const update = (): void => {
      setFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])
  useEffect(() => {
    if (keys) document.getElementById('keys-close')?.focus()
  }, [keys])
  const keyboard = useEffectEvent((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
    const target = e.target as HTMLElement
    if (target.matches('input:not([type="range"]), select, textarea, [contenteditable]')) return
    if (target.id === 'volume' && /^Arrow/.test(e.key)) return
    if ((e.key === ' ' || e.key === 'Enter') && target.closest('button, summary, a')) return
    wake()
    if (e.key === '?') {
      setKeys((k) => !k)
      return
    }
    if (e.key === 'Escape' && keys) {
      setKeys(false)
      return
    }
    if (!s?.decision || !player) return
    const command = keyCommand(e.key)
    if (!command) return
    e.preventDefault()
    switch (command) {
      case 'playPause':
        player.togglePlay()
        break
      case 'back':
        player.seekBy(-10)
        break
      case 'forward':
        player.seekBy(10)
        break
      case 'volumeUp':
        player.changeVolume(0.1)
        break
      case 'volumeDown':
        player.changeVolume(-0.1)
        break
      case 'mute':
        player.toggleMute()
        break
      case 'fullscreen':
        toggleFullscreen()
        break
      case 'subtitles':
        player.toggleSubtitles()
        break
      case 'next':
        player.playNext()
        break
      case 'slower':
        player.stepSpeed(-1)
        break
      case 'faster':
        player.stepSpeed(1)
        break
    }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyboard(e)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const pointerSleep = (): void => {
    clearTimeout(idleTimer.current)
    sleepChrome()
  }
  const showTip = (at: number, x: number): void => {
    if (!s?.media.duration) return
    const half = (tipNode.current?.offsetWidth || 160) / 2
    const width = seekbar.current?.offsetWidth ?? 0
    setTip({ at, x: Math.max(half, Math.min(width - half, x)) })
  }
  const menuToggle = (name: string, open: boolean): void => {
    setMenus((old) => {
      const next = new Set(old)
      if (open) next.add(name)
      else next.delete(name)
      return next
    })
    wake()
  }
  const chromeMenu = (
    name: string,
    label: ReactNode,
    ariaLabel: string,
    children: ReactNode,
    summaryClassName = ''
  ): ReactNode => (
    <Menu
      label={label}
      ariaLabel={ariaLabel}
      title={ariaLabel}
      up
      within={within}
      summaryClassName={summaryClassName}
      onToggle={(open) => menuToggle(name, open)}
    >
      {children}
    </Menu>
  )
  const togglePin = (): void => {
    setPinned((p) => !p)
    wake()
  }
  const missing = s?.overlay?.kind === 'missing'
  const v = s?.info?.video
  const ar = v?.width && v.height ? (v.width * (v.sampleAspect || 1)) / v.height : undefined
  const stageStyle = ar ? ({ '--ar': String(ar) } as CSSProperties) : undefined
  const external = s?.file
    ? playerApps(ih, idx, s.file.name).map(([label, href, title]) => (
      <a key={label} href={href} title={title}>
        {label}
      </a>
    ))
    : null
  const copyStream = s?.file
    ? (
        <CopyButton
          label='Copy stream link'
          text={streamUrl(ih, idx, s.file.name)}
          title='Copy the stream link for any player'
        />
      )
    : null
  const action = (name: PlaybackAction): ReactNode =>
    name === 'retry'
      ? (
          <button type='button' className='button primary' data-action={name} onClick={() => player?.retry()}>
            Try again
          </button>
        )
      : name === 'play'
        ? (
            <button
              type='button'
              className='button primary'
              data-action={name}
              onClick={() => player?.togglePlay()}
            >
              Play
            </button>
          )
        : name === 'release'
          ? (
              <CatalogLink className='button' href={urls.search(s?.torrent ? releaseName(s.torrent.name) : '')}>
                Choose another release
              </CatalogLink>
            )
          : s?.file
            ? (
                <Menu label='Open in player' className='button playback-external'>
                  {external}
                  {copyStream}
                </Menu>
              )
            : null
  const speedChoices = (narrow = false): ReactNode =>
    SPEEDS.map((rate) => (
      <button
        type='button'
        key={rate}
        role='menuitemradio'
        className={`choice${narrow ? ' narrow-only' : ''}`}
        aria-checked={s?.media.rate === rate}
        onClick={() => player?.setSpeed(rate)}
      >
        {rate === 1 ? '1× (normal)' : speedLabel(rate)}
      </button>
    ))
  const total = s?.media.duration ?? 0
  const at = dragging ?? s?.media.position ?? 0
  const silent = s?.media.muted || s?.media.volume === 0
  const overlay = s?.overlay
  const overlayCard = (text: string, actions: ReactNode): ReactNode => (
    <div className='card'>
      <p>{text}</p>
      <p className='actions'>{actions}</p>
    </div>
  )
  const tipOutcome =
    s?.decision && tip
      ? seekOutcome(tip.at, {
        mode: s.decision.mode,
        duration: total,
        buffered: s.media.buffered,
        ready: sessionStatus(s)?.ready ?? null,
        growingEnd: s.growingEnd,
        ranges: fileRanges(s),
      })
      : 'seekable'
  return (
    <>
      <div className='band'>
        <div
          id='stage'
          ref={stage}
          style={stageStyle}
          className={`${waiting ? 'has-playback-wait' : ''}${idle && !waiting ? ' idle' : ''}`}
          onPointerMove={(e) => {
            if (e.pointerType !== 'touch') wake()
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== 'touch') pointerSleep()
          }}
          onFocus={wake}
        >
          <video
            id='video'
            ref={video}
            playsInline
            onPointerDown={(e) => {
              tapWoke.current =
                idle &&
                (e.pointerType === 'touch' || e.clientY >= (chrome.current?.getBoundingClientRect().top ?? 0))
              wake()
            }}
            onClick={() => {
              if (tapWoke.current || menus.size || player?.unmuteAutoplay()) return
              player?.togglePlay()
            }}
            onDoubleClick={toggleFullscreen}
            onPlay={wake}
            onPause={wake}
          />
          <div id='screen-title' className='screen-title'>
            <b id='screen-name'>{title}</b>
            <span id='screen-sub'>{s?.file && baseName(s.file.name)}</span>
          </div>
          <div id='overlay' aria-live='polite'>
            {overlay &&
              (overlay.kind === 'resume'
                ? (
                    overlayCard(
                  `Resume from ${clock(overlay.at)}?`,
                  <>
                    <button
                      type='button'
                      className='button primary'
                      onClick={() => player?.playFrom(overlay.at)}
                    >
                      Resume
                    </button>
                    <button type='button' className='button' onClick={() => player?.startOver()}>
                      Start over
                    </button>
                  </>
                    )
                  )
                : overlay.kind === 'countdown'
                  ? (
                      overlayCard(
                  `Next: ${fileLabel(overlay.next)} in ${overlay.left} s`,
                  <>
                    <CatalogLink className='button primary' href={urls.player(ih, overlay.next.idx)}>
                      Play now
                    </CatalogLink>
                    <button type='button' className='button' onClick={() => player?.cancelCountdown()}>
                      Cancel
                    </button>
                  </>
                      )
                    )
                  : overlay.kind === 'missing'
                    ? (
                        overlayCard(
                          overlay.message,
                          <CatalogLink className='button primary' href={urls.torrent(ih)}>
                            Back to files
                          </CatalogLink>
                        )
                      )
                    : (
                        <div className={`toast ${overlay.kind}`}>{overlay.text}</div>
                      ))}
          </div>
          <PlaybackFlow
            model={model}
            elapsed={s ? s.now - s.waitingAt : 0}
            context={
              s?.starting ? `${s.starting} · Waiting ${Math.floor((s.now - s.waitingAt) / 1000)} s` : ''
            }
            togglePin={togglePin}
            action={action}
          />
          <div id='chrome' ref={chrome} className='chrome' hidden={missing}>
            <div
              id='seekbar'
              ref={seekbar}
              className='seekbar'
              onPointerMove={(e) => {
                if (dragging !== null || !track.current || !seekbar.current) return
                const bounds = track.current.getBoundingClientRect()
                const fraction = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width))
                showTip(fraction * total, e.clientX - seekbar.current.getBoundingClientRect().left)
              }}
              onPointerLeave={() => {
                if (dragging === null) setTip(null)
              }}
            >
              <div className='track' ref={track} aria-hidden='true'>
                <i
                  id='layer-server'
                  className='layer server'
                  style={{
                    backgroundImage:
                      s && total ? layerBackground(fileRanges(s) ?? [], 'var(--seek-server)') : 'none',
                  }}
                />
                <i
                  id='layer-conv'
                  className='layer conv'
                  style={{
                    backgroundImage:
                      s && total
                        ? layerBackground(
                          (sessionStatus(s)?.ready ?? []).map(([a, b]) => [a / total, b / total]),
                          'var(--seek-conv)'
                        )
                        : 'none',
                  }}
                />
                <i
                  id='layer-buf'
                  className='layer buf'
                  style={{
                    backgroundImage:
                      s?.decision && total
                        ? layerBackground(
                          s.media.buffered.map(([a, b]) => [a / total, b / total]),
                          'var(--seek-buf)'
                        )
                        : 'none',
                  }}
                />
                <i
                  id='layer-played'
                  className='layer played'
                  style={{ width: total ? `${Math.min(100, (at / total) * 100)}%` : '0' }}
                />
              </div>
              <input
                id='seek'
                type='range'
                min={0}
                max={Math.floor(total)}
                step={1}
                value={at}
                aria-label='Position'
                aria-valuetext={`${clock(at)} of ${clock(total)}`}
                onInput={(e) => {
                  const value = Number(e.currentTarget.value)
                  setDragging(value)
                  if (track.current) {
                    showTip(
                      value,
                      track.current.offsetLeft + (total ? value / total : 0) * track.current.offsetWidth
                    )
                  }
                }}
                onChange={() => {}}
              />
              <div id='seektip' ref={tipNode} className='seektip' hidden={!tip} style={{ left: tip?.x }}>
                <b>{clock(tip?.at ?? 0)}</b>
                <span>{seekHint(tipOutcome)}</span>
              </div>
            </div>
            <div className='controls'>
              <button
                id='playpause'
                className='ic'
                type='button'
                aria-label={s?.media.paused ? 'Play' : 'Pause'}
                title={`${s?.media.paused ? 'Play' : 'Pause'} (K)`}
                disabled={!s || nothingToPlay(s)}
                onClick={() => player?.togglePlay()}
              >
                <Icon name={s?.media.paused ? 'play' : 'pause'} />
              </button>
              <button
                id='back10'
                className='ic wide-only'
                type='button'
                aria-label='Back 10 seconds'
                title='Back 10 seconds (J)'
                onClick={() => player?.seekBy(-10)}
              >
                <Icon name='back' />
              </button>
              <button
                id='fwd10'
                className='ic wide-only'
                type='button'
                aria-label='Forward 10 seconds'
                title='Forward 10 seconds (L)'
                onClick={() => player?.seekBy(10)}
              >
                <Icon name='forward' />
              </button>
              <button
                id='mute'
                className='ic'
                type='button'
                aria-label={silent ? 'Unmute' : 'Mute'}
                title={`${silent ? 'Unmute' : 'Mute'} (M)`}
                onClick={() => player?.toggleMute()}
              >
                <Icon name={silent ? 'muted' : (s?.media.volume ?? 1) < 0.5 ? 'volumeLow' : 'volume'} />
              </button>
              <input
                id='volume'
                className='wide-only'
                type='range'
                min={0}
                max={1}
                step={0.05}
                value={silent ? 0 : (s?.media.volume ?? 1)}
                aria-label='Volume'
                aria-valuetext={`${Math.round((silent ? 0 : (s?.media.volume ?? 1)) * 100)}%`}
                style={{ '--vol': `${(silent ? 0 : (s?.media.volume ?? 1)) * 100}%` } as CSSProperties}
                onChange={(e) => player?.setVolume(Number(e.target.value))}
              />
              <span id='time' className='time'>
                {clock(at)} / {clock(total)}
              </span>
              <span className='gap' />
              {s?.next
                ? (
                    <CatalogLink
                      id='next'
                      className='pill-link'
                      aria-label={`Next: ${fileLabel(s.next)}`}
                      href={urls.player(ih, s.next.idx)}
                      title={`Next: ${fileLabel(s.next)} (N)`}
                    >
                      <span className='pill wide-only'>Next: {fileLabel(s.next)}</span>
                      <span className='narrow-only'>
                        <Icon name='next' />
                      </span>
                    </CatalogLink>
                  )
                : (
                    <a id='next' className='pill-link' hidden />
                  )}
              <span id='subs-slot' hidden={!s?.subtitleOptions.length}>
                {chromeMenu(
                  'subtitles',
                  <Icon name='subtitles' />,
                  `Subtitles: ${s?.subtitleOptions.find((o) => o.value === s.subtitles)?.name ?? 'Off'}`,
                  <>
                    <div className='menu-heading'>Subtitles</div>
                    <button
                      type='button'
                      className='choice'
                      role='menuitemradio'
                      data-value=''
                      aria-checked={!s?.subtitles}
                      onClick={() => player?.setSubtitles('')}
                    >
                      Off
                    </button>
                    {s?.subtitleOptions.map((o) => (
                      <button
                        key={o.value}
                        type='button'
                        className='choice'
                        role='menuitemradio'
                        data-value={o.value}
                        aria-checked={o.value === s.subtitles}
                        disabled={o.disabled}
                        title={o.disabled ? 'Image subtitles are not supported' : ''}
                        onClick={() => player?.setSubtitles(o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </>,
                  s?.subtitles ? 'on' : ''
                )}
              </span>
              <span id='audio-slot' hidden={(s?.info?.audio.length ?? 0) < 2}>
                {chromeMenu(
                  'audio',
                  <Icon name='audio' />,
                  `Audio: ${s?.info?.audio[s.audio] ? audioTrackName(s.info.audio[s.audio]!) : 'Track 1'}`,
                  <>
                    <div className='menu-heading'>Audio</div>
                    {s?.info?.audio.map((a) => (
                      <button
                        key={a.index}
                        type='button'
                        className='choice'
                        role='menuitemradio'
                        data-value={a.index}
                        aria-checked={a.index === s.audio}
                        onClick={() => player?.setAudio(a.index)}
                      >
                        {audioTrackLabel(a)}
                      </button>
                    ))}
                  </>
                )}
              </span>
              <span id='speed-slot' className='wide-only'>
                {chromeMenu(
                  'speed',
                  <span className='pill'>{speedLabel(s?.media.rate ?? 1)}</span>,
                  `Speed: ${speedLabel(s?.media.rate ?? 1)}`,
                  <>
                    <div className='menu-heading'>Speed</div>
                    {speedChoices()}
                  </>
                )}
              </span>
              <span id='more-slot'>
                {chromeMenu(
                  'more',
                  <Icon name='more' />,
                  'More',
                  <>
                    {s?.file && (
                      <>
                        <div className='menu-heading'>Open in</div>
                        {external}
                        <hr />
                        <a href={urls.download(ih, idx, s.file.name)}>Download file</a>
                        {copyStream}
                        <hr />
                      </>
                    )}
                    {document.pictureInPictureEnabled && (
                      <button type='button' onClick={() => player?.togglePip()}>
                        {s?.media.pip ? 'Exit picture in picture' : 'Picture in picture'}
                      </button>
                    )}
                    <button
                      type='button'
                      onClick={() => {
                        setKeys(true)
                        wake()
                      }}
                    >
                      Keyboard shortcuts
                    </button>
                    <button
                      type='button'
                      role='menuitemradio'
                      className='choice'
                      aria-checked={pinned}
                      onClick={togglePin}
                    >
                      Playback flow
                    </button>
                    <hr className='narrow-only' />
                    <div className='menu-heading narrow-only'>Speed</div>
                    {speedChoices(true)}
                  </>
                )}
              </span>
              <button
                id='fullscreen'
                className='ic'
                type='button'
                aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                title={`${fullscreen ? 'Exit fullscreen' : 'Fullscreen'} (F)`}
                onClick={toggleFullscreen}
              >
                <Icon name={fullscreen ? 'exitFullscreen' : 'fullscreen'} />
              </button>
            </div>
          </div>
          <div id='keys' className='keysheet' role='dialog' aria-labelledby='keys-title' hidden={!keys}>
            <div className='keysheet-head'>
              <h2 id='keys-title'>Keyboard shortcuts</h2>
              <button
                id='keys-close'
                className='ic'
                type='button'
                aria-label='Close'
                title='Close (Esc)'
                onClick={() => {
                  setKeys(false)
                  wake()
                }}
              >
                <Icon name='close' />
              </button>
            </div>
            <dl>
              {[
                ['Space K', 'Play or pause'],
                ['← → J L', 'Back or forward 10 seconds'],
                ['↑ ↓', 'Volume up or down'],
                ['M', 'Mute'],
                ['F', 'Fullscreen'],
                ['C', 'Subtitles on or off'],
                ['N', 'Next file'],
                ['< >', 'Slower or faster'],
                ['?', 'This list'],
              ].map(([key, label]) => (
                <Fragment key={key}>
                  <dt>
                    {key!.split(' ').map((k) => (
                      <Fragment key={k}>
                        <kbd>{k}</kbd>{' '}
                      </Fragment>
                    ))}
                  </dt>
                  <dd>{label}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </div>
      </div>
      <main className='wide player-main'>
        <div id='titlerow' className='titlerow'>
          <div className='titles'>
            <p className='back'>
              <CatalogLink id='back' href={urls.torrent(ih)}>
                ← {s?.torrent?.name ?? 'Files'}
              </CatalogLink>
            </p>
            <h1 id='title'>{title}</h1>
          </div>
          <div id='title-actions' className='title-actions' hidden={missing}>
            <span id='openin'>
              {s?.file && (
                <Menu label='Open in ▾' className='button'>
                  <div className='menu-heading'>Other players</div>
                  {external}
                  {copyStream}
                </Menu>
              )}
            </span>
            <button
              id='details-toggle'
              className='disclosure'
              type='button'
              aria-expanded={details}
              aria-controls='details'
              onClick={() => setDetails((d) => !d)}
            >
              ⓘ Details
            </button>
            <button
              id='perf-toggle'
              className='disclosure'
              type='button'
              aria-expanded={performance}
              aria-controls='performance'
              onClick={() => setPerformance((p) => !p)}
            >
              Performance
            </button>
          </div>
        </div>
        <section id='details' className='panel' aria-label='Details' hidden={!details || missing}>
          <dl id='facts'>
            {details &&
              s &&
              factRows({
                decision: s.decision,
                file: s.file ?? undefined,
                info: s.info,
                audio: s.audio,
                status: s.status,
                buffered: s.media.ahead,
              }).map(([label, value]) => (
                <Fragment key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </Fragment>
              ))}
          </dl>
        </section>
        <section
          id='performance'
          className='panel performance'
          aria-label='Playback performance'
          hidden={!performance || missing}
        >
          {performance && s && <Performance history={s.history} direct={isLocal(s.decision)} />}
        </section>
      </main>
    </>
  )
}
