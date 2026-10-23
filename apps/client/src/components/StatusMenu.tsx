// The right side of the top bar: a status button showing overall health, whose panel lists the checks worst first
// with their fixes, and a gear that links to Settings.
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { problems } from '@magplay/api-contract'
import type { StatusCheck, StatusLevel } from '@magplay/api-contract'
import { STORAGE_KEYS } from '../lib/preferences.ts'
import { statusQuery, refreshBrowserChecks } from '../lib/query.ts'
import { buttonLabel, HEADLINES, LEVEL_NAMES, summary } from '../lib/status-menu.ts'
import type { MergedStatus } from '../lib/status-menu.ts'
import { Menu } from './Menu.tsx'

const Dot = ({ level, large = false }: { level: StatusLevel, large?: boolean }): ReactNode =>
  <span className={`status-dot lvl-${level}${large ? ' large' : ''}`} title={LEVEL_NAMES[level]} />

function CheckRow ({ check: c }: { check: StatusCheck }): ReactNode {
  const problem = c.level === 'warn' || c.level === 'error'
  const action = c.action && <Link to={c.action.href.split('#')[0]!} hash={c.action.href.split('#')[1] ?? ''}>{`${c.action.label} →`}</Link>
  return (
    <li className={`status-check lvl-${c.level}`}>
      <Dot level={c.level} />
      <div className='status-check-main'>
        <div className='status-check-line'>
          <span className='status-check-label'>{c.label}</span>
          {c.value && <span className='status-check-value'>{c.value}</span>}
        </div>
        {problem && c.message && <p className='status-check-message'>{c.message[0]!.toUpperCase() + c.message.slice(1)} {action}</p>}
        {!problem && c.level === 'unknown' && action && <p className='status-check-message'>{action}</p>}
      </div>
    </li>
  )
}

function Panel ({ status }: { status: MergedStatus | null }): ReactNode {
  if (!status) return <div className='status-panel'><p className='status busy'>Checking…</p></div>
  return (
    <div className='status-panel'>
      <div className='status-head'>
        <Dot level={status.level} large />
        <div>
          <strong>{HEADLINES[status.level]}</strong>
          <p>{summary(status)}</p>
        </div>
      </div>
      <div className='status-section'>
        <div className='menu-heading'>Status</div>
        <ul className='status-checks'>{status.checks.map(c => <CheckRow key={c.id} check={c} />)}</ul>
      </div>
      <div className='status-foot'><Link to='/settings' hash='debug'>Debug details</Link></div>
    </div>
  )
}

export function StatusMenu (): ReactNode {
  const { data: status = null, refetch } = useQuery(statusQuery)
  // A connection test on the settings page (another tab) updates this one
  useEffect(() => {
    const storage = (e: StorageEvent): void => { if (e.key === STORAGE_KEYS.connection) refreshBrowserChecks() }
    addEventListener('storage', storage)
    return () => { removeEventListener('storage', storage) }
  }, [])
  const level = status?.level ?? 'unknown'
  const count = status ? problems(status.checks).length : 0
  const label = buttonLabel(status)
  return (
    <div className='topbar-end'>
      <Menu
        className='status-menu'
        summaryClassName='status-button'
        title={label}
        ariaLabel={label}
        label={<><Dot level={level} />{count > 0 && <span className='status-count'>{count}</span>}</>}
        onToggle={open => { if (open) refetch().catch(console.error) }}
      >
        <Panel status={status} />
      </Menu>
      <Link to='/settings' className='settings-link' title='Settings' aria-label='Settings'>
        <svg viewBox='0 0 24 24' width='18' height='18' aria-hidden='true' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
          <circle cx='12' cy='12' r='3' />
          <path d='M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' />
        </svg>
      </Link>
    </div>
  )
}
