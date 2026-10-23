// A page's status line, as ui.ts setStatus() and setError() draw it: plain, busy (spinner) or an error with Try again.
import type { ReactNode } from 'react'

interface StatusProps {
  text?: string
  busy?: boolean
  /** An error message; `retry` adds a Try again button that reruns the request on the page. */
  error?: string | null | undefined
  retry?: (() => void) | undefined
}

export function Status ({ text = '', busy = false, error, retry }: StatusProps): ReactNode {
  if (error) {
    return (
      <p id='status' className='status error'>
        {error}{retry && <> <button type='button' className='retry' onClick={retry}>Try again</button></>}
      </p>
    )
  }
  return <p id='status' className={`status ${busy ? 'busy' : ''}`}>{text}</p>
}

export const errorText = (err: unknown): string | null => err == null ? null : err instanceof Error ? err.message : typeof err === 'string' ? err : 'The request failed.'
