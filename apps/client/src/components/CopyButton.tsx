import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { copy } from '../lib/ui.ts'

export function CopyButton ({
  label,
  text,
  title = text,
}: {
  label: string
  text: string
  title?: string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type='button'
      className='copy'
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        copy(text).then(() => {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1500)
        }, console.error)
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}
