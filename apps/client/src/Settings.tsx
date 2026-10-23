import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  SECTIONS,
  SERVER_CONVERSION_KEY,
  SETTINGS,
  isMaskedSecret,
  isValueDef,
  redactDeep,
  validate,
} from '@magplay/api-contract'
import type {
  DebugInfo,
  ListItem,
  SettingDef,
  SettingsErrorResponse,
  SettingsResponse,
  StatusCheck,
  StatusResponse,
  ValueDef,
} from '@magplay/api-contract'
import { api } from './lib/api.ts'
import { ActionControl, Field, ListControl, OptionalNote, host } from './lib/controls.tsx'
import { presentSetting } from './lib/setting-rules.ts'
import { readPreferences, setPreference } from './lib/preferences.ts'
import type { PreferenceKey } from './lib/preferences.ts'
import { measureConnection, saveConnection } from './lib/speedtest.ts'
import { updateBrowserChecks } from './lib/status-menu.ts'
import { queryClient, statusQuery } from './lib/query.ts'
import { copy } from './lib/ui.ts'
import { SettingsReadout } from './components/SettingsReadout.tsx'

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
class SaveError extends Error {
  readonly fields: Record<string, string>
  constructor (message: string, fields: Record<string, string>) { super(message); this.fields = fields }
}
function SourceExtras ({
  item,
  check,
  onResult,
}: {
  item: ListItem
  check: StatusCheck | undefined
  onResult: (c: StatusCheck) => void
}): ReactNode {
  const test = useMutation({
    mutationFn: () => api<StatusCheck>('/api/settings/test', { json: { key: 'sources', item } }),
    onSuccess: onResult,
  })
  const current = test.isPending ? { level: 'unknown' as const } : (test.data ?? check)
  const word = current?.level === 'ok' ? 'Working' : current?.level === 'unknown' ? 'Checking' : 'Failed'
  return (
    <>
      <span className='source-status' title={current && 'message' in current ? (current.message ?? '') : ''}>
        {current && (
          <>
            <span className={`status-dot lvl-${current.level}`} />
            {word}
            {current.level === 'ok' && 'value' in current && current.value ? ` · ${current.value}` : ''}
          </>
        )}
      </span>
      <button
        type='button'
        className='button'
        aria-label={`Test ${host(item.url) || 'source'}`}
        disabled={test.isPending}
        onClick={() => test.mutate()}
      >
        Test
      </button>
      <span className='sr-only' role='status'>
        {test.error?.message ??
          (test.data ? (test.data.level === 'ok' ? 'Working' : (test.data.message ?? 'Failed')) : '')}
      </span>
    </>
  )
}
function SettingsEditor ({ saved: initialSaved }: { saved: SettingsResponse }): ReactNode {
  const [saved, setSaved] = useState(initialSaved)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [prefs, setPrefs] = useState(readPreferences)
  const [epoch, setEpoch] = useState(0)
  const [live, setLive] = useState(false)
  const [savedNote, setSavedNote] = useState<{ text: string; expiresAt: number } | null>(null)
  const status = useQuery(statusQuery).data
  const debug = useQuery({
    queryKey: ['debug'],
    queryFn: ({ signal }) => api<DebugInfo>('/api/debug', { signal }),
    enabled: (query) => live || query.state.data === undefined,
    refetchInterval: live ? 5000 : false,
  })
  const dirty = Object.keys(draft).length
  useEffect(() => {
    const onScreen = new Set<Element>()
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) onScreen.add(e.target)
        else onScreen.delete(e.target)
      }
      setLive(onScreen.size > 0)
    })
    for (const id of ['storage', 'debug']) {
      const node = document.getElementById(id)
      if (node) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [epoch])
  useEffect(() => {
    const scroll = (): void => {
      if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
    }
    scroll()
    addEventListener('hashchange', scroll)
    return () => removeEventListener('hashchange', scroll)
  }, [])
  useEffect(() => {
    if (!savedNote) return
    const expire = (): void => {
      setSavedNote((current) => (current && Date.now() >= current.expiresAt ? null : current))
    }
    const timer = setTimeout(expire, Math.max(0, savedNote.expiresAt - Date.now()))
    document.addEventListener('visibilitychange', expire)
    addEventListener('pageshow', expire)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', expire)
      removeEventListener('pageshow', expire)
    }
  }, [savedNote])
  useEffect(() => {
    if (!dirty) return
    const before = (e: BeforeUnloadEvent): void => e.preventDefault()
    addEventListener('beforeunload', before)
    return () => removeEventListener('beforeunload', before)
  }, [dirty])
  const read = (key: string): unknown => (key in draft ? draft[key] : saved.values[key])
  const save = useMutation({
    mutationFn: async (changes: Record<string, unknown>) => {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
      const out = (await response.json()) as SettingsResponse | SettingsErrorResponse
      if (!response.ok) {
        throw new SaveError(
          'error' in out ? out.error : `HTTP ${response.status}`,
          'fields' in out ? out.fields : {}
        )
      }
      return out as SettingsResponse
    },
    onSuccess: (out, changes) => {
      queryClient.setQueryData(['settings'], out)
      setSaved(out)
      setDraft({})
      setErrors({})
      setEpoch((e) => e + 1)
      setSavedNote({
        text: `Saved: ${Object.keys(changes)
          .map((key) => SETTINGS.find((d) => d.key === key)?.label.toLowerCase() ?? key)
          .join(', ')}`,
        expiresAt: Date.now() + 4000,
      })
      queryClient.invalidateQueries({ queryKey: ['status'] }).catch(console.error)
      queryClient.invalidateQueries({ queryKey: ['debug'] }).catch(console.error)
    },
    onError: (error) => {
      if (error instanceof SaveError) {
        setErrors(error.fields)
        const key = Object.keys(error.fields)[0]
        if (key) {
          document
            .getElementById(`row-setting-${key.replace(/\./g, '-')}`)
            ?.scrollIntoView({ block: 'center' })
        }
      }
    },
  })
  const clear = useMutation({
    mutationFn: () => api<{ stopped: number }>('/api/debug/clear-hls', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['debug'] }).catch(console.error)
      queryClient.invalidateQueries({ queryKey: ['status'] }).catch(console.error)
    },
  })
  const action = async (key: string): Promise<string | undefined> => {
    if (key === 'connection.test') {
      saveConnection(await measureConnection())
      updateBrowserChecks()
      setEpoch((e) => e + 1)
      return undefined
    }
    if (key === 'debug.clearHls') {
      const { stopped } = await clear.mutateAsync()
      return stopped ? `Stopped ${stopped} conversion${stopped === 1 ? '' : 's'}` : 'Cleared'
    }
    if (key === 'debug.diagnostics') {
      const [info, settings, statusNow] = await Promise.all([
        api<DebugInfo>('/api/debug'),
        api<SettingsResponse>('/api/settings'),
        api<StatusResponse>('/api/status'),
      ])
      await copy(
        JSON.stringify(
          redactDeep({
            at: new Date().toISOString(),
            userAgent: navigator.userAgent,
            debug: info,
            settings,
            preferences: prefs,
            status: statusNow,
          }),
          null,
          2
        )
      )
      return 'Copied'
    }
    return 'Not available'
  }
  const edit = (def: ValueDef, next: unknown, committed: boolean): void => {
    setSavedNote(null)
    if (def.scope === 'browser') {
      if (setPreference(def.key as PreferenceKey, next as never)) setPrefs(readPreferences())
      return
    }
    setDraft((before) => {
      const updated = { ...before }
      if (same(next, saved.values[def.key])) delete updated[def.key]
      else updated[def.key] = next
      return updated
    })
    if (committed) {
      const result = isMaskedSecret(next) ? { ok: true as const } : validate(def, next)
      setErrors((e) => ({ ...e, [def.key]: result.ok ? '' : `${def.label} ${result.error}` }))
    }
  }
  const row = (original: SettingDef): ReactNode => {
    const def = presentSetting(original, (key) =>
      key === SERVER_CONVERSION_KEY ? (debug.data?.serverConversion ?? true) : read(key)
    )
    const id = `setting-${def.key.replace(/\./g, '-')}`
    const meta = def.scope === 'server' ? saved.meta[def.key] : undefined
    const locked = meta?.source === 'env' && def.type !== 'list'
    const disabled = locked || !!def.disabled || save.isPending
    const value =
      def.scope === 'server' ? read(def.key) : isValueDef(def) ? prefs[def.key as PreferenceKey] : undefined
    const wide =
      def.type === 'list' ||
      (def.type === 'readout' && (def.key.startsWith('debug.') || def.key === 'connection.result'))
    return (
      <div
        key={def.key}
        className={`row${wide ? ' wide' : ''}${def.disabled ? ' inactive' : ''}`}
        id={`row-${id}`}
        hidden={!!def.hidden}
      >
        <div className='row-text'>
          {!(wide && def.type === 'readout') &&
            (isValueDef(def) && def.type !== 'list'
              ? (
                  <label className='row-label' htmlFor={id}>
                    {def.label}
                    <OptionalNote def={def} />
                  </label>
                )
              : (
                  <span className='row-label'>
                    {def.label}
                    <OptionalNote def={def} />
                  </span>
                ))}
          {def.help && <p className='help'>{def.help}</p>}
          {locked && (
            <p className='env-note'>
              Set by <code>{meta.env ?? def.env?.[0] ?? ''}</code>. Change this environment variable to edit
              the setting.
            </p>
          )}
        </div>
        <div className='row-control'>
          {def.type === 'action'
            ? (
                <ActionControl def={def} id={id} run={() => action(def.key)} />
              )
            : def.type === 'readout'
              ? (
                  <div id={id} className='readout' aria-live='polite'>
                    <SettingsReadout name={def.key} debug={debug.data} />
                  </div>
                )
              : def.type === 'list'
                ? (
                    <ListControl
                      def={def}
                      id={id}
                      value={value}
                      locked={meta?.locked ?? []}
                      onChange={(next, committed) => edit(def, next, committed)}
                      extras={(item) => (
                        <SourceExtras
                          item={item}
                          check={status?.checks.find((c) => c.id === `source:${item.id}`)}
                          onResult={(c) => {
                            setErrors((e) => ({ ...e, sources: c.level === 'ok' ? '' : (c.message ?? '') }))
                            queryClient.invalidateQueries({ queryKey: ['status'] }).catch(console.error)
                          }}
                        />
                      )}
                    />
                  )
                : (
                    <Field
                      def={def}
                      id={id}
                      label={def.label}
                      value={value}
                      disabled={disabled}
                      onChange={(next, committed) => edit(def, next, committed)}
                    />
                  )}
        </div>
        <p className='field-error' role='alert'>
          {errors[def.key]}
        </p>
      </div>
    )
  }
  return (
    <>
      <div id='settings-body' className='settings-body'>
        {SECTIONS.map((section) => {
          const defs = SETTINGS.filter((d) => d.section === section.id && !d.hidden)
          const groups = new Map<string, SettingDef[]>()
          for (const def of defs) groups.set(def.group ?? '', [...(groups.get(def.group ?? '') ?? []), def])
          const problems =
            status?.checks.filter(
              (c) =>
                c.action?.href === `/settings#${section.id}` && (c.level === 'warn' || c.level === 'error')
            ) ?? []
          const level = problems.some((c) => c.level === 'error') ? 'error' : problems.length ? 'warn' : null
          const stored = defs.filter(isValueDef)
          return (
            <section
              key={`${section.id}:${epoch}`}
              id={section.id}
              className='settings-section'
              aria-labelledby={`${section.id}-title`}
            >
              <div className='section-head'>
                <h2 id={`${section.id}-title`}>
                  {section.label}
                  <span className='section-status'>
                    {level && (
                      <span
                        className={`status-dot lvl-${level}`}
                        title={level === 'error' ? 'Has a problem' : 'Needs attention'}
                      />
                    )}
                  </span>
                </h2>
                <p className='intro'>{section.intro}</p>
              </div>
              {stored.length > 0 &&
                stored.every(
                  (d) => d.scope === 'server' && saved.meta[d.key]?.source === 'env' && d.type !== 'list'
                ) && <p className='muted'>These settings are controlled by environment variables.</p>}
              {[...groups].map(([name, list]) => (
                <div key={name} className='card'>
                  {name && (
                    <div className='card-head'>
                      <h3>{name}</h3>
                    </div>
                  )}
                  {list.map(row)}
                </div>
              ))}
            </section>
          )
        })}
      </div>
      <div
        id='savebar'
        className={`savebar${!dirty && savedNote ? ' saved' : ''}`}
        role='region'
        aria-label='Unsaved changes'
        hidden={!dirty && !savedNote}
      >
        <span id='savebar-count' role='status'>
          {!dirty && savedNote ? savedNote.text : `${dirty} unsaved ${dirty === 1 ? 'change' : 'changes'}`}
        </span>
        <span
          id='savebar-status'
          className={`status${save.isPending ? ' busy' : save.error ? ' error' : ''}`}
        >
          {save.isPending ? 'Saving…' : save.error?.message}
        </span>
        <button
          id='savebar-discard'
          type='button'
          className='button'
          onClick={() => {
            setDraft({})
            setErrors({})
            setSavedNote(null)
            setEpoch((e) => e + 1)
            save.reset()
          }}
        >
          Discard
        </button>
        <button
          id='savebar-save'
          type='button'
          className='button primary'
          disabled={save.isPending}
          onClick={() => save.mutate(draft)}
        >
          Save
        </button>
      </div>
    </>
  )
}
export function Settings (): ReactNode {
  useEffect(() => {
    document.title = 'Settings · magplay'
  }, [])
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api<SettingsResponse>('/api/settings', { signal, cache: 'no-store' }),
    staleTime: Infinity,
  })
  return (
    <main className='settings'>
      <h1>Settings</h1>
      {settings.data
        ? (
            <SettingsEditor saved={settings.data} />
          )
        : settings.error
          ? (
              <>
                <p className='status error'>Couldn’t load settings: {settings.error.message}</p>
                <button
                  type='button'
                  className='button'
                  onClick={() => {
                    settings.refetch().catch(console.error)
                  }}
                >
                  Try again
                </button>
              </>
            )
          : (
              <p className='status busy'>Loading settings…</p>
            )}
    </main>
  )
}
