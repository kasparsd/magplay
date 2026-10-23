// A dropdown on <details>; mounted geometry and document interactions live in attachMenu().
import { useEffect, useRef } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { attachMenu } from '../lib/ui.ts'
import type { MenuOptions } from '../lib/ui.ts'

interface MenuProps extends MenuOptions {
  label: ReactNode
  summaryClassName?: string
  onToggle?: (open: boolean) => void
  children: ReactNode
}

export function Menu ({ label, title = '', className = '', ariaLabel, up = false, within, summaryClassName, onToggle, children }: MenuProps): ReactNode {
  const box = useRef<HTMLDetailsElement>(null)
  useEffect(() => box.current ? attachMenu(box.current, { up, within }) : undefined, [up, within])
  const toggle = (e: SyntheticEvent<HTMLDetailsElement>): void => { onToggle?.(e.currentTarget.open) }
  return (
    <details ref={box} className={`menu ${className}`.trim()} onToggle={toggle}>
      {/* A summary isn't announced as a button everywhere; say what it is and whether it is open */}
      <summary title={title} aria-label={ariaLabel} className={summaryClassName} role='button' aria-haspopup='menu' aria-expanded='false'>{label}</summary>
      <div className={`menu-items${up ? ' up' : ''}`}>{children}</div>
    </details>
  )
}
